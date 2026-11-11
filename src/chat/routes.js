/**
 * Rutas HTTP del chat privado.
 *
 * Atiende el envío, la lectura, la edición y el borrado de mensajes de uno a
 * uno, y aplica las mismas reglas de contenido, de adjuntos y de cuota que
 * los grupos. El cifrado y el paginado viven en messages.js; el resumen de
 * cada conversación, en summaries.js.
 */
'use strict';

// Orden de los estados de entrega: un acuse solo avanza si es posterior.
const RANK = { sent: 1, delivered: 2, read: 3 };

const crypto = require('crypto');
const {
    MEDIA_FALLBACK_DATA_URL,
    MEDIA_FALLBACK_HASH,
    blobAvailableTo,
    blobHashOk,
    blobQuotaOk,
    invalidateBlobQuota,
    readBlob,
    storeBlob
} = require('./media.js');
const { deleteMessageById, filterForViewer, getChatPage, invalidateChatPage, readMessagePage, resolveReply, rowToMessage, updateStoredMessage } = require('./messages.js');
const { decorateForClient, decryptSummaryCached, healSummary, lastEntryFromMsg, onChatDeletedSummary, onMessageDeletedSummary, onMessageSentSummary, onReadSummary, readSummaryEntry, resolveName, writeSummaryEntry } = require('./summaries.js');
const { applyChatPrefs, readChatPrefs, resolveTarget, unarchiveForIncoming } = require('./prefs.js');
const { CONFIG } = require('../config.js');
const { decryptAtRest, encryptAtRest } = require('../crypto/setup.js');
const { db } = require('../db/database.js');
const { Stmt } = require('../db/statements.js');
const { pruneBlobHashes, tx } = require('../db/transactions.js');
const { groupLastEntry, groupPolicies, healGroupSummary, readGroup, readGroupSummary, writeGroupSummary } = require('../groups/store.js');
const { rejectRateLimited, rejectRateLimitedMessage } = require('../http/helpers.js');
const { chatPrefsLimiter, receiptLimiter, reactionLimiter } = require('../http/rate-limit.js');
const { json, securityHeaders } = require('../http/responses.js');
const { notifyUser, pushNameOf } = require('../push/vapid.js');
const { push, pushName } = require('../realtime/notify.js');
const { storeGallery, validateGallery } = require('../shared/gallery.js');
const { MESSAGE_LIMITS, characterCount } = require('../shared/limits.js');
const { normalizeContactData, normalizePollData, togglePollVote } = require('../shared/types.js');
const { clampStr, localStickerHash, validMessageId, validMime, validStickerData } = require('../shared/validation.js');
const { profiles, users } = require('../state.js');
const { byName, isChatMuted, mutedChatPeers, pairKeyFromIds } = require('../users/helpers.js');
const { accountsBlocked, isBlockedBy, permite } = require('../users/privacy.js');

const REACTION_EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
const emojiSegmenter = new Intl.Segmenter('es', { granularity: 'grapheme' });

function isValidReactionEmoji(value) {
    if (typeof value !== 'string' || value.length > 32 || !REACTION_EMOJI_RE.test(value)) return false;
    const segments = [...emojiSegmenter.segment(value)];
    return segments.length === 1 && segments[0].segment === value;
}

function withMessageReactions(messages, viewerId) {
    if (!messages.length) return messages;
    const ids = messages.map(message => message.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT message_id, user_id, emoji FROM message_reactions
        WHERE message_id IN (${placeholders}) ORDER BY updated_at ASC`).all(...ids);
    const grouped = new Map();
    for (const stored of rows) {
        const row = { ...stored, emoji: decryptAtRest(stored.emoji) };
        if (typeof row.emoji !== 'string' || !isValidReactionEmoji(row.emoji)) {
            console.error(`[reactions] Reacción ilegible para el mensaje ${row.message_id}.`);
            continue;
        }
        let byEmoji = grouped.get(row.message_id);
        if (!byEmoji) grouped.set(row.message_id, byEmoji = new Map());
        let reaction = byEmoji.get(row.emoji);
        if (!reaction) byEmoji.set(row.emoji, reaction = { emoji: row.emoji, count: 0, mine: false });
        reaction.count++;
        if (row.user_id === viewerId) reaction.mine = true;
    }
    return messages.map(message => ({
        ...message,
        reactions: [...(grouped.get(message.id)?.values() || [])]
    }));
}

function messageReactionsForViewer(messageId, viewerId) {
    return withMessageReactions([{ id: messageId }], viewerId)[0].reactions;
}

function broadcastMessageReactions(row, group, reactions) {
    const recipients = group ? group.members.map(name => byName(name)).filter(Boolean)
        : [users.get(row.from_id), users.get(row.to_id)].filter(Boolean);
    const unique = new Map(recipients.map(user => [user.id, user]));
    const userReactions = Stmt.listMessageReactions.all(row.id).map(item => ({
        ...item,
        emoji: decryptAtRest(item.emoji)
    }));
    for (const user of unique.values()) {
        const personalized = reactions.map(reaction => ({
            ...reaction,
            mine: userReactions.some(item => item.emoji === reaction.emoji && item.user_id === user.id)
        }));
        push(user, {
            type: 'message-reactions',
            messageId: row.id,
            groupId: group ? group.id : '',
            reactions: personalized
        });
    }
}

function postMessageReaction(req, res, url, data, actor) {
    if (typeof data.messageId !== 'string' || !validMessageId(data.messageId) ||
        typeof data.emoji !== 'string' || (data.emoji !== '' && !isValidReactionEmoji(data.emoji)))
        return json(res, 400, { error: 'Reacción inválida.' });
    if (rejectRateLimited(res, reactionLimiter, req.authUser.id, 120, 'reacciones por minuto')) return;
    const row = Stmt.getMessage.get(data.messageId);
    if (!row || row.once || row.kind === 'seen' ||
        db.prepare('SELECT 1 FROM message_deletions WHERE message_id = ? AND user_id = ?').get(row.id, req.authUser.id))
        return json(res, 404, { error: 'Mensaje no disponible.' });
    let group = null;
    if (row.chat.startsWith('chat:')) {
        if (row.from_id !== req.authUser.id && row.to_id !== req.authUser.id) return json(res, 404, { error: 'Mensaje no disponible.' });
        const peerId = row.from_id === req.authUser.id ? row.to_id : row.from_id;
        const peer = peerId && users.get(peerId);
        if (!peer || accountsBlocked(actor, peer.username)) return json(res, 404, { error: 'Mensaje no disponible.' });
    } else if (row.chat.startsWith('group:')) {
        group = readGroup(row.chat.slice(6));
        if (!group || !group.memberIds.includes(req.authUser.id)) return json(res, 404, { error: 'Mensaje no disponible.' });
    } else return json(res, 404, { error: 'Mensaje no disponible.' });

    const previous = Stmt.getMessageReaction.get(row.id, req.authUser.id);
    const previousEmoji = previous ? decryptAtRest(previous.emoji) : '';
    if (!data.emoji || (previousEmoji && previousEmoji === data.emoji))
        Stmt.deleteMessageReaction.run(row.id, req.authUser.id);
    else
        Stmt.upsertMessageReaction.run(row.id, req.authUser.id, encryptAtRest(data.emoji), Date.now());
    const reactions = messageReactionsForViewer(row.id, req.authUser.id);
    broadcastMessageReactions(row, group, reactions);
    return json(res, 200, { ok: true, reactions });
}

function getRoute2197(req, res, url, data, actor) {
    const hash = url.pathname.slice(6);
    if (!blobAvailableTo(req.authUser, hash)) return json(res, 404, {});
    const stored = readBlob(hash);
    const missing = stored === null || stored === '';
    const plaintext = missing ? MEDIA_FALLBACK_DATA_URL : stored;
    res.writeHead(200, {
    'Content-Type': 'text/plain',
    // La caché es privada y dura poco: los adjuntos no deben quedar
    // vivos en el navegador de un dispositivo compartido.
    'Cache-Control': missing ? 'private, no-store' : 'private, max-age=86400',
    'ETag': '"' + (missing ? MEDIA_FALLBACK_HASH : hash) + '"',
    ...securityHeaders
    });
    return res.end(plaintext);
}

function getHave(req, res, url, data, actor) {
    const h = url.searchParams.get('hash') || '';
    return json(res, 200, { ok: blobAvailableTo(req.authUser, h) && Stmt.hasBlob.get(h) });
}

/* Orden de la lista de chats: lo manda el SERVIDOR. Fijados primero (el más
   recientemente fijado por delante) y luego por actividad del último mensaje.
   El cliente lo respeta tal cual, así que entrar en un chat no puede recolocar
   la lista: el orden no depende de nada que cambie al leer. */
function summarySort(a, b) {
    if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if ((b.pinnedAt || 0) !== (a.pinnedAt || 0)) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
    return ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0);
}

function getChatsSummary(req, res, url, data, actor) {
    const uuid = req.authUser.id;
    // Preferencias una vez: el orden (fijados, actividad) y los estados viajan
    // en la misma respuesta, para que la lista sea un solo viaje.
    const prefs = readChatPrefs(uuid);
    const chats = [];
    for (const row of Stmt.listSummaries.all(uuid)) {
    // El resumen se guarda cifrado con la clave del titular: se
    // descifra antes de interpretarlo (el formato antiguo sin cifrar
    // se tolera tal cual).
    let last = null;
    try {
    const raw = decryptSummaryCached(uuid, row.last_data);
    last = raw ? JSON.parse(raw) : null;
    /* Copia cifrada que YA no se puede leer (quedó con la clave anterior a la
       corrección de la rotación): el resumen es una caché, se reconstruye
       desde el último mensaje. Solo en ese caso: un resumen vacío a propósito
       (mensaje borrado "para mí") se queda como está. */
    if (!last && raw === null && String(row.last_data || '').startsWith('PCE3:'))
        last = healSummary(uuid, row.peer, row.unread);
    } catch { }
    const name = resolveName(row.peer);
    const pref = prefs[name === actor ? 'saved' : 'dm:' + name] || {};
    chats.push({
        peer: name, peerId: row.peer, unread: row.unread, last,
        pinned: pref.pinned === true, pinnedAt: pref.pinnedAt || 0, archived: pref.archived === true
    });
    }
    // Los grupos van con el mismo trato: así la lista ENTERA la ordena el
    // servidor, no cada cliente por su cuenta.
    for (const row of Stmt.listGroupSummaries.all(uuid)) {
        // Grupo ocultado manualmente por esta cuenta (BUG-013): fuera de la
        // lista hasta que un mensaje nuevo lo reabra.
        if (Stmt.chatDeletedFor.get('group:' + row.gid, uuid)) continue;
        let last = null;
        const cifrado = String(row.last_data || '').startsWith('PCE3:');
        if (cifrado) {
            try {
                const raw = decryptSummaryCached(uuid, row.last_data);
                last = raw ? JSON.parse(raw) : null;
                // Misma regla que los DMs: solo se reconstruye lo ilegible.
                if (!last && raw === null) {
                    const sanado = healGroupSummary(uuid, row.gid);
                    if (sanado) last = sanado.last;
                }
            } catch { }
        } else if (row.last_data) {
            // Formato antiguo (resúmenes de grupo guardados en claro).
            try { last = JSON.parse(row.last_data); } catch { }
        }
        const pref = prefs['group:' + row.gid] || {};
        const group = readGroup(row.gid);
        chats.push({
            group: row.gid, groupName: (group && group.name) || '',
            unread: row.unread, last,
            pinned: pref.pinned === true, pinnedAt: pref.pinnedAt || 0, archived: pref.archived === true
        });
    }
    chats.sort(summarySort);
    return json(res, 200, { chats });
}

function getChatPreferences(req, res, url, data, actor) {
    return json(res, 200, {
        prefs: readChatPrefs(req.authUser.id),
        mutedPeers: mutedChatPeers(req.authUser.username)
    });
}

/* Preferencias de la lista de chats.
 *
 * Forma nueva (recomendada): un bloque atómico sobre varios chats.
 *   { targets: ['dm:ana', 'group:g_x'], pinned?: bool, muted?: bool, unread?: bool }
 * Forma antigua (se mantiene): { peer: 'ana', muted: bool }
 *
 * Los cambios se aplican en una sola transacción y se notifican a los demás
 * dispositivos de la cuenta para que la lista quede igual en todos ellos. */
function postChatPreferences(req, res, url, data, actor) {
    // Cada petición puede resolver hasta 200 destinos contra la base (grupos
    // por id): sin cota, una sola cuenta generaba SELECTs baratos a ritmo de
    // red. El freno va ANTES de resolver nada.
    if (rejectRateLimited(res, chatPrefsLimiter, req.authUser.id, 20, 'cambios de preferencias de chat por minuto')) return;
    const patch = {
        pinned: typeof data.pinned === 'boolean' ? data.pinned : undefined,
        muted: typeof data.muted === 'boolean' ? data.muted : undefined,
        unread: typeof data.unread === 'boolean' ? data.unread : undefined,
        archived: typeof data.archived === 'boolean' ? data.archived : undefined
    };
    let targets = [];
    if (Array.isArray(data.targets)) {
        if (data.targets.length > 200) return json(res, 400, { error: 'Demasiados chats seleccionados.' });
        targets = data.targets.filter(item => typeof item === 'string' && item);
        // Todo o nada: si un destino no es válido, no se aplica nada.
        for (const target of targets) {
            if (!resolveTarget(actor, target))
                return json(res, 400, { error: 'Algún chat no es válido.' });
        }
    } else if (typeof data.peer === 'string') {
        const key = data.peer.startsWith('dm:') || data.peer.startsWith('group:') || data.peer === 'saved'
            ? data.peer
            : 'dm:' + data.peer;
        if (!resolveTarget(actor, key)) return json(res, 400, { error: 'Chat no válido.' });
        targets = [key];
    } else {
        return json(res, 400, { error: 'Preferencia de chat inválida.' });
    }
    if (patch.pinned === undefined && patch.muted === undefined && patch.unread === undefined && patch.archived === undefined)
        return json(res, 400, { error: 'Preferencia de chat inválida.' });
    const prefs = applyChatPrefs(actor, req.authUser.id, targets, patch);
    // Los demás dispositivos de la cuenta se enteran al instante.
    pushName(actor, { type: 'chat-prefs', prefs });
    return json(res, 200, { ok: true, prefs, mutedPeers: mutedChatPeers(actor) });
}

function postPollVote(req, res, url, data, actor) {
    const messageId = typeof data.messageId === 'string' ? data.messageId : '';
    const optionId = typeof data.optionId === 'string' ? data.optionId : '';
    const row = Stmt.getMessage.get(messageId);
    if (!row || row.kind !== 'poll') return json(res, 404, { error: 'Encuesta no disponible.' });

    let allowed = false;
    let group = null;
    if (row.chat.startsWith('group:')) {
        group = readGroup(row.chat.slice(6));
        allowed = !!group && group.memberIds.includes(req.authUser.id);
    } else if (row.chat.startsWith('chat:')) {
        allowed = row.chat.slice(5).split('__').includes(req.authUser.id);
    }
    if (!allowed) return json(res, 403, { error: 'No puedes votar en esta encuesta.' });

    const message = rowToMessage(row);
    const poll = message && normalizePollData(message.data);
    if (!poll || !poll.options.some(option => option.id === optionId))
        return json(res, 400, { error: 'Opción de encuesta inválida.' });
    let existingPoll;
    try { existingPoll = JSON.parse(message.data); } catch { existingPoll = null; }
    poll.votes = existingPoll && existingPoll.votes && typeof existingPoll.votes === 'object' && !Array.isArray(existingPoll.votes)
        ? existingPoll.votes : {};
    poll.votes = togglePollVote(poll.votes, req.authUser.id, optionId, poll.allowMultiple);
    message.data = JSON.stringify(poll);
    updateStoredMessage(message, row);
    if (row.chat.startsWith('chat:')) invalidateChatPage(row.chat.slice(5));

    const decorated = decorateForClient(message);
    const recipients = group ? group.memberIds.map(id => users.get(id)).filter(Boolean)
        : row.chat.slice(5).split('__').map(id => users.get(id)).filter(Boolean);
    for (const recipient of recipients) push(recipient, {
        type: 'poll-update', message: decorated, groupId: group ? group.id : null
    });
    return json(res, 200, { ok: true, message: decorated });
}

function postSend(req, res, url, data, actor) {
    const sender = req.authUser;
    const recipient = byName(data.to);
    if (!recipient) return json(res, 404, { error: 'contact does not exist' });
    // Se trabaja con la cuenta resuelta y su nombre canónico: indexar perfiles
    // con el texto recibido ("Ana9") dejaría fuera el bloqueo y los permisos,
    // que se guardan con el nombre en minúsculas.
    const to = recipient.username;
    if (isBlockedBy(profiles[to], actor) || isBlockedBy(profiles[actor], to))
        return json(res, 200, { ok: false, blocked: true });
    if (!permite(profiles[to], 'mensajes', actor))
        return json(res, 200, { ok: false, denied: true });
    if (data.kind === 'text' && (typeof data.data !== 'string' ||
        characterCount(data.data, MESSAGE_LIMITS.directMessageCharacters) > MESSAGE_LIMITS.directMessageCharacters))
        return json(res, 400, { error: `Los mensajes privados admiten hasta ${MESSAGE_LIMITS.directMessageCharacters} caracteres.` });
    if (typeof data.data === 'string' && data.data.length > CONFIG.maxMessageDataChars)
        return json(res, 413, { error: 'Contenido demasiado grande.' });
    if (data.kind === 'sticker' && !validStickerData(data.data))
        return json(res, 400, { error: 'Sticker inválido.' });
    // El DM aplica las MISMAS reglas de contenido que el grupo:
    // tipo dentro de la allowlist y hash obligatorio para los
    // medios, para que no entre media inline de cualquier MIME.
    const dmKinds = new Set([...Object.keys(groupPolicies), 'group-invite']);
    if (typeof data.kind !== 'string' || !dmKinds.has(data.kind))
        return json(res, 400, { error: 'Tipo inválido.' });
    /* Cota del medio EN LÍNEA (sin hash): el flujo normal de medios sube el
       blob y manda hash+data; la vía sin hash es interop y, sin esta cota,
       admitía 24 MB por mensaje (bypass de cuota, según SECOA-I-001:
       bytesNuevos no contaba el data sin hash). Con hash el conteo de cuota
       siempre se paga; solo la vía en línea era el agujero. */
    if (['image', 'video', 'audio', 'file'].includes(data.kind) && !data.hash &&
        typeof data.data === 'string' && data.data.length > CONFIG.maxInlineMediaChars)
        return json(res, 413, { error: 'Contenido demasiado grande.' });
    if (['image', 'video', 'audio', 'file'].includes(data.kind) && !data.hash && !Array.isArray(data.gallery))
        return json(res, 400, { error: 'Falta hash.' });
    if (data.mime !== undefined && data.mime !== '' && !validMime(data.mime))
        return json(res, 400, { error: 'Tipo de archivo no permitido.' });
    // La galería se VALIDA sin escribir nada: los blobs se guardan más abajo,
    // cuando la petición ya ha pasado todas las comprobaciones (antes se
    // guardaban durante la validación y una galería acabada en 429 o en 400
    // dejaba adjuntos huérfanos ocupando disco para siempre).
    const gallery = data.gallery === undefined ? [] : validateGallery(sender, data.gallery, blobAvailableTo);
    if (data.gallery !== undefined && (!gallery || data.kind !== 'image'))
        return json(res, 400, { error: 'Galería inválida.' });
    // La cuota se consume con el payload ya validado: una petición
    // inválida no debe gastar los 30 mensajes/minuto.
    if (rejectRateLimitedMessage(res, sender.id)) return;

    let messageData = typeof data.data === 'string' ? data.data : '';
    let messageHash = typeof data.hash === 'string' ? data.hash.toLowerCase() : '';
    const stickerBlobHash = data.kind === 'sticker' ? localStickerHash(messageData) : '';
    if (stickerBlobHash) {
        if ((messageHash && messageHash !== stickerBlobHash) || !blobAvailableTo(sender, stickerBlobHash))
            return json(res, 400, { error: 'Sticker no disponible.' });
        messageHash = stickerBlobHash;
    }
    if (messageHash) {
        if (!blobHashOk(messageHash)) return json(res, 400, { error: 'Hash inválido.' });
        // Referenciar un adjunto QUE YA EXISTE exige tener acceso a
        // él (mismo control que la galería): conocer su hash no
        // basta para leer adjuntos de conversaciones ajenas.
        if (!messageData && !blobAvailableTo(sender, messageHash)) return json(res, 400, { error: 'Archivo no disponible.' });
    }
    /* Cuota de almacenamiento antes de tocar disco (última barrera) y, solo
       entonces, la escritura de los adjuntos que trae el mensaje. El `data`
       se cuenta SIEMPRE que venga: con hash (subida de blob) o sin él (línea
       persistida en el mensaje). Antes, la vía sin hash no pagaba cuota:
       SECOA-I-001. */
    const bytesNuevos = (messageData && !stickerBlobHash ? Buffer.byteLength(messageData) : 0) +
        gallery.reduce((total, item) => total + (item.data ? Buffer.byteLength(item.data) : 0), 0);
    if (bytesNuevos > 0 && !blobQuotaOk(sender.id, bytesNuevos))
        return json(res, 413, { error: 'Has alcanzado el límite de almacenamiento de adjuntos.' });
    if (messageHash && messageData && !stickerBlobHash && !storeBlob(messageHash, messageData))
        return json(res, 400, { error: 'Archivo inválido.' });
    if (gallery.length && !storeGallery(gallery, storeBlob)) return json(res, 400, { error: 'Galería inválida.' });
    // El espacio acaba de crecer: fuera de la caché de cuota, o durante la
    // ventana de 15 s peticiones concurrentes veían el mismo consumo y
    // pasaban todas la barrera (hasta N extra de 18 MB por cuenta).
    invalidateBlobQuota(sender.id);
    if (messageHash && !stickerBlobHash) messageData = '';

    const msg = {
        id: crypto.randomUUID(),
        fromId: sender.id, toId: recipient.id,
        kind: data.kind, name: data.kind === 'image' ? '' : clampStr(data.name, 180), mime: validMime(data.mime) ? data.mime.slice(0, 120) : '',
        caption: clampStr(data.caption, 2000), data: messageData, hash: messageHash, once: !!data.once,
        gallery,
        reply: resolveReply(data.reply, 'chat:' + pairKeyFromIds(sender.id, recipient.id)),
        enc: typeof data.enc === 'string' && (data.enc === 'e2' || data.enc === 'g2') ? data.enc : '',
        status: 'sent', edited: false, ts: Date.now()
    };
    if (msg.kind === 'contact') {
        const contact = normalizeContactData(msg.data, byName);
        if (!contact) return json(res, 400, { error: 'Contacto inválido.' });
        msg.data = JSON.stringify(contact);
    } else if (msg.kind === 'poll') {
        const poll = normalizePollData(msg.data);
        if (!poll) return json(res, 400, { error: 'Encuesta inválida.' });
        msg.data = JSON.stringify(poll);
    }
    if (data.kind === 'group-invite') {
        const g = readGroup(typeof data.groupId === 'string' ? data.groupId : '');
        if (!g || !g.memberIds.includes(sender.id)) return json(res, 403, { error: 'No puedes invitar.' });
        if (typeof data.inviteCode !== 'string' || data.inviteCode !== g.inviteCode) return json(res, 403, { error: 'Invitación inválida.' });
        msg.data = ''; msg.hash = ''; msg.name = ''; msg.mime = ''; msg.caption = '';
        msg.invite = {
            groupId: g.id, code: g.inviteCode, name: g.name,
            description: g.description || '', visibility: g.visibility,
            joinPolicy: g.joinPolicy, memberCount: g.members.length,
            members: g.members.slice(0, 4), avatar: g.avatar || ''
        };
    }
    const pk = pairKeyFromIds(sender.id, recipient.id);
    tx.sendMessage(msg, 'chat:' + pk);
    // Un mensaje nuevo reabre la conversación que el destinatario — o el
    // propio emisor al volver a escribir — había borrado de su lista.
    Stmt.deleteChatDeletion.run('chat:' + pk, recipient.id);
    Stmt.deleteChatDeletion.run('chat:' + pk, sender.id);
    // Un mensaje nuevo devuelve el chat a la lista, salvo que el destinatario
    // haya activado «Mantener los chats archivados».
    if (recipient.id !== sender.id)
        unarchiveForIncoming(recipient.username, recipient.id, 'dm:' + sender.username);
    invalidateChatPage(pk);
    onMessageSentSummary(msg);
    const decorated = decorateForClient(msg);
    push(sender, { type: 'message', message: decorated });
    if (recipient.id !== sender.id) push(recipient, { type: 'message', message: decorated });
    if (sender.id !== recipient.id && !recipient.online && !isChatMuted(recipient.username, sender.username))
        void notifyUser(recipient.username, { title: 'Nuevo mensaje de ' + pushNameOf(sender.username), body: 'Tienes un mensaje', tag: 'msg-' + msg.id, renotify: true, url: '/?open=' + encodeURIComponent(sender.username) });
    return json(res, 200, { ok: true, message: decorated });
}

function postSeen(req, res, url, data, actor) {
    if (typeof data.id !== 'string' || !data.id || data.id.length > 128) return json(res, 400, { ok: false });
    const row = Stmt.getMessage.get(data.id);
    if (!row || row.to_id !== req.authUser.id) return json(res, 404, { ok: false });
    // Solo los mensajes de "ver una vez" se destruyen al verse: el
    // resto conserva su texto y su adjunto para los dos lados.
    if (!row.once) return json(res, 409, { ok: false, error: 'Este mensaje no es de una sola vista.' });
    const m = rowToMessage(row);
    if (!m) return json(res, 404, { ok: false });
    const readAt = Date.now();
    m.kind = 'seen';
    m.data = '';
    m.hash = '';
    m.once = false;
    m.gallery = [];
    m.status = 'read';
    m.readAt = readAt;
    pruneBlobHashes(tx.markSeenMessage(m, row)); invalidateBlobQuota(req.authUser.id);
    for (const [ownerId, peerId] of [[m.fromId, m.toId], [m.toId, m.fromId]]) {
        const summary = readSummaryEntry(ownerId, peerId);
        if (summary && summary.last && summary.last.id === m.id) {
            summary.last.status = 'read';
            summary.last.readAt = readAt;
            writeSummaryEntry(ownerId, peerId, summary);
        }
    }
    if (row.chat.startsWith('chat:')) invalidateChatPage(row.chat.slice(5));
    const fromU = users.get(m.fromId), toU = users.get(m.toId);
    if (fromU) push(fromU, { type: 'seen', id: data.id, readAt, signature: m.signature, signingPublicKey: m.signingPublicKey, signatureValid: m.signatureValid });
    if (toU) push(toU, { type: 'seen', id: data.id, readAt, signature: m.signature, signingPublicKey: m.signingPublicKey, signatureValid: m.signatureValid });
    return json(res, 200, { ok: true });
}

function postReceipt(req, res, url, data, actor) {
    // Cada acuse recorre hasta 500 ids y descifra cada fila encontrada, y
    // toca resúmenes y candados de página: sin cota era el multiplicador de
    // escritura barato por cuenta (SECOA-I-004).
    if (rejectRateLimited(res, receiptLimiter, req.authUser.id, 120, 'acuses por minuto')) return;
    if (!['delivered', 'read'].includes(data.status) || !Array.isArray(data.ids) || data.ids.length > 500 ||
        data.ids.some(id => typeof id !== 'string' || !id || id.length > 128))
        return json(res, 400, { error: 'Invalid receipt.' });
    const peerIds = new Set();
    const processedIds = [];
    const pkTouched = new Set();
    const receiptAt = Date.now();
    for (const id of data.ids) {
        const row = Stmt.getMessage.get(id);
        if (!row || row.to_id !== req.authUser.id) continue;
        const m = rowToMessage(row);
        if (!m) continue;
        processedIds.push(id);
        peerIds.add(m.fromId);
        if ((RANK[data.status] || 0) > (RANK[m.status] || 0)) {
            m.status = data.status;
            if (data.status === 'read') m.readAt = receiptAt;
            updateStoredMessage(m, row);
            if (data.status === 'read') {
                for (const [ownerId, peerId] of [[m.fromId, m.toId], [m.toId, m.fromId]]) {
                    const summary = readSummaryEntry(ownerId, peerId);
                    if (summary && summary.last && summary.last.id === m.id) {
                        summary.last.status = 'read';
                        summary.last.readAt = m.readAt;
                        writeSummaryEntry(ownerId, peerId, summary);
                    }
                }
            }
            pkTouched.add(pairKeyFromIds(m.fromId, m.toId));
        }
    }
    for (const pk of pkTouched) invalidateChatPage(pk);
    if (data.status === 'read') for (const peerId of peerIds) onReadSummary(req.authUser.id, peerId);
    for (const peerId of [req.authUser.id, ...peerIds]) {
        const u = users.get(peerId);
        if (u) push(u, { type: 'receipt', ids: processedIds, status: data.status, readAt: receiptAt });
    }
    return json(res, 200, { ok: true });
}

function postMsgDelete(req, res, url, data, actor) {
    if (typeof data.id !== 'string' || !data.id || data.id.length > 128) return json(res, 400, { ok: false });
    const row = Stmt.getMessage.get(data.id);
    if (!row || (row.from_id !== req.authUser.id && row.to_id !== req.authUser.id)) return json(res, 404, { ok: false });
    // El borrado GLOBAL es del autor del mensaje. Si quien lo pide
    // es el destinatario, el mensaje se oculta solo para él: su
    // texto, su adjunto y su firma siguen en el historial del
    // emisor.
    if (row.from_id !== req.authUser.id) {
        Stmt.insertMessageDeletion.run(data.id, req.authUser.id, Date.now());
        // El borrado es "para mi": el resumen de QUIEN lo pide deja de
        // apuntar al mensaje borrado (su vista previa de la lista), y el
        // autor conserva su copia.
        const m0 = rowToMessage(row);
        if (m0) onMessageDeletedSummary(m0, req.authUser.id);
        return json(res, 200, { ok: true, scope: 'me' });
    }
    const m = rowToMessage(row);
    if (m) onMessageDeletedSummary(m);
    deleteMessageById(data.id);
    const chat = row.chat;
    const peerId = chat.startsWith('chat:') ? (chat.slice(5).split('__').find(id => id !== req.authUser.id)) : null;
    if (chat.startsWith('chat:')) {
        for (const id of [row.from_id, row.to_id]) {
            const u = users.get(id);
            if (u) push(u, { type: 'msgDelete', id: data.id });
        }
    } else if (chat.startsWith('group:')) {
        const gid = chat.slice(6);
        const g = readGroup(gid);
        if (g) for (const u of g.members) pushName(u, { type: 'group-message-delete', groupId: gid, messageId: data.id });
    }
    return json(res, 200, { ok: true });
}

function postMsgEdit(req, res, url, data, actor) {
    if (typeof data.id !== 'string' || !data.id || data.id.length > 128) return json(res, 400, { ok: false });
    const row = Stmt.getMessage.get(data.id);
    if (!row || row.from_id !== req.authUser.id || row.kind !== 'text' || typeof data.data !== 'string') return json(res, 404, { ok: false });
    const isGroup = row.chat.startsWith('group:');
    // En grupos se respeta la política de edición y se avisa a TODOS
    // los miembros, para que ninguno se quede con el texto viejo.
    let group = null;
    if (isGroup) {
        group = readGroup(row.chat.slice(6));
        const isAdmin = group && group.admins.some(name => byName(name)?.id === req.authUser.id);
        if (!group || !group.memberIds.includes(req.authUser.id) || (group.editPolicy === 'admins' && !isAdmin))
            return json(res, 403, { ok: false, error: 'No puedes editar este mensaje.' });
    }
    const editLimit = isGroup ? MESSAGE_LIMITS.groupMessageCharacters : MESSAGE_LIMITS.directMessageCharacters;
    if (characterCount(data.data, editLimit) > editLimit)
        return json(res, 400, { error: `Los mensajes admiten hasta ${editLimit} caracteres.` });
    const m = rowToMessage(row);
    if (!m) return json(res, 404, { ok: false });
    m.data = data.data;
    m.enc = typeof data.enc === 'string' && (data.enc === 'e2' || data.enc === 'g2') ? data.enc : (m.enc || '');
    m.edited = true;
    updateStoredMessage(m, row);
    /* El resumen de la lista de chats cachea el último mensaje: si el
       mensaje editado ES esa vista previa, se reescribe con el texto nuevo
       (antes quedaba congelada con el texto viejo hasta el siguiente
       mensaje, y podía usarse para "espiar" el texto editado en la lista).
       Patrón idéntico al reescrito al borrar (router.js, data.deleteMessage). */
    if (isGroup) {
        const ultimo = groupLastEntry(m);
        for (const uuid of group.memberIds) {
            const groupEntry = readGroupSummary(uuid, group.id);
            if (groupEntry && groupEntry.last && groupEntry.last.id === m.id) {
                groupEntry.last = ultimo;
                writeGroupSummary(uuid, group.id, groupEntry);
            }
        }
    } else {
        for (const [ownerId, peerId] of [[m.fromId, m.toId], [m.toId, m.fromId]]) {
            if (!ownerId || !peerId) continue;
            const entry = readSummaryEntry(ownerId, peerId);
            if (!entry || !entry.last || entry.last.id !== m.id) continue;
            entry.last = { ...lastEntryFromMsg(m), prevId: entry.last.prevId || null };
            writeSummaryEntry(ownerId, peerId, entry);
        }
    }
    if (!isGroup) invalidateChatPage(pairKeyFromIds(m.fromId, m.toId));
    const editEvent = {
        type: 'msgEdit', id: data.id, data: data.data, enc: m.enc,
        signature: m.signature, signingPublicKey: m.signingPublicKey,
        signatureValid: m.signatureValid
    };
    if (group) {
        editEvent.groupId = group.id;
        for (const username of group.members) {
            const member = byName(username);
            if (member) push(member, editEvent);
        }
    } else {
        for (const id of [m.fromId, m.toId]) {
            const u = users.get(id);
            if (u) push(u, editEvent);
        }
    }
    return json(res, 200, { ok: true });
}

/* Borrado de una o varias conversaciones 1:1.
 *
 * Hay dos modos:
 *   · `clearBoth: true` ("vaciar chat"): borra los mensajes DE VERDAD para
 *     los dos, como en WhatsApp. La conversación sigue en la lista, vacía.
 *   · sin `clearBoth` ("eliminar chat"): es "borrar para mí"; el historial es
 *     compartido, así que solo se oculta para quien lo pide y el otro conserva
 *     su copia.
 *
 * Con varios chats, todo se hace en una sola transacción: o se borran todos,
 * o ninguno.
 *
 * `keepSummary` deja el chat en la lista (solo se ocultan los mensajes y la
 * conversación se reabre al escribir de nuevo). */
function postChatDelete(req, res, url, data, actor) {
    const peers = Array.isArray(data.peers)
        ? data.peers.filter(item => typeof item === 'string' && item).slice(0, 200)
        : (typeof data.to === 'string' ? [data.to] : []);
    if (!peers.length) return json(res, 404, { error: 'chat not found' });
    const keepSummary = data.keepSummary === true;
    const clearBoth = data.clearBoth === true;
    const targets = [];
    // Los chats de grupo se aceptan como "group:<gid>" (BUG-013): ocultar el
    // grupo de la lista sin dejar de ser miembro. Vaciar "para los dos" no
    // aplica: el historial de un grupo es de todos los miembros.
    const groupTargets = [];
    for (const peer of peers) {
        if (peer.startsWith('group:')) {
            const g = readGroup(peer.slice(6));
            if (!g || !g.memberIds.includes(req.authUser.id)) return json(res, 404, { error: 'chat not found' });
            groupTargets.push(g);
            continue;
        }
        if (peer !== actor && !byName(peer)) return json(res, 404, { error: 'chat not found' });
        const peerAcc = byName(peer);
        const peerId = peer === actor ? req.authUser.id : (peerAcc ? peerAcc.id : null);
        if (!peerId) return json(res, 404, { error: 'chat not found' });
        targets.push({ peer, peerId, pk: pairKeyFromIds(req.authUser.id, peerId) });
    }
    if (clearBoth) {
        if (groupTargets.length) return json(res, 400, { error: 'Vaciar un grupo no está disponible.' });
        // Vaciar para los dos: se borran los mensajes del chat y se avisa a
        // ambas partes para que limpien su copia local.
        // UNA transacción para todos los chats: si algo falla a medias, antes
        // quedaba un chat borrado y otro no, con la lista y el contador de no
        // leídos desincronados.
        const cleared = db.transaction(() => {
            const hechos = [];
            for (const target of targets) {
                const chatKey = 'chat:' + target.pk;
                const hashes = tx.clearChatMessages(chatKey);
                pruneBlobHashes(hashes);
                // Si antes se habia borrado "para mi", esa marca se quita: el
                // historial ya no existe para nadie.
                Stmt.deleteChatDeletion.run(chatKey, req.authUser.id);
                Stmt.deleteChatDeletion.run(chatKey, target.peerId);
                // Los dos resúmenes (el de cada parte) dejan de mostrar el
                // último mensaje. keepSummary conserva el chat en la lista,
                // vacío para los dos (BUG-008: aquí se ignoraba).
                if (!keepSummary) {
                    Stmt.deleteSummary.run(req.authUser.id, target.peerId);
                    Stmt.deleteSummary.run(target.peerId, req.authUser.id);
                }
                invalidateChatPage(target.pk);
                hechos.push(target.peer);
            }
            return hechos;
        })();
        for (const peer of cleared) {
            const target = targets.find(t => t.peer === peer);
            for (const account of [users.get(req.authUser.id), users.get(target.peerId)]) {
                if (account) push(account, { type: 'chat-cleared', peer: peer === actor ? req.authUser.id : peer, clearedBy: actor });
            }
        }
        invalidateBlobQuota(req.authUser.id);
        return json(res, 200, { ok: true, scope: 'both', cleared });
    }
    const now = Date.now();
    tx.deleteChats(req.authUser.id, targets.map(target => ({
        chatId: 'chat:' + target.pk,
        peerId: target.peerId,
        peerKey: 'dm:' + target.peer,
        pk: target.pk
    })), now, keepSummary);
    // Ocultar grupos de la lista sin salir (BUG-013): marca de conversación
    // oculta + fuera el resumen. Un mensaje nuevo reabre el chat: el envío
    // de grupo limpia la marca de TODOS los miembros (store.js).
    if (groupTargets.length) {
        const ocultar = db.transaction(gids => {
            for (const gid of gids) {
                Stmt.insertChatDeletion.run('group:' + gid, req.authUser.id, now);
                Stmt.deleteGroupSummary.run(req.authUser.id, gid);
                Stmt.deleteChatPref.run(req.authUser.id, 'group:' + gid);
            }
        });
        ocultar(groupTargets.map(g => g.id));
    }
    const me = users.get(req.authUser.id);
    for (const target of targets) {
        if (!keepSummary) onChatDeletedSummary(req.authUser.id, target.peerId);
        invalidateChatPage(target.pk);
        if (me) push(me, { type: 'chatDelete', peer: target.peer });
    }
    for (const g of groupTargets) {
        if (me) push(me, { type: 'chatDelete', peer: 'group:' + g.id });
    }
    return json(res, 200, { ok: true, scope: 'me', deleted: [
        ...targets.map(target => target.peer),
        ...groupTargets.map(g => 'group:' + g.id)
    ] });
}

function postMessages(req, res, url, data, actor) {
    const peer = data.to;
    if (typeof peer !== 'string' || (peer !== actor && !byName(peer))) return json(res, 404, { messages: [], more: false });
    if (peer !== actor && accountsBlocked(actor, peer)) return json(res, 404, { messages: [], more: false });
    const peerId = peer === actor ? req.authUser.id : byName(peer)?.id;
    if (!peerId) return json(res, 404, { messages: [], more: false });
    const pk = pairKeyFromIds(req.authUser.id, peerId);
    const limit = Math.min(200, Math.max(1, Number(data.limit) || 20));
    let page;
    if (typeof data.beforeId === 'string') page = readMessagePage('chat:' + pk, { beforeId: data.beforeId, limit });
    else page = getChatPage(pk, limit);
    const visible = filterForViewer(page.messages, req.authUser.id, 'chat:' + pk);
    return json(res, 200, { messages: withMessageReactions(visible, req.authUser.id).map(decorateForClient), more: page.more });
}


module.exports = {
    getRoute2197,
    getHave,
    getChatsSummary,
    getChatPreferences,
    postChatPreferences,
    postPollVote,
    postSend,
    postSeen,
    postReceipt,
    postMsgDelete,
    postMsgEdit,
    postMessageReaction,
    withMessageReactions,
    postChatDelete,
    postMessages,
};

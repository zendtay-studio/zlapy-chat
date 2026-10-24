/**
 * Mensajes.
 *
 * Un mensaje se guarda cifrado con la auth_key de su autor (AES-256-GCM
 * con el contexto del mensaje autenticado, ver src/crypto/mtproto.js):
 * el servidor conoce la clave y con ella sincroniza el historial entre
 * dispositivos. La auth_key va guardada cifrada con la llave maestra, asi que
 * la maestra ES la raiz de confianza: el modelo "por usuario" solo protege
 * ante fuga de la base de datos sin la llave maestra.
 */
'use strict';

const mtproto = require('../crypto/mtproto.js');

const crypto = require('crypto');
const { db } = require('../db/database.js');
const { authKeyRecord, decryptAtRest, ensureAuthKey, messageContextBytes, messageCrypto } = require('../crypto/setup.js');
const { Stmt } = require('../db/statements.js');
const { decryptLegacyMessageFields } = require('../shared/message-data.js');
const { clampStr } = require('../shared/validation.js');
const { CHAT_PAGE_MAX, CHAT_PAGE_TTL, chatPageCache } = require('../state.js');

// Mensajes — helpers SQL
function messageBody(message) {
    return {
        name: message.name || '', mime: message.mime || '', caption: message.caption || '',
        data: message.data || '', gallery: message.gallery || [], reply: message.reply || null,
        status: message.status || 'sent', enc: message.enc || '',
        mentions: message.mentions || [], mentionLabels: message.mentionLabels || {},
        invite: message.invite || null, readAt: message.readAt || 0
    };
}

function prepareStoredMessage(message, chat, cryptoGroupId = null) {
    const row = {
        id: message.id, chat, ts: message.ts, from_id: message.fromId,
        to_id: message.toId || null, kind: message.kind,
        crypto_group_id: cryptoGroupId || null
    };
    // La auth_key debe EXISTIR antes de firmar: en el primer mensaje de un
    // usuario authKeyRecord devolvía null y la firma se hacía con la semilla
    // de la LLAVE MAESTRA (y la caché de pares quedaba poblada con esa
    // semilla, sin invalidarse jamás). Orden seguro: clave primero, firma
    // después.
    const rec = ensureAuthKey(message.fromId);
    const signature = messageCrypto.signMessage(message, row);
    message.signature = signature.signature;
    message.signingPublicKey = signature.signingPublicKey;
    message.cryptoGroupId = row.crypto_group_id || '';
    message.signatureValid = true;
    // Cifrado del contenido: AES-256-GCM con la auth_key del autor y el
    // contexto del mensaje (chat, autor, tipo, marca) como dato autenticado,
    // para que una fila movida de chat no siga siendo valida.
    const body = JSON.stringify(messageBody(message));
    const encrypted = mtproto.encrypt(rec.key, body, messageContextBytes(row));
    return {
        data: encrypted.blob,
        cryptoVersion: 3,
        cryptoGroupId: row.crypto_group_id,
        signature: signature.signature,
        signingPublicKey: signature.signingPublicKey
    };
}

function updateStoredMessage(message, row) {
    const stored = prepareStoredMessage(message, row.chat, row.crypto_group_id);
    Stmt.updateMessage.run(
        message.kind, stored.data, message.hash || null, message.once ? 1 : 0,
        message.edited ? 1 : 0, stored.cryptoVersion, stored.cryptoGroupId,
        stored.signature, stored.signingPublicKey, message.id
    );
}

function rowToMessage(row) {
    if (!row) return null;
    // Un solo formato: PCE3 (AES-256-GCM con la auth_key del autor, AAD que
    // ata el contexto). Las bases que no hablan PCE3 no son compatibles: el
    // arranque exige un esquema nuevo (tests + guards en database.js).
    if (!(typeof row.data === 'string' && row.data.startsWith('PCE3:')) || row.crypto_version !== 3) {
        console.error(`[crypto] Versión de cifrado no soportada para el mensaje ${row.id} (se espera PCE3/crypto_version=3).`);
        return null;
    }
    let plain;
    const rec = authKeyRecord(row.from_id);
    if (!rec) {
        console.error(`[crypto] No se encontró la auth_key del autor del mensaje ${row.id}.`);
        return null;
    }
    const out = mtproto.decrypt(rec.key, row.data, messageContextBytes(row));
    if (!out) {
        console.error(`[crypto] No se pudo descifrar el mensaje ${row.id}.`);
        return null;
    }
    plain = out.body.toString('utf8');
    if (plain === null) return null;
    let body;
    try { body = decryptLegacyMessageFields(JSON.parse(plain), decryptAtRest); } catch { return null; }
    const message = {
        id: row.id, fromId: row.from_id, toId: row.to_id || '',
        kind: row.kind, ts: row.ts, hash: row.hash || '',
        once: !!row.once, edited: !!row.edited,
        name: body.name || '', mime: body.mime || '', caption: body.caption || '',
        data: body.data || '', gallery: body.gallery || [],
        reply: body.reply || null, status: body.status || 'sent',
        enc: body.enc || '', mentions: body.mentions || [],
        mentionLabels: body.mentionLabels || {}, invite: body.invite || null,
        readAt: Number.isFinite(body.readAt) ? body.readAt : 0,
        signature: row.signature || '', signingPublicKey: row.signing_public_key || '',
        cryptoGroupId: row.crypto_group_id || '', signatureValid: false
    };
    if (row.crypto_version >= 2) {
        message.signatureValid = messageCrypto.verifyMessage(
            message, row, message.signature, message.signingPublicKey
        );
        if (!message.signatureValid) {
            console.error(`[crypto] Firma inválida para el mensaje ${row.id}.`);
            return null;
        }
    }
    return message;
}

const findMessage = id => rowToMessage(Stmt.getMessage.get(id));
const findMessageRow = id => Stmt.getMessage.get(id);

/* Cita de respuesta: el servidor NO confía en el id ni en el autor que envía el
 * cliente; se resuelve contra el mensaje real. Si el mensaje no existe o no
 * pertenece a esta conversación, la cita se descarta. Esto corta de raíz:
 *   · el XSS vía el id de respuesta (el cliente lo interpola en un onclick) y
 *   · el preview falsificado atribuido a otra persona.
 *
 * Se guarda SOLO el id del mensaje citado: el texto de la vista previa se
 * resuelve al leer (ver enrichReplies) y en el cliente a partir del mensaje
 * original, así que si ese mensaje se edita o se borra la vista previa se
 * actualiza o desaparece en lugar de quedarse congelada. */
const REPLY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function resolveReply(input, chatKey) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    // Las citas de historia se validan aparte (el cliente comprueba que la
    // historia existe; aquí solo se acota el formato).
    if (input.kind === 'story' && Number.isSafeInteger(input.storyTs) && input.storyTs > 0 && typeof input.from === 'string')
        return { kind: 'story', storyTs: input.storyTs, from: clampStr(input.from, 64), id: '', preview: clampStr(input.preview || '', 120) };
    // Las notas de estado (el texto de 24 h del perfil) no son mensajes, asi
    // que no tienen id: se cita el texto que envio el cliente, firmado por el
    // emisor. Sin este caso la cita se descartaba y el mensaje salia normal.
    if (input.kind === 'note' && typeof input.from === 'string' && input.from)
        return { kind: 'note', from: clampStr(input.from, 64), text: clampStr(input.text || '', 140), id: '', preview: clampStr(input.text || '', 140) };
    const id = typeof input.id === 'string' ? input.id : '';
    if (!REPLY_ID_RE.test(id)) return null;
    const row = Stmt.getMessage.get(id);
    if (!row || row.chat !== chatKey) return null;
    // El autor y el id son los REALES del mensaje referenciado. El preview NO
    // se guarda: se resuelve al leer para que nunca quede desactualizado.
    return { fromId: row.from_id, id: row.id, preview: '' };
}

/* Texto de la vista previa de una cita, tal y como lo ve el cliente.
   Los mensajes cifrados de extremo a extremo no los puede leer el servidor:
   ahí el preview lo resuelve el cliente con el mensaje ya descifrado. */
function replyPreviewText(message) {
    if (!message) return '';
    if (message.enc === 'e2' || message.enc === 'g2') return '';
    if (message.kind !== 'text' || message.once) return '';
    return String(message.data || '').slice(0, 200);
}

/* Rellena el preview de las citas de una página de mensajes.
   · si el mensaje citado está en la página, se usa su texto actual;
   · si no está, se busca en la base: si existe se usa su texto y si ya no
     existe (se borró) la cita se marca como "missing" para que el cliente
     no muestre ninguna vista previa. */
function enrichReplies(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    const byId = new Map();
    for (const message of messages) {
        if (message && message.id) byId.set(message.id, message);
    }
    for (const message of messages) {
        if (!message || !message.reply || !message.reply.id) continue;
        let original = byId.get(message.reply.id);
        let missing = false;
        if (!original) {
            const row = Stmt.getMessage.get(message.reply.id);
            if (!row) missing = true;
            else original = rowToMessage(row);
        }
        message.reply = { ...message.reply, preview: replyPreviewText(original), missing };
    }
    return messages;
}

function readMessagePage(chat, { beforeId, limit } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 20));
    let rows;
    if (beforeId) {
        const anchor = Stmt.getMessage.get(beforeId);
        if (!anchor || anchor.chat !== chat) return { messages: [], more: false };
        rows = Stmt.prevMessages.all(chat, anchor.ts, anchor.ts, beforeId, lim + 1);
    } else {
        rows = Stmt.lastMessages.all(chat, lim + 1);
    }
    const more = rows.length > lim;
    const messages = rows.slice(0, lim).map(rowToMessage).filter(Boolean).reverse();
    // Las citas se resuelven con los mensajes de la propia página: así el
    // preview sale siempre del texto actual del mensaje citado.
    return { messages: enrichReplies(messages), more };
}

/* ¿Cuáles de los mensajes de esta página tiene ocultos el usuario? Consulta
   SOLO los ids de la página (≤200): materializar los borrados completos del
   usuario en cada lectura era O(n) acumulable con el uso del chat. La cláusula
   IN lleva placeholders y los ids viajan como parámetros (nunca interpolados). */
function userDeletionIdsFor(viewerId, ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(
        `SELECT message_id FROM message_deletions WHERE user_id = ? AND message_id IN (${placeholders})`
    ).all(viewerId, ...ids).map(r => r.message_id);
}

/* Borrados con alcance por usuario: el filtro se aplica al SERVIR la página,
   no al leerla, porque la caché de páginas de chat es compartida por los dos
   interlocutores de un DM (filtrar antes de cachear haría que uno viera los
   borrados del otro). */
function filterForViewer(messages, viewerId, chatKey) {
    if (!viewerId) return messages;
    if (Stmt.chatDeletedFor.get(chatKey, viewerId)) return [];
    const hidden = new Set(userDeletionIdsFor(
        viewerId,
        messages.filter(m => m && typeof m.id === 'string').map(m => m.id)
    ));
    if (!hidden.size) return messages;
    return messages.filter(m => !hidden.has(m.id));
}

function getChatPage(pairKeyName, limit) {
    const now = Date.now();
    const cached = chatPageCache.get(pairKeyName);
    if (cached && now - cached.savedAt < CHAT_PAGE_TTL && cached.messages.length >= limit) {
        return { messages: cached.messages.slice(-limit), more: cached.more };
    }
    const fetchLimit = Math.max(50, limit);
    const page = readMessagePage('chat:' + pairKeyName, { limit: fetchLimit });
    chatPageCache.set(pairKeyName, { messages: page.messages, savedAt: now, more: page.more });
    if (chatPageCache.size > CHAT_PAGE_MAX)
        chatPageCache.delete(chatPageCache.keys().next().value);
    return { messages: page.messages.slice(-limit), more: page.more };
}
function invalidateChatPage(pairKeyName) { chatPageCache.delete(pairKeyName); }

function deleteMessageById(id) {
    // Require perezoso: evita un ciclo entre módulos.
    const { pruneBlobHashes, tx } = require('../db/transactions.js');
    const row = Stmt.getMessage.get(id);
    if (!row) return null;
    const msg = rowToMessage(row);
    const chat = row.chat;
    pruneBlobHashes(tx.deleteMessage(id, chat));
    if (chat.startsWith('chat:')) invalidateChatPage(chat.slice(5));
    return msg;
}

module.exports = {
    messageBody,
    prepareStoredMessage,
    updateStoredMessage,
    rowToMessage,
    findMessage,
    findMessageRow,
    REPLY_ID_RE,
    resolveReply,
    replyPreviewText,
    enrichReplies,
    readMessagePage,
    filterForViewer,
    getChatPage,
    invalidateChatPage,
    deleteMessageById,
};

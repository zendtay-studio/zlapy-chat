/**
 * Almacén de cuentas.
 *
 * Mantiene las cuentas en RAM y las persiste en SQLite: perfil, contactos,
 * stickers, grupos vistos, silencios, privacidad, apariencia y ajustes.
 * También hidrata una cuenta al vuelo y regenera la clave de cifrado
 * re-cifrando con ella todo el contenido del usuario.
 */
'use strict';

const mtproto = require('../crypto/mtproto.js');

const { prepareStoredMessage } = require('../chat/messages.js');
const { CONFIG } = require('../config.js');
const { authKeyRecord, authKeys, decryptForUser, encryptAtRest, encryptForUser, messageContextBytes, messageCrypto } = require('../crypto/setup.js');
const { db } = require('../db/database.js');
const { SCHEMA_VERSION } = require('../db/schema.js');
const { Stmt } = require('../db/statements.js');
const { tx } = require('../db/transactions.js');
const { messageRateLimiter } = require('../http/rate-limit.js');
const { push } = require('../realtime/notify.js');
const { blockedSet, callFiles, chatPageCache, groupCache, notesMap, pendingOffers, profiles, pushSubs, sessionCache, stories, usernameIndex, users, setStories } = require('../state.js');
const { byId, byName, mutedChatPeers, parseJsonSafe } = require('./helpers.js');

function hydrateUserFromDb(acc) {
    // Perfil público (reutiliza la entrada existente y la refresca)
    const row = Stmt.getProfile.get(acc.id);
    // Los campos de texto del perfil (nombre, bio y nota) se guardan cifrados
    // en reposo con la CLAVE DEL USUARIO (PCE3); los datos anteriores usan la
    // llave maestra (PCE1). decryptForUser entiende los dos formatos.
    // Ojo: con decryptAtRest (que solo sabe PCE1) un PCE3 se devolvía TAL
    // CUAL, así que al reiniciar el servidor el perfil se pintaba con el
    // texto cifrado en crudo ("PCE3:...") en lugar del nombre real.
    const dec = value => {
        if (typeof value !== 'string' || value === '') return '';
        const out = decryptForUser(acc.id, value);
        return typeof out === 'string' ? out : '';
    };
    const profile = profiles[acc.username] || {
        username: acc.username,
        name: (row && dec(row.display_name)) || acc.username,
        avatar: (row && row.avatar) || '',
        desc: (row && dec(row.bio)) || '',
        note: (row && dec(row.note)) || '',
        noteTs: (row && row.note_ts) || 0
    };
    if (row) {
        profile.name = dec(row.display_name) || profile.name;
        profile.avatar = row.avatar || '';
        profile.desc = dec(row.bio) || '';
        profile.note = dec(row.note) || '';
        profile.noteTs = row.note_ts || 0;
    }
    profiles[acc.username] = profile;

    // Contactos: se cargan de la base porque la lista no debe depender solo
    // de la RAM (la privacidad por defecto "solo contactos" denegaría los DMs
    // en silencio si la lista llegara vacía).
    acc.contacts = Stmt.listContacts.all(acc.id).map(r => r.contact);

    // Stickers favoritos
    acc.stickers = Stmt.listStickers.all(acc.id).map(r => r.sticker).slice(-30);

    // Grupos vistos
    const seen = {};
    for (const r of Stmt.listGroupSeen.all(acc.id)) seen[r.gid] = r.ts;
    acc.groupSeen = seen;

    // Clave del dispositivo (cifrada en reposo)
    try {
        const keyRow = Stmt.getKey.get(acc.id);
        if (keyRow && keyRow.key_cipher) {
            const key = JSON.parse(decryptForUser(acc.id, keyRow.key_cipher) || 'null');
            if (key && typeof key === 'object') acc.publicKey = key;
        }
    } catch { }

    // Nota personal (la de "estados": texto + fondo)
    const noteRow = Stmt.getUserNote.get(acc.id);
    if (noteRow && noteRow.data) {
        const data = parseJsonSafe(decryptForUser(acc.id, noteRow.data) || '');
        if (data && typeof data === 'object') {
            const note = { ...data, ts: noteRow.ts || data.ts || 0 };
            notesMap[acc.username] = note;
            if (typeof note.text === 'string' && note.text) {
                profile.note = note.text;
                profile.noteTs = note.ts || profile.noteTs;
            }
        }
    }

    // Privacidad por función
    const privacyRows = Stmt.listPrivacy.all(acc.id);
    if (privacyRows.length) {
        const lists = Stmt.listPrivacyUsers.all(acc.id);
        const privacy = {};
        for (const r of privacyRows) {
            const names = lists
                .filter(entry => entry.feature === r.feature)
                .map(entry => (entry.target_id && byId(entry.target_id)?.username) || entry.target_name)
                .filter(Boolean);
            privacy[r.feature] = { mode: r.mode, users: names };
        }
        profile.privacy = privacy;
    }

    // Apariencia del chat
    const chat = Stmt.getChatSettings.get(acc.id);
    if (chat) {
        profile.chatAppearance = {
            wall: chat.wall || '', opacity: chat.opacity, blur: chat.blur,
            sender: chat.sender || '', receiver: chat.receiver || '',
            senderText: chat.sender_text || '', receiverText: chat.receiver_text || '',
            fontSize: chat.font_size, autoText: !!chat.auto_text, image: chat.wallpaper || ''
        };
    }

    // Chats silenciados
    profile.mutedChatPeers = Stmt.listMutedPeers.all(acc.id)
        .map(r => (r.peer_id && byId(r.peer_id)?.username) || r.peer_name)
        .filter(Boolean);

    // Bloqueados
    const set = new Set();
    for (const r of Stmt.listBlocked.all(acc.id)) {
        const target = users.get(r.target);
        if (target) set.add(target.username);
    }
    blockedSet.set(acc.username, set);
    profile.blocked = [...set];
}

// Carga inicial desde SQLite
function loadFromDb() {
    // Require perezoso: evita un ciclo entre modulos.
    const { readGroup } = require('../groups/store.js');
    // Cuentas: cada fila trae id, username, hash, salt y política…
    for (const row of Stmt.listAllUsers.all()) {
        try {
            const acc = userFromRow(row);
            users.set(acc.id, acc);
            usernameIndex.set(acc.username, acc.id);
        } catch (e) { console.error('[load] user', row.id, e.message); }
    }
    // TODO: hidratar todo lo que pertenece a cada cuenta en una sola pasada
    // (contactos incluidos: ver hydrateUserFromDb).
    for (const acc of users.values()) {
        try { hydrateUserFromDb(acc); }
        catch (e) { console.error('[load] hydrate', acc.username, e.message); }
    }
    // Sesiones
    const now = Date.now();
    for (const row of Stmt.listSessions.all()) {
        if (row.expires_at > now && users.has(row.user_id))
            sessionCache.set(row.token_hash, { userId: row.user_id, expiresAt: row.expires_at });
    }
    Stmt.deleteExpiredSessions.run(now);
    // Push
    for (const row of Stmt.listPushSubs.all()) {
        if (!pushSubs.has(row.user_id)) pushSubs.set(row.user_id, []);
        try { const sub = parseJsonSafe(decryptForUser(row.user_id, row.data) || ''); if (sub) pushSubs.get(row.user_id).push(sub); } catch { }
    }
    // Llamadas (en RAM, son pocas)
    for (const acc of users.values()) {
        const list = [];
        for (const row of Stmt.listCalls.all(acc.id, 100)) {
            try { const call = parseJsonSafe(decryptForUser(acc.id, row.data) || ''); if (call) list.push(call); } catch { }
        }
        callFiles.set(acc.username, list.reverse());
    }
    // Historias en RAM (solo las vivas)
    const cutoff = now - CONFIG.storyTtlMs;
    for (const row of Stmt.listLiveStories.all(cutoff)) {
        try {
            const s = JSON.parse(decryptForUser(row.from_id, row.data) || 'null');
            const owner = users.get(row.from_id);
            if (s && owner) { s.ts = row.ts; s.from = owner.username; s.hash = row.hash || ''; stories.push(s); }
        } catch { }
    }
    // Grupos
    for (const gRow of db.prepare('SELECT id FROM groups').all()) {
        readGroup(gRow.id);
    }
    console.log(`[load] esquema v${SCHEMA_VERSION}: ${users.size} usuarios, ${groupCache.size} grupos, ${stories.length} historias`);
}

// Regeneracion de la clave de cifrado (MTProto 2.0)
// En MTProto, regenerar la auth_key hace que el servidor olvide la clave
// anterior (los mensajes viejos dejan de ser descifrables y solo queda la
// copia del otro extremo). Aqui, para no perder el historial, el contenido
// del usuario se RE-CIFRA con la clave nueva y solo despues se sustituye
// la anterior.
function regenerateAuthKey(userId) {
    /* Una sola transacción para toda la operación. Antes la clave nueva se
       instalaba y el contenido se re-cifra fila a fila con `run` sueltos: un
       fallo a medias (disco lleno, SQLITE_BUSY) dejaba parte del historial
       cifrado con la clave anterior y la nueva a la vez, es decir ilegible
       para siempre y sin vuelta atrás. Ahora, o se hace todo o no se hace
       nada. */
    return db.transaction(() => regenerateAuthKeyInner(userId))();
}

function regenerateAuthKeyInner(userId) {
    const oldRec = authKeyRecord(userId);
    const newKey = mtproto.generateAuthKey();
    const newKeyId = mtproto.authKeyId(newKey);
    const now = Date.now();
    const salt = authKeys.randomUint64();
    const sessionId = authKeys.randomUint64();
    let reencrypted = 0;

    // La clave nueva se instala ANTES de re-cifrar: asi las firmas se rehacen
    // con la clave nueva (si se re-cifrara antes, los mensajes quedarian
    // firmados con la clave vieja y dejarian de verificarse).
    Stmt.replaceAuthKey.run(encryptAtRest(newKey.toString('hex')), newKeyId, salt, sessionId, '0', now, userId);
    authKeys.authKeyCache.delete(userId);
    messageCrypto.forgetSigningKey(userId);

    const encryptWithNew = plain => {
        if (typeof plain !== 'string' || plain === '') return plain;
        const msgId = mtproto.nextMsgId('0');
        return mtproto.encrypt(newKey, plain, { salt, sessionId, msgId, seqNo: 0 }).blob;
    };

    // 1) Mensajes del usuario: se descifran con la clave previa (o con la
    //    maestra si se guardaron con la clave global) y se re-cifran con la
    //    nueva.
    const messages = db.prepare(`SELECT id, chat, ts, from_id, to_id, kind, data, hash, once, edited,
        crypto_version, crypto_group_id FROM messages WHERE from_id = ?`).all(userId);
    for (const row of messages) {
        let plain = null;
        if (typeof row.data === 'string' && row.data.startsWith('PCE3:')) {
            if (!oldRec) continue;
            const out = mtproto.decrypt(oldRec.key, row.data, messageContextBytes(row));
            if (!out) continue;
            plain = out.body.toString('utf8');
        } else {
            try { plain = messageCrypto.decryptMessage(row.data, row); } catch { continue; }
        }
        if (plain === null) continue;
        let body;
        try { body = JSON.parse(plain); } catch { continue; }
        const msg = {
            id: row.id, fromId: row.from_id, toId: row.to_id || '', kind: row.kind, ts: row.ts,
            name: body.name || '', mime: body.mime || '', caption: body.caption || '',
            data: body.data || '', gallery: body.gallery || [], reply: body.reply || null,
            status: body.status || 'sent', enc: body.enc || '', mentions: body.mentions || [],
            mentionLabels: body.mentionLabels || {}, invite: body.invite || null, readAt: body.readAt || 0,
            hash: row.hash || '', once: !!row.once, edited: !!row.edited
        };
        const stored = prepareStoredMessage(msg, row.chat, row.crypto_group_id);
        Stmt.updateMessage.run(msg.kind, stored.data, msg.hash || null, msg.once ? 1 : 0,
            msg.edited ? 1 : 0, stored.cryptoVersion, stored.cryptoGroupId,
            stored.signature, stored.signingPublicKey, msg.id);
        reencrypted++;
    }

    // 2) El resto de contenido del usuario.
    for (const row of db.prepare('SELECT owner, peer, unread, last_data FROM summaries WHERE owner = ?').all(userId)) {
        const plain = decryptForUser(userId, row.last_data);
        if (plain === null) continue;
        Stmt.upsertSummary.run(row.owner, row.peer, row.unread, encryptWithNew(plain));
        reencrypted++;
    }
    for (const row of db.prepare('SELECT owner, gid, unread, last_data FROM group_summaries WHERE owner = ?').all(userId)) {
        const plain = decryptForUser(userId, row.last_data);
        if (plain === null) continue;
        Stmt.upsertGroupSummary.run(row.owner, row.gid, row.unread, encryptWithNew(plain));
        reencrypted++;
    }
    for (const row of db.prepare('SELECT user_id, data FROM user_notes WHERE user_id = ?').all(userId)) {
        const plain = decryptForUser(userId, row.data);
        if (plain === null) continue;
        db.prepare('UPDATE user_notes SET data = ? WHERE user_id = ?').run(encryptWithNew(plain), userId);
        reencrypted++;
    }
    for (const row of db.prepare('SELECT user_id, display_name, bio, note FROM user_profiles WHERE user_id = ?').all(userId)) {
        const name = decryptForUser(userId, row.display_name);
        const bio = decryptForUser(userId, row.bio);
        const note = decryptForUser(userId, row.note);
        if (name === null || bio === null || note === null) continue;
        db.prepare('UPDATE user_profiles SET display_name = ?, bio = ?, note = ? WHERE user_id = ?')
            .run(encryptWithNew(name), encryptWithNew(bio), encryptWithNew(note), userId);
        reencrypted++;
    }
    for (const row of db.prepare('SELECT id, owner, peer, ts, data FROM calls WHERE owner = ?').all(userId)) {
        const plain = decryptForUser(userId, row.data);
        if (plain === null) continue;
        db.prepare('UPDATE calls SET data = ? WHERE id = ? AND owner = ?').run(encryptWithNew(plain), row.id, userId);
        reencrypted++;
    }
    for (const row of db.prepare('SELECT user_id, endpoint, data FROM push_subs WHERE user_id = ?').all(userId)) {
        const plain = decryptForUser(userId, row.data);
        if (plain === null) continue;
        db.prepare('UPDATE push_subs SET data = ? WHERE user_id = ? AND endpoint = ?').run(encryptWithNew(plain), userId, row.endpoint);
        reencrypted++;
    }
    for (const row of db.prepare('SELECT from_id, ts, data FROM stories WHERE from_id = ?').all(userId)) {
        const plain = decryptForUser(userId, row.data);
        if (plain === null) continue;
        db.prepare('UPDATE stories SET data = ? WHERE from_id = ? AND ts = ?').run(encryptWithNew(plain), userId, row.ts);
        reencrypted++;
    }

    return { keyId: newKeyId, reencrypted };
}



/* Construye el objeto de cuenta en RAM a partir de una fila de `users`. */
function userFromRow(row) {
    return {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        passwordSalt: row.password_salt,
        publicKey: null,
        groupSeen: {},
        stickers: [],
        contacts: [],
        addPolicy: ['all', 'request', 'nobody'].includes(row.add_policy) ? row.add_policy : 'request',
        createdAt: row.created_at || 0,
        sockets: new Set(), online: false, lastSeen: row.last_seen || null
    };
}

/* Recupera una cuenta que existe en la base pero no estaba en RAM (por ejemplo
   tras un borrado a medias o si el proceso quedó desincronizado). La deja
   HIDRATADA COMPLETA, igual que en el arranque: un guardado posterior
   sobrescribiría en la base la privacidad y los silenciados si faltaran. */
function loadUserFromRow(row) {
    const acc = userFromRow(row);
    users.set(acc.id, acc);
    usernameIndex.set(acc.username, acc.id);
    hydrateUserFromDb(acc);
    return acc;
}

/* Busca una cuenta por nombre con la base como fuente de verdad y repara la
   caché en RAM si estaba sucia (esto es lo que permite borrar una cuenta y
   volver a registrarla con el mismo nombre sin reiniciar el servidor). */
function accountByName(name) {
    if (typeof name !== 'string' || !name) return undefined;
    const clean = name.trim().toLowerCase();
    const row = Stmt.getUserByName.get(clean);
    if (!row) {
        // Nombre libre: si el índice en RAM apuntaba a algo, está obsoleto.
        usernameIndex.delete(clean);
        return undefined;
    }
    let acc = users.get(row.id);
    if (!acc) acc = loadUserFromRow(row);
    if (usernameIndex.get(clean) !== row.id) {
        usernameIndex.delete(clean);
        usernameIndex.set(clean, row.id);
    }
    return acc;
}

/* Elimina de la RAM todo rastro de una cuenta (usada al borrar y al reparar). */
function purgeUserFromMemory(id, username) {
    const acc = users.get(id);
    if (acc) for (const s of [...(acc.sockets || [])]) { try { s.destroy(); } catch { } }
    users.delete(id);
    if (usernameIndex.get(username) === id) usernameIndex.delete(username);
    for (const [name, uuid] of [...usernameIndex]) if (uuid === id) usernameIndex.delete(name);
    delete profiles[username];
    delete notesMap[username];
    blockedSet.delete(username);
    callFiles.delete(username);
    pushSubs.delete(id);
    messageRateLimiter.delete(id);
    setStories(stories.filter(s => s.from !== username && s.fromId !== id));
    for (const [pk, c] of [...chatPageCache]) if (pk.includes(id)) chatPageCache.delete(pk);
    for (const [key, o] of pendingOffers) if (o.to === username || o.from === username || o.toId === id || o.fromId === id) pendingOffers.delete(key);
    // Quitar al usuario de los contactos/bloqueos de los demás (en RAM).
    for (const other of users.values()) {
        other.contacts = other.contacts.filter(cid => cid !== id);
        const set = blockedSet.get(other.username);
        if (set && set.delete(username)) profiles[other.username] && (profiles[other.username].blocked = [...set]);
    }
}

// Users — persistencia
function writeUserRows(user) {
    const profile = profiles[user.username] || {};
    const note = notesMap[user.username] || null;
    const exists = Stmt.getUserById.get(user.id);
    if (exists) Stmt.updateUser.run(
        user.username, user.passwordHash || '', user.passwordSalt || '',
        ['all', 'request', 'nobody'].includes(user.addPolicy) ? user.addPolicy : 'request',
        user.lastSeen || null, user.id
    );
    else Stmt.insertUser.run(
        user.id, user.username, user.passwordHash || '', user.passwordSalt || '',
        ['all', 'request', 'nobody'].includes(user.addPolicy) ? user.addPolicy : 'request',
        user.createdAt || Date.now(), user.lastSeen || null
    );
    const now = Date.now();
    Stmt.upsertProfile.run(
        user.id,
        // Nombre, bio y nota se cifran en reposo (el avatar no: es público
        // por definición).
        encryptForUser(user.id, typeof profile.name === 'string' && profile.name ? profile.name : user.username),
        typeof profile.avatar === 'string' ? profile.avatar : '',
        encryptForUser(user.id, typeof profile.desc === 'string' ? profile.desc : ''),
        encryptForUser(user.id, typeof profile.note === 'string' ? profile.note : ''),
        Number.isFinite(profile.noteTs) ? profile.noteTs : 0,
        now
    );
    if (user.publicKey && typeof user.publicKey === 'object')
        Stmt.upsertKey.run(user.id, encryptForUser(user.id, JSON.stringify(user.publicKey)), now);
    // Privacidad: se reemplaza el conjunto completo de reglas.
    Stmt.deletePrivacy.run(user.id);
    Stmt.deletePrivacyUsers.run(user.id);
    const privacy = profile.privacy;
    if (privacy && typeof privacy === 'object') {
        for (const [feature, rule] of Object.entries(privacy)) {
            if (!rule || typeof rule !== 'object') continue;
            const mode = rule.mode === 'all' ? 'server' : rule.mode;
            if (!['server', 'contacts', 'nobody', 'except', 'only'].includes(mode)) continue;
            Stmt.upsertPrivacy.run(user.id, feature, mode);
            const list = Array.isArray(rule.users) ? rule.users : [];
            list.forEach((name, index) => {
                if (typeof name !== 'string') return;
                Stmt.upsertPrivacyUser.run(user.id, feature, index, byName(name)?.id || null, name);
            });
        }
    }
    // Apariencia del chat
    const chat = profile.chatAppearance;
    if (chat && typeof chat === 'object' && !Array.isArray(chat)) {
        Stmt.upsertChatSettings.run(
            user.id, chat.wall || null,
            Number.isFinite(chat.opacity) ? chat.opacity : 30,
            Number.isFinite(chat.blur) ? chat.blur : 0,
            chat.sender || null, chat.receiver || null,
            chat.senderText || null, chat.receiverText || null,
            Number.isFinite(chat.fontSize) ? chat.fontSize : 15,
            chat.autoText === false ? 0 : 1,
            typeof chat.image === 'string' ? chat.image : '', now
        );
    }
    // Chats silenciados
    Stmt.deleteMutedPeers.run(user.id);
    for (const peer of Array.isArray(profile.mutedChatPeers) ? profile.mutedChatPeers : []) {
        if (typeof peer !== 'string' || !peer) continue;
        Stmt.insertMutedPeer.run(user.id, byName(peer)?.id || null, peer);
    }
    // Nota personal (estado)
    // La nota personal se cifra en reposo.
    if (note && typeof note === 'object') Stmt.upsertUserNote.run(user.id, encryptForUser(user.id, JSON.stringify(note)), note.ts || 0);
    else Stmt.deleteUserNote.run(user.id);
    // Stickers favoritos
    Stmt.deleteStickers.run(user.id);
    (Array.isArray(user.stickers) ? user.stickers : []).slice(-30).forEach((sticker, index) => {
        if (typeof sticker === 'string') Stmt.insertSticker.run(user.id, index, sticker);
    });
    // Grupos vistos
    Stmt.deleteGroupSeenByUser.run(user.id);
    const groupSeen = user.groupSeen && typeof user.groupSeen === 'object' ? user.groupSeen : {};
    for (const [gid, ts] of Object.entries(groupSeen)) {
        if (!Number.isFinite(ts)) continue;
        if (Stmt.groupExists.get(gid)) Stmt.upsertGroupSeen.run(user.id, gid, ts);
    }
}

/* Guardados quirúrgicos: los eventos triviales (visto de grupo, stickers,
 * mute, apariencia) escriben solo su tabla en lugar de reescribir las ~8
 * tablas de la cuenta. */
function saveStickers(user) {
    Stmt.deleteStickers.run(user.id);
    (Array.isArray(user.stickers) ? user.stickers : []).slice(-30).forEach((sticker, index) => {
        if (typeof sticker === 'string') Stmt.insertSticker.run(user.id, index, sticker);
    });
}
function saveMutedPeers(user, profile) {
    Stmt.deleteMutedPeers.run(user.id);
    for (const peer of Array.isArray(profile.mutedChatPeers) ? profile.mutedChatPeers : []) {
        if (typeof peer === 'string' && peer) Stmt.insertMutedPeer.run(user.id, byName(peer)?.id || null, peer);
    }
}
function saveChatSettings(user) {
    const chat = (profiles[user.username] || {}).chatAppearance;
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return;
    Stmt.upsertChatSettings.run(
        user.id, chat.wall || null,
        Number.isFinite(chat.opacity) ? chat.opacity : 30,
        Number.isFinite(chat.blur) ? chat.blur : 0,
        chat.sender || null, chat.receiver || null,
        chat.senderText || null, chat.receiverText || null,
        Number.isFinite(chat.fontSize) ? chat.fontSize : 15,
        chat.autoText === false ? 0 : 1,
        typeof chat.image === 'string' ? chat.image : '', Date.now()
    );
}

function saveUserToDb(user) {
    if (!user || !user.id || !user.username) return;
    if (db.inTransaction) writeUserRows(user);
    else tx.saveUser(user);
}

module.exports = {
    hydrateUserFromDb,
    loadFromDb,
    regenerateAuthKey,
    userFromRow,
    loadUserFromRow,
    accountByName,
    purgeUserFromMemory,
    writeUserRows,
    saveStickers,
    saveMutedPeers,
    saveChatSettings,
    saveUserToDb,
};

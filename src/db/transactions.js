/**
 * Transacciones y limpieza de adjuntos.
 *
 * Envuelve en transacciones las escrituras que deben ser atómicas (mensajes,
 * grupos, cuentas) y purga los blobs que se quedan sin referencia en la tabla
 * de permisos de descarga.
 */
'use strict';

const { blobDb, db } = require('./database.js');
const { deleteAccountRows, deleteGroupRows } = require('./schema.js');
const { Stmt } = require('./statements.js');

const stmtBlobHasReference = db.prepare('SELECT 1 FROM blob_access WHERE hash = ? LIMIT 1');
const stmtBlobRemove = blobDb.prepare('DELETE FROM blobs WHERE hash = ?');
function pruneBlobHashes(hashes) {
    // Sentencias preparadas una vez: better-sqlite3 no cachea db.prepare, así
    // que recompilarlas en cada borrado de mensaje o historia costaría una
    // compilación por operación.
    for (const hash of new Set(hashes))
        if (!stmtBlobHasReference.get(hash)) stmtBlobRemove.run(hash);
}

const blobAccessWhereCache = new Map();
function removeBlobAccess(where, ...values) {
    // Cada variante de `where` se compila una sola vez y se reutiliza.
    let pair = blobAccessWhereCache.get(where);
    if (!pair) {
        pair = {
            hashes: db.prepare(`SELECT DISTINCT hash FROM blob_access WHERE ${where}`).pluck(),
            del: db.prepare(`DELETE FROM blob_access WHERE ${where}`)
        };
        blobAccessWhereCache.set(where, pair);
    }
    const hashes = pair.hashes.all(...values);
    pair.del.run(...values);
    return hashes;
}

// Borrado en cascada
// Las reglas viven en src/db/schema.js (SQL puro, cubierto por los
// tests). Aquí solo se envuelven en transacciones.
const tx = {
    sendMessage: db.transaction((msg, location, cryptoGroupId = null) => {
        // Require perezoso: evita un ciclo entre modulos.
        const { prepareStoredMessage } = require('../chat/messages.js');
        const stored = prepareStoredMessage(msg, location, cryptoGroupId);
        Stmt.insertMessage.run(
            msg.id, location, msg.ts, msg.fromId, msg.toId || null,
            msg.kind, stored.data, msg.hash || null, msg.once ? 1 : 0, msg.edited ? 1 : 0,
            stored.cryptoVersion, stored.cryptoGroupId, stored.signature, stored.signingPublicKey
        );
        const hashes = [msg.hash, ...(msg.gallery || []).map(g => g.hash)].filter(Boolean);
        for (const hash of hashes) {
            if (location.startsWith('chat:')) {
                const [a, b] = location.slice(5).split('__');
                Stmt.insertBlobAccessChat.run(hash.toLowerCase(), msg.id, 'chat', a, b);
            } else if (location.startsWith('group:')) {
                Stmt.insertBlobAccessGroup.run(hash.toLowerCase(), msg.id, 'group', location.slice(6));
            }
        }
    }),
    deleteMessage: db.transaction(msgId => {
        const hashes = Stmt.getBlobHashesByMessage.pluck().all(msgId);
        Stmt.deleteBlobAccessByMessage.run(msgId);
        Stmt.deleteMessage.run(msgId);
        return hashes;
    }),
    markSeenMessage: db.transaction((message, row) => {
        const hashes = Stmt.getBlobHashesByMessage.pluck().all(message.id);
        Stmt.deleteBlobAccessByMessage.run(message.id);
        const { updateStoredMessage } = require('../chat/messages.js');
        updateStoredMessage(message, row);
        return hashes;
    }),
    deleteGroup: db.transaction(gid => deleteGroupRows(db, gid)),
    deleteAccount: db.transaction((userId, username) => deleteAccountRows(db, userId, username)),
    // Vaciar un chat para los dos: se borran sus mensajes de verdad.
    clearChatMessages: db.transaction(chatKey => {
        const { deleteMessageRowsWhere } = require('../db/schema.js');
        return deleteMessageRowsWhere(db, 'chat = ?', chatKey);
    }),
    // Borrado de varias conversaciones a la vez: todo o nada.
    // keepSummary = "vaciar chat": se ocultan los mensajes pero la
    // conversacion sigue en la lista.
    deleteChats: db.transaction((userId, chats, now, keepSummary = false) => {
        const { Stmt } = require('../db/statements.js');
        for (const chat of chats) {
            Stmt.insertChatDeletion.run(chat.chatId, userId, now);
            if (!keepSummary) Stmt.deleteSummary.run(userId, chat.peerId);
        }
    }),
    // Preferencias de la lista de chats: un bloque de cambios (fijado,
    // silencio, no leído) se aplica TODO o NADA, en una sola transacción.
    applyChatPrefs: db.transaction((userId, updates) => {
        const { Stmt } = require('../db/statements.js');
        const now = Date.now();
        for (const update of updates) {
            if (typeof update.pinned === 'boolean' || typeof update.unread === 'boolean' || typeof update.archived === 'boolean') {
                const current = Stmt.getChatPref.get(userId, update.key);
                const pinnedAt = typeof update.pinned === 'boolean'
                    ? (update.pinned ? now : 0)
                    : Number(current && current.pinned_at) || 0;
                const unread = typeof update.unread === 'boolean'
                    ? (update.unread ? 1 : 0)
                    : Number(current && current.unread) || 0;
                const archived = typeof update.archived === 'boolean'
                    ? (update.archived ? 1 : 0)
                    : Number(current && current.archived) || 0;
                if (!pinnedAt && !unread && !archived) Stmt.deleteChatPref.run(userId, update.key);
                else Stmt.upsertChatPref.run(userId, update.key, pinnedAt, unread, archived, now);
            }
            if (typeof update.muted === 'boolean') {
                if (update.muted) Stmt.insertMutedPeer.run(userId, update.peerId || null, update.peerName);
                else Stmt.deleteMutedPeer.run(userId, update.peerName);
            }
        }
    }),
    // Require perezoso: evita un ciclo entre modulos.
    saveUser: db.transaction(user => require('../users/store.js').writeUserRows(user))
};

module.exports = {
    stmtBlobHasReference,
    stmtBlobRemove,
    pruneBlobHashes,
    blobAccessWhereCache,
    removeBlobAccess,
    tx,
};

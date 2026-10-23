/**
 * Resúmenes de conversación.
 *
 * Cada resumen guarda el último mensaje de un chat 1:1 para las listas de
 * conversaciones: se cifra con la clave del usuario dueño del resumen y los
 * nombres de los interlocutores se resuelven desde el estado en memoria.
 */
'use strict';

const { findMessage, rowToMessage } = require('./messages.js');
const { decryptForUser, encryptForUser } = require('../crypto/setup.js');
const { Stmt } = require('../db/statements.js');
const { users } = require('../state.js');

// Resúmenes de chat (1:1)
function resolveName(id) {
    if (!id) return 'eliminado';
    const u = users.get(id);
    return (u && u.username) || 'eliminado';
}

function decorateForClient(m) {
    if (!m || typeof m !== 'object') return m;
    const out = { ...m };
    if (out.fromId) out.from = resolveName(out.fromId);
    if (out.toId) out.to = resolveName(out.toId);
    if (out.reply && typeof out.reply === 'object') {
        out.reply = { ...out.reply };
        if (out.reply.fromId) out.reply.from = resolveName(out.reply.fromId);
    }
    return out;
}

function readSummaryEntry(owner, peer) {
    const row = Stmt.getSummary.get(owner, peer);
    if (!row) return null;
    let last = null;
    // La copia de resumen se guarda cifrada con la clave del usuario: si no,
    // expondría en claro los primeros 200 caracteres del mensaje. Se tolera
    // el formato antiguo sin migrar.
    try { const raw = row.last_data ? decryptForUser(owner, row.last_data) : null; last = raw ? JSON.parse(raw) : null; } catch { }
    return { peerId: peer, peer: resolveName(peer), unread: row.unread, last };
}

function writeSummaryEntry(owner, peer, entry) {
    Stmt.upsertSummary.run(owner, peer, entry.unread || 0, encryptForUser(owner, JSON.stringify(entry.last || null)));
}

/* El resumen es una CACHÉ del último mensaje. Si su copia cifrada quedó
   ilegible —una rotación de clave anterior a que la rotación re-cifrara esta
   tabla, o una fila corrupta—, se reconstruye desde el propio mensaje, que sí
   se descifra. Se reescribe para no repetirlo, y así el chat vuelve a tener
   vista previa y su fecha real en la lista (orden incluido). */
function healSummary(owner, peerId, unread = 0) {
    const row = Stmt.lastMessage.get('chat:' + [owner, peerId].sort().join('__'));
    const last = row ? lastEntryFromMsg(rowToMessage(row) || {}) : null;
    if (!last || !last.id) return null;
    writeSummaryEntry(owner, peerId, { unread: unread || 0, last });
    return last;
}

function lastEntryFromMsg(msg) {
    return {
        id: msg.id, prevId: null, kind: msg.kind,
        from: resolveName(msg.fromId), fromId: msg.fromId || '',
        ts: msg.ts, status: msg.status || 'sent', once: !!msg.once,
        text: msg.kind === 'text' && !msg.once ? String(msg.data || '').slice(0, 200) : ''
    };
}

function onMessageSentSummary(msg) {
    const pairs = [
        { owner: msg.toId, peerId: msg.fromId },
        { owner: msg.fromId, peerId: msg.toId }
    ];
    for (const { owner, peerId } of pairs) {
        if (!owner || !peerId) continue;
        const entry = readSummaryEntry(owner, peerId) || { peerId, peer: resolveName(peerId), unread: 0, last: null };
        const nuevaLast = lastEntryFromMsg(msg);
        if (entry.last && entry.last.id) nuevaLast.prevId = entry.last.id;
        entry.last = nuevaLast;
        if (owner === msg.toId && msg.status !== 'read') entry.unread = (entry.unread || 0) + 1;
        writeSummaryEntry(owner, peerId, entry);
        // Un mensaje nuevo deja de estar marcado a mano como "no leído".
        if (owner === msg.toId) clearUnreadFlag(owner, 'dm:' + resolveName(peerId));
    }
}

/* Quita la marca de "no leído" de una conversación. */
function clearUnreadFlag(userId, peerKey) {
    // Require perezoso: evita un ciclo entre módulos.
    const { setUnreadFlag } = require('./prefs.js');
    try { setUnreadFlag(userId, peerKey, false); } catch { }
}

function onReadSummary(owner, peer) {
    const entry = readSummaryEntry(owner, peer);
    if (!entry) return;
    entry.unread = 0;
    writeSummaryEntry(owner, peer, entry);
}

/* Tras borrar un mensaje, el resumen de la conversación deja de apuntar a el.
   `onlyOwner` (borrado "para mi") actualiza solo el resumen de quien lo
   pidio: el autor conserva su copia del mensaje. */
function onMessageDeletedSummary(msg, onlyOwner = '') {
    const pairs = [
        { owner: msg.toId, peerId: msg.fromId },
        { owner: msg.fromId, peerId: msg.toId }
    ];
    for (const { owner, peerId } of pairs) {
        if (!owner || !peerId) continue;
        if (onlyOwner && owner !== onlyOwner) continue;
        const entry = readSummaryEntry(owner, peerId);
        if (!entry || !entry.last || entry.last.id !== msg.id) continue;
        // El mensaje borrado ya no se cuenta como pendiente de leer.
        if (entry.unread > 0) entry.unread -= 1;
        if (entry.last.prevId) {
            const prev = findMessage(entry.last.prevId);
            if (prev) { entry.last = lastEntryFromMsg(prev); entry.last.prevId = null; }
            else entry.last = null;
        } else entry.last = null;
        writeSummaryEntry(owner, peerId, entry);
    }
}

function onChatDeletedSummary(a, b) {
    // Solo se borra el resumen de quien pidió el borrado: el otro
    // interlocutor conserva su conversación.
    Stmt.deleteSummary.run(a, b);
}

function renamePeerInSummaries(owner, peer, newName) {
    const entry = readSummaryEntry(owner, peer);
    if (!entry) return;
    entry.peer = newName;
    writeSummaryEntry(owner, peer, entry);
}

module.exports = {
    resolveName,
    decorateForClient,
    readSummaryEntry,
    writeSummaryEntry,
    lastEntryFromMsg,
    onMessageSentSummary,
    onReadSummary,
    onMessageDeletedSummary,
    onChatDeletedSummary,
    renamePeerInSummaries,
    healSummary,
};

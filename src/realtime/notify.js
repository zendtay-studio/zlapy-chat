/**
 * Envío de mensajes a los clientes.
 *
 * Escribe frames WebSocket a las conexiones de cada cuenta, mantiene las
 * listas de usuarios y contactos, y reparte las historias solo a quien puede
 * verlas según su privacidad.
 */
'use strict';

const { CONFIG } = require('../config.js');
const { Stmt } = require('../db/statements.js');
const { profiles, stories, users } = require('../state.js');
const { byName, uniq } = require('../users/helpers.js');
const { isBlockedBy, permite } = require('../users/privacy.js');
const { sealFrame } = require('./encrypted.js');

// WebSocket — frames y push
const WS_MAX_PER_USER = 8;          // conexiones simultáneas por cuenta
const WS_FRAME_RATE = 200;          // frames/s sostenidos por conexión
const WS_FRAME_BURST = 600;         // ráfaga inicial del token bucket
const WS_MAX_BACKLOG_BYTES = 1024 * 1024; // 1 MB pendiente antes de cortar a un cliente lento
/* Cabecera de frame de texto del servidor → cliente. */
function textFrameHead(len) {
    let head;
    if (len < 126) head = Buffer.from([0x81, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    return head;
}
function wsSend(socket, obj) {
    if (socket.destroyed) return;
    // Backpressure: un receptor lento no puede acumular escrituras sin límite.
    if (socket.writableLength > WS_MAX_BACKLOG_BYTES) { try { socket.destroy(); } catch { } return; }
    // Con sesión cifrada el frame va envuelto; sin ella, en claro.
    const text = JSON.stringify(obj);
    const payload = Buffer.from(sealFrame(socket, text) || text);
    socket.write(Buffer.concat([textFrameHead(payload.length), payload]));
}
/* Push de un payload YA serializado: el fan-out a grupos no vuelve a
 * serializar el mismo mensaje por cada miembro. */
function pushRawName(username, raw) {
    const u = byName(username);
    if (!u || !u.sockets) return;
    for (const s of [...u.sockets]) {
        if (s.destroyed) continue;
        if (s.writableLength > WS_MAX_BACKLOG_BYTES) { try { s.destroy(); } catch { } continue; }
        const payload = Buffer.from(sealFrame(s, raw) || raw);
        s.write(Buffer.concat([textFrameHead(payload.length), payload]));
    }
}
// Una cuenta puede tener varias conexiones a la vez (móvil + PC): el push
// se entrega en TODAS sus sockets.
const push = (u, obj) => { if (!u || !u.sockets) return; for (const s of [...u.sockets]) wsSend(s, obj); };
const pushName = (username, obj) => push(byName(username), obj);

function userList(viewerId) {
    const viewer = users.get(viewerId);
    if (!viewer) return [];
    const out = [{ id: viewer.id, username: viewer.username, online: !!viewer.online, lastSeen: viewer.lastSeen }];
    for (const id of viewer.contacts) {
        if (id === viewer.id) continue;
        const u = users.get(id);
        if (!u) continue;
        if (isBlockedBy(profiles[u.username], viewer.username)) continue;
        out.push({ id: u.id, username: u.username, online: !!u.online, lastSeen: u.lastSeen });
    }
    return out;
}
function broadcastUsersAround(uuid) {
    const targets = new Set([uuid]);
    const contacts = Stmt.listContacts.all(uuid);
    for (const c of contacts) targets.add(c.contact);
    const owners = Stmt.listOwnersByContact.all(uuid);
    for (const o of owners) targets.add(o.owner);
    for (const id of targets) {
        const v = users.get(id);
        if (v && v.online) push(v, { type: 'users', users: userList(id) });
    }
}
function broadcastUsers() {
    for (const u of users.values()) if (u.online) push(u, { type: 'users', users: userList(u.id) });
}
const updateContactRequests = user => {
    const count = Stmt.listContactRequestsTo.all(user.id).length;
    const sentCount = Stmt.listContactRequestsFrom.all(user.id).length;
    push(user, { type: 'contact-requests', count, sentCount });
};

function connectContacts(a, b) {
    // Require perezoso: evita un ciclo entre modulos.
    const { saveUserToDb } = require('../users/store.js');
    Stmt.insertContact.run(a.id, b.id);
    Stmt.insertContact.run(b.id, a.id);
    Stmt.deleteContactRequest.run(a.id, b.id);
    Stmt.deleteContactRequest.run(b.id, a.id);
    a.contacts = uniq([...a.contacts, b.id]);
    b.contacts = uniq([...b.contacts, a.id]);
    saveUserToDb(a); saveUserToDb(b);
    updateContactRequests(a); updateContactRequests(b);
    broadcastUsersAround(a.id); broadcastUsersAround(b.id);
}
function removeContacts(a, b) {
    // Require perezoso: evita un ciclo entre modulos.
    const { saveUserToDb } = require('../users/store.js');
    Stmt.deleteContact.run(a.id, b.id);
    Stmt.deleteContact.run(b.id, a.id);
    Stmt.deleteContactRequest.run(a.id, b.id);
    Stmt.deleteContactRequest.run(b.id, a.id);
    a.contacts = a.contacts.filter(id => id !== b.id);
    b.contacts = b.contacts.filter(id => id !== a.id);
    saveUserToDb(a); saveUserToDb(b);
    updateContactRequests(a); updateContactRequests(b);
    broadcastUsersAround(a.id); broadcastUsersAround(b.id);
}

const liveStories = () => {
    const now = Date.now();
    return stories.filter(s => now - s.ts < CONFIG.storyTtlMs);
};
const storyForViewer = (s, username) => {
    if (s.from === username) return s;
    const { viewers, likes, keys, ...story } = s;
    story.keybox = (keys || []).find(k => k.to === username) || null;
    return { ...story, liked: (likes || []).includes(username) };
};
function pushStories() {
    const live = liveStories();
    for (const u of users.values()) {
        if (!u.online) continue;
        const list = live.filter(s => permite(profiles[s.from], 'historias', u.username))
            .map(s => storyForViewer(s, u.username));
        push(u, { type: 'stories', stories: list });
    }
}

module.exports = {
    WS_MAX_PER_USER,
    WS_FRAME_RATE,
    WS_FRAME_BURST,
    WS_MAX_BACKLOG_BYTES,
    textFrameHead,
    wsSend,
    pushRawName,
    push,
    pushName,
    userList,
    broadcastUsersAround,
    broadcastUsers,
    updateContactRequests,
    connectContacts,
    removeContacts,
    liveStories,
    storyForViewer,
    pushStories,
};

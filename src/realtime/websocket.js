/**
 * Servidor WebSocket.
 *
 * Gestiona el upgrade a WebSocket, autentica la sesión, reparte los frames
 * entre las conexiones de cada cuenta y limita el tráfico entrante para que
 * un cliente no pueda acaparar el proceso. También mantiene las tareas
 * periódicas de limpieza (historias, sesiones y notas caducadas).
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const { getSessionFromCache, hashSessionToken, originAllowed, sessionCookie } = require('../auth/sessions.js');
const { addCall, endUserCalls, hasCall, updateCall } = require('../calls/store.js');
const { CONFIG } = require('../config.js');
const { db } = require('../db/database.js');
const { Stmt } = require('../db/statements.js');
const { pruneBlobHashes, removeBlobAccess } = require('../db/transactions.js');
const { readGroup } = require('../groups/store.js');
const { loginAttempts, registerAttempts } = require('../http/rate-limit.js');
const { notifyUser, pushNameOf } = require('../push/vapid.js');
const { MAX_BUFFER_BYTES, closeFrame, parseFrames } = require('./frames.js');
const { acceptHandshake, openFrame } = require('./encrypted.js');
const { WS_FRAME_BURST, WS_FRAME_RATE, WS_MAX_PER_USER, broadcastUsersAround, liveStories, push, pushName, pushStories, storyForViewer, updateContactRequests, userList, wsSend } = require('./notify.js');
const { MESSAGE_LIMITS, characterCount } = require('../shared/limits.js');
const { NOTE_TTL, validAvatar } = require('../shared/validation.js');
const { callFiles, notesMap, pendingOffers, profiles, sessionCache, stories, users, setStories } = require('../state.js');
const { byId, byName } = require('../users/helpers.js');
const { isBlockedBy, normPriv, permite } = require('../users/privacy.js');
const { loadUserFromRow, saveUserToDb } = require('../users/store.js');


// WebSocket upgrade
// Responder antes de destruir: un rechazo silencioso deja el endpoint sin
// prueba posible.
const rejectUpgrade = (socket, code, message) => {
    try {
        socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch { }
    try { socket.destroy(); } catch { }
};
const wsUpgradeInner = (req, socket) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
    if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');
    // Handshake: validar lo mínimo que exige RFC 6455 antes de responder 101.
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
        req.headers['sec-websocket-version'] !== '13' ||
        typeof req.headers['sec-websocket-key'] !== 'string' || !req.headers['sec-websocket-key'])
        return rejectUpgrade(socket, 400, 'Bad WebSocket Handshake');
    const token = sessionCookie(req);
    const s = token ? getSessionFromCache(hashSessionToken(token)) : null;
    let u = s && s.expiresAt > Date.now() ? users.get(s.userId) : null;
    if (s && !u) {
        const row = Stmt.getUserById.get(s.userId);
        if (row) u = loadUserFromRow(row);
    }
    if (!u) return rejectUpgrade(socket, 401, 'Unauthorized');
    socket.authToken = token;
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    // Una cuenta puede tener varias conexiones (móvil + PC). Con cap por
    // cuenta: la más antigua se corta si se supera, así nunca quedan sockets
    // huérfanos fuera del control del heartbeat.
    while (u.sockets.size >= WS_MAX_PER_USER) {
        const oldest = u.sockets.values().next().value;
        u.sockets.delete(oldest);
        try { oldest.destroy(); } catch { }
    }
    u.sockets.add(socket);
    u.online = true;
    u.lastSeen = null;
    u.lastHeartbeat = Date.now();
    broadcastUsersAround(u.id);
    push(u, { type: 'users', users: userList(u.id) });
    updateContactRequests(u);
    push(u, { type: 'stories', stories: liveStories().filter(x => permite(profiles[x.from], 'historias', u.username)).map(x => storyForViewer(x, u.username)) });
    for (const [k, o] of [...pendingOffers]) {
        if (o.to === u.username && Date.now() - o.ts < 30000) { pendingOffers.delete(k); push(u, { type: 'call-incoming', from: o.from, video: o.video, callId: o.callId }); }
        else if (o.to === u.username) pendingOffers.delete(k);
    }

    let buf = Buffer.alloc(0);
    socket.lastSeen = Date.now();
    socket.wsTokens = WS_FRAME_BURST;
    socket.wsRefill = Date.now();
    socket.on('data', d => {
        buf = Buffer.concat([buf, d]);
        socket.lastSeen = Date.now();
        // Tope de buffer entrante: un frame declarado gigante no puede agotar
        // la memoria del proceso.
        if (buf.length > MAX_BUFFER_BYTES) {
            socket.wsKilled = true; // el resto del buffer ya no se procesa
            try { socket.write(closeFrame(1009, 'buffer excedido')); } catch { }
            try { socket.end(); } catch { }
            const backstop = setTimeout(() => { try { socket.destroy(); } catch { } }, 2000);
            backstop.unref?.();
            return;
        }
        buf = parseFrames(socket, buf, text => {
            if (socket.wsKilled) return; // ya cerrado por flood: ignorar el resto
            // Token bucket por conexión: un flood de frames no puede acaparar
            // el relay ni inundar a otros usuarios.
            const nowT = Date.now();
            socket.wsTokens = Math.min(WS_FRAME_BURST, socket.wsTokens + ((nowT - socket.wsRefill) / 1000) * WS_FRAME_RATE);
            socket.wsRefill = nowT;
            if (--socket.wsTokens < 0) {
                socket.wsKilled = true; // sin más writes: un end() posterior rompería la cola
                try { socket.write(closeFrame(1008, 'demasiados mensajes')); } catch { }
                try { socket.end(); } catch { }
                const backstop = setTimeout(() => { try { socket.destroy(); } catch { } }, 2000);
                backstop.unref?.();
                return;
            }
            // Canal cifrado: el primer frame es el saludo en claro con la clave
            // pública efímera; a partir de ahí todo llega envuelto.
            let m;
            if (socket.zlapy) {
                m = openFrame(socket, text);
            } else {
                let parsed; try { parsed = JSON.parse(text); } catch { return; }
                if (parsed && parsed.type === 'enc') {
                    if (acceptHandshake(socket, parsed.ephemeral)) wsSend(socket, { type: 'enc-ok' });
                    return;
                }
                m = parsed;
            }
            if (!m || !m.type) return;
            const from = u.username;
            // Los identificadores que llegan del cliente se usan como claves de
            // consultas y de mensajes: si no son cadenas se descartan aquí,
            // antes de que lleguen a la base de datos.
            if (m.to !== undefined && typeof m.to !== 'string') return;
            if (m.callId !== undefined && typeof m.callId !== 'string') return;
            if (m.groupId !== undefined && typeof m.groupId !== 'string') return;
            // Todo el manejo del frame va dentro de un try/catch: un mensaje
            // malformado (un campo con el tipo equivocado, por ejemplo) solo
            // puede cerrar ESTA conexión, nunca el proceso compartido con el
            // resto de usuarios.
            try {

            if (m.type === 'call-offer') {
                const target = typeof m.to === 'string' ? byName(m.to) : null;
                if (!target || typeof m.callId !== 'string' || !m.callId || m.callId.length > 128) return;
                const targetP = profiles[m.to];
                if (isBlockedBy(targetP, from)) { updateCall(from, m.callId, { state: 'blocked' }); pushName(from, { type: 'call-blocked', from: m.to, callId: m.callId }); return; }
                if (isBlockedBy(profiles[from], m.to)) { push(from, { type: 'call-blocked', from: m.to, callId: m.callId }); return; }
                if (!permite(targetP, 'llamadas', from)) { updateCall(from, m.callId, { state: 'denied' }); push(from, { type: 'call-denied', from: m.to, callId: m.callId }); return; }
                const rec = addCall(from, { id: m.callId, peer: m.to, dir: 'out', video: !!m.video, state: 'calling' });
                addCall(m.to, { id: m.callId, peer: from, dir: 'in', video: !!m.video, state: 'calling' });
                pushName(m.to, { type: 'call-incoming', from, video: !!m.video, callId: m.callId });
                push(from, { type: 'call-log', call: rec });
                if (!target.online) {
                    pendingOffers.set(m.to + ':' + m.callId, { to: m.to, from, video: !!m.video, callId: m.callId, ts: Date.now() });
                    notifyUser(m.to, { title: (m.video ? 'Videollamada de ' : 'Llamada de ') + pushNameOf(from), body: m.video ? 'Videollamada' : 'Llamada', tag: 'call-' + m.callId, renotify: true, requireInteraction: true, url: '/?open=' + encodeURIComponent(from) });
                }
                setTimeout(() => {
                    pendingOffers.delete(m.to + ':' + m.callId);
                    const list = callFiles.get(from) || [];
                    if (list.some(c => c.id === m.callId && c.state === 'calling')) {
                        updateCall(from, m.callId, { state: 'missed' });
                        updateCall(m.to, m.callId, { state: 'missed' });
                        pushName(m.to, { type: 'call-missed', from, callId: m.callId });
                        push(from, { type: 'call-missed', from: m.to, callId: m.callId });
                    }
                }, 30000);
                return;
            }
            if (m.type === 'call-busy') {
                if (!hasCall(from, m.to, m.callId)) return;
                updateCall(from, m.callId, { state: 'busy' });
                pushName(m.to, { type: 'call-busy', from, callId: m.callId });
                return;
            }
            if (m.type === 'typing' || m.type === 'recording') {
                if (typeof m.to !== 'string' || !byName(m.to) || !permite(profiles[m.to], 'mensajes', from) ||
                    isBlockedBy(profiles[m.to], from) || isBlockedBy(profiles[from], m.to)) return;
                pushName(m.to, { type: m.type, from, on: !!m.on });
                return;
            }
            if (m.type === 'group-typing' || m.type === 'group-recording') {
                // El id de grupo lo elige el cliente: si no es una cadena, se
                // descarta antes de tocar la base, donde una consulta SQL
                // lanzaría una excepción.
                if (typeof m.groupId !== 'string' || !m.groupId) return;
                const g = readGroup(m.groupId);
                if (!g || !g.memberIds.includes(u.id)) return;
                const evt = m.type === 'group-typing' ? 'typing' : 'recording';
                for (const mem of g.members) if (mem !== from) pushName(mem, { type: evt, from, on: !!m.on, group: true, groupId: g.id });
                return;
            }
            if (m.type === 'privacy') {
                const p = profiles[from] = profiles[from] || { username: from };
                // La privacidad se FUSIONA, no se reemplaza: un mensaje que
                // solo trae el nombre (sin la matriz completa) no debe
                // reiniciar toda la configuración a los valores por defecto,
                // que son más permisivos (foto y descripción para cualquiera).
                if (m.privacy && typeof m.privacy === 'object' && !Array.isArray(m.privacy)) {
                    const current = normPriv(p.privacy);
                    const incoming = normPriv(m.privacy);
                    const merged = {};
                    for (const key of Object.keys(current)) {
                        merged[key] = Object.prototype.hasOwnProperty.call(m.privacy, key) ? incoming[key] : current[key];
                    }
                    p.privacy = merged;
                }
                if (typeof m.name === 'string' && m.name.length <= 64) p.name = m.name;
                            if (typeof m.note === 'string' && m.note.length <= 500 && m.note !== p.note) {
                    p.note = m.note;
                    p.noteTs = m.note ? Date.now() : 0;
                    // Una sola fuente de verdad: la nota también vive en
                    // notesMap (lo que leen los demás y lo que persiste).
                    if (m.note) notesMap[from] = { ...(notesMap[from] || {}), text: m.note, ts: p.noteTs };
                    else delete notesMap[from];
                }
                if (typeof m.desc === 'string' && characterCount(m.desc, MESSAGE_LIMITS.profileDescriptionCharacters) <= MESSAGE_LIMITS.profileDescriptionCharacters) p.desc = m.desc;
                if (validAvatar(m.avatar)) p.avatar = m.avatar;
                saveUserToDb(u);
                for (const user of users.values()) push(user, { type: 'profile', username: from });
                return;
            }
            if (m.type === 'call-accept') {
                if (!hasCall(from, m.to, m.callId)) return;
                pendingOffers.delete(m.to + ':' + m.callId);
                updateCall(from, m.callId, { state: 'active' });
                updateCall(m.to, m.callId, { state: 'active' });
                pushName(m.to, { type: 'call-accepted', from, callId: m.callId });
                return;
            }
            if (m.type === 'call-reject' || m.type === 'call-cancel' || m.type === 'call-end') {
                if (!hasCall(from, m.to, m.callId)) return;
                pendingOffers.delete(m.to + ':' + m.callId);
                const state = m.type === 'call-reject' ? 'rejected' : m.type === 'call-cancel' ? 'cancelled' : 'ended';
                const relay = m.type === 'call-reject' ? 'call-rejected' : m.type === 'call-cancel' ? 'call-cancelled' : 'call-ended';
                updateCall(from, m.callId, { state });
                updateCall(m.to, m.callId, { state: m.type === 'call-reject' ? 'missed' : state });
                pushName(m.to, { type: relay, from, callId: m.callId });
                return;
            }
            if (m.type === 'call-sdp' || m.type === 'call-ice' || m.type === 'call-mute') {
                if (!hasCall(from, m.to, m.callId)) return;
                if (isBlockedBy(profiles[from], m.to) || isBlockedBy(profiles[m.to], from)) return;
                pushName(m.to, { type: m.type, from, callId: m.callId, sdp: m.sdp, candidate: m.candidate, muted: !!m.muted });
                return;
            }
            if (m.type === 'ping') {
                socket.lastSeen = Date.now();
                push(u, { type: 'pong', ts: Date.now() });
                return;
            }
            } catch (error) {
                // Un frame malformado no puede tumbar el proceso compartido: se
                // cierra SOLO esta conexión.
                console.error('[ws] error al procesar un mensaje:', error && error.message);
                try { socket.write(closeFrame(1011, 'error interno')); } catch { }
                try { socket.destroy(); } catch { }
            }
        });
    });
    socket.on('close', () => {
        u.sockets.delete(socket);
        if (u.sockets.size) return; // le quedan otras conexiones abiertas
        u.online = false; u.lastHeartbeat = 0; u.lastSeen = Date.now();
        // En la desconexión solo cambia la última vez visto.
        try { Stmt.touchUser.run(u.lastSeen, u.id); } catch (error) { console.error('[seen]', error.message); }
        // Sus llamadas vivas se cierran y se avisa a la contraparte.
        try { endUserCalls(u.username); } catch (error) { console.error('[calls]', error.message); }
        broadcastUsersAround(u.id);
    });
    socket.on('error', () => { try { socket.destroy(); } catch { } });
};
const wsUpgrade = (req, socket) => {
    try { wsUpgradeInner(req, socket); }
    catch (err) { console.error('[ws] error en upgrade:', err); try { socket.destroy(); } catch { } }
};

// Heartbeat: cierra conexiones colgadas (por socket, no por cuenta)
setInterval(() => {
    const now = Date.now();
    for (const u of users.values())
        for (const s of [...u.sockets])
            if (now - (s.lastSeen || 0) > 90000) { try { s.destroy(); } catch { } }
}, 15000).unref();

// Limpieza de historias expiradas
setInterval(() => {
    const cutoff = Date.now() - CONFIG.storyTtlMs;
    const before = stories.length;
    setStories(stories.filter(s => s.ts > cutoff));
    if (stories.length !== before) pushStories();
    const expired = db.prepare('SELECT from_id, ts FROM stories WHERE ts <= ?').all(cutoff);
    const removedHashes = db.transaction(() => {
        const hashes = [];
        for (const story of expired)
            hashes.push(...removeBlobAccess("kind = 'story' AND story_user = ? AND message_id = ?",
                story.from_id, `story:${story.from_id}:${story.ts}`));
        Stmt.deleteExpiredStories.run(cutoff);
        return hashes;
    })();
    pruneBlobHashes(removedHashes);
}, 60000).unref();

// Limpieza de sesiones expiradas y de los mapas de intentos (una vez cada 10 min)
setInterval(() => {
    try { Stmt.deleteExpiredSessions.run(Date.now()); } catch { }
    const now = Date.now();
    for (const [key, entry] of [...loginAttempts]) if (entry.until <= now) loginAttempts.delete(key);
    for (const [key, entry] of [...registerAttempts]) if (entry.until <= now) registerAttempts.delete(key);
    for (const [hash, session] of [...sessionCache]) if (session.expiresAt <= now) sessionCache.delete(hash);
}, 600000).unref();

// Limpieza de notas personales caducadas: la caducidad (24 h) se aplica
// también al almacenamiento, para que la nota caducada no siga en la base
// (ni en el perfil) indefinidamente.
setInterval(() => {
    try {
        const cutoff = Date.now() - NOTE_TTL;
        const expired = db.prepare('SELECT user_id FROM user_notes WHERE ts < ?').all(cutoff);
        for (const row of expired) {
            const user = byId(row.user_id);
            if (user) delete notesMap[user.username];
            const profile = user ? profiles[user.username] : null;
            if (profile && profile.noteTs && Date.now() - profile.noteTs >= NOTE_TTL) {
                profile.note = '';
                profile.noteTs = 0;
            }
        }
        db.prepare('DELETE FROM user_notes WHERE ts < ?').run(cutoff);
        db.prepare('UPDATE user_profiles SET note = ?, note_ts = 0 WHERE note_ts > 0 AND note_ts < ?').run('', cutoff);
    } catch (error) {
        console.error('[notes] limpieza de notas caducadas:', error.message);
    }
}, 10 * 60 * 1000).unref();

module.exports = {
    rejectUpgrade,
    wsUpgradeInner,
    wsUpgrade,
};

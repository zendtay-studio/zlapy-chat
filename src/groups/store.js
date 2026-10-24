/**
 * Grupos.
 *
 * Guarda los grupos (miembros, políticas, invitaciones) y el material de
 * cifrado extremo a extremo de cada uno. `readGroup` normaliza y cachea el
 * grupo en memoria; `pub` decide qué campos ve cada usuario según sea admin o
 * no, y el resumen por grupo lleva la cuenta de no leídos.
 */
'use strict';

const crypto = require('crypto');
const { rowToMessage } = require('../chat/messages.js');
const { decorateForClient, resolveName } = require('../chat/summaries.js');
const { decryptAtRest, decryptForUser, encryptAtRest, encryptForUser } = require('../crypto/setup.js');
const { Stmt, deleteGroupSummary } = require('../db/statements.js');
const { push } = require('../realtime/notify.js');
const { groupCache, groupPubCache, users } = require('../state.js');
const { byName, parseJsonSafe } = require('../users/helpers.js');

// Grupos — carga con caché
const groupPolicies = {
    text: ['all', 'admins'],
    image: ['all', 'admins', 'off'],
    video: ['all', 'admins', 'off'],
    audio: ['all', 'admins', 'off'],
    file: ['all', 'admins', 'off'],
    sticker: ['all', 'admins', 'off'],
    contact: ['all', 'admins', 'off'],
    poll: ['all', 'admins', 'off']
};

function normalizeGroup(g) {
    if (!g || typeof g !== 'object') return g;
    if (typeof g.cryptoId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(g.cryptoId))
        g.cryptoId = crypto.randomUUID();
    g.members = Array.isArray(g.members) ? g.members : [];
    g.admins = Array.isArray(g.admins) ? g.admins : [];
    g.memberIds = Array.isArray(g.memberIds) ? g.memberIds : [];
    g.description = typeof g.description === 'string' ? g.description : '';
    g.visibility = g.visibility === 'public' ? 'public' : 'private';
    g.joinPolicy = ['open', 'request', 'closed'].includes(g.joinPolicy) ? g.joinPolicy : 'request';
    g.writePolicy = g.writePolicy === 'admins' ? 'admins' : 'all';
    g.addPolicy = g.addPolicy === 'all' ? 'all' : 'admins';
    g.editPolicy = g.editPolicy === 'all' ? 'all' : 'admins';
    g.mentionAllPolicy = g.mentionAllPolicy === 'all' ? 'all' : 'admins';
    g.contentPolicy = g.contentPolicy && typeof g.contentPolicy === 'object' ? g.contentPolicy : {};
    for (const [kind, policies] of Object.entries(groupPolicies))
        if (!policies.includes(g.contentPolicy[kind])) g.contentPolicy[kind] = 'all';
    g.joinRequests = Array.isArray(g.joinRequests) ? g.joinRequests : [];
    g.keyboxes = Array.isArray(g.keyboxes) ? g.keyboxes : [];
    g.ownerId = typeof g.ownerId === 'string' ? g.ownerId : '';
    g.createdAt = Number.isFinite(g.createdAt) ? g.createdAt : Date.now();
    g.inviteCode = typeof g.inviteCode === 'string' ? g.inviteCode : crypto.randomBytes(18).toString('base64url');
    return g;
}

/* Caché de GRUPOS INEXISTENTES (gid →caduca). Los ids que no existen NO se
   cacheaban, así que resolver 200 targets con ids aleatorios eran 200 SELECT
   por petición. TTL corto: si el grupo nace poco después, groupCache (que va
   primero) lo tapa. */
const groupNegCache = new Map();
const GROUP_NEG_TTL_MS = 5000;
const GROUP_NEG_MAX = 4096;
function groupNegMiss(gid, ahora) {
    if (groupNegCache.size > GROUP_NEG_MAX) {
        for (const [key, expira] of groupNegCache) if (expira <= ahora) groupNegCache.delete(key);
        if (groupNegCache.size > GROUP_NEG_MAX) groupNegCache.clear();
    }
    groupNegCache.set(gid, ahora + GROUP_NEG_TTL_MS);
}
function invalidateGroupNegCache(gid) { groupNegCache.delete(gid); }

function readGroup(gid) {
    if (groupCache.has(gid)) return groupCache.get(gid);
    const ahora = Date.now();
    const neg = groupNegCache.get(gid);
    if (neg && neg > ahora) return null;
    const row = Stmt.getGroup.get(gid);
    if (!row) { groupNegMiss(gid, ahora); return null; }
    const keys = decryptGroupKeys(row.keys_cipher);
    const g = normalizeGroup({
        id: row.id,
        cryptoId: keys.cryptoId || row.crypto_id,
        name: row.name,
        description: row.description,
        avatar: row.avatar,
        ownerId: row.owner_id || '',
        visibility: row.visibility,
        joinPolicy: row.join_policy,
        writePolicy: row.write_policy,
        addPolicy: row.add_policy,
        editPolicy: row.edit_policy,
        mentionAllPolicy: row.mention_all_policy,
        contentPolicy: parseJsonSafe(row.content_policy, {}),
        inviteCode: row.invite_code,
        createdAt: row.created_at,
        keyboxes: keys.keyboxes || [],
        members: [], memberIds: [], admins: [], joinRequests: []
    });
    const memberRows = Stmt.listGroupMembers.all(gid);
    g.memberIds = memberRows.map(r => r.user_id).filter(id => users.has(id));
    g.members = g.memberIds.map(id => users.get(id).username);
    g.admins = memberRows
        .filter(r => r.role === 'admin' && users.has(r.user_id))
        .map(r => users.get(r.user_id).username);
    if (row.owner_id) {
        const ownerName = users.get(row.owner_id)?.username;
        if (ownerName && !g.admins.includes(ownerName)) g.admins.push(ownerName);
    }
    // Un grupo vivo siempre tiene al menos un administrador.
    if (!g.admins.length && g.members.length) g.admins.push(g.members[0]);
    g.joinRequests = Stmt.listJoinRequests.all(gid).map(r => ({ userId: r.user_id, username: r.username, ts: r.ts }));
    groupCache.set(gid, g);
    return g;
}

/* El material de cifrado extremo a extremo (cryptoId + keyboxes) viaja en una
   sola columna cifrada: no es «el grupo entero», solo las claves. */
function decryptGroupKeys(cipher) {
    if (!cipher) return {};
    const plain = decryptAtRest(cipher);
    if (!plain) return {};
    const value = parseJsonSafe(plain, null);
    return value && typeof value === 'object' ? value : {};
}

function writeGroupMeta(g) {
    const normalized = normalizeGroup(g);
    const keysCipher = encryptAtRest(JSON.stringify({
        cryptoId: normalized.cryptoId,
        keyboxes: Array.isArray(normalized.keyboxes) ? normalized.keyboxes : []
    }));
    const ownerId = users.has(normalized.ownerId) ? normalized.ownerId : null;
    const columns = [
        normalized.cryptoId,
        normalized.name || normalized.id,
        normalized.description || '',
        normalized.avatar || '',
        ownerId,
        normalized.visibility === 'public' ? 'public' : 'private',
        ['open', 'request', 'closed'].includes(normalized.joinPolicy) ? normalized.joinPolicy : 'request',
        normalized.writePolicy === 'admins' ? 'admins' : 'all',
        normalized.addPolicy === 'all' ? 'all' : 'admins',
        normalized.editPolicy === 'all' ? 'all' : 'admins',
        normalized.mentionAllPolicy === 'all' ? 'all' : 'admins',
        JSON.stringify(normalized.contentPolicy || {}),
        normalized.inviteCode,
        keysCipher,
        Number.isFinite(normalized.createdAt) ? normalized.createdAt : Date.now()
    ];
    if (Stmt.getGroup.get(normalized.id)) Stmt.updateGroup.run(...columns, normalized.id);
    else Stmt.insertGroup.run(normalized.id, ...columns);

    const admins = new Set(normalized.admins || []);
    const memberIds = new Set((normalized.memberIds || []).filter(id => users.has(id)));
    for (const row of Stmt.listGroupMembers.all(normalized.id))
        if (!memberIds.has(row.user_id)) Stmt.deleteGroupMember.run(normalized.id, row.user_id);
    // joined_at real: los miembros que ya estaban conservan su fecha de entrada
    // (ON CONFLICT solo toca el rol); los nuevos la reciben ahora.
    const joinedAt = Date.now();
    for (const id of memberIds) {
        const name = users.get(id).username;
        Stmt.insertGroupMember.run(normalized.id, id, admins.has(name) || id === ownerId ? 'admin' : 'member', joinedAt);
    }
    Stmt.deleteJoinRequestsByGid.run(normalized.id);
    for (const r of normalized.joinRequests || []) {
        if (!r || !users.has(r.userId)) continue;
        Stmt.insertJoinRequest.run(normalized.id, r.userId, r.username || users.get(r.userId).username, r.ts || Date.now());
    }
    normalized.ownerId = ownerId || '';
    normalized.members = [...memberIds].map(id => users.get(id).username);
    normalized.admins = [...admins].filter(name => byName(name));
    groupCache.set(normalized.id, normalized);
    // El grupo EXISTE ahora: fuera de la caché de inexistencia.
    invalidateGroupNegCache(normalized.id);
    invalidateGroupPubCache(normalized.id);
}

const invalidateGroupPubCache = gid => {
    for (const key of [...groupPubCache.keys()])
        if (key.startsWith(gid + '\0')) groupPubCache.delete(key);
};

const pub = (g, viewerId = '') => {
    const key = g.id + '\0' + viewerId;
    const cached = groupPubCache.get(key);
    if (cached) return { ...cached }; // Copia: los handlers decoran el objeto sin ensuciar la caché
    const out = {
        id: g.id, name: g.name, description: g.description, members: g.members,
        admins: g.admins, createdAt: g.createdAt, avatar: g.avatar || '',
        visibility: g.visibility, joinPolicy: g.joinPolicy, writePolicy: g.writePolicy,
        addPolicy: g.addPolicy, editPolicy: g.editPolicy, contentPolicy: g.contentPolicy,
        mentionAllPolicy: g.mentionAllPolicy,
        joinRequests: viewerId && g.admins.some(name => byName(name)?.id === viewerId) ? g.joinRequests : [],
        // El código de invitación es una credencial de acceso: con joinPolicy
        // 'open' permite entrar directamente en un grupo privado. Solo se
        // entrega a los administradores.
        inviteCode: viewerId && g.admins.some(name => byName(name)?.id === viewerId) ? g.inviteCode : undefined,
        keybox: (viewerId && (g.keyboxes || []).find(b => byName(b.recipient)?.id === viewerId)) || null
    };
    groupPubCache.set(key, out);
    return { ...out }; // Copia defensiva
};

function lastGroupMessage(gid) {
    const row = Stmt.lastMessage.get('group:' + gid);
    const m = rowToMessage(row);
    return m ? decorateForClient(m) : null;
}

function groupBrief(gid) {
    const rows = Stmt.lastMessages.all('group:' + gid, 12);
    return rows.map(rowToMessage).filter(Boolean).reverse().map(m => ({
        id: m.id, kind: m.kind, from: resolveName(m.fromId), fromId: m.fromId || '',
        ts: m.ts, name: m.name || '',
        text: m.kind === 'text' ? String(m.data || '').slice(0, 200) : ''
    }));
}

function groupLastEntry(m) {
    if (!m) return null;
    return {
        id: m.id, from: resolveName(m.fromId), fromId: m.fromId || '',
        kind: m.kind,
        text: m.kind === 'text' && !m.once ? String(m.data || '').slice(0, 200) : '',
        name: m.name || '', ts: m.ts
    };
}

// Resúmenes de grupo
function readGroupSummary(owner, gid) {
    const row = Stmt.getGroupSummary.get(owner, gid);
    if (!row) return null;
    let last = null;
    try { const raw = row.last_data ? decryptForUser(owner, row.last_data) : null; last = raw ? JSON.parse(raw) : null; } catch { }
    return { gid, unread: row.unread, last };
}
function writeGroupSummary(owner, gid, entry) {
    Stmt.upsertGroupSummary.run(owner, gid, entry.unread || 0, encryptForUser(owner, JSON.stringify(entry.last || null)));
}

/* Igual que los DMs: si la copia cifrada del resumen quedó ilegible, se
   reconstruye desde el último mensaje del grupo (que sí se descifra) y se
   reescribe. Devuelve el arreglo { gid, unread, last }. */
function healGroupSummary(owner, gid) {
    const row = Stmt.lastMessage.get('group:' + gid);
    const m = row ? rowToMessage(row) : null;
    if (!m) return null;
    const existing = readGroupSummary(owner, gid);
    const entry = { gid, unread: (existing && existing.unread) || 0, last: groupLastEntry(m) };
    writeGroupSummary(owner, gid, entry);
    return entry;
}

function groupSummaryFor(owner, gid) {
    const existing = readGroupSummary(owner, gid);
    if (existing) return existing;
    const entry = { gid, unread: 0, last: groupLastEntry(lastGroupMessage(gid)) };
    writeGroupSummary(owner, gid, entry);
    return entry;
}

function updateGroupMessageSummaries(group, msg, senderId) {
    const last = groupLastEntry(lastGroupMessage(group.id));
    const lastData = JSON.stringify(last);
    // Un solo upsert por miembro: el resumen de cada uno se actualiza con
    // una única sentencia, en vez de un SELECT seguido de INSERT o UPDATE.
    for (const uuid of group.memberIds)
        // Cifrado con la clave de cada miembro, como writeGroupSummary: el
        // resumen llevaba el preview del último mensaje en claro.
        Stmt.bumpGroupSummary.run(uuid, group.id, uuid === senderId ? 0 : 1, encryptForUser(uuid, lastData));
    // Un mensaje nuevo deja de estar marcado a mano como "no leído".
    for (const uuid of group.memberIds) {
        if (uuid === senderId) continue;
        try {
            // Require perezoso: evita un ciclo entre módulos.
            const { setUnreadFlag } = require('../chat/prefs.js');
            setUnreadFlag(uuid, 'group:' + group.id, false);
        } catch { }
    }
}

function initializeGroupSummary(uuid, gid) {
    // Require perezoso: evita un ciclo entre módulos.
    const { saveUserToDb } = require('../users/store.js');
    const last = groupLastEntry(lastGroupMessage(gid));
    const account = users.get(uuid);
    if (account && last) {
        account.groupSeen = account.groupSeen || {};
        if (last.ts > (account.groupSeen[gid] || 0)) {
            account.groupSeen[gid] = last.ts;
            saveUserToDb(account);
        }
    }
    writeGroupSummary(uuid, gid, { gid, unread: 0, last });
}

module.exports = {
    groupPolicies,
    normalizeGroup,
    readGroup,
    decryptGroupKeys,
    writeGroupMeta,
    invalidateGroupPubCache,
    pub,
    lastGroupMessage,
    groupBrief,
    groupLastEntry,
    readGroupSummary,
    writeGroupSummary,
    healGroupSummary,
    deleteGroupSummary,
    groupSummaryFor,
    updateGroupMessageSummaries,
    initializeGroupSummary,
};

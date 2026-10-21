/**
 * Preferencias de la lista de chats (fijado, silencio y "no leído").
 *
 * Viven en el servidor para que el estado sea el mismo en todos los
 * dispositivos de la cuenta. La clave canónica de una conversación es:
 *   · 'dm:<usuario>'  → chat 1:1
 *   · 'group:<id>'    → chat de grupo
 *   · 'saved'         → mensajes guardados
 *
 * El silencio se guarda en su propia tabla (user_muted_peers) porque el
 * servidor también la consulta para no enviar notificaciones push; aquí se
 * mezcla con el resto de preferencias para que el cliente trabaje con un
 * único objeto.
 */
'use strict';

const { Stmt } = require('../db/statements.js');
const { tx } = require('../db/transactions.js');
const { profiles } = require('../state.js');
const { isContact } = require('../users/privacy.js');
const { byName } = require('../users/helpers.js');

const DM_PREFIX = 'dm:';
const GROUP_PREFIX = 'group:';
const SAVED_KEY = 'saved';

const dmKey = username => DM_PREFIX + username;
const groupKey = id => GROUP_PREFIX + id;

/** Convierte una clave canónica en su tipo y su identificador. */
function parseKey(key) {
    if (typeof key !== 'string' || !key) return null;
    if (key === SAVED_KEY) return { type: 'saved', id: '' };
    if (key.startsWith(DM_PREFIX)) {
        const id = key.slice(DM_PREFIX.length);
        return id ? { type: 'dm', id } : null;
    }
    if (key.startsWith(GROUP_PREFIX)) {
        const id = key.slice(GROUP_PREFIX.length);
        return id ? { type: 'group', id } : null;
    }
    return null;
}

const emptyPref = () => ({ pinned: false, pinnedAt: 0, muted: false, unread: false, archived: false });

/**
 * Comprueba que el actor puede tocar esa conversación. Un chat 1:1 solo
 * existe si el otro es un contacto suyo; un grupo, solo si es miembro.
 * Devuelve la clave normalizada o null si no es válida.
 */
function resolveTarget(actor, key) {
    const target = parseKey(key);
    if (!target) return null;
    if (target.type === 'saved') return { key: SAVED_KEY, peerName: SAVED_KEY, peerId: null, type: 'saved', id: '' };
    if (target.type === 'dm') {
        if (target.id === actor) return { key: SAVED_KEY, peerName: SAVED_KEY, peerId: null, type: 'saved', id: '' };
        const account = byName(target.id);
        if (!account) return null;
        const profile = profiles[actor] || {};
        if (!isContact(profile, target.id)) return null;
        return { key: dmKey(target.id), peerName: target.id, peerId: account.id, type: 'dm', id: target.id };
    }
    const { readGroup } = require('../groups/store.js');
    const group = readGroup(target.id);
    if (!group || !group.memberIds.includes(byName(actor)?.id || '')) return null;
    return { key: groupKey(target.id), peerName: GROUP_PREFIX + target.id, peerId: null, type: 'group', id: target.id };
}

/** Todas las preferencias de la cuenta, ya unificadas. */
function readChatPrefs(userId) {
    const prefs = {};
    for (const row of Stmt.listChatPrefs.all(userId)) {
        prefs[row.peer_key] = {
            pinned: Number(row.pinned_at) > 0,
            pinnedAt: Number(row.pinned_at) || 0,
            unread: !!row.unread,
            archived: !!row.archived,
            muted: false
        };
    }
    for (const row of Stmt.listMutedPeers.all(userId)) {
        if (!row.peer_name) continue;
        const key = row.peer_name.startsWith(GROUP_PREFIX) ? row.peer_name : dmKey(row.peer_name);
        const entry = prefs[key] || (prefs[key] = emptyPref());
        entry.muted = true;
    }
    return prefs;
}

/**
 * Aplica un bloque de cambios (fijado / silencio / no leído) a varias
 * conversaciones en una sola transacción: o se aplica todo o no se aplica
 * nada. Devuelve las preferencias resultantes.
 */
function applyChatPrefs(actor, userId, targets, patch) {
    const updates = [];
    for (const target of targets) {
        const resolved = resolveTarget(actor, target);
        if (!resolved) continue;
        const update = { key: resolved.key, peerName: resolved.peerName, peerId: resolved.peerId };
        if (typeof patch.pinned === 'boolean') update.pinned = patch.pinned;
        if (typeof patch.muted === 'boolean') update.muted = patch.muted;
        if (typeof patch.unread === 'boolean') update.unread = patch.unread;
        if (typeof patch.archived === 'boolean') update.archived = patch.archived;
        if (update.pinned === undefined && update.muted === undefined && update.unread === undefined && update.archived === undefined) continue;
        updates.push(update);
    }
    if (!updates.length) return readChatPrefs(userId);
    tx.applyChatPrefs(userId, updates);
    // El silencio también vive en el perfil en memoria: si no se actualiza,
    // un guardado posterior del perfil lo borraría.
    const profile = profiles[actor] || (profiles[actor] = {});
    const muted = new Set(Array.isArray(profile.mutedChatPeers) ? profile.mutedChatPeers : []);
    for (const update of updates) {
        if (update.muted === undefined) continue;
        if (update.muted) muted.add(update.peerName);
        else muted.delete(update.peerName);
    }
    profile.mutedChatPeers = [...muted];
    return readChatPrefs(userId);
}

/** Marca un chat como "no leído" (o lo devuelve a leído). */
function setUnreadFlag(userId, peerKey, unread) {
    tx.applyChatPrefs(userId, [{ key: peerKey, unread: !!unread }]);
}

module.exports = {
    DM_PREFIX,
    GROUP_PREFIX,
    SAVED_KEY,
    dmKey,
    groupKey,
    parseKey,
    resolveTarget,
    readChatPrefs,
    applyChatPrefs,
    setUnreadFlag
};

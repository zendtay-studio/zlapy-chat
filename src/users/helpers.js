/**
 * Ayudas de cuentas.
 *
 * Consultas por id o por nombre sobre las cuentas en RAM, utilidades de JSON
 * que no rompen una ruta cuando un dato guardado está corrupto y accesores
 * al perfil (nota, silencios).
 */
'use strict';

const { Stmt } = require('../db/statements.js');
const { NOTE_TTL } = require('../shared/validation.js');
const { profiles, usernameIndex, users } = require('../state.js');

// Helpers básicos
const uniq = arr => [...new Set(arr.filter(Boolean))];
/* JSON a prueba de datos corruptos: si el texto no se puede interpretar se
   devuelve el valor por defecto en lugar de lanzar. */
const parseJsonSafe = (text, fallback = null) => {
    if (typeof text !== 'string' || !text) return fallback;
    try { const value = JSON.parse(text); return value === null || value === undefined ? fallback : value; }
    catch { return fallback; }
};

const byId = id => (typeof id === 'string' ? users.get(id) : undefined);
const byName = name => {
    if (typeof name !== 'string') return undefined;
    const uuid = usernameIndex.get(name) || usernameIndex.get(name.toLowerCase());
    if (!uuid) return undefined;
    const acc = users.get(uuid);
    // Índice obsoleto (apunta a una cuenta borrada): se limpia solo.
    if (!acc) { usernameIndex.delete(name); usernameIndex.delete(name.toLowerCase()); return undefined; }
    return acc;
};
const usernameTakenInDb = (username, exceptId = '') => {
    const row = Stmt.getUserByName.get(username);
    return !!row && row.id !== exceptId;
};
/* Identificador estable de una cuenta: el UUID si está registrada y un
   marcador con su nombre si no, para poder asociar datos sin cuenta. */
const accountId = username => byName(username)?.id || `unregistered:${username}`;
const pairKeyFromIds = (idA, idB) => [idA, idB].sort().join('__');

const freshNote = username => {
    const p = profiles[username];
    if (!p || !p.note) return '';
    if (!p.noteTs || Date.now() - p.noteTs >= NOTE_TTL) return '';
    return p.note;
};
const mutedChatPeers = username => {
    const muted = profiles[username]?.mutedChatPeers;
    return Array.isArray(muted) ? muted : [];
};
const isChatMuted = (username, peer) => mutedChatPeers(username).includes(peer);


module.exports = {
    uniq,
    parseJsonSafe,
    byId,
    byName,
    usernameTakenInDb,
    accountId,
    pairKeyFromIds,
    freshNote,
    mutedChatPeers,
    isChatMuted,
};

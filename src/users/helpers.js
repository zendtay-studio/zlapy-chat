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
/* Búsqueda de cuenta por nombre: sin distinguir mayúsculas ni espacios
   sobrantes, que es exactamente lo que acepta el registro. Normalizar aquí
   evita que " Ana9 " resuelva de forma distinta a "ana9" en según qué ruta. */
const byName = name => {
    if (typeof name !== 'string') return undefined;
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    const uuid = usernameIndex.get(trimmed) || usernameIndex.get(key);
    if (!uuid) return undefined;
    const acc = users.get(uuid);
    // Índice obsoleto (apunta a una cuenta borrada): se limpia solo.
    if (!acc) { usernameIndex.delete(trimmed); usernameIndex.delete(key); return undefined; }
    return acc;
};
const usernameTakenInDb = (username, exceptId = '') => {
    const row = Stmt.getUserByName.get(username);
    return !!row && row.id !== exceptId;
};
/* Resuelve un identificador de cuenta recibido del cliente aceptando el
   nombre canónico y, SOLO para quien tiene una relación autorizada con la
   cuenta, su alias opaco (el UUID que se publica cuando la privacidad
   'usuario' oculta el @usuario). Sin esta comprobación, /profile, /send o la
   búsqueda con el UUID serían un oráculo para confirmar cuentas ajenas.
   Relaciones válidas: uno mismo, contacto, solicitud de contacto pendiente
   en cualquier dirección o grupo en común (los mismos supuestos con los que
   se entrega el alias). */
const resolveAccount = (identifier, viewer) => {
    if (typeof identifier !== 'string') return undefined;
    const trimmed = identifier.trim();
    if (!trimmed) return undefined;
    const direct = byName(trimmed);
    if (direct) return direct;
    const account = users.get(trimmed);
    if (!account) return undefined;
    const viewerAccount = typeof viewer === 'string'
        ? (byName(viewer) || users.get(viewer))
        : (viewer && typeof viewer === 'object' ? viewer : undefined);
    if (!viewerAccount) return undefined;
    if (viewerAccount.id === account.id) return account;
    if (viewerAccount.contacts && viewerAccount.contacts.has(account.id)) return account;
    if (Stmt.contactRequestBetween.get(viewerAccount.id, account.id, account.id, viewerAccount.id)) return account;
    if (Stmt.sharedGroupBetween.get(viewerAccount.id, account.id)) return account;
    if (Stmt.groupJoinRequestForAdmin.get(account.id, viewerAccount.id)) return account;
    return undefined;
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
/* ¿Hay que enviar push a esta cuenta ahora mismo? Por defecto solo a las
   cuentas SIN conexión activa: quien está conectado ya recibe el aviso en
   vivo por WebSocket y el push solo lo duplicaría. El ajuste manual de la
   cuenta (Ajustes > Notificaciones › «Push con la app conectada») fuerza el
   push también conectado: con la app abierta en OTRO dispositivo el
   WebSocket no llega ahí y sin este ajuste el push se saltaba entero. */
const wantsAlwaysPush = username => !!(profiles[username] && profiles[username].alwaysPush === true);


module.exports = {
    uniq,
    parseJsonSafe,
    byId,
    byName,
    resolveAccount,
    usernameTakenInDb,
    accountId,
    pairKeyFromIds,
    freshNote,
    mutedChatPeers,
    isChatMuted,
    wantsAlwaysPush,
};

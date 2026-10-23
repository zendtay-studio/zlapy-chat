/**
 * Privacidad por función.
 *
 * Cada cuenta decide, función por función (foto, nota, descripción,
 * historias, llamadas, mensajes y compartir), quién ve ese contenido: todo
 * el mundo, solo contactos, nadie o una lista explícita. El bloqueo entre
 * dos cuentas siempre gana a la regla de privacidad.
 */
'use strict';

const { blockedSet, users } = require('../state.js');
const { byName } = require('./helpers.js');

// Permisos
const PRIV_KEYS = ['foto', 'nota', 'descripcion', 'historias', 'llamadas', 'mensajes', 'compartir'];
/* Valores por defecto: la foto y la descripción son públicas; el resto
   (nota, historias, llamadas, mensajes, compartir) es solo para contactos. */
const PRIV_DEF = { foto: 'server', nota: 'contacts', descripcion: 'server', historias: 'contacts', llamadas: 'contacts', mensajes: 'contacts', compartir: 'contacts' };
/* Normaliza las reglas de privacidad: cada función acaba con un modo válido
   y una lista de usuarios, aunque el cliente envíe campos raros o ausentes. */
const normPriv = raw => {
    const out = {};
    for (const k of PRIV_KEYS) {
        const v = (raw && raw[k]) || {};
        const mode = v.mode === 'all' ? 'server'
            : ['server', 'contacts', 'nobody', 'except', 'only'].includes(v.mode) ? v.mode : PRIV_DEF[k];
        out[k] = { mode, users: Array.isArray(v.users) ? v.users.filter(u => typeof u === 'string') : [] };
    }
    return out;
};

const isContact = (owner, viewer) => {
    if (!owner || !viewer || viewer === owner.username) return false;
    const oA = byName(owner.username), vA = byName(viewer);
    return !!(oA && vA && oA.contacts.includes(vA.id));
};
/* ¿El propietario tiene bloqueado a este visor? Se compara por nombre
   normalizado: el conjunto se indexa por el nombre canónico (minúsculas). */

/* Los nombres de usuario se guardan siempre en minúsculas, pero una petición
   puede traerlos con cualquier capitalización (la búsqueda de cuentas es
   case-insensitive). Normalizar aquí, en el único sitio que decide bloqueo y
   permisos, evita que "Ana9" se salte un bloqueo puesto a "ana9". */
const normName = value => (typeof value === 'string' ? value.trim().toLowerCase() : value);

const accountsBlocked = (first, second) => {
    if (!first || !second) return false;
    const a = normName(first), b = normName(second);
    const s1 = blockedSet.get(a), s2 = blockedSet.get(b);
    return (s1 && s1.has(b)) || (s2 && s2.has(a)) || false;
};

const privacyFor = owner => {
    const privacy = normPriv(owner && owner.privacy);
    // El ajuste de foto o descripción en modo privado se respeta mientras no
    // exista una regla por función que lo sustituya.
    if (owner && (!owner.privacy || !Object.prototype.hasOwnProperty.call(owner.privacy, 'foto')) && owner.privacyPhoto === 'private')
        privacy.foto = { mode: 'nobody', users: [] };
    if (owner && (!owner.privacy || !Object.prototype.hasOwnProperty.call(owner.privacy, 'descripcion')) && owner.privacyDesc === 'private')
        privacy.descripcion = { mode: 'nobody', users: [] };
    return privacy;
};

const permite = (owner, key, viewer) => {
    if (!owner) return false;
    if (!viewer) return false;
    // Nombre normalizado para todo: las listas de excepciones guardan nombres
    // canónicos y la petición puede llegar con cualquier capitalización.
    const v = normName(viewer);
    if (v === normName(owner.username)) return true;
    if (isBlockedBy(owner, v)) return false;
    const p = privacyFor(owner)[key];
    if (p.mode === 'server') return true;
    if (p.mode === 'contacts') return isContact(owner, v);
    if (p.mode === 'nobody') return false;
    if (p.mode === 'only') return isContact(owner, v) && p.users.some(u => normName(u) === v);
    // 'except': todos los contactos menos los de la lista.
    return isContact(owner, v) && !p.users.some(u => normName(u) === v);
};
const permiteDescripcion = (owner, viewer) => permite(owner, 'descripcion', viewer);

const isBlockedBy = (owner, viewer) => {
    if (!owner || !viewer) return false;
    const set = blockedSet.get(normName(owner.username));
    return !!(set && set.has(normName(viewer)));
};

module.exports = {
    PRIV_KEYS,
    PRIV_DEF,
    normPriv,
    isContact,
    normName,
    accountsBlocked,
    privacyFor,
    permite,
    permiteDescripcion,
    isBlockedBy,
};

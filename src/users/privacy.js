/**
 * Privacidad por función.
 *
 * Cada cuenta decide, función por función (foto, nota, descripción,
 * historias, llamadas, mensajes, compartir y presencia «en línea»), quién ve
 * ese contenido: todo el mundo, solo contactos, nadie o una lista explícita.
 * El bloqueo entre dos cuentas siempre gana a la regla de privacidad.
 */
'use strict';

const { blockedSet, users } = require('../state.js');
const { byName } = require('./helpers.js');

// Permisos
/* 'online' cubre la PRESENCIA (en línea / última vez visto) de la cuenta. */
const PRIV_KEYS = ['foto', 'nota', 'descripcion', 'historias', 'llamadas', 'mensajes', 'compartir', 'online'];
/* Valores por defecto: la foto y la descripción son públicas; el resto
   (nota, historias, llamadas, mensajes, compartir y online) es solo para
   contactos — el valor que ya tenía la presencia antes de ser configurable. */
const PRIV_DEF = { foto: 'server', nota: 'contacts', descripcion: 'server', historias: 'contacts', llamadas: 'contacts', mensajes: 'contacts', compartir: 'contacts', online: 'contacts' };
/* Normaliza las reglas de privacidad: cada función acaba con un modo válido
   y una lista de usuarios, aunque el cliente envíe campos raros o ausentes.
   La lista de excepciones se canoniza AQUÍ (minúsculas, sin espacios): así
   las comparaciones de 'only'/'except' son una búsqueda directa sin volver a
   normalizar cada elemento en cada petición (PERF-P06). */
const normPriv = raw => {
    const out = {};
    for (const k of PRIV_KEYS) {
        const v = (raw && raw[k]) || {};
        const mode = v.mode === 'all' ? 'server'
            : ['server', 'contacts', 'nobody', 'except', 'only'].includes(v.mode) ? v.mode : PRIV_DEF[k];
        const users = Array.isArray(v.users)
            ? v.users.filter(u => typeof u === 'string' && u.trim()).map(u => u.trim().toLowerCase())
            : [];
        out[k] = { mode, users };
    }
    return out;
};

const isContact = (owner, viewer) => {
    if (!owner || !viewer || viewer === owner.username) return false;
    const oA = byName(owner.username), vA = byName(viewer);
    return !!(oA && vA && oA.contacts.has(vA.id));
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

/* Memoización por objeto de perfil (PERF-P06): privacyFor recalculaba
   normPriv y revisaba los legacy en cada llamada (permite se llama una vez
   por historia y espectador en cada envío o push). La clave es el PROPIO
   objeto: cambiar de identidad (renombrar, reconstruir en el arranque) crea
   un objeto nuevo y la caché se invalida sola. Para cambios DENTRO del mismo
   objeto (guardados de /profile, fusión por WebSocket) hay que avisar con
   privacyCacheBust. */
const privacyMemo = new WeakMap();
const privacyFor = owner => {
    if (!owner) return normPriv(null);
    let privacy = privacyMemo.get(owner);
    if (privacy !== undefined) return privacy;
    privacy = normPriv(owner.privacy);
    // El ajuste de foto o descripción en modo privado se respeta mientras no
    // exista una regla por función que lo sustituya.
    if ((!owner.privacy || !Object.prototype.hasOwnProperty.call(owner.privacy, 'foto')) && owner.privacyPhoto === 'private')
        privacy.foto = { mode: 'nobody', users: [] };
    if ((!owner.privacy || !Object.prototype.hasOwnProperty.call(owner.privacy, 'descripcion')) && owner.privacyDesc === 'private')
        privacy.descripcion = { mode: 'nobody', users: [] };
    privacyMemo.set(owner, privacy);
    return privacy;
};
/* Descarta la copia en caché de un perfil: se llama en los sitios que
   MUTAN el objeto por dentro (p.privacy = ...) en vez de reemplazarlo. */
const privacyCacheBust = owner => { if (owner && typeof owner === 'object') privacyMemo.delete(owner); };

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
    // Listas ya canonizadas (minúsculas) en normPriv: comparación directa
    // sin allocar un normName por elemento en cada llamada.
    if (p.mode === 'only') return isContact(owner, v) && p.users.includes(v);
    // 'except': todos los contactos menos los de la lista.
    return isContact(owner, v) && !p.users.includes(v);
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
    privacyCacheBust,
    permite,
    permiteDescripcion,
    isBlockedBy,
};

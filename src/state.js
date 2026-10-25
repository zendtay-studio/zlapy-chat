/**
 * Estado compartido en memoria.
 *
 * Guarda las cuentas, los grupos, las sesiones y los resúmenes que se
 * consultan en cada petición. Es la capa de caché del servidor: la base de
 * datos sigue siendo la fuente de verdad.
 */
'use strict';

const { CONFIG } = require('./config.js');
const { makeCache } = require('./shared/cache.js');

// Estado en RAM (users, grupos, bloqueados, sesiones)
const users = new Map();             // id → user object
const usernameIndex = new Map();     // username → id
const profiles = Object.create(null);  // username → profile object (sin prototipo: __proto__ no es una clave válida)
const groupCache = new Map();        // gid → normalized group
/* Vistas públicas serializadas por grupo y espectador (dos claves entran en
   una: gid\0viewer). Caché perecedera de más (shared/cache): se invalida a
   mano por gid cuando el grupo cambia y el tope desaloja por uso. */
const groupPubCache = makeCache({ max: 20000 });
const blockedSet = new Map();        // username → Set<username>
const sessionCache = new Map();      // hash → { userId, expiresAt }
const pushSubs = new Map();          // userId → array of subs
const notesMap = Object.create(null);   // username → note object (sin prototipo)
const callFiles = new Map();           // username → array de calls (en RAM por velocidad)
const stories = [];                    // array de story objects (solo las vivas en RAM)
const pendingOffers = new Map();
/* chatPageCache queda como Map (no como shared/cache): llevar su cota de
   BYTES exige desalojos manuales con contabilidad extrayendo entradas en orden
   de inserción (FIFO), y el coste ya anda acotado (chatPageCacheMax/ttl en
   config.js). Véase chat/messages.js (SECOA-I-003). */
const chatPageCache = new Map();     // pairKey → { messages, savedAt, more }
/* Total global de bytes de blobs en RAM: se suma/resta en cada
   insert/borrado (PERF-P02) para no repetir un SELECT SUM que recorre la
   tabla entera en cada subida. `bytes === null` significa "cargar en el
   primer uso". */
const blobBytesCache = { bytes: null };
const CHAT_PAGE_TTL = CONFIG.chatPageCacheTtlMs;
const CHAT_PAGE_MAX = CONFIG.chatPageCacheMax;

const AUTH_SESSION_TTL = CONFIG.authSessionTtlMs;

/* Listas mutables del estado: se filtran a menudo, así que se cambian por
 * aquí. IMPORTANTE: se MUTAN en lugar de reasignarse. Todos los módulos
 * importan estas referencias con `const { stories } = require(...)`, así que
 * si la variable se reasignara, los importadores se quedarían con la lista
 * antigua (y, por ejemplo, una historia borrada seguiría apareciendo).
 * Mutando el mismo objeto, todas las referencias ven siempre el estado
 * actual. */
const setStories = list => {
    stories.length = 0;
    for (const item of list) stories.push(item);
};
const setNotesMap = map => {
    for (const key of Object.keys(notesMap)) delete notesMap[key];
    Object.assign(notesMap, map);
};
const setCallFiles = map => {
    callFiles.clear();
    for (const [key, value] of map) callFiles.set(key, value);
};

module.exports = {
    setStories,
    setNotesMap,
    setCallFiles,
    users,
    usernameIndex,
    profiles,
    groupCache,
    groupPubCache,
    blockedSet,
    sessionCache,
    pushSubs,
    notesMap,
    callFiles,
    stories,
    pendingOffers,
    chatPageCache,
    blobBytesCache,
    CHAT_PAGE_TTL,
    CHAT_PAGE_MAX,
    AUTH_SESSION_TTL,
};

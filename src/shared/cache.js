/**
 * Caché en RAM del servidor — "Redis sin Redis".
 *
 * Fábrica única para TODAS las cachés perecederas: get/set/remove con coste
 * O(1), desalojo por orden de uso (la menos usada se va cuando se llena) y
 * vida útil por entrada (ttl). Debajo usa el paquete `lru`; si un día hay
 * que cambiar el motor, solo archivo cambia.
 *
 * Quedan FUERA de esta capa las estructuras que son ESTADO y no caché
 * (cuentas, grupos, sesiones, bloqueos: la fuente de verdad no se desaloja),
 * y la caché de páginas de chat, que lleva además su cota propia de bytes
 * con contabilidad manual (SECOA-I-003).
 */
'use strict';

const LRU = require('lru');

function makeCache({ max = 1000, ttl = 0 } = {}) {
    const opts = { max };
    if (ttl) opts.maxAge = ttl;
    const cache = new LRU(opts);
    return {
        /* Devuelve undefined si no está o si su vida ya pasó (lru los expulsa
           al leerlos). Con ttl, el toque de uso también ocurre aquí. */
        get: key => cache.get(key),
        /* Igual que get pero sin tocar el orden de uso. */
        peek: key => cache.peek(key),
        set: (key, value) => { cache.set(key, value); return value; },
        delete: key => { cache.remove(key); },
        clear: () => cache.clear(),
        /* Array de claves vivas (el paquete expone `.keys` como propiedad). */
        keys: () => [...cache.keys],
        get size() { return cache.length; },
    };
}

module.exports = { makeCache };

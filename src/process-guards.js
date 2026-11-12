/**
 * Guardas de proceso: errores globales que NO tumban el servidor.
 *
 * Cualquier excepción que se escape de un manejador (un bug en una ruta, en
 * el WebSocket o en un temporizador) llega aquí. Antes, `uncaughtException`
 * checkpointaba la base y moría: correcto para la consistencia, pero un
 * fallo de un solo mensaje dejaba a todo el servicio caído. Ahora:
 *
 *   · SIEMPRE se registra el error completo (consola + data/log/errors.log,
 *     fichero acotado a 2 MB conservando el final): nada pasa en silencio.
 *   · Los errores FATALES (base corrompia, disco lleno, permisos del
 *     directorio de datos) cierran la base de forma ordenada y salen con
 *     código 1: el supervisor levanta un proceso nuevo y limpio.
 *   · El resto se registra y EL SERVIDOR SIGUE SIRVIENDO. El watchdog del
 *     supervisor (health check + latido) vigila que ese "seguir vivo" no sea
 *     en realidad un proceso zombi.
 *
 * `unhandledRejection` nunca es fatal: una promesa rechazada aislada no
 * implica que el proceso esté inservible.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* Carpeta de datos: la misma que usa el servidor. Si la configuración aún no
   se puede cargar (arranque muy temprano), se registra solo en consola. */
let DATA_DIR = null;
try { DATA_DIR = require('./config.js').DATA; } catch { /* sin log a disco */ }
const LOG_DIR = DATA_DIR ? path.join(DATA_DIR, 'log') : null;
const LOG_FILE = LOG_DIR ? path.join(LOG_DIR, 'errors.log') : null;
const LOG_MAX_BYTES = 2 * 1024 * 1024;   // techo del fichero
const LOG_KEEP_BYTES = 1024 * 1024;      // lo que se conserva al truncar
const ENTRY_MAX_BYTES = 8192;            // techo por entrada (pila incluida)

/* Fatales = el proceso no puede continuar de forma fiable. Códigos de
   sistema más textos de SQLite: una base corrupta o un disco lleno no se
   arreglan "siguiendo vivo". */
const FATAL_CODES = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EACCES', 'EPERM', 'ERR_OUT_OF_MEMORY']);
const FATAL_TEXTS = [
    'sqlite_corrupt', 'sqlite_notadb', 'sqlite_full',
    'database disk image is malformed', 'file is not a database',
    'unable to open database file', 'database or disk is full'
];

function isFatal(err) {
    if (!err) return false;
    const code = err.code || err.errno;
    if (code && FATAL_CODES.has(code)) return true;
    const text = [err.message, err.code, err.name].filter(Boolean).join(' ').toLowerCase();
    return FATAL_TEXTS.some(t => text.includes(t));
}

/* Escritura acotada: truncar conservando el final es suficiente para
   diagnosticar (lo antiguo importa menos que lo reciente). */
function writeLog(kind, err, fatal = false) {
    if (!LOG_FILE) return;
    try {
        const body = String((err && err.stack) || (err && err.message) || err);
        const entry = `\n===== ${new Date().toISOString()} — ${kind}${fatal ? ' — FATAL' : ''} =====\n${body.slice(0, ENTRY_MAX_BYTES)}\n`;
        fs.mkdirSync(LOG_DIR, { recursive: true });
        try {
            if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
                const keep = fs.readFileSync(LOG_FILE).slice(-LOG_KEEP_BYTES);
                fs.writeFileSync(LOG_FILE, keep);
            }
        } catch { /* fichero nuevo: nada que truncar */ }
        fs.appendFileSync(LOG_FILE, entry);
    } catch { /* el log es best-effort: nunca debe tumbar el proceso */ }
}

/* Cierre ordenado de las bases cuando el error es fatal. Lo inyecta
   src/http/servers.js, que es quien las tiene abiertas. */
let fatalHook = null;
function setFatalHook(fn) { fatalHook = fn; }

function handle(kind, err, { onError } = {}) {
    const fatal = kind === 'uncaughtException' && isFatal(err);
    writeLog(kind, err, fatal);
    try { if (onError) onError(err); } catch { /* el observador no cambia el flujo */ }
    if (fatal) {
        console.error(`[${kind}] FATAL:`, err && err.stack ? err.stack : err);
        try { if (fatalHook) fatalHook(); } catch { }
        process.exit(1);
    }
    console.error(`[${kind}] se sigue sirviendo:`, err && err.stack ? err.stack : err);
}

/**
 * Instala los manejadores globales.
 * @param {{onError?: function}} [opts] observador opcional (tests/diagnóstico)
 */
function installProcessGuards({ onError } = {}) {
    process.on('uncaughtException', err => handle('uncaughtException', err, { onError }));
    process.on('unhandledRejection', err => handle('unhandledRejection', err, { onError }));
}

/**
 * Latido hacia el supervisor por el canal IPC.
 *
 * El health check HTTP ya detecta un proceso colgado (si el event loop está
 * bloqueado, /healthz tampoco responde), pero tarda: el latido da una señal
 * cada pocos segundos y permite al supervisor reiniciar antes uno bloqueado.
 * Sin canal IPC (p. ej. los tests, que arrancan server.js directamente) no
 * hace nada.
 *
 * @param {{intervalMs?: number}} [opts]
 * @returns {NodeJS.Timeout|null}
 */
function startHeartbeat({ intervalMs = 10000 } = {}) {
    if (typeof process.send !== 'function') return null;
    const send = process.send.bind(process);
    const timer = setInterval(() => {
        try { send({ t: 'hb', ts: Date.now(), pid: process.pid }); } catch { /* el supervisor se fue */ }
    }, intervalMs);
    timer.unref();
    return timer;
}

module.exports = { installProcessGuards, setFatalHook, startHeartbeat, isFatal, writeLog };

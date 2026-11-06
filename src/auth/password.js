'use strict';
/**
 * Contraseñas de cuenta: API del servidor.
 *
 * El trabajo pesado (bcrypt) se hace en un worker aparte para no bloquear el
 * hilo principal del servidor; si el worker no se puede arrancar, se recurre
 * a la misma implementación en el propio proceso (más lenta para el resto del
 * servicio, pero funcional).
 */

const path = require('path');
const { Worker } = require('worker_threads');
const core = require('./password-core.js');

const WORKER_PATH = path.join(__dirname, 'password-worker.js');

let worker = null;
let workerFallido = false;
let siguienteId = 1;
const pendientes = new Map();

function workerVivo() {
    if (workerFallido) return null;
    if (worker) return worker;
    try {
        worker = new Worker(WORKER_PATH);
    } catch (error) {
        workerFallido = true;
        console.warn('[passwords] no se pudo arrancar el worker de contraseñas:', error.message);
        return null;
    }
    worker.on('message', mensaje => {
        const entrada = pendientes.get(mensaje.id);
        if (!entrada) return;
        pendientes.delete(mensaje.id);
        if (mensaje.ok) entrada.resolve(mensaje.value);
        else entrada.reject(new Error(mensaje.error || 'fallo del worker de contraseñas'));
    });
    worker.on('error', error => {
        console.warn('[passwords] el worker de contraseñas falló:', error.message);
        for (const [, entrada] of pendientes) entrada.reject(error);
        pendientes.clear();
        worker = null;
        workerFallido = true;
    });
    worker.on('exit', () => {
        worker = null;
        for (const [, entrada] of pendientes) entrada.reject(new Error('el worker de contraseñas terminó'));
        pendientes.clear();
    });
    return worker;
}

function pedirAlWorker(mensaje) {
    const vivo = workerVivo();
    if (!vivo) return null;
    const id = siguienteId++;
    return new Promise((resolve, reject) => {
        pendientes.set(id, { resolve, reject });
        vivo.postMessage({ id, ...mensaje });
    });
}

/**
 * Deriva el hash de una contraseña (bcrypt, coste 10).
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
    const viaWorker = pedirAlWorker({ op: 'hash', password });
    if (viaWorker) return viaWorker;
    return core.hashPassword(password);
}

/**
 * Comprueba una contraseña contra el hash guardado (bcrypt o el scrypt
 * antiguo).
 *
 * @param {string} password
 * @param {string} stored
 * @param {string} [salt]
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored, salt) {
    const viaWorker = pedirAlWorker({ op: 'verify', password, stored, salt });
    if (viaWorker) return viaWorker;
    return core.verifyPassword(password, stored, salt);
}

/** ¿El hash guardado es del formato antiguo (scrypt)? */
const esHashAntiguo = core.esHashAntiguo;

/** Cierra el worker (para los tests y para un apagado limpio). */
function cerrarWorker() {
    if (!worker) return;
    try { worker.terminate(); } catch { }
    worker = null;
}

module.exports = { hashPassword, verifyPassword, esHashAntiguo, cerrarWorker };

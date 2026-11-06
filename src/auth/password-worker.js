'use strict';
/**
 * Worker de contraseñas.
 *
 * Ejecuta el hash y la verificación de contraseñas FUERA del hilo principal
 * del servidor: bcrypt cuesta ~100 ms de CPU por operación, y hacerlo en el
 * hilo principal bloquearía TODAS las peticiones durante ese tiempo (un
 * login ajeno frenaría el chat entero).
 */

const { parentPort } = require('worker_threads');
const { hashPassword, verifyPassword } = require('./password-core.js');

parentPort.on('message', async mensaje => {
    const { id, op, password, stored, salt } = mensaje || {};
    try {
        if (op === 'hash') {
            const value = await hashPassword(password);
            parentPort.postMessage({ id, ok: true, value });
            return;
        }
        if (op === 'verify') {
            const value = await verifyPassword(password, stored, salt);
            parentPort.postMessage({ id, ok: true, value });
            return;
        }
        parentPort.postMessage({ id, ok: false, error: `operación desconocida: ${op}` });
    } catch (error) {
        parentPort.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
    }
});

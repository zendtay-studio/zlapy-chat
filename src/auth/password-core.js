'use strict';
/**
 * Verificación yderivación de las contraseñas de cuenta (implementación pura).
 *
 * Este módulo NO se usa directamente desde el servidor: vive dentro del
 * worker de contraseñas (`password-worker.js`) para que el coste de bcrypt no
 * bloquee el hilo principal del servidor, y también como recurso si el worker
 * no se puede arrancar.
 *
 * Formato de la columna `users.password_hash`:
 *
 *   · `$2b$10$…` → bcrypt (coste 10). La sal va dentro del hash: la columna
 *     `password_salt` queda vacía.
 *   · 128 hex → scrypt (formato antiguo, N=16384 r=8 p=1) con la sal de la
 *     columna `password_salt`. Se sigue aceptando para no dejar fuera a las
 *     cuentas existentes; el login las re-hashea con bcrypt al entrar (migración
 *     perezosa).
 */
'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const bcrypt = require('bcryptjs');
const { BCRYPT_COST, bcryptInput } = require('../crypto/kdf.js');

const scryptAsync = promisify(crypto.scrypt);

/* Formato de bcrypt: $2<variante>$<coste>$<sal><hash> */
const ES_BCRYPT = /^\$2[aby]\$\d{2}\$/;
/* Formato antiguo: scrypt en hex (64 bytes = 128 caracteres). */
const ES_SCRYPT_HEX = /^[a-f0-9]{128}$/i;

/**
 * Deriva el hash de una contraseña con bcrypt.
 *
 * La contraseña se pre-hasha con SHA-256 en Base64 antes de entrar en bcrypt:
 * bcrypt trunca la entrada a 72 bytes, y una contraseña larga (o con bytes
 * multibyte) perdería la parte que no cabe. El pre-hash conserva la
 * entropía completa y evita el truncamiento.
 *
 * @param {string} password
 * @returns {Promise<string>} hash bcrypt
 */
async function hashPassword(password) {
    return bcrypt.hash(bcryptInput(password), BCRYPT_COST);
}

/**
 * Comprueba una contraseña contra el hash guardado.
 *
 * Acepta los dos formatos (bcrypt y el scrypt antiguo) para que las cuentas
 * existentes sigan entrando.
 *
 * @param {string} password
 * @param {string} stored  hash guardado en `users.password_hash`
 * @param {string} [salt]  sal de la columna `password_salt` (formato antiguo)
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, stored, salt) {
    if (typeof stored !== 'string' || !stored) return false;
    if (typeof password !== 'string') return false;
    if (ES_BCRYPT.test(stored)) {
        try { return await bcrypt.compare(bcryptInput(password), stored); }
        catch { return false; }
    }
    if (ES_SCRYPT_HEX.test(stored) && typeof salt === 'string' && salt) {
        try {
            const calculado = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
            const guardado = Buffer.from(stored, 'hex');
            if (guardado.length !== calculado.length) return false;
            return crypto.timingSafeEqual(calculado, guardado);
        } catch { return false; }
    }
    return false;
}

/** ¿El hash guardado está en el formato antiguo (scrypt)? */
function esHashAntiguo(stored) {
    return typeof stored === 'string' && ES_SCRYPT_HEX.test(stored);
}

module.exports = { hashPassword, verifyPassword, esHashAntiguo, ES_BCRYPT };

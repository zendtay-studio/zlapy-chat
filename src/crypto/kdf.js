/**
 * Derivación de llaves y verificación de contraseñas.
 *
 * Dos tipos de KDF, con librerías externas y no con el módulo nativo:
 *
 *   · scrypt (@noble/hashes) deriva la LLAVE MAESTRA a partir de la credencial
 *     del propietario (DB_USER + DB_PASSWORD). Es una KDF lenta y con coste de
 *     memoria: sin ella, la contraseña del .env sería la llave y se podría
 *     probar a fuerza bruta sin más coste que un hash.
 *   · bcryptjs verifica las contraseñas de las CUENTAS de la aplicación. Aquí
 *     bcrypt es la herramienta adecuada: es un hash de contraseña, no una
 *     fuente de llave, y su salida truncada no importa para verificar.
 *
 * Por qué no bcrypt para derivar la llave: bcrypt corta la entrada a 72 bytes
 * y no produce 256 bits de salida utilizables como llave simétrica. Para
 * derivarMaterial criptográfico con contraseña se usa scrypt o argon2.
 *
 * Por qué no argon2: es más resistente que scrypt contra GPU/ASIC, pero su
 * implementación habitual es un módulo nativo que hay que compilar (y este
 * proyecto también corre en Termux/Android, donde compilar es un MARTIRIO).
 * scrypt de @noble/hashes es JS puro, auditado y sin compilación.
 */
'use strict';

const crypto = require('node:crypto');
const { scrypt } = require('@noble/hashes/scrypt.js');
const bcrypt = require('bcryptjs');

/* Coste de la derivación de la llave maestra: N=32768 y r=8 son 32 MiB de
   memoria por derivación, y una derivación tarda ~0,2-0,4 s. Ese coste es el
   que encarece una fuerza bruta offline de la credencial del .env. */
const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, dkLen: 32 });

/* Coste de bcrypt para las cuentas de la aplicación. bcryptjs es JS puro: el
   coste 10 tarda ~130 ms en un portátil y bastante más en un móvil; el 12
   doblaría el coste sin necesidad para el login diario. */
const BCRYPT_COST = 10;

/* El material de la credencial es "usuario\0contraseña": el separador evita
   que ("ab", "c") y ("a", "bc") den el mismo material. */
function credentialMaterial(user, password) {
    return `${String(user || '')}\0${String(password || '')}`;
}

/**
 * Deriva una llave de 32 bytes con scrypt.
 *
 * @param {string|Uint8Array} password material de la contraseña
 * @param {Buffer|Uint8Array} salt    sal de 16 bytes (única por instalación)
 * @param {object} [params]            {N, r, p, dkLen}
 * @returns {Buffer} 32 bytes
 */
function deriveKey(password, salt, params = SCRYPT_PARAMS) {
    const saltBytes = Buffer.isBuffer(salt) ? salt : Buffer.from(salt || []);
    if (saltBytes.length < 8)
        throw new Error('La sal de derivación debe tener al menos 8 bytes.');
    const { N, r, p, dkLen } = { ...SCRYPT_PARAMS, ...(params || {}) };
    const out = scrypt(password, saltBytes, { N, r, p, dkLen });
    return Buffer.from(out);
}

/**
 * Deriva la llave maestra a partir de la credencial del propietario.
 *
 * @param {string} user     DB_USER
 * @param {string} password DB_PASSWORD
 * @param {Buffer} salt     sal de `meta.kdf_salt`
 * @param {object} [params] parámetros de `meta.kdf_params`
 * @returns {Buffer} 32 bytes
 */
function deriveMasterKey(user, password, salt, params = SCRYPT_PARAMS) {
    return deriveKey(credentialMaterial(user, password), salt, params);
}

/* bcrypt corta la entrada a 72 bytes: una contraseña larga se truncaría y
   "contraseñaA" y "contraseñaB..." con el mismo prefijo colisionarían. Se
   pre-hashea con SHA-256 (y se codifica en base64, 44 caracteres) para que
   entre siempre entero y sin colisiones. */
function bcryptInput(password) {
    return crypto.createHash('sha256').update(String(password || ''), 'utf8').digest('base64');
}

/**
 * Hashea una contraseña de cuenta (bcryptjs).
 *
 * @param {string} password
 * @returns {string} hash bcrypt ($2b$…)
 */
function hashPassword(password) {
    if (typeof password !== 'string' || !password)
        throw new Error('La contraseña no puede estar vacía.');
    return bcrypt.hashSync(bcryptInput(password), BCRYPT_COST);
}

/**
 * Verifica una contraseña de cuenta contra su hash bcrypt.
 *
 * @param {string} password
 * @param {string} hash
 * @returns {boolean}
 */
function verifyPassword(password, hash) {
    if (typeof password !== 'string' || typeof hash !== 'string' || !hash) return false;
    try { return !!bcrypt.compareSync(bcryptInput(password), hash); }
    catch { return false; }
}

/* Estimación aproximada de la entropía de una contraseña, en bits. No es un
   medidor de calidad real (no sabe de diccionarios), pero sirve para AVISAR
   cuando la credencial del propietario es demasiado débil para la fuerza
   bruta offline que permite el KDF. */
function estimatePasswordBits(password) {
    const value = String(password || '');
    if (!value) return 0;
    let pool = 0;
    if (/[a-z]/.test(value)) pool += 26;
    if (/[A-Z]/.test(value)) pool += 26;
    if (/[0-9]/.test(value)) pool += 10;
    if (/[^A-Za-z0-9]/.test(value)) pool += 33;
    let bits = value.length * Math.log2(Math.max(pool, 2));
    // Una frase larga de palabras separa mejor que una cadena corta: cada
    // espacio añade ~4 bits de separación.
    bits += (value.match(/\s+/g) || []).length * 4;
    return Math.round(bits);
}

/* Contraseñas triviales que un KDF no salva: el coste de scrypt encarece cada
   intento, pero una contraseña de 4 dígitos cae igual. */
const WEAK_PASSWORDS = new Set([
    '1234', '12345', '123456', '1234567', '12345678', '123456789', '1234567890',
    'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
    'admin', 'admin123', 'administrator', 'root', 'root123', 'secret', 'secret123',
    'changeme', 'letmein', 'welcome', 'welcome1', 'iloveyou', 'abc123', '111111',
    'zaq12wsx', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'master'
]);

/**
 * ¿La contraseña es demasiado débil para ser la credencial del propietario?
 *
 * @param {string} password
 * @returns {{weak: boolean, bits: number, motivo: string}}
 */
function assessPassword(password) {
    const value = String(password || '');
    const bits = estimatePasswordBits(value);
    if (!value) return { weak: true, bits, motivo: 'la contraseña está vacía' };
    if (WEAK_PASSWORDS.has(value.toLowerCase()))
        return { weak: true, bits, motivo: 'es una de las contraseñas más usadas del mundo' };
    if (value.length < 12)
        return { weak: true, bits, motivo: `tiene menos de 12 caracteres (${bits} bits estimados)` };
    if (bits < 60)
        return { weak: true, bits, motivo: `solo unos ${bits} bits de entropía estimados` };
    return { weak: false, bits, motivo: `${bits} bits de entropía estimados` };
}

module.exports = {
    SCRYPT_PARAMS,
    BCRYPT_COST,
    credentialMaterial,
    deriveKey,
    deriveMasterKey,
    hashPassword,
    verifyPassword,
    estimatePasswordBits,
    assessPassword,
    bcryptInput
};

/**
 * Cifrado de contenido con la auth_key por usuario.
 *
 * Lo que hace de verdad: AES-256-GCM con una clave aleatoria de 2048 bits por
 * usuario y contexto autenticado (AAD) que ata cada sobre a su destino. El
 * envoltorio "MTProto 2.0" (server_salt, session_id, msg_id, seq_no, msg_key,
 * derivación sha256_a/sha256_b y relleno a bloque de 16) se eliminó: GCM ya
 * autentica el contenido, y ese armazón ni se verificaba ni se usaba.
 *
 * Formato: PCE3:<iv_b64>:<cifrado+tag_b64>
 */

'use strict';

const crypto = require('crypto');

const AUTH_KEY_BYTES = 256;      // 2048 bits aleatorios por usuario
const DOMAIN = Buffer.from('zlapy/content-aead/v4', 'utf8');

/* Identificador de la clave: SHA-256 truncado a 128 bits. (MTProto usa los 64
 * bits bajos de un SHA-1 por compatibilidad histórica; aquí no hay protocolo
 * heredado que conservar, y SHA-256/128 evita tanto la colisión corta como
 * apoyarse en un SHA-1 roto.) */
function authKeyId(authKey) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    return crypto.createHash('sha256').update(key).digest().subarray(0, 16).toString('hex');
}

/* Clave de AES (32 bytes) derivada de la auth_key con HKDF y dominio
 * dedicado. AES-256 exige exactamente 32 bytes; la auth_key sin derivar
 * (256 bytes) no sirve tal cual, y HKDF la proyecta al espacio correcto
 * sin usar la clave en claro para otra cosa. */
const CONTENT_KEY_INFO = Buffer.from('zlapy/aead-content/v4', 'utf8');
function contentKey(authKey) {
    return Buffer.from(crypto.hkdfSync('sha256', authKey, Buffer.alloc(0), CONTENT_KEY_INFO, 32));
}

/* Genera una auth_key aleatoria de 2048 bits. */
function generateAuthKey() {
    return crypto.randomBytes(AUTH_KEY_BYTES);
}

/* Cifra un contenido con la auth_key del usuario. Devuelve { keyId, blob }. */
function encrypt(authKey, body, extraAad = null) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    if (key.length !== AUTH_KEY_BYTES) throw new Error('auth_key invalida.');
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const iv = crypto.randomBytes(12);
    // `extraAad` liga el sobre a su contexto (chat, autor, tipo, marca de
    // tiempo): una fila movida de sitio deja de descifrar.
    const aad = extraAad ? Buffer.concat([DOMAIN, extraAad]) : DOMAIN;
    const cipher = crypto.createCipheriv('aes-256-gcm', contentKey(key), iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
    return {
        keyId: authKeyId(key),
        blob: `PCE3:${iv.toString('base64')}:${ciphertext.toString('base64')}`
    };
}

/* Descifra un sobre PCE3. Devuelve { body } o null si la autenticación
 * falla (eto incluye contexto manipulado o clave equivocada). */
function decrypt(authKey, blob, extraAad = null) {
    try {
        if (typeof blob !== 'string') return null;
        const parts = blob.split(':');
        if (parts.length !== 3 || parts[0] !== 'PCE3') return null;
        const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
        if (key.length !== AUTH_KEY_BYTES) return null;
        const iv = Buffer.from(parts[1], 'base64');
        const ciphertext = Buffer.from(parts[2], 'base64');
        if (iv.length !== 12 || ciphertext.length < 16) return null;
        const aad = extraAad ? Buffer.concat([DOMAIN, extraAad]) : DOMAIN;
        const decipher = crypto.createDecipheriv('aes-256-gcm', contentKey(key), iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(ciphertext.subarray(-16));
        const body = Buffer.concat([
            decipher.update(ciphertext.subarray(0, -16)),
            decipher.final()
        ]);
        return { body };
    } catch {
        return null;
    }
}

module.exports = {
    AUTH_KEY_BYTES,
    DOMAIN,
    authKeyId,
    generateAuthKey,
    encrypt,
    decrypt
};

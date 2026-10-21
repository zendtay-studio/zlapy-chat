/**
 * Cifrado del canal HTTP (capa de aplicación).
 *
 * Cuando el cliente se conecta por HTTP sin cifrar, el cuerpo de la petición
 * y el de la respuesta viajan en claro: en una red compartida, cualquiera que
 * espere el tráfico ve las contraseñas y los mensajes. Este módulo resuelve
 * ese caso con un sobre propio:
 *
 *   - El servidor tiene un par de claves X25519 cuya clave privada se deriva
 *     de la llave maestra (no hay que respaldar ningún secreto nuevo).
 *   - El cliente recibe la clave pública en `/config` y genera una clave
 *     efímera: con X25519 ambos calculan el mismo secreto compartido.
 *   - De ese secreto se deriva (HKDF-SHA256) una clave de sesión con la que
 *     se cifra el cuerpo con ChaCha20 y se autentica con HMAC-SHA256.
 *
 * El sobre viaja en cabeceras y el cuerpo va cifrado:
 *
 *   X-Zlapy-Enc:       x25519-chacha20-hmac-v1
 *   X-Zlapy-Ephemeral: clave pública efímera del cliente (base64)
 *   X-Zlapy-Nonce:     nonce de 12 bytes (base64)
 *   X-Zlapy-Time:      marca de tiempo en ms
 *
 * El contexto cifrado (AAD) ata el sobre a la petición (método, ruta y
 * marca de tiempo), de modo que un cuerpo no se puede mover a otra ruta ni
 * reutilizar más tarde.
 *
 * Esto protege frente a quien **escucha** el tráfico. No protege frente a
 * quien se interpone en la conexión: la clave pública se entrega por el
 * mismo canal y un atacante activo podría sustituirla. Para eso está HTTPS.
 */
'use strict';

const crypto = require('crypto');
const { getMasterKeyBytes } = require('./master-key.js');

/* Identificador del sobre: el cliente lo envía en `X-Zlapy-Enc`. */
const TRANSPORT_ALGO = 'x25519-chacha20-hmac-v1';
/* Info de HKDF: separa las derivaciones de clave de sesión. */
const SESSION_INFO = 'zlapy-transport-v1/session';
/* Margen de reloj admitido entre el cliente y el servidor. */
const MAX_CLOCK_SKEW_MS = 60_000;
/* Longitudes de los campos del sobre. */
const EPHEMERAL_BYTES = 32;
const NONCE_BYTES = 12;
const MAC_BYTES = 32;   // HMAC-SHA256

// Claves del servidor

/* X25519 en PKCS#8 y SPKI: son estructuras de tamaño fijo, así que la clave
 * cruda se envuelve sin necesidad de un parser ASN.1. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

/* El clamping que exige X25519: 3 bits bajos a 0, bit alto a 0 y bit 254 a 1. */
function clampScalar(bytes) {
    const out = Buffer.from(bytes);
    out[0] &= 248;
    out[31] &= 127;
    out[31] |= 64;
    return out;
}

let cached = null;

/* Deriva el par de claves de transporte de la llave maestra. */
function transportKeys() {
    if (cached) return cached;
    const master = getMasterKeyBytes();
    const raw = Buffer.from(crypto.hkdfSync(
        'sha256', master,
        Buffer.from('zlapy-transport-salt'),
        Buffer.from('x25519-private'),
        32
    ));
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_PREFIX, clampScalar(raw)]),
        format: 'der',
        type: 'pkcs8'
    });
    const publicKey = crypto.createPublicKey(privateKey);
    const publicRaw = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
    cached = { privateKey, publicKey, publicRaw };
    return cached;
}

/* Clave pública del servidor, en base64: es lo que se publica en /config. */
function transportPublicKey() {
    return transportKeys().publicRaw.toString('base64');
}

// Sobre: descifrado (servidor) y cifrado (ambos lados)

/* Contexto autenticado: ata el sobre a la petición concreta. */
function requestAad(method, path, time) {
    return `zlapy-transport-v1|REQ|${method}|${path}|${time}`;
}

function responseAad(method, path, time, status) {
    return `zlapy-transport-v1|RSP|${method}|${path}|${time}|${status}`;
}

/* Abre un sobre de clave pública cruda (32 bytes) como clave X25519. */
function importPublicKey(raw) {
    return crypto.createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, raw]),
        format: 'der',
        type: 'spki'
    });
}

/* Deriva la clave de sesión a partir del secreto compartido.
 * Son 64 bytes: 32 para ChaCha20 y 32 para el HMAC de la etiqueta.
 * `info` separa los dominios de uso (HTTP y WebSocket). */
function deriveSessionKey(privateKey, serverPublicRaw, ephemeralRaw, info = SESSION_INFO) {
    const shared = crypto.diffieHellman({
        privateKey,
        publicKey: importPublicKey(ephemeralRaw)
    });
    return Buffer.from(crypto.hkdfSync(
        'sha256', shared,
        Buffer.concat([ephemeralRaw, serverPublicRaw]),
        Buffer.from(info),
        64
    ));
}

/* Clave de sesión a partir de la clave pública efímera de un cliente. */
function sessionFromEphemeral(ephemeralRaw, info) {
    const { privateKey, publicRaw } = transportKeys();
    return deriveSessionKey(privateKey, publicRaw, ephemeralRaw, info);
}

/* Cifra con ChaCha20 y sella con HMAC-SHA256 (cifrar-y-luego-autenticar).
 * El nonce va en los 12 bytes últimos del IV de Node (los 4 primeros son el
 * contador, en little-endian). */
function seal(key, nonce, plaintext, aad) {
    const cipher = crypto.createCipheriv('chacha20', key.subarray(0, 32), Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const aadBytes = Buffer.from(aad || '', 'utf8');
    const mac = crypto.createHmac('sha256', key.subarray(32, 64))
        .update(Buffer.concat([aadBytes, u64le(aadBytes.length), nonce, ciphertext, u64le(ciphertext.length)]))
        .digest();
    return Buffer.concat([ciphertext, mac]);
}

/* Descifra un sobre; devuelve null si la autenticación falla. */
function open(key, nonce, ciphertext, aad) {
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length < MAC_BYTES) return null;
    const mac = ciphertext.subarray(ciphertext.length - MAC_BYTES);
    const body = ciphertext.subarray(0, ciphertext.length - MAC_BYTES);
    const aadBytes = Buffer.from(aad || '', 'utf8');
    const expected = crypto.createHmac('sha256', key.subarray(32, 64))
        .update(Buffer.concat([aadBytes, u64le(aadBytes.length), nonce, body, u64le(body.length)]))
        .digest();
    if (!crypto.timingSafeEqual(expected, mac)) return null;
    try {
        const decipher = crypto.createDecipheriv('chacha20', key.subarray(0, 32), Buffer.concat([Buffer.from([1, 0, 0, 0]), nonce]));
        return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
        return null;
    }
}

/* Longitud de 64 bits en little-endian (para el HMAC). */
function u64le(n) {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(BigInt(n));
    return out;
}

/* Normaliza a Buffer lo que llegue como Buffer o Uint8Array. */
function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return null;
}

/* Descifra el cuerpo de una petición cifrada.
 * Devuelve { key, plaintext } o null si el sobre no es válido. */
function decryptEnvelope({ method, path, time, ephemeral, nonce, ciphertext }) {
    const ephemeralRaw = toBuffer(ephemeral);
    const nonceRaw = toBuffer(nonce);
    const sealed = toBuffer(ciphertext);
    if (!ephemeralRaw || ephemeralRaw.length !== EPHEMERAL_BYTES) return null;
    if (!nonceRaw || nonceRaw.length !== NONCE_BYTES) return null;
    if (!sealed) return null;
    const key = sessionFromEphemeral(ephemeralRaw, SESSION_INFO);
    const plaintext = open(key, nonceRaw, sealed, requestAad(method, path, time));
    if (!plaintext) return null;
    return { key, plaintext };
}

/* Cifra un cuerpo con la clave de sesión de una petición. */
function encryptEnvelope(key, { method, path, time, status }, plaintext) {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const aad = responseAad(method, path, time, status);
    return { nonce, ciphertext: seal(key, nonce, Buffer.from(plaintext), aad) };
}

module.exports = {
    TRANSPORT_ALGO,
    MAX_CLOCK_SKEW_MS,
    transportPublicKey,
    sessionFromEphemeral,
    decryptEnvelope,
    encryptEnvelope,
    requestAad,
    responseAad,
    deriveSessionKey,
    seal,
    open,
};

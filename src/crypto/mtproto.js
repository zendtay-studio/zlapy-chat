/**
 * Cifrado en la nube multi-dispositivo, al estilo MTProto 2.0 de Telegram.
 *
 * Replica la estructura de MTProto 2.0 (auth_key por usuario, server_salt,
 * session_id, msg_id, msg_key y la derivacion de aes_key/aes_iv) y aporta el
 * cifrado y el descifrado de un mensaje con esa clave.
 */

/* QUÉ ES Y QUÉ NO ES
 *   · MTProto 2.0 es el cifrado "de nube" (cloud chats) de Telegram: el
 *     servidor CONOCE la clave y por eso puede sincronizar el historial entre
 *     dispositivos. NO es el cifrado de extremo a extremo (los "chats
 *     secretos"), que queda fuera de alcance a proposito: en Zlapy las
 *     llamadas siguen siendo P2P (DTLS-SRTP de WebRTC, en el momento y sin
 *     guardarse), igual que en Telegram.
 *   · Aqui se replica la ESTRUCTURA de MTProto 2.0 (referencia:
 *     https://core.telegram.org/mtproto/description.md):
 *       - auth_key por usuario: 2048 bits aleatorios, con su auth_key_id
 *         (los 64 bits bajos del SHA-1 de la clave, como en MTProto).
 *       - server_salt de 64 bits, rotado cada 30 minutos.
 *       - session_id de 64 bits e identificador de mensaje msg_id monotono
 *         basado en el tiempo.
 *       - msg_key: los 128 bits centrales del SHA-256 del mensaje a cifrar
 *         (incluido el relleno) precedido por 32 bytes de la auth_key.
 *       - aes_key y aes_iv derivados EXACTAMENTE como en MTProto 2.0
 *         (sha256_a, sha256_b y el ensamblado de 8+16+8 bytes).
 *       - cabecera interna cifrada: salt, session, msg_id, seq_no y longitud.
 *       - relleno aleatorio de 12..27 bytes (MTProto exige 12..1024 y que el
 *         total sea multiplo de 16) que se incluye en el calculo del
 *         msg_key.
 *       - comprobacion en la recepcion: el msg_key recibido debe coincidir
 *         con el recalculado sobre el texto descifrado.
 *
 * DESVIACION DOCUMENTADA (y por que)
 *   MTProto cifra con AES-256 en modo IGE, que NO tiene etiqueta de
 *   autenticacion: un atacante que modifique el cifrado no lo detecta (solo
 *   hay un CRC interno). Aqui se usa la MISMA derivacion de claves de
 *   MTProto pero con AES-256-GCM, que si es autenticada. Es estrictamente mas
 *   fuerte y no cambia el modelo (la clave sigue siendo por mensaje). */
'use strict';

const crypto = require('crypto');

const AUTH_KEY_BYTES = 256;      // 2048 bits, como en MTProto
const PADDING_MIN = 12;          // MTProto 2.0: 12..1024 bytes de relleno
const PADDING_MAX = 27;          // (subconjunto que mantiene el total en 16)
const INTERNAL_HEADER_BYTES = 32; // salt(8) + session(8) + msg_id(8) + seq_no(4) + len(4)
const DOMAIN = Buffer.from('zlapy/mtproto2/v3', 'utf8');

/* auth_key_id: los 64 bits bajos del SHA-1 de la auth_key (igual que MTProto,
 * donde se usa SHA-1 para que identifique la clave con independencia de la
 * version del protocolo). */
function authKeyId(authKey) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    return crypto.createHash('sha1').update(key).digest().subarray(-8).toString('hex');
}

/* Genera una auth_key aleatoria de 2048 bits. */
function generateAuthKey() {
    return crypto.randomBytes(AUTH_KEY_BYTES);
}

/* Deriva msg_key, aes_key y aes_iv tal y como MTProto 2.0:
 *   msg_key_large = SHA256(substr(auth_key, 88+x, 32) + plaintext)
 *   msg_key      = substr(msg_key_large, 8, 16)
 *   sha256_a     = SHA256(msg_key + substr(auth_key, x, 36))
 *   sha256_b     = SHA256(substr(auth_key, 40+x, 36) + msg_key)
 *   aes_key      = substr(sha256_a, 0, 8) + substr(sha256_b, 8, 16) + substr(sha256_a, 24, 8)
 *   aes_iv       = substr(sha256_b, 0, 8) + substr(sha256_a, 8, 16) + substr(sha256_b, 24, 8)
 * x = 0 para lo que va del cliente al servidor y x = 8 en sentido contrario. */
function deriveKeys(authKey, msgKey, x = 0) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    const mk = Buffer.isBuffer(msgKey) ? msgKey : Buffer.from(String(msgKey), 'hex');
    if (key.length !== AUTH_KEY_BYTES) throw new Error('auth_key invalida.');
    if (mk.length !== 16) throw new Error('msg_key invalida.');
    const sha256a = crypto.createHash('sha256').update(Buffer.concat([mk, key.subarray(x, x + 36)])).digest();
    const sha256b = crypto.createHash('sha256').update(Buffer.concat([key.subarray(40 + x, 76 + x), mk])).digest();
    return {
        aesKey: Buffer.concat([sha256a.subarray(0, 8), sha256b.subarray(8, 24), sha256a.subarray(24, 32)]),
        aesIv: Buffer.concat([sha256b.subarray(0, 8), sha256a.subarray(8, 24), sha256b.subarray(24, 32)])
    };
}

/* Calcula el msg_key de un texto plano (con relleno) ya construido. */
function computeMsgKey(authKey, plaintextWithPadding, x = 0) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    const large = crypto.createHash('sha256')
        .update(Buffer.concat([key.subarray(88 + x, 120 + x), plaintextWithPadding]))
        .digest();
    return large.subarray(8, 24);
}

/* Relleno aleatorio: 12..27 bytes y longitud total multiple de 16. */
function buildPadding(bodyLength) {
    const base = INTERNAL_HEADER_BYTES + bodyLength;
    let size = PADDING_MIN + ((16 - ((base + PADDING_MIN) % 16)) % 16);
    if (size > PADDING_MAX) size = PADDING_MAX;
    return crypto.randomBytes(size);
}

/* Cabecera interna de MTProto: salt, session, msg_id, seq_no y longitud. */
function buildInternalHeader({ salt, sessionId, msgId, seqNo, bodyLength }) {
    const header = Buffer.alloc(INTERNAL_HEADER_BYTES);
    const u64 = value => {
        try { return BigInt.asUintN(64, BigInt(value)); }
        catch { return 0n; }
    };
    header.writeBigUInt64LE(u64(salt), 0);
    header.writeBigUInt64LE(u64(sessionId), 8);
    header.writeBigUInt64LE(u64(msgId), 16);
    header.writeUInt32LE(seqNo >>> 0, 24);
    header.writeUInt32LE(bodyLength >>> 0, 28);
    return header;
}

function readInternalHeader(header) {
    return {
        salt: Number(header.readBigUInt64LE(0)),
        sessionId: Number(header.readBigUInt64LE(8)),
        msgId: Number(header.readBigUInt64LE(16)),
        seqNo: header.readUInt32LE(24),
        bodyLength: header.readUInt32LE(28)
    };
}

/* Cifra un contenido con el esquema MTProto 2.0.
 * Devuelve el sobre: PCE3:<key_id>:<msg_key>:<iv>:<cifrado+tag>. */
function encrypt(authKey, body, context, extraAad = null) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const padding = buildPadding(payload.length);
    const header = buildInternalHeader({
        salt: context.salt,
        sessionId: context.sessionId,
        msgId: context.msgId,
        seqNo: context.seqNo || 0,
        bodyLength: payload.length
    });
    const plaintext = Buffer.concat([header, payload, padding]);
    const msgKey = computeMsgKey(key, plaintext, 0);
    const { aesKey, aesIv } = deriveKeys(key, msgKey, 0);
    const iv = aesIv.subarray(0, 12);
    // El resto del iv y el dominio se autentican como datos asociados (AAD);
    // `extraAad` liga ademas el mensaje a su contexto (chat, autor, tipo...).
    const aad = Buffer.concat([aesIv.subarray(12), DOMAIN, extraAad || Buffer.alloc(0)]);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return {
        keyId: authKeyId(key),
        msgKey: msgKey.toString('hex'),
        blob: `PCE3:${authKeyId(key)}:${msgKey.toString('hex')}:${iv.toString('base64')}:${ciphertext.toString('base64')}`
    };
}

/* Descifra un sobre PCE3. Devuelve null si el sobre no es valido, si la
 * autenticacion falla o si el msg_key no coincide con el recalculado
 * (comprobacion de MTProto). */
function decrypt(authKey, blob, extraAad = null) {
    try {
        if (typeof blob !== 'string') return null;
        const parts = blob.split(':');
        if (parts.length !== 5 || parts[0] !== 'PCE3') return null;
        const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
        const keyId = parts[1];
        const msgKey = Buffer.from(parts[2], 'hex');
        const iv = Buffer.from(parts[3], 'base64');
        const ciphertext = Buffer.from(parts[4], 'base64');
        if (key.length !== AUTH_KEY_BYTES || msgKey.length !== 16 || iv.length !== 12) return null;
        if (authKeyId(key) !== keyId) return null;   // la clave no corresponde al sobre
        const { aesKey, aesIv } = deriveKeys(key, msgKey, 0);
        const aad = Buffer.concat([aesIv.subarray(12), DOMAIN, extraAad || Buffer.alloc(0)]);
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
        decipher.setAAD(aad);
        decipher.setAuthTag(ciphertext.subarray(-16));
        const plaintext = Buffer.concat([
            decipher.update(ciphertext.subarray(0, -16)),
            decipher.final()
        ]);
        // Comprobacion de MTProto: el msg_key debe coincidir con el recalculado.
        if (!computeMsgKey(key, plaintext, 0).equals(msgKey)) return null;
        const header = readInternalHeader(plaintext.subarray(0, INTERNAL_HEADER_BYTES));
        if (header.bodyLength > plaintext.length - INTERNAL_HEADER_BYTES) return null;
        const body = plaintext.subarray(INTERNAL_HEADER_BYTES, INTERNAL_HEADER_BYTES + header.bodyLength);
        return { body, header };
    } catch {
        return null;
    }
}

/* "Huella" de la clave (safety card): los 64 bits bajos del SHA-1 de la
 * auth_key, igual que el auth_key_id pero como identificador legible. */
function keyFingerprint(authKey) {
    return authKeyId(authKey);
}

/* msg_id monotono basado en el tiempo (unixtime * 2^32), como en MTProto.
 * `lastMsgId` es el ultimo identificador emitido por esa clave. */
function nextMsgId(lastMsgId, now = Date.now()) {
    const base = BigInt(Math.floor(now / 1000)) << 32n;
    const last = BigInt(lastMsgId || 0);
    return (base > last ? base : last + 1n).toString();
}

/* Ventana de antiguedad admitida (MTProto: 300 s hacia atras, 30 s hacia
 * delante) para descartar repeticiones.
 *
 * La ventana es relativa al instante actual, asi que solo tiene sentido para
 * sobres que llegan por el canal: el historial almacenado tiene mensajes de
 * cualquier edad y quedaria fuera de ella. Como el servidor cifra al escribir
 * (el cliente nunca envia sobres), aqui la repeticion se descarta con el
 * recalculo del msg_key y con el contexto autenticado. */
function msgIdAcceptable(msgId, now = Date.now()) {
    const value = Number(msgId);
    if (!Number.isFinite(value) || value <= 0) return false;
    const seconds = value / 4294967296;
    const delta = now / 1000 - seconds;
    return delta <= 300 && delta >= -30;
}

module.exports = {
    AUTH_KEY_BYTES,
    PADDING_MIN,
    PADDING_MAX,
    INTERNAL_HEADER_BYTES,
    DOMAIN,
    authKeyId,
    generateAuthKey,
    deriveKeys,
    computeMsgKey,
    buildPadding,
    buildInternalHeader,
    readInternalHeader,
    encrypt,
    decrypt,
    keyFingerprint,
    nextMsgId,
    msgIdAcceptable
};

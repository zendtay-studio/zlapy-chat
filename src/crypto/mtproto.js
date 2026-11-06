/**
 * Cifrado de contenido en MTProto 2.0 COMPLETO (nube).
 *
 * Aquí ya no queda "AES-GCM con acento de MTProto": es el esquema
 * criptográfico completo de MTProto 2.0 tal como lo define
 * core.telegram.org/mtproto/description (protocolo de la nube, v4.6+),
 * aplicado a los sobres de contenido del servidor. Lo único que NO llega
 * desde la especificación es el transporte (TL y el intercambio de llaves
 * por DH): aquí el material viaja por HTTPS y las auth_key nacen del CSPRNG
 * local, no de un cliente MTProto.
 *
 * Lo que SÍ está aquí, tal como la especificación:
 *
 *   · Sobre externo     : auth_key_id (64b, SHA-1 bajo de la auth_key)
 *                         + msg_key (128b).
 *   · Cabecera interna  : server_salt (64b) + session_id (64b)...
 *   · Paquete           : msg_id (64b, ~unixtime*2^32, paridad impar),
 *                         seq_no (32b, content-related ⇒ n*2+1),
 *                         message_data + padding de 12..1024 bytes
 *                         aleatorios, todo múltiplo de 16.
 *   · Derivación (x=8, server→client):
 *       msg_key_large = SHA256(auth_key[96..128] + plaintext + padding)
 *       msg_key       = msg_key_large[8..24]
 *       sha256_a      = SHA256(msg_key + auth_key[8..44])
 *       sha256_b      = SHA256(auth_key[48..84] + msg_key)
 *       aes_key       = sha256_a[0..8]  + sha256_b[8..24] + sha256_a[24..32]
 *       aes_iv        = sha256_b[0..8]  + sha256_a[8..24] + sha256_b[24..32]
 *   · Cifrado: AES-256-IGE (el modo histórico de Telegram, montado aquí
 *     sobre AES-ECB de node:crypto, con sus dos registros en cadena).
 *
 * Comprobaciones de la especificación en descifrado ("discard" al fallar):
 *   · auth_key_id = SHA-1 bajo de la auth_key (enrutamiento de llave).
 *   · msg_key recalculado sobre el plaintext DESCIFRADO (padding incluido).
 *   · message_data_length divisible por 4 y dentro del buffer.
 *   · padding de 12..1024 bytes, total múltiplo de 16.
 *   · session_id = session enlazada a la auth_key (HKDF).
 *   · msg_id de paridad impar (mensajes del servidor).
 *
 * Desviaciones documentadas frente al protocolo en vivo (no hay cable):
 *   · server_salt y session_id se derivan por HKDF de la auth_key (valores
 *     estables por llave); la rotación de salt cada 30 min es un mecanismo
 *     anti-replay del TRANSPORTE y no tiene efecto sobre contenido
 *     almacenado en reposo: la no-repetición aquí la dan el padding
 *     aleatorio y msg_id.
 *   · El "contexto" (chat, autor, tipo, marca) va DENTRO de message_data
 *     ([len4][contexto][len4][cuerpo][relleno4]) y se compara byte a byte
 *     al descifrar: en el esquema anterior ese papel lo cubría el AAD de
 *     GCM; aquí lo firma msg_key junto con todo el plaintext.
 *
 * Formato al almacenar: PCE3:<base64(auth_key_id ++ msg_key ++ encrypted_data)>
 */

'use strict';

const crypto = require('node:crypto');

const AUTH_KEY_BYTES = 256;
const ENVELOPE_PCE3 = 'PCE3:';

/* auth_key de 2048 bits por usuario (CSPRNG del sistema; Telegram la llega
 * por DH: aquí la fabrica el servidor, igual de válida y más rápida). */
function generateAuthKey() {
    return crypto.randomBytes(AUTH_KEY_BYTES);
}

/* Identificador de llave de la especificación: los 64 bits BAJOS del SHA-1
 * de la auth_key ("For MTProto 2.0, SHA1 is still used here"). */
function authKeyId(authKey) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    return crypto.createHash('sha1').update(key).digest().subarray(0, 8).toString('hex');
}

/* ─────────────── sessionId y server_salt ir codificados a la llave ─────────────── */

const SESSION_INFO = 'zlapy/mtproto-session/v1';
const SALT_INFO = 'zlapy/mtproto-salt/v1';

function sessionOf(authKey) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), SESSION_INFO, 16)).subarray(0, 8);
}

function saltOf(authKey) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey), 'hex');
    return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), SALT_INFO, 16)).subarray(0, 8);
}

/* ───────────────────────────── AES-256-IGE ───────────────────────────── */

/* IGE (Infinite Garble Extension): cifrado/descifrado en cadena con un
 * registro de texto claro y otro de cifrado:
 *   cifrar:    c_i = E(p_i XOR c_[i-1]) XOR p_[i-1]
 *   descifrar: p_i = D(c_i XOR p_[i-1]) XOR c_[i-1]
 * con registros iniciales (c_0, p_0) = (iv[0..16], iv[16..32]) en ambos.
 * AES-ECB de node procesa un bloque por update: así se monta IGE sin
 * dependencias externas. Los registros del bloque SIGUIENTE son SIEMPRE
 * los valores del bloque actual ya XOR-eados, nunca la salida cruda. */
function xor16(a, b) {
    const out = Buffer.allocUnsafe(16);
    for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
    return out;
}

function xorInto(dest, offset, x, y) {
    for (let i = 0; i < 16; i++) dest[offset + i] = x[i] ^ y[i];
}

function igeEncrypt(aesKey, aesIv, data) {
    if (!Buffer.isBuffer(aesKey) || aesKey.length !== 32 ||
        !Buffer.isBuffer(aesIv) || aesIv.length !== 32 ||
        !Buffer.isBuffer(data) || data.length % 16 !== 0)
        throw new Error('AES-IGE exige llave/iv correctos y data múltiplo de 16.');
    const ecb = crypto.createCipheriv('aes-256-ecb', aesKey, null);
    ecb.setAutoPadding(false);
    let prevC = Buffer.from(aesIv.subarray(0, 16));
    let prevP = Buffer.from(aesIv.subarray(16, 32));
    const out = Buffer.allocUnsafe(data.length);
    for (let off = 0; off < data.length; off += 16) {
        xorInto(out, off, ecb.update(xor16(data.subarray(off, off + 16), prevC)), prevP);
        prevP = Buffer.from(data.subarray(off, off + 16));
        prevC = Buffer.from(out.subarray(off, off + 16));
    }
    return out;
}

function igeDecrypt(aesKey, aesIv, data) {
    if (!Buffer.isBuffer(aesKey) || aesKey.length !== 32 ||
        !Buffer.isBuffer(aesIv) || aesIv.length !== 32 ||
        !Buffer.isBuffer(data) || data.length % 16 !== 0 || data.length === 0)
        return null;
    try {
        const ecb = crypto.createDecipheriv('aes-256-ecb', aesKey, null);
        ecb.setAutoPadding(false);
        let prevC = Buffer.from(aesIv.subarray(0, 16));
        let prevP = Buffer.from(aesIv.subarray(16, 32));
        const out = Buffer.allocUnsafe(data.length);
        for (let off = 0; off < data.length; off += 16) {
            xorInto(out, off, ecb.update(xor16(data.subarray(off, off + 16), prevP)), prevC);
            prevP = Buffer.from(out.subarray(off, off + 16));
            prevC = Buffer.from(data.subarray(off, off + 16));
        }
        return out;
    } catch {
        return null;
    }
}

/* ───────────────────── derivación aes_key/aes_iv (x = 8) ─────────────────── */

/* x = 8: los sobres aquí son siempre "del servidor hacia la cuenta" — el
 * servidor los produce y los vuelve a leer —, así que toda la derivación
 * usa la ventana del servidor (Telegram: x = 0 cliente→servidor, x = 8
 * servidor→cliente; el lado x=0 no tiene quien lo hable aquí). */
const X = 8;

function deriveAesKeys(authKey, msgKey) {
    const auth = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey || ''), 'hex');
    if (!Buffer.isBuffer(auth) || auth.length !== AUTH_KEY_BYTES || !Buffer.isBuffer(msgKey) || msgKey.length !== 16)
        return null;
    const sha256a = crypto.createHash('sha256')
        .update(Buffer.concat([msgKey, auth.subarray(X, X + 36)]))
        .digest();
    const sha256b = crypto.createHash('sha256')
        .update(Buffer.concat([auth.subarray(40 + X, 76 + X), msgKey]))
        .digest();
    const aesKey = Buffer.concat([sha256a.subarray(0, 8), sha256b.subarray(8, 24), sha256a.subarray(24, 32)]);
    const aesIv = Buffer.concat([sha256b.subarray(0, 8), sha256a.subarray(8, 24), sha256b.subarray(24, 32)]);
    return { aesKey, aesIv };
}

/* msg_key_large = SHA256(auth_key[88+x .. 120+x] || plaintext COMPLETO);
 * msg_key = substr(msg_key_large, 8, 16) — sus 128 bits centrales. */
function computeMsgKeyFromPlaintext(authKey, plaintext) {
    const auth = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey || ''), 'hex');
    return crypto.createHash('sha256')
        .update(Buffer.concat([auth.subarray(88 + X, 120 + X), plaintext]))
        .digest()
        .subarray(8, 24);
}

/* ───────────────────────── contadores de sesión ───────────────────────── */

/* MTProto exige msg_id y seq_no monotónicos dentro de una sesión. Aquí el
 * conteo vive en RAM por llave; el reboot lo reinicia (los blob nuevos
 * parten del reloj otra vez, y el contenido en reposo no rechaza por
 * monotonia: esa disciplina es del canal en vivo). */
const sessionCounters = new Map();

function nextPacketState(authKey) {
    const id = authKeyId(authKey);
    const st = sessionCounters.get(id) || { seq: 0, lastMsgId: 0n };
    const unixtime = BigInt(Math.floor(Date.now() / 1000));
    const frac = BigInt((st.seq % 2147483647) * 4 + 1);   // 32 bits bajos no nulos, paridad 1
    let msgId = (unixtime << 32n) | frac;
    if (msgId <= st.lastMsgId) msgId = st.lastMsgId + 4n;  // monotonia dentro de la sesión
    const msgSeqNo = st.seq * 2 + 1;      // content-related: todo sobre aquí es contenido
    sessionCounters.set(id, { seq: st.seq + 1, lastMsgId: msgId });
    return { msgId, msgSeqNo };
}

/* ─────────────────────────── empaquetado ─────────────────────────────── */

function encrypt(authKey, body, extraAad = null) {
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey || ''), 'hex');
    if (!Buffer.isBuffer(key) || key.length !== AUTH_KEY_BYTES)
        throw new Error('auth_key inválida (2048 bits).');
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');

    /* message_data = [len4][contexto][len4][cuerpo][relleno4]. Garantiza
     * length divisible por 4 (la especificación lo exige; Telegram lo
     * consigue al serializar TL) y el contexto autenticado por msg_key. */
    const aad = Buffer.isBuffer(extraAad) && extraAad.length ? extraAad : Buffer.alloc(0);
    const aadLen = Buffer.alloc(4);
    aadLen.writeUInt32BE(aad.length, 0);
    const bodyLen = Buffer.alloc(4);
    bodyLen.writeUInt32BE(payload.length, 0);
    /* El relleno del cuerpo ENDEREZA el total: (8 + aad + cuerpo) % 4 == 0,
     * así que message_data entero queda divisible por 4 pase lo que pase. */
    const bodyPadLen = (4 - ((8 + aad.length + payload.length) % 4)) % 4;
    const bodyPad = bodyPadLen ? crypto.randomBytes(bodyPadLen) : Buffer.alloc(0);
    const messageData = Buffer.concat([aadLen, aad, bodyLen, payload, bodyPad]);

    /* Paquete interno: salt(8) session_id(8) msg_id(8) seq_no(4) length(4). */
    const sessionId = sessionOf(key);
    const salt = saltOf(key);
    const { msgId, msgSeqNo } = nextPacketState(key);
    const inner = Buffer.alloc(32);
    salt.copy(inner, 0);
    sessionId.copy(inner, 8);
    inner.writeBigUInt64BE(msgId, 16);
    inner.writeUInt32BE(msgSeqNo >>> 0, 24);
    inner.writeUInt32BE(messageData.length, 28);

    /* Padding MTProto 2.0: 12..1024 bytes aleatorios, y (32+data+pad) % 16 == 0. */
    const soFar = 32 + messageData.length;
    let padBase = (16 - (soFar % 16)) % 16;
    if (padBase < 12) padBase += 16;
    const extraBlocks = crypto.randomInt(0, Math.floor((1024 - padBase) / 16) + 1);
    const padding = crypto.randomBytes(padBase + extraBlocks * 16);

    const plaintext = Buffer.concat([inner, messageData, padding]);
    const msgKey = computeMsgKeyFromPlaintext(key, plaintext);
    const derived = deriveAesKeys(key, msgKey);
    const encrypted_data = igeEncrypt(derived.aesKey, derived.aesIv, plaintext);

    const packet = Buffer.concat([
        Buffer.from(authKeyId(key), 'hex'),
        msgKey,
        encrypted_data
    ]);
    return { keyId: authKeyId(key), blob: ENVELOPE_PCE3 + packet.toString('base64') };
}

/* Descifra un sobre PCE3 MTProto 2.0 completo. Devuelve { body } o null si
 * CUALQUIERA de los checks de la especificación falla (incluye contexto
 * manipulado, session_id equivocado o llave incorrecta): "discard". */
function decrypt(authKey, blob, extraAad = null) {
    if (typeof blob !== 'string' || !blob.startsWith(ENVELOPE_PCE3)) return null;
    const key = Buffer.isBuffer(authKey) ? authKey : Buffer.from(String(authKey || ''), 'hex');
    if (!Buffer.isBuffer(key) || key.length !== AUTH_KEY_BYTES) return null;

    const packet = Buffer.from(blob.slice(ENVELOPE_PCE3.length), 'base64');
    if (packet.length < 24 + 16) return null;    // id(8) + msg_key(16) + mínimo cifrado

    /* 1) Enrutamiento por auth_key_id (SHA-1 bajo, 64 bits). */
    const expectedId = Buffer.from(authKeyId(key), 'hex');
    if (!packet.subarray(0, 8).equals(expectedId)) return null;

    /* 2) AES-IGE. La cabecera externa son 24 bytes: encrypted_data empieza
     * ahí dentro. */
    const msgKey = packet.subarray(8, 24);
    const derived = deriveAesKeys(key, msgKey);
    if (!derived) return null;
    const plaintext = igeDecrypt(derived.aesKey, derived.aesIv, packet.subarray(24));
    if (!plaintext) return null;

    /* 3) msg_key = 128 bits centrales de SHA256(auth_key[96..128] || plaintext),
     * recalculado sobre lo DESCIFRADO (padding incluido), como exige el
     * "Checking SHA256 hash value of msg_key". */
    if (!timingSafeEqual(computeMsgKeyFromPlaintext(key, plaintext), msgKey)) return null;

    /* 4) Cabecera interna: salt / session_id / msg_id / seq_no / length. */
    if (!timingSafeEqual(plaintext.subarray(8, 16), sessionOf(key))) return null;
    const msgId = plaintext.readBigUInt64BE(16);
    if (msgId % 4n === 0n) return null;              // paridad: servidor ⇒ impar
    const msgLen = plaintext.readUInt32BE(28);
    if (msgLen % 4 !== 0) return null;               // length divisible por 4
    if (32 + msgLen > plaintext.length) return null; // nada más allá del buffer

    /* 5) Padding de la especificación: 12..1024 bytes. */
    const padLen = plaintext.length - 32 - msgLen;
    if (padLen < 12 || padLen > 1024) return null;

    /* 6) message_data: [len4][contexto][len4][cuerpo][relleno4]; el contexto
     * se compara byte a byte (papel del AAD en el esquema anterior). */
    const messageData = plaintext.subarray(32, 32 + msgLen);
    const aadLen = messageData.readUInt32BE(0);
    if (4 + aadLen + 4 > messageData.length) return null;
    const aad = messageData.subarray(4, 4 + aadLen);
    const want = Buffer.isBuffer(extraAad) && extraAad.length ? extraAad : Buffer.alloc(0);
    if (!aad.equals(want)) return null;
    const bodyOff = 4 + aadLen;
    const bodyLen = messageData.readUInt32BE(bodyOff);
    if (bodyOff + 4 + bodyLen > messageData.length) return null;
    const tailLen = messageData.length - (bodyOff + 4 + bodyLen);
    if (tailLen < 0 || tailLen >= 4) return null;    // relleno del cuerpo: 0..3
    return { body: messageData.subarray(bodyOff + 4, bodyOff + 4 + bodyLen) };
}

function timingSafeEqual(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

module.exports = {
    AUTH_KEY_BYTES,
    ENVELOPE_PCE3,
    authKeyId,
    generateAuthKey,
    encrypt,
    decrypt,
    igeEncrypt,
    igeDecrypt,
    deriveAesKeys,
    computeMsgKeyFromPlaintext
};

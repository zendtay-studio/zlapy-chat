// Tests del esquema de cifrado en la nube (MTProto 2.0) y de su integracion
// en el servidor: clave por usuario, clave de mensaje derivada, cabecera
// interna, relleno, comprobaciones de recepcion y aislamiento de la llave
// maestra.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const path = require('node:path');
const mtproto = require('../src/crypto/mtproto.js');

const ctx = (over = {}) => ({
    salt: 0x1234567890abcdefn,
    sessionId: 0x1122334455667788n,
    msgId: mtproto.nextMsgId(0),
    seqNo: 1,
    ...over
});

test('ida y vuelta: el contenido se recupera integro', () => {
    const key = mtproto.generateAuthKey();
    const texto = 'mensaje con acentos: ñ, á, é — y emoji 🦞';
    const { blob } = mtproto.encrypt(key, texto, ctx());
    const out = mtproto.decrypt(key, blob);
    assert.ok(out, 'debe descifrar');
    assert.equal(out.body.toString('utf8'), texto);
});

test('la auth_key son 2048 bits y su identificador son los 64 bits bajos del SHA-1', () => {
    const key = mtproto.generateAuthKey();
    assert.equal(key.length, 256);
    const expected = crypto.createHash('sha1').update(key).digest().subarray(-8).toString('hex');
    assert.equal(mtproto.authKeyId(key), expected);
    assert.equal(mtproto.keyFingerprint(key), expected);
});

test('la derivacion de claves sigue las formulas de MTProto 2.0', () => {
    const key = mtproto.generateAuthKey();
    const plaintext = Buffer.from('contenido a cifrar', 'utf8');
    const msgKey = mtproto.computeMsgKey(key, plaintext, 0);
    // msg_key = los 128 bits centrales del SHA-256(auth_key[88..120] + plaintext)
    const large = crypto.createHash('sha256')
        .update(Buffer.concat([key.subarray(88, 120), plaintext])).digest();
    assert.deepEqual(msgKey, large.subarray(8, 24));
    // aes_key = sha256_a[0:8] + sha256_b[8:24] + sha256_a[24:32]
    const sha256a = crypto.createHash('sha256').update(Buffer.concat([msgKey, key.subarray(0, 36)])).digest();
    const sha256b = crypto.createHash('sha256').update(Buffer.concat([key.subarray(40, 76), msgKey])).digest();
    const expectedKey = Buffer.concat([sha256a.subarray(0, 8), sha256b.subarray(8, 24), sha256a.subarray(24, 32)]);
    const { aesKey } = mtproto.deriveKeys(key, msgKey, 0);
    assert.deepEqual(aesKey, expectedKey);
    assert.equal(aesKey.length, 32);
});

test('con otra clave no se puede descifrar', () => {
    const { blob } = mtproto.encrypt(mtproto.generateAuthKey(), 'secreto', ctx());
    assert.equal(mtproto.decrypt(mtproto.generateAuthKey(), blob), null);
});

test('un cifrado manipulado se rechaza (autenticacion)', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto', ctx());
    const parts = blob.split(':');
    const ct = Buffer.from(parts[4], 'base64');
    ct[3] ^= 0xff;
    parts[4] = ct.toString('base64');
    assert.equal(mtproto.decrypt(key, parts.join(':')), null);
});

test('el msg_key del sobre tiene que coincidir con el recalculado', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto', ctx());
    const parts = blob.split(':');
    parts[2] = crypto.randomBytes(16).toString('hex');
    assert.equal(mtproto.decrypt(key, parts.join(':')), null);
});

test('el contexto va ligado: con otro contexto no descifra', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto', ctx(), Buffer.from('contexto-A', 'utf8'));
    assert.ok(mtproto.decrypt(key, blob, Buffer.from('contexto-A', 'utf8')));
    assert.equal(mtproto.decrypt(key, blob, Buffer.from('contexto-B', 'utf8')), null);
});

test('el relleno es aleatorio, de 12 a 27 bytes y deja el total en multiplo de 16', () => {
    const key = mtproto.generateAuthKey();
    const a = mtproto.encrypt(key, 'x', ctx());
    const b = mtproto.encrypt(key, 'x', ctx());
    assert.notEqual(a.blob, b.blob, 'dos cifrados del mismo texto deben ser distintos (relleno aleatorio)');
    for (const len of [1, 15, 16, 100, 1000]) {
        const padding = mtproto.buildPadding(len);
        assert.ok(padding.length >= mtproto.PADDING_MIN && padding.length <= mtproto.PADDING_MAX);
        assert.equal((mtproto.INTERNAL_HEADER_BYTES + len + padding.length) % 16, 0);
    }
});

test('la cabecera interna lleva sal, sesion, msg_id, seq_no y longitud', () => {
    const key = mtproto.generateAuthKey();
    const c = ctx();
    const { blob } = mtproto.encrypt(key, '12345', c);
    const out = mtproto.decrypt(key, blob);
    assert.equal(out.header.salt, Number(c.salt));
    assert.equal(out.header.sessionId, Number(c.sessionId));
    assert.equal(out.header.msgId, Number(c.msgId));
    assert.equal(out.header.seqNo, c.seqNo);
    assert.equal(out.header.bodyLength, 5);
});

test('el msg_id es monotono y basado en el tiempo', () => {
    const first = BigInt(mtproto.nextMsgId(0));
    const second = BigInt(mtproto.nextMsgId(first.toString()));
    assert.ok(second > first, 'debe crecer');
    const now = Date.now();
    const base = BigInt(Math.floor(now / 1000)) << 32n;
    assert.ok(first >= base - 4294967296n && first <= base + 4294967296n, 'debe estar cerca del tiempo actual');
});

test('la ventana anti-repeticion acepta lo reciente y rechaza lo antiguo', () => {
    assert.equal(mtproto.msgIdAcceptable(mtproto.nextMsgId(0)), true);
    const viejo = String(Math.floor(Date.now() / 1000 - 400) * 4294967296);
    assert.equal(mtproto.msgIdAcceptable(viejo), false, 'un mensaje de hace mas de 300 s se rechaza');
    const futuro = String(Math.floor(Date.now() / 1000 + 120) * 4294967296);
    assert.equal(mtproto.msgIdAcceptable(futuro), false, 'un mensaje mas de 30 s en el futuro se rechaza');
});

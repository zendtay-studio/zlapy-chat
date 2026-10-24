// Tests del cifrado de contenido (auth_key por usuario, AES-256-GCM con AAD).
// El armazón MTProto (sal, sesión, msg_id, msg_key, relleno) se eliminó: lo
// que queda es lo que aporta seguridad real.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const mtproto = require('../src/crypto/mtproto.js');

test('ida y vuelta: el contenido se recupera integro', () => {
    const key = mtproto.generateAuthKey();
    const texto = 'mensaje con acentos: ñ, á, é — y emoji 🦞';
    const { blob } = mtproto.encrypt(key, texto);
    assert.match(blob, /^PCE3:/);
    const out = mtproto.decrypt(key, blob);
    assert.ok(out, 'debe descifrar');
    assert.equal(out.body.toString('utf8'), texto);
});

test('la auth_key son 2048 bits y su identificador es SHA-256 truncado a 128 bits', () => {
    const key = mtproto.generateAuthKey();
    assert.equal(key.length, 256);
    const expected = crypto.createHash('sha256').update(key).digest().subarray(0, 16).toString('hex');
    assert.equal(mtproto.authKeyId(key), expected);
    assert.equal(mtproto.authKeyId(key).length, 32);
});

test('con otra clave no se puede descifrar', () => {
    const { blob } = mtproto.encrypt(mtproto.generateAuthKey(), 'secreto');
    assert.equal(mtproto.decrypt(mtproto.generateAuthKey(), blob), null);
});

test('un cifrado manipulado se rechaza (autenticación GCM)', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto');
    const parts = blob.split(':');
    const ct = Buffer.from(parts[2], 'base64');
    ct[3] ^= 0xff;
    parts[2] = ct.toString('base64');
    assert.equal(mtproto.decrypt(key, parts.join(':')), null);
});

test('el contexto va ligado: con otro AAD no descifra', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto', Buffer.from('contexto-A', 'utf8'));
    assert.ok(mtproto.decrypt(key, blob, Buffer.from('contexto-A', 'utf8')));
    assert.equal(mtproto.decrypt(key, blob, Buffer.from('contexto-B', 'utf8')), null);
    assert.equal(mtproto.decrypt(key, blob), null);
});

test('el sobre no altea su contenido tras re-cifrar el mismo texto (IV aleatorio)', () => {
    const key = mtproto.generateAuthKey();
    const a = mtproto.encrypt(key, 'x').blob;
    const b = mtproto.encrypt(key, 'x').blob;
    assert.notEqual(a, b, 'dos cifrados del mismo texto deben ser distintos (IV aleatorio)');
});

test('claves malformadas se rechazan sin colgar el proceso', () => {
    assert.equal(mtproto.decrypt(Buffer.alloc(31), 'PCE3:AAAA:AAAA'), null);
    assert.equal(mtproto.decrypt('no-es-buffer-32-bytes', 'PCE3:AAAA:AAAA'), null);
    assert.throws(() => mtproto.encrypt(Buffer.alloc(16), 'secreto'));
});

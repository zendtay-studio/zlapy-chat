// Tests del cifrado de contenido MTProto 2.0 COMPLETO:
// sobre externo (auth_key_id + msg_key), paquete interno
// (salt, session_id, msg_id, seq_no, length, padding 12..1024),
// AES-256-IGE y los checks de la especificación en descifrado.
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const mtproto = require('../../src/crypto/mtproto.js');

test('ida y vuelta: el contenido se recupera íntegro', () => {
    const key = mtproto.generateAuthKey();
    const texto = 'mensaje con acentos: ñ, á, é — y emoji 🦞';
    const { blob } = mtproto.encrypt(key, texto);
    assert.match(blob, /^PCE3:/);
    const out = mtproto.decrypt(key, blob);
    assert.ok(out, 'debe descifrar');
    assert.equal(out.body.toString('utf8'), texto);
});

test('la auth_key son 2048 bits y su identificador es el SHA-1 bajo (64 bits)', () => {
    const key = mtproto.generateAuthKey();
    assert.equal(key.length, 256);
    const expected = crypto.createHash('sha1').update(key).digest().subarray(0, 8).toString('hex');
    assert.equal(mtproto.authKeyId(key), expected);
    assert.equal(mtproto.authKeyId(key).length, 16);
});

test('el paquete interno respeta la tabla de la especificación', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'hola');
    const packet = Buffer.from(blob.slice(5), 'base64');
    // sobre externo: auth_key_id (8) + msg_key (16) + encrypted_data
    assert.equal(packet.subarray(0, 8).toString('hex'), mtproto.authKeyId(key), 'auth_key_id primero');
    // el descifrado IGE recupera salt/session/msg_id/seq_no/length
    const { aesKey, aesIv } = mtproto.deriveAesKeys(key, packet.subarray(8, 24));
    const plain = mtproto.igeDecrypt(aesKey, aesIv, packet.subarray(24));
    assert.ok(plain, 'IGE descifra');
    const msgId = plain.readBigUInt64BE(16);
    assert.ok(msgId % 4n !== 0n, 'msg_id de servidor: paridad impar');
    assert.equal(plain.readUInt32BE(24) % 2, 1, 'seq_no content-related: n*2+1');
    const msgLen = plain.readUInt32BE(28);
    assert.equal(msgLen % 4, 0, 'length divisible por 4');
    const pad = plain.length - 32 - msgLen;
    assert.ok(pad >= 12 && pad <= 1024, 'padding MTProto 2.0 de 12..1024 bytes');
    assert.equal((32 + msgLen + pad) % 16, 0, 'total múltiplo de 16');
    // salt y session_id enlazados a la llave por HKDF
    assert.ok(mtproto.deriveAesKeys(key, packet.subarray(8, 24)), 'la derivación proyecta a aes_key/aes_iv');
});

test('msg_key verificada sobre lo descifrado (padding incluido)', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto');
    const packet = Buffer.from(blob.slice(5), 'base64');
    const { aesKey, aesIv } = mtproto.deriveAesKeys(key, packet.subarray(8, 24));
    const plain = mtproto.igeDecrypt(aesKey, aesIv, packet.subarray(24));
    const recomputed = mtproto.computeMsgKeyFromPlaintext(key, plain);
    assert.deepEqual([...recomputed], [...packet.subarray(8, 24)]);
});

test('con otra clave no se puede descifrar (auth_key_id enruta la llave)', () => {
    const { blob } = mtproto.encrypt(mtproto.generateAuthKey(), 'secreto');
    assert.equal(mtproto.decrypt(mtproto.generateAuthKey(), blob), null);
});

test('un cifrado manipulado se rechaza (msg_key deja de verificar)', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto');
    const packet = Buffer.from(blob.slice(5), 'base64');
    packet[30] ^= 0xff;   // byte de encrypted_data
    assert.equal(mtproto.decrypt(key, 'PCE3:' + packet.toString('base64')), null);
});

test('manipular el msg_key del sobre también se rechaza', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto');
    const packet = Buffer.from(blob.slice(5), 'base64');
    packet[9] ^= 0x01;    // dentro de msg_key (externo)
    assert.equal(mtproto.decrypt(key, 'PCE3:' + packet.toString('base64')), null);
});

test('el contexto va ligado: con otro contexto no descifra', () => {
    const key = mtproto.generateAuthKey();
    const { blob } = mtproto.encrypt(key, 'secreto', Buffer.from('contexto-A', 'utf8'));
    assert.ok(mtproto.decrypt(key, blob, Buffer.from('contexto-A', 'utf8')));
    assert.equal(mtproto.decrypt(key, blob, Buffer.from('contexto-B', 'utf8')), null);
    assert.equal(mtproto.decrypt(key, blob), null);
});

test('el sobre nunca se repite (padding y msg_id aleatorios por paquete)', () => {
    const key = mtproto.generateAuthKey();
    const a = mtproto.encrypt(key, 'x').blob;
    const b = mtproto.encrypt(key, 'x').blob;
    assert.notEqual(a, b, 'dos cifrados del mismo texto deben ser distintos');
});

test('msg_id es monotónico dentro de la sesión y ≈ unixtime*2^32', () => {
    const key = mtproto.generateAuthKey();
    const ids = [];
    for (let i = 0; i < 5; i++) {
        const packet = Buffer.from(mtproto.encrypt(key, 'n' + i).blob.slice(5), 'base64');
        const { aesKey, aesIv } = mtproto.deriveAesKeys(key, packet.subarray(8, 24));
        ids.push(mtproto.igeDecrypt(aesKey, aesIv, packet.subarray(24)).readBigUInt64BE(16));
    }
    for (let i = 1; i < ids.length; i++) {
        assert.ok(ids[i] > ids[i - 1], 'msg_id crece');
    }
    const approx = BigInt(Math.floor(Date.now() / 1000)) << 32n;
    assert.ok(ids[0] > approx - (300n * 4294967296n) && ids[0] < approx + (30n * 4294967296n), '≈ unixtime*2^32');
});

test('claves y sobres malformados se rechazan sin colgar el proceso', () => {
    assert.equal(mtproto.decrypt(Buffer.alloc(31), 'PCE3:AAAA'), null);
    assert.equal(mtproto.decrypt('no-es-buffer', 'PCE3:AAAA'), null);
    assert.equal(mtproto.decrypt(mtproto.generateAuthKey(), 'PCE3-no'), null);
    assert.equal(mtproto.decrypt(mtproto.generateAuthKey(), 'PCE3:'), null);
    assert.throws(() => mtproto.encrypt(Buffer.alloc(16), 'secreto'));
});

// Los contadores MTProto por auth_key tienen cota y se olvidan con su llave.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const mtproto = require('../../src/crypto/mtproto.js');
const { createMessageCrypto } = require('../../src/crypto/message-crypto.js');
const { createUserAuthKeys } = require('../../src/crypto/user-auth-keys.js');

test('forgetSession elimina solo el contador de esa auth_key', () => {
    const key = mtproto.generateAuthKey();
    mtproto.encrypt(key, 'contador');
    assert.equal(mtproto.forgetSession(key), true);
    assert.equal(mtproto.forgetSession(key), false, 'la segunda poda es idempotente');
});

test('sessionCounters está acotado aunque entren muchas auth_key distintas', () => {
    for (let i = 0; i < mtproto.SESSION_COUNTERS_MAX + 3; i++)
        mtproto.encrypt(mtproto.generateAuthKey(), 'x');
    assert.ok(mtproto.sessionCounterCount() <= mtproto.SESSION_COUNTERS_MAX);
});

function estadoPaquete(key, blob) {
    const packet = Buffer.from(blob.slice('PCE3:'.length), 'base64');
    const { aesKey, aesIv } = mtproto.deriveAesKeys(key, packet.subarray(8, 24));
    const plain = mtproto.igeDecrypt(aesKey, aesIv, packet.subarray(24));
    return { msgId: plain.readBigUInt64BE(16), seqNo: plain.readUInt32BE(24) };
}

test('expulsar una auth_key no reinicia msg_id ni seq_no al reutilizarla', t => {
    t.mock.method(Date, 'now', () => 1_800_000_000_000);
    const volcados = new Map();
    mtproto.configureSessionPersistence({
        load: id => volcados.get(id) || 0,
        save: (id, seq) => volcados.set(id, seq),
        forget: id => volcados.delete(id)
    });
    t.after(() => mtproto.configureSessionPersistence());
    const key = mtproto.generateAuthKey();
    const primero = estadoPaquete(key, mtproto.encrypt(key, 'antes').blob);
    for (let i = 0; i < mtproto.SESSION_COUNTERS_MAX; i++)
        mtproto.encrypt(mtproto.generateAuthKey(), 'expulsa');
    const despues = estadoPaquete(key, mtproto.encrypt(key, 'después').blob);

    assert.ok(despues.msgId > primero.msgId, 'msg_id nunca retrocede ni se repite');
    assert.equal(despues.seqNo, primero.seqNo + 2, 'la sesión recupera su propia secuencia');
});

test('dos auth_keys intercaladas conservan cada una seq_no 1, 3, 5…', () => {
    const a = mtproto.generateAuthKey();
    const b = mtproto.generateAuthKey();
    assert.equal(estadoPaquete(a, mtproto.encrypt(a, 'a1').blob).seqNo, 1);
    assert.equal(estadoPaquete(b, mtproto.encrypt(b, 'b1').blob).seqNo, 1);
    assert.equal(estadoPaquete(a, mtproto.encrypt(a, 'a2').blob).seqNo, 3);
    assert.equal(estadoPaquete(b, mtproto.encrypt(b, 'b2').blob).seqNo, 3);
});

test('cacheAuthKey conserva la cota aunque se use durante una rotación', () => {
    const cifrado = createMessageCrypto(crypto.randomBytes(32));
    const authKeys = createUserAuthKeys({ db: {}, Stmt: {}, ...cifrado });
    for (let i = 0; i < 505; i++) {
        const key = mtproto.generateAuthKey();
        authKeys.cacheAuthKey('u-' + i, { key, keyId: mtproto.authKeyId(key) });
    }
    assert.equal(authKeys.authKeyCache.size, 500);
});

test('forgetAuthKey purga caché y contador al rotar o borrar la cuenta', () => {
    const filas = new Map();
    const Stmt = {
        getAuthKey: { get: id => filas.get(id) || null },
        insertAuthKey: { run: (userId, authKey, keyId) => filas.set(userId, { auth_key: authKey, key_id: keyId }) }
    };
    const cifrado = createMessageCrypto(crypto.randomBytes(32));
    const authKeys = createUserAuthKeys({ db: {}, Stmt, ...cifrado });
    authKeys.ensureAuthKey('u-1');
    authKeys.encryptForUser('u-1', 'contenido');
    const antes = mtproto.sessionCounterCount();

    assert.equal(authKeys.forgetAuthKey('u-1'), true);
    assert.equal(authKeys.authKeyCache.has('u-1'), false);
    assert.equal(mtproto.sessionCounterCount(), antes - 1);
});

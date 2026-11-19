// Integración del volcado SQLite usado al expulsar una sesión MTProto del LRU.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const mtproto = require('../../src/crypto/mtproto.js');
const { blobDb } = require('../../src/db/database.js');
require('../../src/crypto/setup.js'); // configura el adaptador SQLite real

function seqNo(key, blob) {
    const packet = Buffer.from(blob.slice('PCE3:'.length), 'base64');
    const { aesKey, aesIv } = mtproto.deriveAesKeys(key, packet.subarray(8, 24));
    return mtproto.igeDecrypt(aesKey, aesIv, packet.subarray(24)).readUInt32BE(24);
}

test('SQLite devuelve la secuencia propia tras expulsar y la olvida con la clave', () => {
    const key = mtproto.generateAuthKey();
    const id = mtproto.authKeyId(key);
    assert.equal(seqNo(key, mtproto.encrypt(key, 'primero').blob), 1);
    for (let i = 0; i < mtproto.SESSION_COUNTERS_MAX; i++)
        mtproto.encrypt(mtproto.generateAuthKey(), 'expulsa');

    assert.equal(blobDb.prepare('SELECT next_seq FROM mtproto_session_spill WHERE auth_key_id = ?').get(id)?.next_seq, 1,
        'la expulsión guardó el siguiente número de secuencia de ESA clave');
    assert.equal(seqNo(key, mtproto.encrypt(key, 'segundo').blob), 3);
    assert.equal(mtproto.forgetSession(key), true);
    assert.equal(blobDb.prepare('SELECT 1 FROM mtproto_session_spill WHERE auth_key_id = ?').get(id), undefined);
});

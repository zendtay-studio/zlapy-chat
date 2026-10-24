const assert = require('node:assert/strict');
const test = require('node:test');
const { createMessageCrypto } = require('../src/crypto/message-crypto.js');

const cryptoService = createMessageCrypto(Buffer.alloc(32, 7));
const userSeed = Buffer.alloc(32, 9); // la semilla que efectivamente llega por signingKeyFor
const cryptoService2 = createMessageCrypto(Buffer.alloc(32, 7), { signingKeyFor: () => userSeed });
const row = {
    id: 'message-1',
    chat: 'chat:uid-a__uid-b',
    ts: 1_800_000_000_000,
    from_id: 'uid-a',
    to_id: 'uid-b',
    kind: 'text',
    crypto_group_id: null
};
const message = {
    ...row,
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    data: 'hola',
    hash: '',
    once: false,
    edited: false,
    gallery: [],
    mentions: [],
    mentionLabels: {}
};

test('signs the message with a stable sender key and binds the recipient context', () => {
    const signed = cryptoService2.signMessage(message, row);
    assert.ok(signed.signature);
    assert.ok(signed.signingPublicKey);
    assert.equal(cryptoService2.verifyMessage(message, row, signed.signature, signed.signingPublicKey), true);
    assert.equal(cryptoService2.verifyMessage(
        message, { ...row, to_id: 'uid-c' }, signed.signature, signed.signingPublicKey
    ), false);
    assert.equal(cryptoService2.verifyMessage(
        { ...message, data: 'alterado' }, row, signed.signature, signed.signingPublicKey
    ), false);
});

test('la maestra NO es una segunda firma válida (solo acepta la semilla del usuario)', () => {
    // Par derivado de la llave MAESTRA: el antiguo verifyMessage lo aceptaba
    // siempre y era la puerta para firmar el contenido de cualquiera.
    const masterPair = cryptoService.signMessage(message, row);
    const userPair = cryptoService2.signMessage(message, row);
    assert.notEqual(masterPair.signingPublicKey, userPair.signingPublicKey);
    assert.equal(
        cryptoService2.verifyMessage(message, row, masterPair.signature, masterPair.signingPublicKey),
        false,
        'una firma hecha con la semilla maestra no debe verificar si la auth_key existe'
    );
});

test('encryptAtRest / decryptAtRest: ida y vuelta en el sobre actual (PCE1v2)', () => {
    const encrypted = cryptoService.encryptAtRest('dato sensible');
    assert.match(encrypted, /^PCE1v2:/, 'el sobre nuevo debe ser PCE1v2');
    assert.equal(cryptoService.decryptAtRest(encrypted), 'dato sensible');
    assert.equal(cryptoService.decryptAtRest('plano intacto'), 'plano intacto');
    // Manipular el texto cifrado rompe la autenticación: null, no basura.
    const parts = encrypted.split(':');
    const combined = Buffer.from(parts[2], 'base64');
    combined[2] ^= 0xff;
    parts[2] = combined.toString('base64');
    assert.equal(cryptoService.decryptAtRest(parts.join(':')), null);
});

test('decryptAtRest sigue entendiendo el sobre heredado PCE1 (AES con la maestra)', () => {
    // Fabricar un sobre legado con la maestra a pelo (como hacía la v1).
    const crypto = require('node:crypto');
    const master = Buffer.alloc(32, 7);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
    const body = Buffer.concat([cipher.update('dato legado', 'utf8'), cipher.final()]);
    const legacy = `PCE1:${iv.toString('base64')}:${Buffer.concat([body, cipher.getAuthTag()]).toString('base64')}`;
    assert.equal(cryptoService.decryptAtRest(legacy), 'dato legado');
});

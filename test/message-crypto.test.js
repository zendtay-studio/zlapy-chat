const assert = require('node:assert/strict');
const test = require('node:test');
const { createMessageCrypto } = require('../src/crypto/message-crypto.js');

const cryptoService = createMessageCrypto(Buffer.alloc(32, 7));
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

test('encrypts messages with authenticated immutable participant context', () => {
    const ciphertext = cryptoService.encryptMessage('contenido', row);
    assert.match(ciphertext, /^PCE2:/);
    assert.equal(cryptoService.decryptMessage(ciphertext, row), 'contenido');
    assert.throws(() => cryptoService.decryptMessage(ciphertext, { ...row, to_id: 'uid-c' }));
    assert.throws(() => cryptoService.decryptMessage(ciphertext, { ...row, chat: 'chat:uid-a__uid-c' }));
    assert.throws(() => cryptoService.decryptMessage(ciphertext, { ...row, kind: 'image' }));
});

test('signs the message with a stable sender key and binds the recipient context', () => {
    const signed = cryptoService.signMessage(message, row);
    assert.ok(signed.signature);
    assert.ok(signed.signingPublicKey);
    assert.equal(cryptoService.verifyMessage(message, row, signed.signature, signed.signingPublicKey), true);
    assert.equal(cryptoService.verifyMessage(
        message, { ...row, to_id: 'uid-c' }, signed.signature, signed.signingPublicKey
    ), false);
    assert.equal(cryptoService.verifyMessage(
        { ...message, data: 'alterado' }, row, signed.signature, signed.signingPublicKey
    ), false);
});

test('keeps legacy at-rest data readable during migration', () => {
    const encrypted = cryptoService.encryptAtRest('dato legado');
    assert.match(encrypted, /^PCE1:/);
    assert.equal(cryptoService.decryptAtRest(encrypted), 'dato legado');
    assert.equal(cryptoService.decryptMessage(encrypted, row), 'dato legado');
});

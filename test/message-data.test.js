const assert = require('node:assert/strict');
const test = require('node:test');
const { decryptLegacyMessageFields } = require('../src/shared/message-data.js');

function decryptLegacyValue(value) {
    return value.startsWith('PCE1:') ? value.slice('PCE1:'.length) : value;
}

test('decrypts old at-rest message fields while leaving current plaintext intact', () => {
    const migrated = decryptLegacyMessageFields({
        kind: 'text',
        data: 'PCE1:mensaje antiguo',
        name: 'PCE1:archivo antiguo',
        caption: 'caption actual',
        reply: { preview: 'PCE1:respuesta antigua', id: 'reply-id' }
    }, decryptLegacyValue);

    assert.equal(migrated.data, 'mensaje antiguo');
    assert.equal(migrated.name, 'archivo antiguo');
    assert.equal(migrated.caption, 'caption actual');
    assert.deepEqual(migrated.reply, { preview: 'respuesta antigua', id: 'reply-id' });
});

test('preserves plaintext and ignores non-message input', () => {
    const message = { kind: 'text', data: 'mensaje nuevo', reply: null };

    assert.deepEqual(decryptLegacyMessageFields(message, decryptLegacyValue), message);
    assert.equal(decryptLegacyMessageFields(null, decryptLegacyValue), null);
});

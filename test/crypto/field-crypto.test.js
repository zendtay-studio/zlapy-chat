// Cifrado en reposo de campos sueltos: cada columna va atada a su AAD, de
// modo que un texto cifrado no se puede pegar de una columna a otra.
const assert = require('node:assert/strict');
const test = require('node:test');

const { encField, decField, decFieldOrNull, isFieldEnvelope, aadOf, FIELD_TABLES } = require('../../src/crypto/field-crypto.js');

test('un campo cifrado vuelve a su valor original', () => {
    const cifrado = encField('groups.name', 'Nombre del grupo');
    assert.notEqual(cifrado, 'Nombre del grupo');
    assert.equal(isFieldEnvelope(cifrado), true);
    assert.equal(decField('groups.name', cifrado), 'Nombre del grupo');
});

test('el AAD ata el texto cifrado a SU columna', () => {
    const cifrado = encField('groups.name', 'Secreto');
    // La misma columna: se descifra.
    assert.equal(decField('groups.name', cifrado), 'Secreto');
    // Otra columna: NO se descifra (el AAD no coincide).
    assert.equal(decField('groups.description', cifrado), '');
    assert.equal(decFieldOrNull('groups.description', cifrado), null);
    assert.equal(decFieldOrNull('user_profiles.note', cifrado), null);
});

test('el texto cifrado de una columna no vale como el de otra', () => {
    const nombre = encField('groups.name', 'Grupo');
    const descripcion = encField('groups.description', 'Grupo');
    assert.notEqual(nombre, descripcion, 'ni el mismo texto produce el mismo sobre en columnas distintas');
});

test('los valores vacíos se quedan vacíos (no hay sobre que gastar)', () => {
    assert.equal(encField('groups.name', ''), '');
    assert.equal(isFieldEnvelope(encField('groups.name', '')), false);
    assert.equal(decField('groups.name', ''), '');
    assert.equal(decFieldOrNull('groups.name', ''), '');
});

test('un valor que no es texto se trata como vacío', () => {
    assert.equal(encField('groups.name', null), '');
    assert.equal(encField('groups.name', undefined), '');
    assert.equal(decField('groups.name', null), '');
    assert.equal(decFieldOrNull('groups.name', null), null);
});

test('un texto en claro (legacy) se devuelve tal cual, sin romperse', () => {
    assert.equal(decField('groups.name', 'Nombre en claro'), 'Nombre en claro');
    assert.equal(decFieldOrNull('groups.name', 'Nombre en claro'), 'Nombre en claro');
});

test('el AAD de cada columna es propio y estable', () => {
    assert.equal(aadOf('groups.name').toString('utf8'), 'field:groups.name');
    assert.equal(aadOf('groups.name').toString('hex'), aadOf('groups.name').toString('hex'));
    assert.notEqual(aadOf('groups.name').toString('hex'), aadOf('groups.description').toString('hex'));
});

test('el mapa de columnas cubre las que el motor de re-cifrado recorre', () => {
    const tablas = FIELD_TABLES.map(t => t.table);
    for (const esperada of ['user_chat_settings', 'user_stickers', 'user_privacy_users',
        'user_muted_peers', 'group_join_requests', 'groups', 'calls', 'push_subs'])
        assert.ok(tablas.includes(esperada), `falta la tabla ${esperada} en el mapa`);
    const grupos = FIELD_TABLES.find(t => t.table === 'groups');
    assert.deepEqual(grupos.columns, ['name', 'description', 'content_policy', 'invite_code']);
});

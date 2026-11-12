// M-01: la firma de mensajes sale SIEMPRE de la auth_key del usuario.
// Bug fijado: prepareStoredMessage firmaba ANTES de crear la auth_key, y la
// caché del par de firma (derivada entonces de la llave maestra) no se
// invalidaba al crear la clave, así que TODAS las firmas de una cuenta salían
// de la semilla maestra para siempre. Ahora ensureAuthKey va antes de firmar
// y createUserAuthKeys invalida la caché (onAuthKeyCreated → forgetSigningKey).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, stop, api, register, TEST_CREDENTIAL } = require('../helpers.js');

const ROOT = path.join(__dirname, '..', '..');

/* Firma + clave pública de firma del último mensaje enviado, junto con el par
   esperado derivado de la auth_key de su autor. */
function lastMessageSigning(dataDir) {
    /* La llave maestra se DERIVA de la credencial del propietario: la sal
       está en la propia base de datos del servidor de prueba (meta.kdf_salt)
       y la credencial es la que usa el helper. */
    const { readKdfMaterial, deriveFromCredential } = require('../../src/crypto/owner-key.js');
    const { SCRYPT_PARAMS } = require('../../src/crypto/kdf.js');
    const dbPath = path.join(dataDir, 'zlapy.db');
    const db0 = new Database(dbPath, { readonly: true });
    const saltRow = db0.prepare("SELECT value FROM meta WHERE key = 'kdf_salt'").get();
    db0.close();
    assert.ok(saltRow, 'la base debe tener la sal de derivación');
    const salt = Buffer.from(saltRow.value, 'base64');
    const master = deriveFromCredential(TEST_CREDENTIAL, { salt, params: SCRYPT_PARAMS });
    assert.equal(master.length, 32, 'la llave maestra debe tener 32 bytes');
    const { createMessageCrypto } = require('../../src/crypto/message-crypto.js');
    const mc = createMessageCrypto(master);
    const db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    const row = db
        .prepare('SELECT from_id, signature, signing_public_key FROM messages ORDER BY ts DESC, id DESC LIMIT 1')
        .get();
    assert.ok(row, 'debe existir el mensaje enviado');
    const authRow = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get(row.from_id);
    assert.ok(authRow, 'el autor debe tener auth_key persistida');
    db.close();
    const authKey = Buffer.from(mc.decryptAtRest(authRow.auth_key), 'hex');
    const expected = createMessageCrypto(master, { signingKeyFor: () => authKey });
    return { row, expectedFromAuthKey: expected.getSigningPublicKey(row.from_id) };
}

test('la firma del mensaje se deriva de la auth_key del usuario (no de la maestra)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        assert.equal(ana.status, 201);
        const beto = await register(srv.base, 'beto');
        assert.equal(beto.status, 201);
        // Contacto mutuo: el chat entre no-contactos está restringido.
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        const sent = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'FIRMA-CLAVE-USUARIO-123' }, ana.cookie);
        assert.equal(sent.status, 200);
        assert.equal(sent.json.ok, true, 'el envio debe aceptarse: ' + JSON.stringify(sent.json).slice(0, 200));
        const { row, expectedFromAuthKey } = lastMessageSigning(srv.dataDir);
        assert.ok(row.signature, 'el mensaje lleva firma');
        assert.ok(row.signing_public_key, 'el mensaje lleva signing_public_key');
        assert.equal(row.signing_public_key, expectedFromAuthKey,
            'la clave almacenada debe ser la derivada de la auth_key del usuario');
        assert.equal(Buffer.from(row.signature, 'base64').length, 64, 'la firma es un Ed25519 de 64 bytes');
    } finally { await stop(srv); }
});

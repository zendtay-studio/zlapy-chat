// Migración del dominio de la llave maestra: cuando cambia la credencial del
// propietario (o se rota la sal), TODO lo que dependía de la llave se
// re-cifra con la nueva, y lo que estaba en claro (legacy) queda cifrado.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { hasMasterDataAtRest, isMasterEnvelope, rotateMasterKey } = require('../ops/reencrypt-master.js');
const { createMessageCrypto } = require('../src/crypto/message-crypto.js');
const { aadOf } = require('../src/crypto/field-crypto.js');
const { ensureSchema } = require('../src/db/schema.js');

/** Proyecto de juguete: un .env con credencial + data/ con las dos bases. */
function maqueta(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotacion-llave-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, 'DB_USER=ana\nDB_PASSWORD=clave-de-prueba-2026\nOTRA.cosas=línea que sobrevive\n');
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    const dbPath = path.join(dataDir, 'zlapy.db');
    const blobPath = path.join(dataDir, 'blob.db');
    const db = new Database(dbPath);
    ensureSchema(db);
    const blobDb = new Database(blobPath);
    blobDb.exec('CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data TEXT)');
    return { root, envPath, dbPath, blobPath, db, blobDb };
}

/** Rellena las bases con la llave dada. Devuelve los textos en claro. */
function rellenaBases({ oldKey, db, blobDb }) {
    const old = createMessageCrypto(oldKey);
    db.prepare('INSERT INTO users (id, username, password_hash, password_salt) VALUES (?, ?, ?, ?)')
        .run('u-ana', 'ana', 'x', 'y');
    db.prepare('INSERT INTO user_auth_keys (user_id, auth_key, key_id) VALUES (?, ?, ?)')
        .run('u-ana', old.encryptAtRest('authkey-de-ana-en-hex'), 'k-ana');
    db.prepare('INSERT INTO groups (id, crypto_id, name, description, content_policy, invite_code, keys_cipher, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('g-1', 'c-1', old.encryptAtRest('Nombre', aadOf('groups.name')),
            old.encryptAtRest('Descripción', aadOf('groups.description')),
            old.encryptAtRest('{}', aadOf('groups.content_policy')),
            old.encryptAtRest('inv-123', aadOf('groups.invite_code')),
            old.encryptAtRest('{"cryptoId":"c-1","keyboxes":["kb-1"]}'), 1);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('vapid', old.encryptAtRest('{"private":"VAPID-CLAVE"}'));
    blobDb.prepare('INSERT INTO blobs (hash, data) VALUES (?, ?)').run('h-1', old.encryptAtRest('contenido-adjunto-1'));
    return {
        authkeyPlain: 'authkey-de-ana-en-hex',
        grupoPlain: '{"cryptoId":"c-1","keyboxes":["kb-1"]}',
        vapidPlain: '{"private":"VAPID-CLAVE"}',
        blobPlain: 'contenido-adjunto-1',
        nombrePlain: 'Nombre'
    };
}

test('la migración re-cifra auth_keys, grupos, meta (VAPID), campos y adjuntos', t => {
    const oldKey = crypto.randomBytes(32);
    const { dbPath, blobPath, db, blobDb } = maqueta(t);
    const secretos = rellenaBases({ oldKey, db, blobDb });

    assert.equal(hasMasterDataAtRest(dbPath, blobPath), true);

    const newKey = crypto.randomBytes(32);
    const resultado = rotateMasterKey({
        dbPath, blobPath, oldKey, newKey, cryptoFactory: createMessageCrypto
    });
    assert.equal(resultado.authKeys, 1);
    assert.equal(resultado.groups, 1);
    assert.equal(resultado.meta, 1);
    assert.equal(resultado.blobs, 1);
    assert.ok(resultado.campos >= 4, 'los campos por columna también se re-cifran');

    const nueva = createMessageCrypto(newKey);
    const vieja = createMessageCrypto(oldKey);

    const authRow = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get('u-ana');
    assert.equal(nueva.decryptAtRest(authRow.auth_key), secretos.authkeyPlain, 'con la NUEVA se descifra');
    assert.equal(vieja.decryptAtRest(authRow.auth_key), null, 'con la VIEJA ya no');

    const grpRow = db.prepare('SELECT keys_cipher FROM groups WHERE id = ?').get('g-1');
    assert.equal(nueva.decryptAtRest(grpRow.keys_cipher), secretos.grupoPlain);
    assert.equal(vieja.decryptAtRest(grpRow.keys_cipher), null);

    const vapidRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('vapid');
    assert.equal(nueva.decryptAtRest(vapidRow.value), secretos.vapidPlain);
    assert.equal(vieja.decryptAtRest(vapidRow.value), null);

    const blobRow = blobDb.prepare('SELECT data FROM blobs WHERE hash = ?').get('h-1');
    assert.equal(nueva.decryptAtRest(blobRow.data), secretos.blobPlain);
    assert.equal(vieja.decryptAtRest(blobRow.data), null);

    // Los campos con AAD propio también.
    const nombre = db.prepare('SELECT name FROM groups WHERE id = ?').get('g-1').name;
    assert.equal(nueva.decryptAtRest(nombre, aadOf('groups.name')), secretos.nombrePlain);
    assert.equal(vieja.decryptAtRest(nombre, aadOf('groups.name')), null);

    // La fila EN CLARO de meta sobrevive sin despeinarse.
    assert.equal(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '4');
    db.close(); blobDb.close();
});

test('los valores EN CLARO heredados en columnas de maestra se recubren (subida de seguridad)', t => {
    const oldKey = crypto.randomBytes(32);
    const { dbPath, blobPath, db, blobDb } = maqueta(t);
    db.prepare('INSERT INTO groups (id, crypto_id, name, invite_code, keys_cipher, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('g-2', 'c-2', 'otro', 'inv', '{"cryptoId":"c-2","keyboxes":[]}', 1);
    db.prepare('INSERT INTO groups (id, crypto_id, name, invite_code, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('g-3', 'c-3', 'Nombre en claro', 'inv3', 1);
    blobDb.prepare('INSERT INTO blobs (hash, data) VALUES (?, ?)').run('h-plain', 'texto-en-claro-legacy');

    const newKey = crypto.randomBytes(32);
    rotateMasterKey({ dbPath, blobPath, oldKey, newKey, cryptoFactory: createMessageCrypto });

    const nueva = createMessageCrypto(newKey);
    const grpRow = db.prepare('SELECT keys_cipher FROM groups WHERE id = ?').get('g-2');
    assert.equal(isMasterEnvelope(grpRow.keys_cipher), true, 'en claro heredado → ahora sobre');
    assert.equal(nueva.decryptAtRest(grpRow.keys_cipher), '{"cryptoId":"c-2","keyboxes":[]}');
    const blobRow = blobDb.prepare('SELECT data FROM blobs WHERE hash = ?').get('h-plain');
    assert.equal(isMasterEnvelope(blobRow.data), true);
    assert.equal(nueva.decryptAtRest(blobRow.data), 'texto-en-claro-legacy');
    // El campo en claro también queda cifrado (con su AAD).
    const nombre = db.prepare('SELECT name FROM groups WHERE id = ?').get('g-3').name;
    assert.equal(isMasterEnvelope(nombre), true);
    assert.equal(nueva.decryptAtRest(nombre, aadOf('groups.name')), 'Nombre en claro');
    db.close(); blobDb.close();
});

test('migrar con una llave que NO descifra los datos aborta sin escribir nada', t => {
    const oldKey = crypto.randomBytes(32);
    const otraLlave = crypto.randomBytes(32);
    const { dbPath, blobPath, db, blobDb } = maqueta(t);
    const secretos = rellenaBases({ oldKey, db, blobDb });

    assert.throws(() => rotateMasterKey({
        dbPath, blobPath, oldKey: otraLlave, newKey: crypto.randomBytes(32), cryptoFactory: createMessageCrypto
    }), /no se descifra con la credencial actual/i);

    const authRow = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get('u-ana');
    assert.equal(createMessageCrypto(oldKey).decryptAtRest(authRow.auth_key), secretos.authkeyPlain,
        'los datos siguen legibles con la llave buena');
    db.close(); blobDb.close();
});

test('la reversión compensada devuelve TODAS las bases al estado previo si blob.db no se puede escribir', t => {
    const oldKey = crypto.randomBytes(32);
    const { dbPath, blobPath, db, blobDb } = maqueta(t);
    const secretos = rellenaBases({ oldKey, db, blobDb });

    // Candado: otra conexión mantiene BEGIN IMMEDIATE sobre blob.db. La
    // VERIFICACIÓN (sólo lectura) lo atraviesa sin problema; la fase de
    // APLICACIÓN pega el busy_timeout y lanza SQLITE_BUSY: excusá real para
    // ejercitar la reversión compensada con zlapy.db YA CONFIRMADA.
    const candado = new Database(blobPath);
    candado.exec('BEGIN IMMEDIATE');

    try {
        assert.throws(() => rotateMasterKey({
            dbPath, blobPath, oldKey, newKey: crypto.randomBytes(32), cryptoFactory: createMessageCrypto
        }), /blob|busy|database/i);
    } finally {
        candado.close();
    }

    const vieja = createMessageCrypto(oldKey);
    const authRow = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get('u-ana');
    assert.equal(vieja.decryptAtRest(authRow.auth_key), secretos.authkeyPlain, 'zlapy compensada (o nunca tocada) → legible con la vieja');
    const blobRow = blobDb.prepare('SELECT data FROM blobs WHERE hash = ?').get('h-1');
    assert.equal(vieja.decryptAtRest(blobRow.data), secretos.blobPlain, 'blob intacto');
    db.close(); blobDb.close();
});

test('hasMasterDataAtRest: esquema sin filas no es "datos"', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotacion-vacia-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dbPath = path.join(root, 'zlapy.db');
    const blobPath = path.join(root, 'blob.db');
    const db = new Database(dbPath); ensureSchema(db); db.close();
    const blobDb = new Database(blobPath); blobDb.exec('CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data TEXT)'); blobDb.close();
    assert.equal(hasMasterDataAtRest(dbPath, blobPath), false);
});

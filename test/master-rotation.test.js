const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { generateMasterKey, setEnvValue } = require('../ops/generate-master-key.js');
const { hasMasterDataAtRest, isMasterEnvelope, rotateMasterKey } = require('../ops/reencrypt-master.js');
const { createMessageCrypto } = require('../src/crypto/message-crypto.js');

const ZLAPY_TABLES = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_auth_keys (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auth_key TEXT NOT NULL, key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY, crypto_id TEXT NOT NULL, keys_cipher TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const BLOB_TABLES = 'CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, data TEXT);';

const nuevoPar = () => [crypto.randomBytes(32), crypto.randomBytes(32)];

/** Proyecto de juguete: .env con la llave dada + data/ con las dos bases. */
function maqueta(t, envKeyBase64) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotacion-llave-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const envPath = path.join(root, '.env');
    fs.writeFileSync(envPath, `CHAT_MASTER_KEY=${envKeyBase64}\nOTRA.cosas=línea que sobrevive\n`);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    const dbPath = path.join(dataDir, 'zlapy.db');
    const blobPath = path.join(dataDir, 'blob.db');
    const db = new Database(dbPath);
    db.exec(ZLAPY_TABLES);
    const blobDb = new Database(blobPath);
    blobDb.exec(BLOB_TABLES);
    return { root, envPath, dbPath, blobPath, db, blobDb };
}

/** Rellena las bases con la llave dada. Devuelve los textos en claro para las aserciones. */
function rellenaBases({ oldKey, db, blobDb }) {
    const old = createMessageCrypto(oldKey);
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u-ana', 'ana');
    db.prepare('INSERT INTO user_auth_keys (user_id, auth_key, key_id) VALUES (?, ?, ?)')
        .run('u-ana', old.encryptAtRest('authkey-de-ana-en-hex'), 'k-ana');
    db.prepare('INSERT INTO groups (id, crypto_id, keys_cipher) VALUES (?, ?, ?)')
        .run('g-1', 'c-1', old.encryptAtRest('{"cryptoId":"c-1","keyboxes":["kb-1"]}'));
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('vapid', old.encryptAtRest('{"private":"VAPID-CLAVE"}'));
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '3'); // en claro: no es de la maestra
    blobDb.prepare('INSERT INTO blobs (hash, data) VALUES (?, ?)').run('h-1', old.encryptAtRest('contenido-adjunto-1'));
    return {
        authkeyPlain: 'authkey-de-ana-en-hex',
        grupoPlain: '{"cryptoId":"c-1","keyboxes":["kb-1"]}',
        vapidPlain: '{"private":"VAPID-CLAVE"}',
        blobPlain: 'contenido-adjunto-1'
    };
}

test('la rotación gira la llave y re-cifra auth_keys, grupos, meta (VAPID) y adjuntos', t => {
    const [oldKey] = nuevoPar();
    const { envPath, dbPath, blobPath, db, blobDb } = maqueta(t, oldKey.toString('base64'));
    const secretos = rellenaBases({ oldKey, db, blobDb });

    assert.equal(hasMasterDataAtRest(dbPath, blobPath), true);

    const resultado = generateMasterKey(envPath, { force: true });
    assert.equal(resultado.rotated, true);
    assert.equal(resultado.authKeys, 1);
    assert.equal(resultado.groups, 1);
    assert.equal(resultado.meta, 1);
    assert.equal(resultado.blobs, 1);

    const nuevaLinea = fs.readFileSync(envPath, 'utf8').match(/^CHAT_MASTER_KEY=(.+)$/m)[1];
    assert.equal(Buffer.from(nuevaLinea, 'base64').length, 32);
    assert.notEqual(nuevaLinea, oldKey.toString('base64'));
    const nueva = createMessageCrypto(Buffer.from(nuevaLinea, 'base64'));
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

    // La fila EN CLARO de meta sobrevive sin despeinarse.
    assert.equal(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '3');
    // El resto del .env también.
    assert.match(fs.readFileSync(envPath, 'utf8'), /^OTRA\.cosas=/m);
    // Y no queda respaldo de la rotación.
    assert.ok(!fs.readdirSync(path.dirname(envPath)).some(f => f.endsWith('.master-bak')));
    db.close(); blobDb.close();
});

test('los valores EN CLARO heredados en columnas de maestra se recubren (subida de seguridad)', t => {
    const [oldKey] = nuevoPar();
    const { envPath, db, blobDb } = maqueta(t, oldKey.toString('base64'));
    db.prepare('INSERT INTO groups (id, crypto_id, keys_cipher) VALUES (?, ?, ?)').run('g-2', 'c-2', '{"cryptoId":"c-2","keyboxes":[]}');
    blobDb.prepare('INSERT INTO blobs (hash, data) VALUES (?, ?)').run('h-plain', 'texto-en-claro-legacy');

    generateMasterKey(envPath, { force: true });

    const nuevaLinea = fs.readFileSync(envPath, 'utf8').match(/^CHAT_MASTER_KEY=(.+)$/m)[1];
    const nueva = createMessageCrypto(Buffer.from(nuevaLinea, 'base64'));
    const grpRow = db.prepare('SELECT keys_cipher FROM groups WHERE id = ?').get('g-2');
    assert.equal(isMasterEnvelope(grpRow.keys_cipher), true, 'en claro heredado → ahora sobre');
    assert.equal(nueva.decryptAtRest(grpRow.keys_cipher), '{"cryptoId":"c-2","keyboxes":[]}');
    const blobRow = blobDb.prepare('SELECT data FROM blobs WHERE hash = ?').get('h-plain');
    assert.equal(isMasterEnvelope(blobRow.data), true);
    assert.equal(nueva.decryptAtRest(blobRow.data), 'texto-en-claro-legacy');
    db.close(); blobDb.close();
});

test('girar con una llave del .env que NO descifra los datos aborta sin escribir nada', t => {
    const [llaveVieja, otraLlave] = [crypto.randomBytes(32), crypto.randomBytes(32)];
    const { envPath, db, blobDb, dbPath, blobPath } = maqueta(t, otraLlave.toString('base64')); // .env con la llave INCORRECTA
    const secretos = rellenaBases({ oldKey: llaveVieja, db, blobDb });

    const contents = fs.readFileSync(envPath, 'utf8');
    assert.throws(() => generateMasterKey(envPath, { force: true }), /no se descifra con la llave del \.env/i);
    assert.equal(fs.readFileSync(envPath, 'utf8'), contents, 'el .env no se toca');
    const authRow = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get('u-ana');
    assert.equal(createMessageCrypto(llaveVieja).decryptAtRest(authRow.auth_key), secretos.authkeyPlain, 'los datos siguen legibles con la llave buena');
    db.close(); blobDb.close();
    assert.ok(!fs.readdirSync(path.dirname(envPath)).some(f => f.endsWith('.master-bak')));
});

test('la reversión compensada devuelve TODAS las bases al estado previo si blob.db no se puede escribir', t => {
    const [oldKey] = [crypto.randomBytes(32)];
    const { envPath, dbPath, blobPath, db, blobDb } = maqueta(t, oldKey.toString('base64'));
    const secretos = rellenaBases({ oldKey, db, blobDb });

    // Candado: otra conexión mantiene BEGIN IMMEDIATE sobre blob.db. La
    // VERIFICACIÓN de la rotación (sólo lectura) lo atraviesa sin problema;
    // la fase de APLICACIÓN pega cinco segundos (busy_timeout por defecto de
    // better-sqlite3) y lanza SQLITE_BUSY — excusada real para ejercitar la
    // reversión compensada con zlapy.db YA CONFIRMADA.
    const candado = new Database(blobPath);
    candado.exec('BEGIN IMMEDIATE');

    try {
        assert.throws(() => rotateMasterKey({
            dbPath, blobPath, envPath, oldKey, newKey: crypto.randomBytes(32),
            cryptoFactory: createMessageCrypto
        }), /blob|busy|database/i);
    } finally {
        candado.close();
    }

    const vieja = createMessageCrypto(oldKey);
    const envLinea = fs.readFileSync(envPath, 'utf8').match(/^CHAT_MASTER_KEY=(.+)$/m)[1];
    assert.equal(Buffer.from(envLinea, 'base64').toString('hex'), oldKey.toString('hex'), '.env devuelto a la llave vieja');
    const authRow = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get('u-ana');
    assert.equal(vieja.decryptAtRest(authRow.auth_key), secretos.authkeyPlain, 'zlapy compensada (o nunca tocada) → legible con la vieja');
    const blobRow = blobDb.prepare('SELECT data FROM blobs WHERE hash = ?').get('h-1');
    assert.equal(vieja.decryptAtRest(blobRow.data), secretos.blobPlain, 'blob intacto');
    assert.ok(!fs.readdirSync(path.dirname(envPath)).some(f => f.endsWith('.master-bak')), 'respaldo limpiado en la reversión exitosa');
    db.close(); blobDb.close();
});

test('un --force con base con datos y llave malformada aborta ("restaura la llave del respaldo")', t => {
    const [oldKey] = [crypto.randomBytes(32)];
    const { envPath, db, blobDb } = maqueta(t, oldKey.toString('base64'));
    rellenaBases({ oldKey, db, blobDb });
    setEnvValue(envPath, 'CHAT_MASTER_KEY', 'no-es-una-llave');

    assert.throws(() => generateMasterKey(envPath, { force: true }), /no codifica una llave válida de 32 bytes/i);
    const authRow = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get('u-ana');
    assert.equal(createMessageCrypto(oldKey).decryptAtRest(authRow.auth_key), 'authkey-de-ana-en-hex');
    db.close(); blobDb.close();
});

test('hasMasterDataAtRest: esquema sin filas no es "datos"', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotacion-vacia-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dbPath = path.join(root, 'zlapy.db');
    const blobPath = path.join(root, 'blob.db');
    const db = new Database(dbPath); db.exec(ZLAPY_TABLES); db.close();
    const blobDb = new Database(blobPath); blobDb.exec(BLOB_TABLES); blobDb.close();
    assert.equal(hasMasterDataAtRest(dbPath, blobPath), false);
});

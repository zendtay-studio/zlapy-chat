// Tests de la instalación nueva (lo que pasa la PRIMERA vez que se arranca):
//   · el `.env` se crea solo a partir de `.env.example`,
//   · la llave maestra se genera sola si la base de datos está vacía,
//   · pero NO se regenera si la base ya tiene cuentas (fail-fast).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { baseDeDatosConDatos } = require('../src/crypto/master-key.js');
const { ensureEnvFile } = require('../ops/generate-master-key.js');

function tempDir(t, prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('the .env is created from .env.example when it does not exist', t => {
    const directory = tempDir(t, 'zlapy-env-');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(path.join(directory, '.env.example'), 'PORT=3000\nCHAT_MASTER_KEY=\n');

    assert.equal(ensureEnvFile(envPath), true);

    const contents = fs.readFileSync(envPath, 'utf8');
    assert.match(contents, /^PORT=3000$/m);
    assert.match(contents, /^CHAT_MASTER_KEY=$/m);
    // El .env puede contener secretos: sólo el propietario puede leerlo.
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test('an existing .env is never overwritten', t => {
    const directory = tempDir(t, 'zlapy-env-');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, 'PORT=9999\n');
    fs.writeFileSync(path.join(directory, '.env.example'), 'PORT=3000\n');

    assert.equal(ensureEnvFile(envPath), false);
    assert.match(fs.readFileSync(envPath, 'utf8'), /^PORT=9999$/m);
});

test('a missing .env without an example is an explicit error', t => {
    const directory = tempDir(t, 'zlapy-env-');
    assert.throws(() => ensureEnvFile(path.join(directory, '.env')), /\.env\.example/);
});

test('a database without accounts does not count as data', t => {
    const directory = tempDir(t, 'zlapy-db-');
    const dbPath = path.join(directory, 'zlapy.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.close();

    assert.equal(baseDeDatosConDatos({ dbPath, blobPath: path.join(directory, 'blob.db') }), false);
});

test('a database with accounts counts as data', t => {
    const directory = tempDir(t, 'zlapy-db-');
    const dbPath = path.join(directory, 'zlapy.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
    db.close();

    assert.equal(baseDeDatosConDatos({ dbPath, blobPath: path.join(directory, 'blob.db') }), true);
});

test('a missing database does not count as data', t => {
    const directory = tempDir(t, 'zlapy-db-');
    assert.equal(baseDeDatosConDatos({
        dbPath: path.join(directory, 'zlapy.db'),
        blobPath: path.join(directory, 'blob.db')
    }), false);
});

test('an unreadable database is treated as data (fail-safe)', t => {
    const directory = tempDir(t, 'zlapy-db-');
    const dbPath = path.join(directory, 'zlapy.db');
    // Un fichero que no es una base SQLite: no se puede leer, así que se
    // asumen datos y el arranque se niega a generar una llave nueva.
    fs.writeFileSync(dbPath, 'esto no es una base de datos');
    assert.equal(baseDeDatosConDatos({
        dbPath,
        blobPath: path.join(directory, 'blob.db')
    }), true);
});

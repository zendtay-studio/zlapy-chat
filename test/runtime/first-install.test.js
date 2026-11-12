// Tests de la instalación nueva (lo que pasa la PRIMERA vez que se arranca):
//   · el `.env` se crea solo a partir de `.env.example`,
//   · la credencial del propietario (DB_USER + DB_PASSWORD) inicializa la
//     base si está vacía (de ahí sale la llave maestra),
//   · pero NO se inicializa si la base ya tiene cuentas (fail-fast): derivar
//     una llave nueva sobre datos existentes los volvería ilegibles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const { ensureEnvFile } = require('../../src/config.js');
const { baseDeDatosConDatos } = require('../../src/crypto/master-key.js');
const { ensureOwnerCredential, readMetaValue, verifyKeycheck } = require('../../src/crypto/owner-key.js');
const { ensureSchema } = require('../../src/db/schema.js');

function tempDir(t, prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('el .env se crea a partir del .env.example cuando no existe', t => {
    const directory = tempDir(t, 'zlapy-env-');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(path.join(directory, '.env.example'), 'PORT=3000\nDB_USER=\nDB_PASSWORD=\n');

    assert.equal(ensureEnvFile(envPath, path.join(directory, '.env.example')), true);

    const contents = fs.readFileSync(envPath, 'utf8');
    assert.match(contents, /^PORT=3000$/m);
    assert.match(contents, /^DB_USER=$/m);
    // El .env puede contener secretos: sólo el propietario puede leerlo.
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test('un .env existente nunca se sobrescribe', t => {
    const directory = tempDir(t, 'zlapy-env-');
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, 'PORT=9999\n');
    fs.writeFileSync(path.join(directory, '.env.example'), 'PORT=3000\n');

    assert.equal(ensureEnvFile(envPath, path.join(directory, '.env.example')), false);
    assert.match(fs.readFileSync(envPath, 'utf8'), /^PORT=9999$/m);
});

test('un .env que falta sin ejemplo es un error explícito', t => {
    const directory = tempDir(t, 'zlapy-env-');
    assert.throws(() => ensureEnvFile(path.join(directory, '.env'), path.join(directory, '.env.example')),
        /\.env\.example/);
});

test('una base sin cuentas no cuenta como datos', t => {
    const directory = tempDir(t, 'zlapy-db-');
    const dbPath = path.join(directory, 'zlapy.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.close();

    assert.equal(baseDeDatosConDatos({ dbPath, blobPath: path.join(directory, 'blob.db') }), false);
});

test('una base con cuentas cuenta como datos', t => {
    const directory = tempDir(t, 'zlapy-db-');
    const dbPath = path.join(directory, 'zlapy.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
    db.close();

    assert.equal(baseDeDatosConDatos({ dbPath, blobPath: path.join(directory, 'blob.db') }), true);
});

test('una base que no existe no cuenta como datos', t => {
    const directory = tempDir(t, 'zlapy-db-');
    assert.equal(baseDeDatosConDatos({
        dbPath: path.join(directory, 'zlapy.db'),
        blobPath: path.join(directory, 'blob.db')
    }), false);
});

test('una base ilegible se trata como con datos (camino seguro)', t => {
    const directory = tempDir(t, 'zlapy-db-');
    const dbPath = path.join(directory, 'zlapy.db');
    // Un fichero que no es una base SQLite: no se puede leer, así que se
    // asumen datos y el arranque se niega a derivar una llave nueva.
    fs.writeFileSync(dbPath, 'esto no es una base de datos');
    assert.equal(baseDeDatosConDatos({
        dbPath,
        blobPath: path.join(directory, 'blob.db')
    }), true);
});

test('la credencial inicializa una base nueva (keycheck + usuario)', t => {
    const directory = tempDir(t, 'zlapy-init-');
    const dbPath = path.join(directory, 'zlapy.db');
    const db = new Database(dbPath);
    ensureSchema(db);
    db.close();

    const resultado = ensureOwnerCredential({
        credential: { user: 'ana', password: 'clave-de-prueba-2026' },
        dbPath
    });
    assert.equal(resultado.nuevo, true);
    assert.equal(resultado.key.length, 32);
    assert.equal(readMetaValue('owner_user', { dbPath }), 'ana');
    assert.ok(readMetaValue('kdf_salt', { dbPath }), 'debe guardar la sal de derivación');
    assert.ok(verifyKeycheck(resultado.key, { dbPath }), 'el keycheck debe descifrar con la llave derivada');
});

test('una base con cuentas pero sin credencial NO se inicializa', t => {
    const directory = tempDir(t, 'zlapy-nocred-');
    const dbPath = path.join(directory, 'zlapy.db');
    const db = new Database(dbPath);
    ensureSchema(db);
    db.prepare('INSERT INTO users (id, username, password_hash, password_salt) VALUES (?, ?, ?, ?)').run('u1', 'ana', 'x', 'y');
    db.close();

    assert.throws(() => ensureOwnerCredential({
        credential: { user: 'ana', password: 'clave-de-prueba-2026' },
        dbPath
    }), /no tiene credencial de propietario/);
});

test('una credencial que no es la de la base no abre la instalación', t => {
    const directory = tempDir(t, 'zlapy-wrong-');
    const dbPath = path.join(directory, 'zlapy.db');
    const db = new Database(dbPath);
    ensureSchema(db);
    db.close();

    ensureOwnerCredential({ credential: { user: 'ana', password: 'clave-buena-2026' }, dbPath });
    assert.throws(() => ensureOwnerCredential({
        credential: { user: 'ana', password: 'clave-mala-2026' },
        dbPath
    }), /no corresponde a esta base/);
});

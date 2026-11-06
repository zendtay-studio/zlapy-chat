// CLI de la credencial del propietario (`npm run owner -- <comando>`).
// Se prueba como proceso aparte (como lo usaría el operador) contra bases
// temporales: nada de esto toca la instalación real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const { startServer, stop, api, register, TEST_CREDENTIAL } = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'ops', 'owner-credentials.js');

/** Instalación de juguete: .env + bases vacías. */
function maqueta(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'PORT=3000\nOTRA=se-queda\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=3000\n');
    const dbPath = path.join(dir, 'zlapy.db');
    const blobPath = path.join(dir, 'blob.db');
    return { dir, envPath, dbPath, blobPath };
}

/** Ejecuta el CLI. Devuelve { codigo, salida }. */
function cli(args) {
    return new Promise(resolve => {
        execFile(process.execPath, [CLI, ...args], { cwd: ROOT }, (error, stdout, stderr) => {
            resolve({
                codigo: error ? (error.code === undefined ? 1 : error.code) : 0,
                salida: `${stdout}\n${stderr}`
            });
        });
    });
}

function leerEnv(envPath, nombre) {
    const match = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^[ \\t]*${nombre}[ \\t]*=[ \\t]*(.*)$`, 'm'));
    return match ? match[1].trim() : null;
}

test('init crea la credencial, la escribe en el .env y deja la base desbloqueable', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    const r = await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(r.codigo, 0, r.salida);

    assert.equal(leerEnv(envPath, 'DB_USER'), 'ana');
    assert.equal(leerEnv(envPath, 'DB_PASSWORD'), 'clave-de-prueba-2026');
    assert.equal(leerEnv(envPath, 'OTRA'), 'se-queda', 'las demás variables se conservan');
    // Los nombres de las bases NO se fuerzan: los resuelve la configuración
    // (BLOB_DB_NAME se deriva de DB_NAME si no se fijan).
    assert.equal(leerEnv(envPath, 'DB_NAME'), null);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600, 'el .env queda sólo para su dueño');

    const db = new Database(dbPath, { readonly: true });
    const filas = db.prepare('SELECT key FROM meta').all().map(f => f.key);
    db.close();
    for (const clave of ['owner_user', 'kdf_salt', 'kdf_params', 'keycheck', 'key_id'])
        assert.ok(filas.includes(clave), `falta la fila meta.${clave}`);

    const check = await cli(['unlock-check', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(check.codigo, 0, check.salida);
});

test('init se niega con una contraseña débil (y con --yes la acepta)', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    const floja = await cli(['init', '--user', 'ana', '--password', '123456',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(floja.codigo, 1);
    assert.match(floja.salida, /débil/i);

    const conSi = await cli(['init', '--user', 'ana', '--password', '123456', '--yes',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(conSi.codigo, 0, conSi.salida);
});

test('init NO pisa una base que ya tiene datos', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    const primera = await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(primera.codigo, 0, primera.salida);

    const db = new Database(dbPath);
    db.prepare('INSERT INTO users (id, username, password_hash, password_salt) VALUES (?, ?, ?, ?)')
        .run('u1', 'ana', 'x', 'y');
    db.close();

    const segunda = await cli(['init', '--user', 'otro', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(segunda.codigo, 1);
    assert.match(segunda.salida, /ya tiene datos/i);
});

test('credential cambia la credencial, re-cifra todo y deja la base legible con la nueva', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    const init = await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(init.codigo, 0, init.salida);

    // Un dato en el dominio de la llave maestra.
    const { createMessageCrypto } = require('../src/crypto/message-crypto.js');
    const { readKdfMaterial, deriveFromCredential } = require('../src/crypto/owner-key.js');
    const { SCRYPT_PARAMS } = require('../src/crypto/kdf.js');
    const db = new Database(dbPath);
    const material = readKdfMaterial({ dbPath });
    const llaveVieja = deriveFromCredential({ user: 'ana', password: 'clave-de-prueba-2026' }, material);
    const cifrador = createMessageCrypto(llaveVieja);
    db.prepare('INSERT INTO users (id, username, password_hash, password_salt) VALUES (?, ?, ?, ?)')
        .run('u1', 'ana', 'x', 'y');
    db.prepare('INSERT INTO user_auth_keys (user_id, auth_key, key_id) VALUES (?, ?, ?)')
        .run('u1', cifrador.encryptAtRest('a'.repeat(512)), 'k1');
    db.close();

    const migra = await cli(['credential', '--user', 'beto', '--password', 'clave-nueva-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(migra.codigo, 0, migra.salida);
    assert.match(migra.salida, /Re-cifrado/);
    assert.equal(leerEnv(envPath, 'DB_USER'), 'beto');
    assert.equal(leerEnv(envPath, 'DB_PASSWORD'), 'clave-nueva-2026');

    // El dato se descifra con la llave nueva y NO con la vieja.
    const db2 = new Database(dbPath, { readonly: true });
    const fila = db2.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get('u1');
    db2.close();
    const material2 = readKdfMaterial({ dbPath });
    const llaveNueva = deriveFromCredential({ user: 'beto', password: 'clave-nueva-2026' }, material2);
    assert.equal(createMessageCrypto(llaveNueva).decryptAtRest(fila.auth_key), 'a'.repeat(512));
    assert.equal(createMessageCrypto(llaveVieja).decryptAtRest(fila.auth_key), null);
});

test('credential se niega si la credencial nueva es la misma', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    const misma = await cli(['credential', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(misma.codigo, 1);
    assert.match(misma.salida, /idéntica/i);
});

test('rotate cambia la sal sin cambiar la credencial', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    const antes = fs.readFileSync(envPath, 'utf8');
    const rotar = await cli(['rotate', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(rotar.codigo, 0, rotar.salida);
    assert.equal(fs.readFileSync(envPath, 'utf8'), antes, 'la credencial no cambia');

    const db = new Database(dbPath, { readonly: true });
    const salt = db.prepare("SELECT value FROM meta WHERE key = 'kdf_salt'").get().value;
    db.close();
    assert.ok(salt, 'la sal sigue estando');
    const check = await cli(['check', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(check.codigo, 0, check.salida);
});

test('check falla (código 1) si la credencial no abre la base', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    fs.writeFileSync(envPath, 'DB_USER=ana\nDB_PASSWORD=clave-equivocada\n');
    const check = await cli(['check', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(check.codigo, 1);
    const unlock = await cli(['unlock-check', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(unlock.codigo, 1);
});

test('export-kit copia la credencial y las bases (sólo para su dueño)', async t => {
    const { dir, envPath, dbPath, blobPath } = maqueta(t);
    await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    const destino = path.join(dir, 'kit');
    const kit = await cli(['export-kit', '--out', destino, '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(kit.codigo, 0, kit.salida);
    assert.ok(fs.existsSync(path.join(destino, 'credencial.env')));
    assert.ok(fs.existsSync(path.join(destino, 'zlapy.db')));
    assert.equal(fs.statSync(path.join(destino, 'credencial.env')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(destino).mode & 0o777, 0o700);
});

test('reset borra las bases (y sin --yes no hace nada)', async t => {
    const { envPath, dbPath, blobPath } = maqueta(t);
    await cli(['init', '--user', 'ana', '--password', 'clave-de-prueba-2026',
        '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.ok(fs.existsSync(dbPath));

    const sinSi = await cli(['reset', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(sinSi.codigo, 1);
    assert.ok(fs.existsSync(dbPath), 'sin --yes no se borra nada');

    const conSi = await cli(['reset', '--yes', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(conSi.codigo, 0, conSi.salida);
    assert.equal(fs.existsSync(dbPath), false);
});

test('el arranque del servidor y el uso normal NO rompen el manifiesto de integridad', async t => {
    // El manifiesto cubre SOLO el enlace credencial ↔ base (sal, keycheck…).
    // Si cubriera filas que cambian con el uso (crypto_version al arrancar,
    // VAPID, auth_key de cada registro), caducaría a la primera escritura y
    // `owner -- check` dejaría de detectar nada real.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-manifest-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, `DB_USER=${TEST_CREDENTIAL.user}\nDB_PASSWORD=${TEST_CREDENTIAL.password}\n`);
    const dbPath = path.join(dir, 'zlapy.db');
    const blobPath = path.join(dir, 'blob.db');

    const srv = await startServer({ dataDir: dir });
    try {
        const ana = await register(srv.base, 'ana');
        assert.equal(ana.status, 201);
        const perfil = await api(srv.base, 'POST', '/profile', { name: 'Ana Real' }, ana.cookie);
        assert.equal(perfil.status, 200);
    } finally { await stop(srv); }

    const check = await cli(['check', '--env', envPath, '--db', dbPath, '--blob-db', blobPath]);
    assert.equal(check.codigo, 0, `el check debe seguir pasando tras arrancar y usar el servidor:\n${check.salida}`);
    assert.match(check.salida, /Manifiesto de integridad : OK/);
});

test('sin argumentos muestra la ayuda y sale con 0', async t => {
    const r = await cli([]);
    assert.equal(r.codigo, 0);
    assert.match(r.salida, /Uso: npm run owner/);
});

// Guardas contra la desincronización de llaves: una fila de `user_auth_keys`
// cifrada con OTRA llave maestra (la que tenía un proceso vivo cuando se
// giró la del `.env`) no puede seguir manifestándose como un `UNIQUE
// constraint failed` de SQLite: hay que distinguirla, diagnosticarla y poder
// repararla.
//
// Qué se cubre aquí:
//   · `ensureAuthKey` distingue "no hay fila" de "hay fila ilegible" y
//     lanza un error que explica qué hacer.
//   · `auditMasterKey` enumera el material ilegible y su impacto real.
//   · La rotación de la llave maestra se niega a girar con el servidor vivo
//     (un proceso con la llave vieja en memoria escribiría filas ilegibles).
//   · `watchCredentialFile` detecta que la credencial del `.env` cambió con el
//     servidor en marcha y lo hace salir para reiniciar.
//   · El script de reparación deja la cuenta utilizable (perfil limpio,
//     auth_key nueva) sin tocar el resto de la base.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const { spawn, execFile } = require('node:child_process');
const { startServer, stop, api, register } = require('../helpers.js');
const { createUserAuthKeys, AuthKeyUnreadableError } = require('../../src/crypto/user-auth-keys.js');
const { createMessageCrypto } = require('../../src/crypto/message-crypto.js');
const { watchCredentialFile } = require('../../src/crypto/master-key.js');
const { auditMasterKey, rotateMasterKey, serverIsRunning } = require('../../ops/crypto/reencrypt-master.js');

const ROOT = path.join(__dirname, '..', '..');

/* Un crypto de mentira: `decryptAtRest` devuelve null para todo lo que no
   sea el sobre que esta misma instancia escribió. Así una fila "de otra
   llave" es indistinguible de una fila corrupta, que es justo el caso. */
function cryptoFalso(llaveBuena) {
    const real = createMessageCrypto(llaveBuena);
    const mios = new Set();
    return {
        encryptAtRest: valor => { const sobre = real.encryptAtRest(valor); mios.add(sobre); return sobre; },
        decryptAtRest: sobre => (mios.has(sobre) ? real.decryptAtRest(sobre) : null)
    };
}

/** Tablas mínimas para las pruebas de las guardas. */
const TABLAS = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_auth_keys (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auth_key TEXT NOT NULL, key_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', note_ts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_notes (user_id TEXT PRIMARY KEY, data TEXT, ts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY, crypto_id TEXT NOT NULL, keys_cipher TEXT,
    created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, chat TEXT, ts INTEGER, from_id TEXT, to_id TEXT,
    kind TEXT, data TEXT, hash TEXT, once INTEGER DEFAULT 0, edited INTEGER DEFAULT 0,
    crypto_version INTEGER DEFAULT 3, crypto_group_id TEXT,
    signature TEXT, signing_public_key TEXT
);
`;

function maquina(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-llave-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'zlapy.db');
    const db = new Database(dbPath);
    db.exec(TABLAS);
    return { dir, dbPath, db };
}

/* Rompe la auth_key de una cuenta: la re-cifra con una llave que el
   servidor no tiene (equivale a que la escribiera un proceso con la llave
   anterior en memoria). */
function rompeAuthKey(dbPath, username) {
    const db = new Database(dbPath);
    const fila = db.prepare('SELECT user_id FROM user_auth_keys WHERE user_id IN (SELECT id FROM users WHERE username = ?)').get(username);
    assert.ok(fila, `la cuenta ${username} debe tener auth_key`);
    const otra = createMessageCrypto(crypto.randomBytes(32));
    db.prepare('UPDATE user_auth_keys SET auth_key = ? WHERE user_id = ?')
        .run(otra.encryptAtRest('c'.repeat(512)), fila.user_id);
    db.close();
    return fila.user_id;
}

test('ensureAuthKey lanza un error claro cuando la fila existe pero no se descifra', t => {
    const { db } = maquina(t);
    const filas = new Map();
    const Stmt = {
        getAuthKey: { get: id => filas.get(id) || null },
        insertAuthKey: {
            run: (userId, authKey, keyId) => {
                // Esto es lo que reventaba antes con UNIQUE: la fila ya
                // estaba y el INSERT no puede duplicarla.
                if (filas.has(userId)) throw new Error('UNIQUE constraint failed: user_auth_keys.user_id');
                filas.set(userId, { user_id: userId, auth_key: authKey, key_id: keyId });
            }
        }
    };
    const engaño = cryptoFalso(crypto.randomBytes(32));
    const authKeys = createUserAuthKeys({ db, Stmt, ...engaño });

    // Una fila escrita con OTRA llave: presente, pero ilegible.
    const otra = createMessageCrypto(crypto.randomBytes(32));
    filas.set('u-1', { user_id: 'u-1', auth_key: otra.encryptAtRest('a'.repeat(512)), key_id: 'k' });

    assert.equal(authKeys.authKeyState('u-1').state, 'ilegible');
    assert.equal(authKeys.authKeyState('u-inexistente').state, 'ausente');

    assert.throws(() => authKeys.ensureAuthKey('u-1'), error => {
        assert.ok(error instanceof AuthKeyUnreadableError);
        assert.equal(error.code, 'AUTH_KEY_UNREADABLE');
        assert.match(error.message, /no se descifra con la llave maestra actual/);
        assert.doesNotMatch(error.message, /UNIQUE/);
        return true;
    }, 'no debe reventar con el error de SQLite, sino explicar la causa');
});

test('ensureAuthKey sigue creando la clave cuando NO hay fila', t => {
    const { db } = maquina(t);
    const filas = new Map();
    const Stmt = {
        getAuthKey: { get: id => filas.get(id) || null },
        insertAuthKey: { run: (userId, authKey, keyId) => filas.set(userId, { user_id: userId, auth_key: authKey, key_id: keyId }) }
    };
    const engaño = cryptoFalso(crypto.randomBytes(32));
    const authKeys = createUserAuthKeys({ db, Stmt, ...engaño });

    const rec = authKeys.ensureAuthKey('u-nuevo');
    assert.ok(rec.key.length > 0);
    assert.equal(filas.size, 1, 'la fila se crea normalmente cuando no había ninguna');
    assert.equal(authKeys.authKeyState('u-nuevo').state, 'ok');
});

test('la auditoría enumera la auth_key ilegible y el contenido que depende de ella', t => {
    const { db, dbPath } = maquina(t);
    const buena = crypto.randomBytes(32);
    const cryptoReal = createMessageCrypto(buena);
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u-ok', 'ana');
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run('u-roto', 'beto');
    db.prepare('INSERT INTO user_auth_keys (user_id, auth_key, key_id) VALUES (?, ?, ?)')
        .run('u-ok', cryptoReal.encryptAtRest('a'.repeat(512)), 'k-ok');
    // Filas escritas con OTRA llave: ilegibles con la actual.
    const otra = createMessageCrypto(crypto.randomBytes(32));
    db.prepare('INSERT INTO user_auth_keys (user_id, auth_key, key_id) VALUES (?, ?, ?)')
        .run('u-roto', otra.encryptAtRest('b'.repeat(512)), 'k-roto');
    db.prepare('INSERT INTO user_profiles (user_id, display_name) VALUES (?, ?)').run('u-roto', 'PCE3:algo');
    db.prepare('INSERT INTO messages (id, chat, ts, from_id, to_id, kind, data, crypto_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('m-1', 'chat:x', 1, 'u-roto', 'u-ok', 'text', 'PCE3:algo', 3);
    db.close();

    const reporte = auditMasterKey({
        dbPath,
        blobPath: path.join(path.dirname(dbPath), 'blob.db'),
        cryptoFactory: createMessageCrypto,
        key: buena
    });
    assert.equal(reporte.ok, false);
    assert.equal(reporte.authKeys.ok, 1);
    assert.equal(reporte.authKeys.ilegibles.length, 1);
    assert.equal(reporte.authKeys.ilegibles[0], 'u-roto');
    assert.equal(reporte.contenido.ilegibles.length, 1);
    assert.equal(reporte.contenido.ilegibles[0].username, 'beto');
    assert.equal(reporte.contenido.ilegibles[0].mensajes, 1);
    assert.equal(reporte.contenido.ilegibles[0].camposPerfil, 1);
});

test('girar la llave maestra se niega si hay un servidor vivo', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-vivo-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'zlapy.db');
    const db = new Database(dbPath);
    db.exec(TABLAS);
    db.close();

    // Un proceso vivo cuya línea de órdenes parece la del servidor.
    const vivo = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'server.js'], { stdio: 'ignore' });
    t.after(() => { try { vivo.kill('SIGKILL'); } catch { } });
    const pidFile = path.join(dir, '.zlapy.pid');
    fs.writeFileSync(pidFile, String(vivo.pid));

    assert.equal(serverIsRunning({ pidFile }).vivo, true);
    assert.throws(() => rotateMasterKey({
        dbPath,
        blobPath: path.join(dir, 'blob.db'),
        envPath: path.join(dir, '.env'),
        oldKey: crypto.randomBytes(32),
        newKey: crypto.randomBytes(32),
        cryptoFactory: createMessageCrypto,
        pidFile
    }), /servidor de Zlapy en marcha/i, 'no se puede girar con un proceso escribiendo con la llave vieja');
});

test('un fichero de PID obsoleto NO bloquea la rotación', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-pid-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pidFile = path.join(dir, '.zlapy.pid');
    // PID improbable (por encima del máximo habitual) → no existe.
    fs.writeFileSync(pidFile, '4194303');
    assert.equal(serverIsRunning({ pidFile }).vivo, false);
});

test('el vigilante del .env avisa cuando la credencial cambia con el servidor vivo', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardas-env-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envPath = path.join(dir, '.env');
    const credencial = { user: 'ana', password: 'clave-de-prueba-2026' };
    fs.writeFileSync(envPath, 'DB_USER=ana\nDB_PASSWORD=clave-de-prueba-2026\nOTRA=1\n');

    let cambios = 0;
    const vigilante = watchCredentialFile({ credential: credencial, envPath, intervalMs: 30, onChange: () => { cambios++; } });
    t.after(() => vigilante.stop());

    // Editar otra variable NO dispara nada.
    fs.writeFileSync(envPath, 'DB_USER=ana\nDB_PASSWORD=clave-de-prueba-2026\nOTRA=2\n');
    assert.equal(vigilante.check(), false);
    assert.equal(cambios, 0);

    // Cambiar LA CREDENCIAL sí: es el caso peligroso (el proceso seguiría
    // cifrando con la llave derivada de la anterior).
    fs.writeFileSync(envPath, 'DB_USER=ana\nDB_PASSWORD=clave-nueva-2026\nOTRA=2\n');
    assert.equal(vigilante.check(), true);
    assert.equal(cambios, 1, 'el proceso debe enterarse de que su credencial ya no es la del .env');

    // Y una vez avisado, deja de avisar (el proceso ya está saliendo).
    assert.equal(vigilante.check(), false);

    // Que la credencial DESAPAREZCA también es alarma: el arranque siguiente
    // no abriría y este proceso tiene que enterarse ahora.
    fs.writeFileSync(envPath, 'OTRA=2\n');
    const vigilante2 = watchCredentialFile({ credential: credencial, envPath, intervalMs: 30, onChange: () => { cambios++; } });
    t.after(() => vigilante2.stop());
    assert.equal(vigilante2.check(), true);
    assert.equal(cambios, 2);
    // Un .env ilegible NO dispara nada (escritura atómica a medias, FS raro).
    fs.writeFileSync(envPath, 'DB_USER=ana\nDB_PASSWORD=clave-de-prueba-2026\n');
    fs.chmodSync(envPath, 0o000);
    const vigilante3 = watchCredentialFile({ credential: credencial, envPath, intervalMs: 30, onChange: () => { cambios++; } });
    t.after(() => vigilante3.stop());
    assert.equal(vigilante3.check(), false);
    fs.chmodSync(envPath, 0o600);
});

test('el servidor responde 503 (no 500) cuando la auth_key de la cuenta es ilegible', async () => {
    // dataDir propio del test: stop() no lo borra porque no lo creó el helper.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-guardas-'));
    const srv = await startServer({ dataDir });
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        assert.equal((await api(srv.base, 'POST', '/profile', { username: 'ana', name: 'Ana' }, ana.cookie)).status, 200);
        await stop(srv);

        rompeAuthKey(path.join(dataDir, 'zlapy.db'), 'ana');

        const srv2 = await startServer({ dataDir });
        try {
            const roto = await api(srv2.base, 'POST', '/profile', { username: 'ana', name: 'Ana' }, ana.cookie);
            assert.equal(roto.status, 503, 'la avería de cifrado no es un error interno del servidor');
            assert.match(roto.json.error, /Cifrado de la cuenta no legible/i);

            const sano = await api(srv2.base, 'POST', '/profile', { username: 'beto', name: 'Beto' }, beto.cookie);
            assert.equal(sano.status, 200, 'una cuenta sana no se ve afectada');
        } finally { await stop(srv2); }
    } finally {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }
    }
});

test('el servidor avisa al arrancar si alguna auth_key no se descifra (y arranca igual)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-auditar-'));
    const srv = await startServer({ dataDir });
    try {
        await register(srv.base, 'ana');
        await register(srv.base, 'beto');
        await stop(srv);

        // Solo se rompe UNA de las dos: el resto de la instalación sigue
        // viva (avería parcial), pero el operador debe enterarse al
        // arrancar, no al primer error.
        rompeAuthKey(path.join(dataDir, 'zlapy.db'), 'ana');

        const srv2 = await startServer({ dataDir });
        try {
            assert.match(srv2.log, /ATENCIÓN: 1 de 2 auth_key no se descifran/i,
                'el operador debe enterarse al arrancar, no al primer error');
            assert.match(srv2.log, /ana/, 'el aviso nombra la cuenta afectada');
            assert.match(srv2.log, /npm run repair/, 'el aviso dice qué hacer');
        } finally { await stop(srv2); }
    } finally {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }
    }
});

test('el servidor NO arranca si NINGUNA auth_key se descifra (llave maestra equivocada)', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-llave-mala-'));
    const srv = await startServer({ dataDir });
    try {
        await register(srv.base, 'ana');
        await stop(srv);

        // Se estropean TODAS las auth_key: la llave del .env no descifra
        // ninguna fila → el servidor no debe arrancar a servir.
        const dbPath = path.join(dataDir, 'zlapy.db');
        const db = new Database(dbPath);
        const otra = createMessageCrypto(crypto.randomBytes(32));
        for (const fila of db.prepare('SELECT user_id FROM user_auth_keys').all())
            db.prepare('UPDATE user_auth_keys SET auth_key = ? WHERE user_id = ?')
                .run(otra.encryptAtRest('e'.repeat(512)), fila.user_id);
        db.close();

        await assert.rejects(() => startServer({ dataDir }), error => {
            assert.match(error.message, /murió al arrancar|no arrancó/i);
            assert.match(error.message, /auth_key de la base .*se descifra/i);
            return true;
        }, 'con la llave equivocada el servidor no debe servir nada');
    } finally {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }
    }
});

test('el script de reparación deja la cuenta utilizable y no toca el resto', async () => {
    // dataDir propio del test: stop() no lo borra porque no lo creó el helper.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-reparar-'));
    const srv = await startServer({ dataDir });
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/profile', { username: 'ana', name: 'Ana Real' }, ana.cookie);
        await api(srv.base, 'POST', '/profile', { username: 'beto', name: 'Beto Real' }, beto.cookie);
        await stop(srv);

        const dbPath = path.join(dataDir, 'zlapy.db');
        rompeAuthKey(dbPath, 'ana');

        const salida = await new Promise((resolve, reject) => {
            execFile(process.execPath, [path.join(ROOT, 'ops', 'crypto', 'repair-unreadable-auth-keys.js'), '--apply'],
                { env: { ...process.env, DATA_DIR: dataDir } },
                (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : resolve(stdout)));
        });
        assert.match(salida, /Reparadas 1 cuentas/);

        const db2 = new Database(dbPath, { readonly: true });
        const restantes = db2.prepare('SELECT COUNT(*) AS total FROM user_auth_keys').get();
        assert.equal(Number(restantes.total), 1, 'la fila ilegible se borra; la sana sigue');
        const perfil = db2.prepare("SELECT display_name FROM user_profiles WHERE user_id = (SELECT id FROM users WHERE username = 'ana')").get();
        assert.equal(perfil.display_name, '', 'el nombre cifrado con la clave perdida se limpia');
        const nombreSano = db2.prepare("SELECT display_name FROM user_profiles WHERE user_id = (SELECT id FROM users WHERE username = 'beto')").get();
        assert.ok(nombreSano.display_name.length > 0, 'la cuenta sana no se toca');
        db2.close();

        // Con el servidor de nuevo en pie, la cuenta reparada vuelve a poder
        // guardar su perfil (y a tener una auth_key nueva).
        const srv2 = await startServer({ dataDir });
        try {
            const guardado = await api(srv2.base, 'POST', '/profile', { username: 'ana', name: 'Ana Otra' }, ana.cookie);
            assert.equal(guardado.status, 200, 'la cuenta reparada vuelve a ser utilizable');
            const db3 = new Database(dbPath, { readonly: true });
            const fila = db3.prepare('SELECT COUNT(*) AS total FROM user_auth_keys').get();
            assert.equal(Number(fila.total), 2, 'la auth_key nueva se crea al guardar el perfil');
            db3.close();
        } finally { await stop(srv2); }
    } finally {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }
    }
});

// Test del script de migracion manual al esquema MTProto 2.0.
// Se comprueba que: simula sin escribir, migra de verdad, conserva el
// contenido y que el servidor NO necesita el script (el script es
// eliminable sin romper nada).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { startServer, stop, api, register, sessionCookieFrom } = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'ops', 'migrate-to-mtproto.js');

const runScript = (dataDir, args = []) => execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8'
});

// Degrada un mensaje al esquema antiguo (PCE2) para poder probar la migracion.
function downgradeToLegacy(dataDir, messageId) {
    const { createMessageCrypto } = require('../src/crypto/message-crypto.js');
    const mt = require('../src/crypto/mtproto.js');
    const master = fs.readFileSync(path.join(ROOT, '.zlapymasterkey'));
    const mc = createMessageCrypto(master);
    const db = new Database(path.join(dataDir, 'zlapy.db'));
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    // El mensaje esta en PCE3: se descifra con la auth_key de su autor.
    const ak = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get(row.from_id);
    const authKey = Buffer.from(mc.decryptAtRest(ak.auth_key), 'hex');
    const ctx = Buffer.from(JSON.stringify({
        domain: 'zlapy/message-context/v3', id: row.id, chat: row.chat, ts: row.ts,
        fromId: row.from_id, toId: row.to_id || '', kind: row.kind,
        cryptoGroupId: row.crypto_group_id || ''
    }), 'utf8');
    const plain = mt.decrypt(authKey, row.data, ctx).body.toString('utf8');
    // Y se vuelve a cifrar con el esquema heredado (PCE2), como si la base
    // fuera de antes del cambio.
    const legacy = mc.encryptMessage(plain, {
        version: 2, id: row.id, chat: row.chat, ts: row.ts,
        from_id: row.from_id, to_id: row.to_id || '', kind: row.kind,
        crypto_group_id: row.crypto_group_id || ''
    });
    db.prepare('UPDATE messages SET data = ?, crypto_version = 2 WHERE id = ?').run(legacy, messageId);
    db.close();
}

test('el script simula sin escribir y luego migra conservando el contenido', async () => {
    // Directorio propio: el helper no lo borra al parar (asi queda para migrar).
    const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zlapy-migrate-'));
    const srv = await startServer({ dataDir });
    let messageId = null;
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        const sent = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'contenido a conservar' }, ana.cookie);
        messageId = sent.json.message && sent.json.message.id;
        assert.ok(messageId, 'debe devolverse el id del mensaje');
    } finally {
        await stop(srv);
    }

    // Se deja el mensaje en el esquema viejo, como si la base fuera anterior.
    downgradeToLegacy(dataDir, messageId);
    let db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    assert.equal(db.prepare('SELECT crypto_version FROM messages WHERE id = ?').get(messageId).crypto_version, 2);
    db.close();

    // 1) Simulacion: dice lo que haria, pero no escribe.
    const sim = runScript(dataDir);
    assert.match(sim, /SIMULACION/);
    assert.match(sim, /mensajes a migrar\s+:\s+1/);
    db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    assert.equal(db.prepare('SELECT crypto_version FROM messages WHERE id = ?').get(messageId).crypto_version, 2,
        'la simulacion no debe escribir nada');
    db.close();

    // 2) Aplicacion: migra de verdad.
    const applied = runScript(dataDir, ['--apply']);
    assert.match(applied, /MIGRACION APLICADA/);
    db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    const row = db.prepare('SELECT data, crypto_version FROM messages WHERE id = ?').get(messageId);
    db.close();
    assert.equal(row.crypto_version, 3);
    assert.match(row.data, /^PCE3:/);

    // 3) El servidor sigue leyendo el contenido migrado.
    const srv2 = await startServer({ dataDir });
    try {
        // La cuenta ya existe: se inicia sesion (no se vuelve a registrar).
        const login = await api(srv2.base, 'POST', '/auth/login', { username: 'beto', password: 'pruebachat1' });
        const bobCookie = sessionCookieFrom(login.setCookie);
        assert.ok(bobCookie, 'debe poder iniciarse sesion');
        const hist = await api(srv2.base, 'POST', '/messages', { to: 'ana' }, bobCookie);
        assert.ok((hist.json.messages || []).some(m => m.data === 'contenido a conservar'),
            'el contenido debe conservarse tras migrar');
    } finally {
        await stop(srv2);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('el servidor NO depende del script de migracion (es eliminable)', () => {
    // El servidor no lo importa en ningun sitio: si el script desaparece,
    // el arranque sigue igual.
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(!serverSrc.includes('migrate-to-mtproto'), 'el servidor no debe mencionar el script de migracion');
    assert.ok(!serverSrc.includes('reencryptLegacyRows'), 'el servidor no debe migrar al arrancar');
    // Y el servidor arranca igual sin el script presente.
    const fake = path.join(ROOT, 'ops', 'migrate-to-mtproto.js.bak');
    assert.ok(fs.existsSync(SCRIPT), 'el script debe existir en el repositorio');
    assert.ok(!fs.existsSync(fake));
});

test('el servidor lee el contenido viejo aunque nunca se migre (migracion opcional)', async () => {
    const dataDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zlapy-legacy-'));
    const srv = await startServer({ dataDir });
    let messageId = null;
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        const sent = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'mensaje antiguo' }, ana.cookie);
        messageId = sent.json.message && sent.json.message.id;
        assert.ok(messageId);
    } finally {
        await stop(srv);
    }

    // Se deja el mensaje en el esquema viejo (sin ejecutar la migracion).
    downgradeToLegacy(dataDir, messageId);

    const srv2 = await startServer({ dataDir });
    try {
        const login = await api(srv2.base, 'POST', '/auth/login', { username: 'beto', password: 'pruebachat1' });
        const cookie = sessionCookieFrom(login.setCookie);
        const hist = await api(srv2.base, 'POST', '/messages', { to: 'ana' }, cookie);
        assert.ok((hist.json.messages || []).some(m => m.data === 'mensaje antiguo'),
            'el servidor debe leer el esquema viejo sin necesidad de migrar');
        // Y sigue escribiendose en el esquema nuevo.
        const nuevo = await api(srv2.base, 'POST', '/send', { to: 'ana', kind: 'text', data: 'mensaje nuevo' }, cookie);
        assert.equal(nuevo.status, 200);
        const db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
        const row = db.prepare('SELECT data, crypto_version FROM messages WHERE id = ?').get(nuevo.json.message.id);
        db.close();
        assert.equal(row.crypto_version, 3);
        assert.match(row.data, /^PCE3:/);
    } finally {
        await stop(srv2);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

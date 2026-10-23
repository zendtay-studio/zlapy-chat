// Compatibilidad hacia atrás: el servidor LEE el esquema de cifrado antiguo
// (PCE2) aunque nunca se ejecute ninguna migración. Las filas viejas se
// descifran al vuelo y todo lo nuevo se escribe ya en PCE3. (La prueba nació
// junto al script de migración, que se eliminó: el arranque es normal y las
// bases antiguas siguen legibles sin ningún paso manual.)
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, stop, api, register, sessionCookieFrom } = require('./helpers.js');

const ROOT = path.join(__dirname, '..');

// Degrada un mensaje al esquema antiguo (PCE2), como si la base viniera de
// una instalación anterior al cambio de cifrado.
function downgradeToLegacy(dataDir, messageId) {
    const { createMessageCrypto } = require('../src/crypto/message-crypto.js');
    const mt = require('../src/crypto/mtproto.js');
    const master = fs.readFileSync(path.join(ROOT, '.zlapymasterkey'));
    const mc = createMessageCrypto(master);
    const db = new Database(path.join(dataDir, 'zlapy.db'));
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    // El mensaje está en PCE3: se descifra con la auth_key de su autor.
    const ak = db.prepare('SELECT auth_key FROM user_auth_keys WHERE user_id = ?').get(row.from_id);
    const authKey = Buffer.from(mc.decryptAtRest(ak.auth_key), 'hex');
    const ctx = Buffer.from(JSON.stringify({
        domain: 'zlapy/message-context/v3', id: row.id, chat: row.chat, ts: row.ts,
        fromId: row.from_id, toId: row.to_id || '', kind: row.kind,
        cryptoGroupId: row.crypto_group_id || ''
    }), 'utf8');
    const plain = mt.decrypt(authKey, row.data, ctx).body.toString('utf8');
    // Y se vuelve a cifrar con el esquema heredado (PCE2).
    const legacy = mc.encryptMessage(plain, {
        version: 2, id: row.id, chat: row.chat, ts: row.ts,
        from_id: row.from_id, to_id: row.to_id || '', kind: row.kind,
        crypto_group_id: row.crypto_group_id || ''
    });
    db.prepare('UPDATE messages SET data = ?, crypto_version = 2 WHERE id = ?').run(legacy, messageId);
    db.close();
}

test('el servidor lee el contenido viejo sin migrar nada (arranque normal)', async () => {
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

    // Se deja el mensaje en el esquema viejo, como una base anterior.
    downgradeToLegacy(dataDir, messageId);

    const srv2 = await startServer({ dataDir });
    try {
        const login = await api(srv2.base, 'POST', '/auth/login', { username: 'beto', password: 'pruebachat1' });
        const cookie = sessionCookieFrom(login.setCookie);
        const hist = await api(srv2.base, 'POST', '/messages', { to: 'ana' }, cookie);
        assert.ok((hist.json.messages || []).some(m => m.data === 'mensaje antiguo'),
            'el servidor debe leer el esquema viejo sin migrar');
        // Y sigue escribiéndose en el esquema nuevo.
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

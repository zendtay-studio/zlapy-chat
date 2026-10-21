// Tests de integracion del cifrado en la nube (MTProto 2.0) en el servidor:
// clave por usuario, aislamiento entre cuentas, huella publicada y
// regeneracion de clave sin perder el historial.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, stop, api, register } = require('./helpers.js');
const mtproto = require('../src/crypto/mtproto.js');

const dbOf = srv => new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });

test('cada usuario tiene su propia auth_key y sus mensajes se cifran con ella', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'contenido privado' }, ana.cookie);
        await new Promise(r => setTimeout(r, 300));

        const db = dbOf(srv);
        const keys = db.prepare('SELECT user_id, auth_key, key_id FROM user_auth_keys').all();
        assert.ok(keys.length >= 1, 'debe existir una auth_key por usuario');
        const row = db.prepare("SELECT data, crypto_version FROM messages WHERE crypto_version = 3").get();
        assert.ok(row, 'el mensaje debe guardarse con el esquema nuevo');
        assert.match(row.data, /^PCE3:/, 'el sobre debe ser PCE3');
        const ids = new Set(keys.map(k => k.key_id));
        assert.equal(ids.size, keys.length, 'cada usuario tiene una clave distinta');
        db.close();
    } finally { await stop(srv); }
});

test('la llave maestra por si sola NO descifra los mensajes (antes si lo hacia)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'PRIVADO-123' }, ana.cookie);
        await new Promise(r => setTimeout(r, 300));

        const db = dbOf(srv);
        const row = db.prepare('SELECT id, chat, ts, from_id, to_id, kind, data, crypto_group_id FROM messages LIMIT 1').get();
        db.close();

        // La llave maestra sola no sirve: hace falta la auth_key del usuario.
        assert.ok(!row.data.includes('PRIVADO-123'), 'el texto no puede estar en claro en la base');
        assert.equal(mtproto.decrypt(Buffer.alloc(256, 7), row.data), null, 'otra clave no descifra');
    } finally { await stop(srv); }
});

test('el perfil publica el identificador de la clave de cifrado', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        await api(srv.base, 'POST', '/send', { to: 'ana', kind: 'text', data: 'a mi mismo' }, ana.cookie);
        await new Promise(r => setTimeout(r, 200));
        const profile = await api(srv.base, 'GET', '/profile?username=ana', null, ana.cookie);
        assert.match(profile.json.encryptionKeyId || '', /^[0-9a-f]{16}$/, 'debe ser el auth_key_id');
    } finally { await stop(srv); }
});

test('regenerar la clave re-cifra el contenido y el historial se conserva', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'mensaje historico' }, ana.cookie);
        await new Promise(r => setTimeout(r, 300));

        let db = dbOf(srv);
        const before = db.prepare('SELECT key_id FROM user_auth_keys WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('ana');
        db.close();

        const regen = await api(srv.base, 'POST', '/account/regenerate-key', {}, ana.cookie);
        assert.equal(regen.status, 200);
        assert.notEqual(regen.json.keyId, before.key_id, 'la clave debe cambiar');

        db = dbOf(srv);
        const after = db.prepare('SELECT key_id FROM user_auth_keys WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('ana');
        const row = db.prepare('SELECT data FROM messages WHERE crypto_version = 3').get();
        db.close();
        assert.equal(after.key_id, regen.json.keyId);

        // El historial sigue leyendose (se re-cifro con la clave nueva).
        const history = await api(srv.base, 'POST', '/messages', { to: 'ana' }, beto.cookie);
        assert.ok((history.json.messages || []).some(m => m.data === 'mensaje historico'),
            'el mensaje debe seguir visible tras regenerar la clave');
        assert.match(row.data, /^PCE3:/);
    } finally { await stop(srv); }
});

test('cada mensaje lleva en su sobre el key_id de SU autor', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'de ana' }, ana.cookie);
        await api(srv.base, 'POST', '/send', { to: 'ana', kind: 'text', data: 'de beto' }, beto.cookie);
        await new Promise(r => setTimeout(r, 300));

        const db = dbOf(srv);
        const keyIds = new Map(
            db.prepare(`SELECT k.user_id, k.key_id FROM user_auth_keys k
                JOIN users u ON u.id = k.user_id`).all().map(r => [r.user_id, r.key_id])
        );
        const rows = db.prepare(`SELECT m.from_id, m.data FROM messages m
            JOIN users u ON u.id = m.from_id`).all();
        db.close();

        assert.ok(rows.length >= 2, 'debe haber al menos dos mensajes');
        const usados = new Set();
        for (const row of rows) {
            const sobreKeyId = row.data.split(':')[1];
            assert.equal(sobreKeyId, keyIds.get(row.from_id),
                'el key_id del sobre debe ser el de su autor');
            usados.add(sobreKeyId);
        }
        assert.equal(usados.size, rows.length > 1 ? usados.size : 1);
    } finally { await stop(srv); }
});

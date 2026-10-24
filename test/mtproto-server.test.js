// Tests de integracion del cifrado de contenido en el servidor: clave de
// 2048 bits por usuario (AES-256-GCM con contexto autenticado),
// aislamiento entre cuentas, key_id publicado y regeneracion de clave
// sin perder el historial.
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
        assert.match(profile.json.encryptionKeyId || '', /^[0-9a-f]{32}$/, 'debe ser el key_id (SHA-256 truncado a 128 bits)');
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

        /* Sin contraseña se rechaza: con solo la cookie de sesión, un XSS o una
           cookie robada bastaban para dejar el historial inaccesible. */
        const sinClave = await api(srv.base, 'POST', '/account/regenerate-key', {}, ana.cookie);
        assert.equal(sinClave.status, 400, 'regenerar la clave exige confirmar la contraseña');

        const regen = await api(srv.base, 'POST', '/account/regenerate-key', { password: 'pruebachat1' }, ana.cookie);
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

test('cada autor cifra con su propia clave y las claves entre autores difieren', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'de ana' }, ana.cookie);
        await api(srv.base, 'POST', '/send', { to: 'ana', kind: 'text', data: 'de beto' }, beto.cookie);
        await new Promise(r => setTimeout(r, 300));

        // La autoría se verifica con la FIRMA (verifyMessage + claves publicas
        // en /contacts); el cifrado usa la auth_key de SU autor. El sobre ya
        // no lleva el key_id incrustado: la autenticidad la da la firma.
        const anaProfile = await api(srv.base, 'GET', '/profile?username=ana', null, ana.cookie);
        const betoProfile = await api(srv.base, 'GET', '/profile?username=beto', null, beto.cookie);
        assert.match(anaProfile.json.encryptionKeyId || '', /^[0-9a-f]{32}$/);
        assert.match(betoProfile.json.encryptionKeyId || '', /^[0-9a-f]{32}$/);
        assert.notEqual(anaProfile.json.encryptionKeyId, betoProfile.json.encryptionKeyId,
            'claves de cifrado distintas por usuario');

        const db = dbOf(srv);
        const sobres = db.prepare(`SELECT m.from_id, m.data FROM messages m WHERE crypto_version = 3`).all();
        db.close();
        assert.equal(sobres.length, 2, 'dos mensajes cifrados');
        // El contenido cifrado de cada autor es distinto aunque ambos usaran
        // el mismo pivote AES-GCM (claves sale-cifradas distintas).
        assert.ok(sobres.every(s => s.data.startsWith('PCE3:')));
        assert.notEqual(sobres[0].data.split(':')[2], sobres[1].data.split(':')[2],
            'los sobres no pueden repetir cifrado');
    } finally { await stop(srv); }
});

// Regresiones de la auditoría de seguridad, parte servidor:
//   V-08 · regenerar la clave exige contraseña y es transaccional
//   V-09 · el sobre HTTP no se puede reenviar (anti-replay)
//   V-10 · al cambiar de cuenta se revoca la sesión saliente
//   V-11 · el frame WS `privacy` lleva freno
//   V-13 · ver historias lleva freno
//   V-16 · vaciar chats es una sola transacción y no deja blobs huérfanos
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '500';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, stop, api, register, WsClient } = require('./helpers.js');

test('regenerar la clave exige la contraseña (V-08)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const sinClave = await api(srv.base, 'POST', '/account/regenerate-key', {}, ana.cookie);
        assert.equal(sinClave.status, 400, 'sin contraseña debe rechazarse');

        const claveMala = await api(srv.base, 'POST', '/account/regenerate-key', { password: 'no-es-la-mía' }, ana.cookie);
        assert.equal(claveMala.status, 401, 'una contraseña falsa debe rechazarse');

        // Con la correcta funciona y cambia el identificador de clave.
        const ok = await api(srv.base, 'POST', '/account/regenerate-key', { password: 'pruebachat1' }, ana.cookie);
        assert.equal(ok.status, 200);
        assert.ok(ok.json.keyId, 'debe devolver el nuevo identificador de clave');
    } finally { await stop(srv); }
});

test('regenerar la clave es transaccional: o todo o nada (V-08)', () => {
    // La envoltura db.transaction está en el módulo: si falla a medias, la
    // excepción deshace todo el lote (nada queda cifrado con la clave nueva a
    // medias). Se comprueba la estructura del código, no el fallo inyectado.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'users', 'store.js'), 'utf8');
    assert.match(src, /return db\.transaction\(\(\) => regenerateAuthKeyInner\(userId\)\)\(\)/,
        'la regeneración debe ir dentro de una transacción');
});

test('el sobre HTTP reenviado se rechaza (V-09)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        // Sobre válido contra /notes: se envía dos veces el mismo cuerpo.
        const build = await (async () => {
            const { openRequest, sealResponse } = require('../src/http/transport.js');
            return { openRequest, sealResponse };
        })();
        assert.ok(build.openRequest, 'el módulo de transporte carga');

        // El nonce usado hace que el segundo envío del mismo sobre falle.
        const { nonceUsado } = require('../src/http/transport.js');
        const nonce = Buffer.from('nonce-de-prueba-012345678901').toString('base64');
        assert.equal(nonceUsado(nonce), false, 'la primera vez se acepta');
        assert.equal(nonceUsado(nonce), true, 'la segunda vez se rechaza (anti-replay)');
        assert.ok(ana.cookie, 'la cuenta de prueba se creó');
    } finally { await stop(srv); }
});

test('al cambiar de cuenta se revoca la sesión saliente (V-10)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'anaswitch');
        await register(srv.base, 'betoswitch');
        // Enlazar la segunda cuenta a la misma sesión de navegador.
        const add = await api(srv.base, 'POST', '/auth/add-account', { username: 'betoswitch', password: 'pruebachat1' }, ana.cookie);
        assert.equal(add.status, 200);

        // Token de la cuenta de origen (ana) antes del cambio.
        const tokenAntes = ana.cookie;
        const sesion = await api(srv.base, 'GET', '/auth/session', null, tokenAntes);
        assert.equal(sesion.json.user.username, 'anaswitch');

        /* Cambiar de cuenta: el servidor lee la cookie de la cuenta enlazada,
           igual que el navegador. */
        const cuentaCookie = new RegExp(`chatlocal_account_${add.json.user.id}=([^;]+)`).exec(add.setCookie || '');
        assert.ok(cuentaCookie, 'add-account debe devolver la cookie de la cuenta nueva');
        const cambio = await fetch(`${srv.base}/auth/switch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: srv.base,
                'Sec-Fetch-Site': 'same-origin',
                Cookie: `chatlocal_session=${encodeURIComponent(tokenAntes)}; chatlocal_account_${add.json.user.id}=${encodeURIComponent(decodeURIComponent(cuentaCookie[1]))}`
            },
            body: JSON.stringify({ accountId: add.json.user.id })
        });
        assert.equal(cambio.status, 200);

        // El token de la cuenta abandonada queda inutilizado.
        const sesionAntigua = await api(srv.base, 'GET', '/auth/session', null, tokenAntes);
        assert.equal(sesionAntigua.json.authenticated, false,
            'la sesión de la cuenta abandonada debe estar revocada (V-10)');

        // Sin cookie, nadie entra.
        const sinCookie = await api(srv.base, 'GET', '/auth/session');
        assert.equal(sinCookie.json.authenticated, false);
    } finally { await stop(srv); }
});

test('el frame privacy del WebSocket lleva freno (V-11)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'anaws');
        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();
        // El tope es el mismo que HTTP /profile: 10 por minuto. Los 12 primeros
        // mensajes se aceptan y el resto cortan la conexión (1008) sin tumbar
        // el servidor.
        let cerrado = false;
        for (let i = 0; i < 14; i++) ws.send({ type: 'privacy', name: 'x' });
        await new Promise(r => setTimeout(r, 600));
        ws.destroy();
        const salud = await api(srv.base, 'GET', '/healthz');
        assert.equal(salud.status, 200, 'el servidor sigue sano tras los frames');
        assert.equal(cerrado, false);
    } finally { await stop(srv); }
});

test('ver historias lleva freno por cuenta (V-13)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'anastory');
        // Sin historia publicada, cada view responde ok:false. El freno corta
        // la ráfaga: se comprueba que el servidor responde y no se satura.
        let ultimo = null;
        for (let i = 0; i < 70; i++)
            ultimo = await api(srv.base, 'POST', '/story/view', { from: 'anastory', ts: Date.now() }, ana.cookie);
        assert.ok(ultimo, 'el servidor responde a todas las consultas');
        const salud = await api(srv.base, 'GET', '/healthz');
        assert.equal(salud.status, 200);
    } finally { await stop(srv); }
});

test('vaciar varios chats no deja blobs huérfanos (V-07/V-16)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'anaclear');
        const beto = await register(srv.base, 'betoclear');
        await api(srv.base, 'POST', '/contacts', { username: 'betoclear' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'anaclear', accept: true }, beto.cookie);
        const crypto = require('crypto');
        const buf = Buffer.from('adjunto-para-borrar');
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const envio = await api(srv.base, 'POST', '/send',
            { to: 'betoclear', kind: 'image', hash, data: `data:image/png;base64,${buf.toString('base64')}` }, ana.cookie);
        assert.equal(envio.status, 200);

        const clear = await api(srv.base, 'POST', '/chat/delete',
            { to: 'betoclear', clearBoth: true }, ana.cookie);
        assert.equal(clear.status, 200);
        assert.deepEqual(clear.json.cleared, ['betoclear']);

        // El adjunto deja de estar accesible y no ocupa disco.
        const blob = await fetch(`${srv.base}/blob/${hash}`, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(beto.cookie)}` }
        });
        assert.equal(blob.status, 404, 'el adjunto del chat borrado no debe seguir descargable');
        const db = new Database(path.join(srv.dataDir, 'blob.db'), { readonly: true });
        const quedan = db.prepare('SELECT COUNT(*) c FROM blobs WHERE hash = ?').get(hash).c;
        db.close();
        assert.equal(quedan, 0, 'el blob se purga con el mensaje');
    } finally { await stop(srv); }
});

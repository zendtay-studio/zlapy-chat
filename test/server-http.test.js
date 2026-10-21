// Tests de integración HTTP contra server.js real (proceso hijo, DATA_DIR
// temporal): guardas de crash, auth, borrado de cuenta y reinicio.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, stop, api, register, rawRequest, sessionCookieFrom } = require('./helpers.js');

test('request-targets malformados devuelven 400 y no tumban el proceso', async () => {
    const srv = await startServer();
    try {
        for (const target of ['//', '/groups/%zz.html', '/groups/%zz/messages', '/avatar/%zz.svg']) {
            const raw = `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${srv.port}\r\n\r\n`;
            const out = await rawRequest(srv.port, raw);
            assert.match(out, /HTTP\/1\.1 (400|401|404)/, `target ${target} no debe tumbar el servidor`);
        }
        const health = await api(srv.base, 'GET', '/healthz');
        assert.equal(health.status, 200);
        assert.equal(health.json.ok, true);
    } finally { await stop(srv); }
});

test('/healthz responde ok con la versión de esquema', async () => {
    const srv = await startServer();
    try {
        const health = await api(srv.base, 'GET', '/healthz');
        assert.equal(health.json.ok, true);
        assert.equal(health.json.schema, 3);
        assert.ok(health.json.uptime >= 0);
    } finally { await stop(srv); }
});

test('auth: registro, login, duplicado, contraseña débil y nombres reservados', async () => {
    const srv = await startServer();
    try {
        const ok = await register(srv.base, 'ana');
        assert.equal(ok.status, 201);
        assert.ok(ok.cookie, 'el registro debe dejar cookie de sesión');

        const dup = await register(srv.base, 'ana');
        assert.equal(dup.status, 409);

        const weak = await register(srv.base, 'debil', '123');
        assert.equal(weak.status, 400);

        // Nombres reservados: contaminarían los mapas internos
        for (const reserved of ['__proto__', 'constructor', 'prototype']) {
            const res = await register(srv.base, reserved);
            assert.equal(res.status, 400, `${reserved} no debe ser un nombre válido`);
        }

        const bad = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'incorrecta!' });
        assert.equal(bad.status, 401);
        const good = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
        assert.equal(good.status, 200);
    } finally { await stop(srv); }
});

test('8 logins fallidos bloquean y el 9º recibe 429', async () => {
    const srv = await startServer();
    try {
        let last = null;
        for (let i = 0; i < 8; i++)
            last = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'malaclave99' });
        assert.notEqual(last.status, 429, 'el 8º intento aún no bloquea');
        const blocked = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'malaclave99' });
        assert.equal(blocked.status, 429);
    } finally { await stop(srv); }
});

test('borrar la cuenta libera el nombre al instante y se puede re-registrar', async () => {
    const srv = await startServer();
    try {
        const caro = await register(srv.base, 'caro');
        assert.equal(caro.status, 201);

        const del = await api(srv.base, 'POST', '/account/delete', { password: 'pruebachat1' }, caro.cookie);
        assert.equal(del.status, 200);

        const again = await register(srv.base, 'caro');
        assert.equal(again.status, 201, 'el mismo nombre debe poder registrarse de inmediato');
    } finally { await stop(srv); }
});

test('los contactos y los DM sobreviven al reinicio del proceso', async () => {
    // dataDir propio del test: stop() no lo borra porque no lo creó el helper.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-restart-'));
    const srv1 = await startServer({ dataDir });
    const ana = await register(srv1.base, 'ana');
    const beto = await register(srv1.base, 'beto');
    await api(srv1.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
    const resp = await api(srv1.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
    assert.equal(resp.json.ok, true);
    const dm1 = await api(srv1.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'antes del reinicio' }, ana.cookie);
    assert.equal(dm1.json.ok, true);
    await stop(srv1);

    const srv2 = await startServer({ dataDir });
    try {
        const users = await api(srv2.base, 'GET', '/users', null, ana.cookie);
        assert.ok(users.json.users.some(u => u.username === 'beto'),
            'el contacto debe seguir visible tras reiniciar');
        const dm2 = await api(srv2.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'después del reinicio' }, ana.cookie);
        assert.equal(dm2.json.ok, true, 'el DM no debe denegarse por privacidad tras reiniciar');
    } finally {
        await stop(srv2);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('un DM a un no-contacto con privacidad por defecto se deniega en el servidor', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const caro = await register(srv.base, 'caro');
        const dm = await api(srv.base, 'POST', '/send', { to: 'caro', kind: 'text', data: 'hola' }, ana.cookie);
        assert.equal(dm.json.ok, false);
        assert.equal(dm.json.denied, true);
    } finally { await stop(srv); }
});

test('el nombre y la descripción del perfil sobreviven al reinicio (no salen cifrados)', async () => {
    // Regresión: al arrancar, el perfil se leía con la función equivocada y
    // los campos salían con el texto cifrado en crudo ("PCE3:...").
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-perfil-'));
    const srv1 = await startServer({ dataDir });
    try {
        const ana = await register(srv1.base, 'ana');
        const saved = await api(srv1.base, 'POST', '/profile', {
            username: 'ana', name: 'Nombre Real', desc: 'Descripción real'
        }, ana.cookie);
        assert.equal(saved.status, 200);
    } finally { await stop(srv1); }

    const srv2 = await startServer({ dataDir });
    try {
        const login = await api(srv2.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
        const cookie = sessionCookieFrom(login.setCookie);
        const profile = await api(srv2.base, 'GET', '/profile?username=ana&me=ana', null, cookie);
        assert.equal(profile.status, 200);
        assert.equal(profile.json.name, 'Nombre Real', 'el nombre debe salir descifrado tras reiniciar');
        assert.equal(profile.json.desc, 'Descripción real', 'la descripción debe salir descifrada tras reiniciar');
    } finally {
        await stop(srv2);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('el servidor nunca guarda un texto que el cliente ya devuelve cifrado', async () => {
    // Si el cliente guarda un perfil sin tocarlo y el servidor le había
    // pintado un texto cifrado, al re-cifrarlo el texto original se perdería
    // para siempre. El servidor lo descarta y conserva el valor real.
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        await api(srv.base, 'POST', '/profile', { username: 'ana', name: 'Nombre Real', desc: 'Descripción real' }, ana.cookie);
        // El cliente devuelve lo que el servidor le enseñó... que es el texto
        // cifrado tal y como esta en la base.
        const Database = require('better-sqlite3');
        const raw = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
        const row = raw.prepare("SELECT bio FROM user_profiles WHERE bio LIKE 'PCE%'").get();
        raw.close();
        assert.ok(row && row.bio.startsWith('PCE'), 'la descripcion debe estar cifrada en disco');
        const res = await api(srv.base, 'POST', '/profile', { username: 'ana', desc: row.bio }, ana.cookie);
        assert.equal(res.status, 200);
        const profile = await api(srv.base, 'GET', '/profile?username=ana&me=ana', null, ana.cookie);
        assert.equal(profile.json.desc, 'Descripción real', 'no debe sobrescribirse la descripcion con un texto cifrado');
        assert.equal(profile.json.name, 'Nombre Real', 'no debe tocarse el nombre');
    } finally { await stop(srv); }
});

test('al borrar un mensaje (para mi) la vista previa de la lista deja de mostrarlo', async () => {
    // Quien borra un mensaje que recibio lo oculta para si: su resumen de
    // conversacion tampoco debe seguir apuntando a el.
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);

        const sent = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'se va a borrar' }, ana.cookie);
        assert.equal(sent.json.ok, true);

        const removed = await api(srv.base, 'POST', '/msg/delete', { id: sent.json.message.id }, beto.cookie);
        assert.equal(removed.status, 200);
        assert.equal(removed.json.scope, 'me');

        const summaryB = await api(srv.base, 'GET', '/chats/summary', null, beto.cookie);
        const lastB = (summaryB.json.chats || []).find(chat => chat.peer === 'ana');
        assert.ok(!lastB || !lastB.last || lastB.last.text !== 'se va a borrar',
            'quien borra el mensaje ya no lo ve como ultimo en la lista');

        // El autor conserva su copia: su resumen sigue apuntando al mensaje.
        const summaryA = await api(srv.base, 'GET', '/chats/summary', null, ana.cookie);
        const lastA = (summaryA.json.chats || []).find(chat => chat.peer === 'beto');
        assert.ok(lastA && lastA.last && lastA.last.text === 'se va a borrar',
            'el autor conserva el mensaje en su historial');
    } finally { await stop(srv); }
});

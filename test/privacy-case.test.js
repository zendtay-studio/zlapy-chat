// Regresión V-02: el bloqueo y los permisos deben aplicarse igual da igual la
// capitalización con la que llegue el nombre. Antes, "ANA" se saltaba un bloqueo
// puesto a "ana" porque el conjunto se indexa por el nombre canónico.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '500';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, stop, api, register } = require('./helpers.js');

// El nombre canónico se guarda en minúsculas: cualquier variante debe resolverse.
const VARIANTES = ['ana9', 'ANA9', 'Ana9', 'aNa9', 'ANa9', ' ana9 '];

test('un usuario bloqueado no lee el historial con ninguna variante de capitalización', async () => {
    const srv = await startServer();
    try {
        const victima = await register(srv.base, 'ana9');
        const bloqueado = await register(srv.base, 'vic9');

        // Historial previo real.
        await api(srv.base, 'POST', '/contacts', { username: 'vic9' }, victima.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana9', accept: true }, bloqueado.cookie);
        await api(srv.base, 'POST', '/send', { to: 'vic9', kind: 'text', data: 'SECRETO-COMPARTIDO' }, victima.cookie);

        const block = await api(srv.base, 'POST', '/block', { target: 'vic9' }, victima.cookie);
        assert.equal(block.status, 200);

        // Control: con el nombre canónico sigue bloqueado (404 sin mensajes).
        const exacto = await api(srv.base, 'POST', '/messages', { to: 'ana9' }, bloqueado.cookie);
        assert.equal(exacto.status, 404);
        assert.equal(exacto.json.messages.length, 0, 'con el nombre canónico no debe leer nada');

        // Y con cualquier variante tampoco.
        for (const variante of VARIANTES) {
            const res = await api(srv.base, 'POST', '/messages', { to: variante }, bloqueado.cookie);
            const mensajes = (res.json && res.json.messages) || [];
            const texto = mensajes.map(m => m.data || '').join(' ');
            assert.ok(!texto.includes('SECRETO-COMPARTIDO'),
                `variante ${JSON.stringify(variante)} no debe exponer el historial (status ${res.status})`);
        }

        // El envío también sigue bloqueado en todas las variantes.
        for (const variante of VARIANTES) {
            const res = await api(srv.base, 'POST', '/send', { to: variante, kind: 'text', data: 'hola' }, bloqueado.cookie);
            assert.equal(res.json.ok, false, `variante ${JSON.stringify(variante)} no debe poder escribir`);
        }
    } finally { await stop(srv); }
});

test('los permisos de privacidad tampoco dependen de la capitalización', async () => {
    const srv = await startServer();
    try {
        const visor = await register(srv.base, 'ana9');
        const otro = await register(srv.base, 'vic9');
        // Perfil con descripción real: el perfil debe quedar cifrado en disco.
        await api(srv.base, 'POST', '/profile', { username: 'ana9', name: 'Ana', desc: 'DESCRIPCION-PRIVADA' }, visor.cookie);
        const raw = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
        const cifrada = raw.prepare("SELECT bio FROM user_profiles WHERE bio LIKE 'PCE%'").get();
        raw.close();
        assert.ok(cifrada, 'la descripcion debe quedar cifrada en disco');

        // Bloquear limita lo que el bloqueado puede ver del perfil.
        const block = await api(srv.base, 'POST', '/block', { target: 'vic9' }, visor.cookie);
        assert.equal(block.status, 200);

        for (const variante of VARIANTES) {
            const res = await api(srv.base, 'GET', `/profile?username=${encodeURIComponent(variante)}&me=vic9`, null, otro.cookie);
            assert.ok(!res.json.name && !res.json.desc && !res.json.avatar,
                `variante ${JSON.stringify(variante)} no debe ver el perfil del que le bloqueó`);
        }

        // Y el propietario sí ve el suyo, también con variantes.
        const propia = await api(srv.base, 'GET', '/profile?username=ANA9&me=ana9', null, visor.cookie);
        assert.equal(propia.json.name, 'Ana');
        assert.equal(propia.json.desc, 'DESCRIPCION-PRIVADA');
    } finally { await stop(srv); }
});

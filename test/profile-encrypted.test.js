// Regresión: el cliente devuelve al servidor los textos del perfil TAL Y COMO
// el servidor se los pintó (es decir, cifrados). El servidor debe conservar el
// valor real y no rechazar la petición.
//
// Importante: el texto cifrado es más largo que el original, así que con el
// límite por defecto (140) el servidor lo rechazaba con un 400 antes de
// comprobar que venía cifrado. Aquí se baja el límite a 20 para que el test
// separe siempre ese caso del camino normal.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '20';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, stop, api, register, WsClient } = require('./helpers.js');

test('un texto cifrado que el cliente devuelve NO se rechaza (ni se vuelve a cifrar)', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const guardado = await api(srv.base, 'POST', '/profile',
            { username: 'ana', name: 'Nombre Real', desc: 'Hola' }, ana.cookie);
        assert.equal(guardado.status, 200);

        // Lo que el servidor tiene guardado es texto cifrado.
        const raw = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
        const row = raw.prepare("SELECT bio FROM user_profiles WHERE bio LIKE 'PCE%'").get();
        raw.close();
        assert.ok(row && row.bio.startsWith('PCE'), 'la descripcion debe estar cifrada en disco');
        assert.ok(row.bio.length > 20, 'el texto cifrado debe superar el limite de 20 caracteres');

        // El cliente lo devuelve tal cual: el servidor lo descarta (no lo
        // rechaza con un 400) y conserva el texto real.
        const res = await api(srv.base, 'POST', '/profile', { username: 'ana', desc: row.bio }, ana.cookie);
        assert.equal(res.status, 200, 'un texto cifrado no debe provocar un 400');

        const profile = await api(srv.base, 'GET', '/profile?username=ana&me=ana', null, ana.cookie);
        assert.equal(profile.json.desc, 'Hola', 'no debe sobrescribirse la descripcion con un texto cifrado');
        assert.equal(profile.json.name, 'Nombre Real', 'no debe tocarse el nombre');

        // Y en disco sigue habiendo UN solo cifrado (no un cifrado del
        // cifrado): el texto guardado vuelve a ser el mismo descifrado.
        const raw2 = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
        const row2 = raw2.prepare('SELECT bio FROM user_profiles WHERE bio LIKE ?').get('PCE%');
        raw2.close();
        assert.ok(row2 && row2.bio.startsWith('PCE') && !row2.bio.includes('PCE3:PCE3:'),
            'el texto guardado debe seguir siendo un unico cifrado');
        const profile2 = await api(srv.base, 'GET', '/profile?username=ana&me=ana', null, ana.cookie);
        assert.equal(profile2.json.desc, 'Hola', 'el texto descifrado debe seguir siendo el original');
    } finally { await stop(srv); }
});

test('un texto normal que supera el limite se sigue rechazando con 400', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const res = await api(srv.base, 'POST', '/profile',
            { username: 'ana', desc: 'x'.repeat(21) }, ana.cookie);
        assert.equal(res.status, 400);
    } finally { await stop(srv); }
});

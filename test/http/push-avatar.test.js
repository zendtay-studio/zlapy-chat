// El avatar público de las notificaciones push NO puede ser un oráculo de
// existencia de cuentas: sin sesión no debe distinguirse si un @usuario existe.
// Antes: existente → 200, inexistente → 404. Ahora: siempre un identicon,
// y para las inexistentes se deriva uno con HMAC de la llave maestra.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

const avatar = async (base, ruta, cookie) => {
    const headers = cookie ? { Cookie: `zlapy_session=${encodeURIComponent(cookie)}` } : {};
    const r = await fetch(base + ruta, { headers });
    return { status: r.status, tipo: r.headers.get('content-type') || '', svg: await r.text() };
};

test('/avatar/push no distingue cuentas existentes de inexistentes', async () => {
    const srv = await startServer();
    try {
        await register(srv.base, 'avatarreal');
        const real = await avatar(srv.base, '/avatar/push/avatarreal.svg');
        const fantasma = await avatar(srv.base, '/avatar/push/noexiste-xyz.svg');

        assert.equal(real.status, 200);
        assert.equal(fantasma.status, 200, 'una cuenta inexistente también responde 200');
        assert.match(real.tipo, /^image\/svg\+xml/);
        assert.match(fantasma.tipo, /^image\/svg\+xml/);
        assert.match(real.svg, /^<svg /);
        assert.match(fantasma.svg, /^<svg /);
        assert.notEqual(real.svg, fantasma.svg, 'cada identificador tiene su identicon');

        // Determinista: la misma cuenta inexistente siempre dibuja lo mismo.
        const otraVez = await avatar(srv.base, '/avatar/push/noexiste-xyz.svg');
        assert.equal(otraVez.svg, fantasma.svg);

        // Otra cuenta inexistente: identicon distinto (no un placeholder común).
        const otra = await avatar(srv.base, '/avatar/push/otro-inexistente.svg');
        assert.notEqual(otra.svg, fantasma.svg);
        assert.equal(otra.status, 200);
    } finally { await stop(srv); }
});

test('el avatar público de grupo tampoco delata su existencia', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'avatarpush1');
        const gid = (await api(srv.base, 'POST', '/groups', { name: 'Push' }, ana.cookie)).json.id;
        const real = await avatar(srv.base, `/avatar/push/${gid}.svg`);
        const fantasma = await avatar(srv.base, '/avatar/push/g_inexistente000.svg');

        assert.equal(real.status, 200);
        assert.equal(fantasma.status, 200);
        // El diseño es el de grupo en los dos casos (escudo con degradado).
        assert.match(real.svg, /linearGradient/);
        assert.match(fantasma.svg, /linearGradient/);
        assert.notEqual(real.svg, fantasma.svg);
    } finally { await stop(srv); }
});

test('el identicon del usuario real no cambia y /avatar sigue exigiendo sesión', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'avatarreal2');
        const publico = await avatar(srv.base, '/avatar/push/avatarreal2.svg');
        const conSesion = await avatar(srv.base, `/avatar/${ana.json.user.id}.svg`, ana.cookie);

        assert.equal(publico.status, 200);
        assert.equal(conSesion.status, 200);
        assert.equal(publico.svg, conSesion.svg,
            'el icono de las push es el mismo que el de la app para esa cuenta');

        // La ruta normal sigue cerrada a quien no tiene sesión.
        const sinSesion = await avatar(srv.base, '/avatar/avatarreal2.svg');
        assert.equal(sinSesion.status, 401);
    } finally { await stop(srv); }
});
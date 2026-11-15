// Ocultar el @usuario (estilo Telegram): ajuste de privacidad por función.
// Cuando está apagado para alguien, el perfil que recibe lleva
// permisos.verUsuario = false y la ficha muestra solo el nombre visible.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

async function pareja(srv, sufijo) {
    const ana = await register(srv.base, 'usu' + sufijo);
    const beto = await register(srv.base, 'usub' + sufijo);
    await api(srv.base, 'POST', '/contacts', { username: 'usub' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'usu' + sufijo, accept: true }, beto.cookie);
    return { ana, beto };
}

const perfilDe = async (base, cookie, username, me) => {
    const r = await api(base, 'GET', '/profile?username=' + encodeURIComponent(username) + '&me=' + encodeURIComponent(me), undefined, cookie);
    assert.equal(r.status, 200);
    return r.json;
};

test('por defecto el @usuario es visible (permisos.verUsuario)', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, '1');
        const p = await perfilDe(srv.base, beto.cookie, 'usu1', 'usub1');
        assert.equal(p.permisos.verUsuario, true);
        assert.equal(p.username, 'usu1');
    } finally { await stop(srv); }
});

test('apagado: el perfil lleva verUsuario=false y deja de servir el @usuario', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, '2');
        const guardado = await api(srv.base, 'POST', '/profile', { username: 'usu2', privacy: { usuario: { mode: 'nobody', users: [] } } }, ana.cookie);
        assert.equal(guardado.status, 200);
        const p = await perfilDe(srv.base, beto.cookie, 'usu2', 'usub2');
        assert.equal(p.permisos.verUsuario, false, 'la ficha sabe que no debe mostrar el @usuario');
        // El nombre visible sigue ahí (es con lo que se identifica).
        assert.ok(p.name && p.name.length, 'el nombre visible se mantiene');
        // Uno mismo siempre ve su propio @usuario.
        const mio = await perfilDe(srv.base, ana.cookie, 'usu2', 'usu2');
        assert.equal(mio.permisos.verUsuario, true);
        assert.equal(mio.username, 'usu2');
    } finally { await stop(srv); }
});
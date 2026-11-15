// ID personalizada de grupo: dirección pública para enlaces cortos
// (p. ej. /?join=equipo&code=…). No es el permiso —el código de
// invitación sigue siendo la puerta— sino la dirección. El servidor
// resuelve igual por id interna o por la personalizada.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

async function cuenta(srv, nombre) {
    const user = await register(srv.base, nombre);
    return user;
}

test('crear con ID personalizada: se guarda, se resuelve y es única', async () => {
    const srv = await startServer();
    try {
        const ana = await cuenta(srv, 'gcid1');
        const creado = await api(srv.base, 'POST', '/groups', { name: 'Equipo', customId: 'equipo-qa' }, ana.cookie);
        assert.equal(creado.status, 200);
        assert.equal(creado.json.customId, 'equipo-qa');

        // Resuelve por la personalizada (GET y POST /groups/<ref>).
        const porCustom = await api(srv.base, 'GET', '/groups/equipo-qa', undefined, ana.cookie);
        assert.equal(porCustom.status, 200);
        assert.equal(porCustom.json.id, creado.json.id);

        // Y por la id interna, como siempre.
        const porId = await api(srv.base, 'GET', '/groups/' + creado.json.id, undefined, ana.cookie);
        assert.equal(porId.status, 200);
        assert.equal(porId.json.customId, 'equipo-qa');

        // En uso: 409 con texto (no un fallo opaco del índice).
        const repetida = await api(srv.base, 'POST', '/groups', { name: 'Otro', customId: 'equipo-qa' }, ana.cookie);
        assert.equal(repetida.status, 409);

        // Formato inválido: 400.
        const mala = await api(srv.base, 'POST', '/groups', { name: 'Otro', customId: 'Equipo QA!' }, ana.cookie);
        assert.equal(mala.status, 400);
        const interna = await api(srv.base, 'POST', '/groups', { name: 'Otro', customId: 'g_reservada' }, ana.cookie);
        assert.equal(interna.status, 400, 'el prefijo g_ queda reservado a las ids internas');
    } finally { await stop(srv); }
});

test('la ID personalizada se puede cambiar y quitarla la deja libre', async () => {
    const srv = await startServer();
    try {
        const ana = await cuenta(srv, 'gcid2');
        const creado = await api(srv.base, 'POST', '/groups', { name: 'Equipo', customId: 'equipo-2' }, ana.cookie);
        const gid = creado.json.id;

        const cambio = await api(srv.base, 'POST', '/groups/' + gid, { customId: 'equipo-nuevo' }, ana.cookie);
        assert.equal(cambio.status, 200);
        assert.equal(cambio.json.customId, 'equipo-nuevo');
        const vieja = await api(srv.base, 'GET', '/groups/equipo-2', undefined, ana.cookie);
        assert.equal(vieja.status, 404, 'la dirección anterior deja de resolver');

        // Quitarla: vacía y liberada.
        const quitada = await api(srv.base, 'POST', '/groups/' + gid, { customId: '' }, ana.cookie);
        assert.equal(quitada.status, 200);
        assert.equal(quitada.json.customId, '');
        const reciclada = await api(srv.base, 'POST', '/groups', { name: 'Otro', customId: 'equipo-nuevo' }, ana.cookie);
        assert.equal(reciclada.status, 200, 'la ID liberada se puede reutilizar');
    } finally { await stop(srv); }
});
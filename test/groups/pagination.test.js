// Comprobar que contactos e integrantes se sirven PAGINADOS: el cliente
// ve la lista completa cuando no pide páginas (compatibilidad) y, con
// limit/offset, recibe una página estable ordenada + more/total para
// seguir cargando al deslizar. El grupo admite además recortar sus
// integrantes (membersLimit) y el detalle pagina el resto.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startServer, stop, api, register } = require('../helpers.js');

test('contactos, integrantes y grupos se sirven paginados', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana', 'claveana1234');
        const beto = await register(srv.base, 'beto', 'clavebeto1234');
        const cira = await register(srv.base, 'cira', 'clavecira1234');
        const dani = await register(srv.base, 'dani', 'clavedani1234');
        const otros = { beto, cira, dani };
        for (const usuario of ['beto', 'cira', 'dani']) {
            await api(srv.base, 'POST', '/contacts', { username: usuario }, ana.cookie);
            await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, otros[usuario].cookie);
        }

        // Compatibilidad: sin parámetros manda TODO (uno mismo primero).
        const full = await api(srv.base, 'GET', '/users', null, ana.cookie);
        assert.equal(full.status, 200);
        assert.equal(full.json.users.length, 4);
        assert.equal(full.json.users[0].username, 'ana');
        assert.equal(full.json.more, false);
        assert.equal(full.json.total, 4);

        // Páginas de 2 (orden estable: uno mismo, luego alfabético).
        const p1 = await api(srv.base, 'GET', '/users?limit=2&offset=0', null, ana.cookie);
        assert.deepEqual(p1.json.users.map(u => u.username), ['ana', 'beto']);
        assert.equal(p1.json.more, true);
        assert.equal(p1.json.total, 4);
        const p2 = await api(srv.base, 'GET', '/users?limit=2&offset=2', null, ana.cookie);
        assert.deepEqual(p2.json.users.map(u => u.username), ['cira', 'dani']);
        assert.equal(p2.json.more, false);
        assert.equal(p2.json.offset, 2);

        // Búsqueda server-side y validación.
        const q = await api(srv.base, 'GET', '/users?limit=40&q=ci', null, ana.cookie);
        assert.deepEqual(q.json.users.map(u => u.username), ['cira']);
        // Un límite absurdo se RECORTA (permisivo); uno no numérico, 400.
        const cero = await api(srv.base, 'GET', '/users?limit=0', null, ana.cookie);
        assert.equal(cero.status, 200);
        assert.equal(cero.json.users.length, 1);
        const exagerado = await api(srv.base, 'GET', '/users?limit=99999&offset=0', null, ana.cookie);
        assert.equal(exagerado.status, 200);
        assert.equal(exagerado.json.users.length, 4);
        const bad = await api(srv.base, 'GET', '/users?limit=abc', null, ana.cookie);
        assert.equal(bad.status, 400);
        const mal = await api(srv.base, 'GET', '/users?offset=-1', null, ana.cookie);
        assert.equal(mal.status, 400);

        // Grupo de 3 integrantes (ana + beto + cira).
        const creado = await api(srv.base, 'POST', '/groups', { name: 'Paginados' }, ana.cookie);
        assert.equal(creado.status, 200);
        const gid = creado.json.id;
        await api(srv.base, 'POST', '/groups/' + gid, { addMember: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/groups/' + gid, { addMember: 'cira' }, ana.cookie);

        const m1 = await api(srv.base, 'GET', `/groups/${gid}/members?limit=1`, null, ana.cookie);
        assert.deepEqual(m1.json.members, ['ana']);
        assert.equal(m1.json.total, 3);
        assert.equal(m1.json.more, true);
        const m3 = await api(srv.base, 'GET', `/groups/${gid}/members?limit=1&offset=2`, null, ana.cookie);
        assert.deepEqual(m3.json.members, ['cira']);
        assert.equal(m3.json.more, false);

        // Quien no es integrante no ve la lista.
        const fuera = await api(srv.base, 'GET', `/groups/${gid}/members`, null, dani.cookie);
        assert.equal(fuera.status, 404);

        // Recorte opcional del grupo (membersTotal sigue siendo el real).
        const recortado = await api(srv.base, 'GET', `/groups/${gid}?membersLimit=2`, null, ana.cookie);
        assert.equal(recortado.status, 200);
        assert.equal(recortado.json.members.length, 2);
        assert.equal(recortado.json.membersTotal, 3);
        const completo = await api(srv.base, 'GET', `/groups/${gid}?light=1`, null, ana.cookie);
        assert.equal(completo.json.members.length, 3);
        const recorteExagerado = await api(srv.base, 'GET', `/groups/${gid}?membersLimit=99999`, null, ana.cookie);
        assert.equal(recorteExagerado.status, 200);
        assert.equal(recorteExagerado.json.members.length, 3);
    } finally {
        await stop(srv);
    }
});
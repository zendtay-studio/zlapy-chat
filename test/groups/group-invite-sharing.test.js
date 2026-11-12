// Comprobar que la invitación de un grupo la puede COMPARTIR cualquier
// miembro, no solo los administradores: el código de invitación llega al
// detalle del grupo de todos los miembros, pero NUNCA a un no miembro.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startServer, stop, api, register } = require('../helpers.js');

test('la invitación de un grupo se comparte entre miembros, no solo admins', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana', 'claveana1234');
        const beto = await register(srv.base, 'beto', 'clavebeto1234');
        const cira = await register(srv.base, 'cira', 'clavecira1234');
        const dani = await register(srv.base, 'dani', 'clavedani1234');
        for (const uno of [ana, beto, cira, dani]) assert.ok(uno.cookie, 'falta cookie de sesión');

        // ana y beto son contactos: ana crea el grupo con beto dentro (beto
        // entra como MIEMBRO, no como admin: solo puede hablar, no gestionar).
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        const creado = await api(srv.base, 'POST', '/groups', { name: 'Equipo' }, ana.cookie);
        assert.equal(creado.status, 200);
        const gid = creado.json.id;
        const metido = await api(srv.base, 'POST', '/groups/' + gid, { addMember: 'beto' }, ana.cookie);
        assert.equal(metido.status, 200, 'beto debe entrar como miembro');
        await api(srv.base, 'POST', '/contacts', { username: 'cira' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, cira.cookie);

        // El detalle del grupo lleva el código de invitación al ADMIN...
        const vistaAdmin = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, ana.cookie);
        assert.equal(vistaAdmin.status, 200);
        assert.ok(vistaAdmin.json.inviteCode, 'el admin debe recibir el código');

        // ...y también al MIEMBRO (antes solo lo veía el admin).
        const vistaMiembro = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, beto.cookie);
        assert.equal(vistaMiembro.status, 200);
        assert.equal(vistaMiembro.json.inviteCode, vistaAdmin.json.inviteCode,
            'un miembro debe poder compartir la invitación');

        // Compartir la invitación desde la cuenta del miembro funciona.
        await api(srv.base, 'POST', '/contacts', { username: 'dani' }, beto.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'beto', accept: true }, dani.cookie);
        await api(srv.base, 'POST', '/contacts', { username: 'cira' }, beto.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'beto', accept: true }, cira.cookie);
        const compartido = await api(srv.base, 'POST', '/send', {
            to: 'cira',
            kind: 'group-invite',
            groupId: gid,
            inviteCode: vistaMiembro.json.inviteCode
        }, beto.cookie);
        assert.equal(compartido.status, 200, 'un miembro debe poder enviar la invitación');

        // Un no miembro NO recibe el código ni puede compartir la invitación.
        const vistaAjena = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, dani.cookie);
        assert.equal(vistaAjena.status, 404);
        // dani y cira son contactos para que el envío llegue a la comprobación
        // de la invitación (el rechazo por privacidad responde 200 "denied").
        await api(srv.base, 'POST', '/contacts', { username: 'cira' }, dani.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'dani', accept: true }, cira.cookie);
        const compartidoAjeno = await api(srv.base, 'POST', '/send', {
            to: 'cira',
            kind: 'group-invite',
            groupId: gid,
            inviteCode: vistaAdmin.json.inviteCode
        }, dani.cookie);
        assert.equal(compartidoAjeno.status, 403, 'un no miembro no puede invitar');

        // La lista de grupos no filtra el código a nadie.
        const lista = await api(srv.base, 'GET', '/groups', null, beto.cookie);
        assert.equal(lista.status, 200);
        for (const grupo of lista.json) assert.equal(grupo.inviteCode, undefined);
    } finally {
        await stop(srv);
    }
});

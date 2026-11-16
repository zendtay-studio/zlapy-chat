// Ocultar el @usuario DEL LADO DEL SERVIDOR en los payloads de grupo.
// Quien apaga la visibilidad de su @usuario (privacidad 'usuario') no debe
// viajar NUNCA con su nombre en los grupos que comparte: el servidor lo
// sustituye por un alias opaco (el UUID de la cuenta), que sirve para abrir
// el perfil, el avatar y las acciones de administración.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OCULTOS = { usuario: { mode: 'nobody', users: [] } };

// ana (admin) + beto y cira (integrantes) + dani (ajeno) contactados entre sí.
async function grupoConOculto(srv, sufijo) {
    const ana = await register(srv.base, 'ana' + sufijo);
    const beto = await register(srv.base, 'beto' + sufijo);
    const cira = await register(srv.base, 'cira' + sufijo);
    const dani = await register(srv.base, 'dani' + sufijo);
    for (const uno of [ana, beto, cira, dani]) assert.ok(uno.cookie, 'falta cookie de sesión');
    // beto oculta su @usuario a todo el mundo y se pone un nombre bien reconocible.
    await api(srv.base, 'POST', '/profile', { username: 'beto' + sufijo, name: 'Beto Secreto', privacy: OCULTOS }, beto.cookie);
    // Contactos: ana necesita ser contacto de beto y cira para meterlos en el grupo.
    await api(srv.base, 'POST', '/contacts', { username: 'beto' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'ana' + sufijo, accept: true }, beto.cookie);
    await api(srv.base, 'POST', '/contacts', { username: 'cira' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'ana' + sufijo, accept: true }, cira.cookie);
    const creado = await api(srv.base, 'POST', '/groups', { name: 'Secreto' + sufijo }, ana.cookie);
    assert.equal(creado.status, 200);
    const gid = creado.json.id;
    for (const nombre of ['beto' + sufijo, 'cira' + sufijo])
        assert.equal((await api(srv.base, 'POST', '/groups/' + gid, { addMember: nombre }, ana.cookie)).status, 200);
    return { ana, beto, cira, dani, gid, alias: beto.json.user.id };
}

test('el @usuario oculto no viaja en el payload del grupo: va su UUID', async () => {
    const srv = await startServer();
    try {
        const { ana, beto, cira, gid, alias } = await grupoConOculto(srv, '1');
        assert.ok(UUID_RE.test(alias), 'el alias debe ser el UUID de la cuenta');

        // Vista del admin: beto NO está por su nombre, sino por el alias.
        const vista = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, ana.cookie);
        assert.equal(vista.status, 200);
        assert.deepEqual(vista.json.members, ['ana1', alias, 'cira1']);
        assert.equal(vista.json.membersTotal, 3, 'el número de integrantes no cambia');
        assert.ok(!vista.json.members.includes('beto1'), 'el nombre oculto NO puede viajar');
        assert.deepEqual(vista.json.hideUsuario, [alias], 'la lista de ocultos lleva el alias, no el nombre');
        assert.ok(!vista.json.hideUsuario.includes('beto1'));

        // La misma historia la ve otro integrante sin permiso.
        const vistaCira = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, cira.cookie);
        assert.ok(!vistaCira.json.members.includes('beto1'));
        assert.deepEqual(vistaCira.json.hideUsuario, [alias]);

        // La lista paginada de integrantes tampoco filtra el nombre.
        const pagina = await api(srv.base, 'GET', '/groups/' + gid + '/members', null, cira.cookie);
        assert.equal(pagina.status, 200);
        assert.equal(pagina.json.total, 3);
        assert.ok(!pagina.json.members.includes('beto1'), 'ni en /members');

        // Uno mismo SI se ve (y el grupo le llega completo).
        const propio = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, beto.cookie);
        assert.ok(propio.json.members.includes('beto1'), 'el dueño del secreto se ve a sí mismo');
        assert.deepEqual(propio.json.hideUsuario, []);
    } finally { await stop(srv); }
});

test('mensajes y previews de grupo van con el alias para cada visor', async () => {
    const srv = await startServer();
    try {
        const { ana, beto, cira, gid, alias } = await grupoConOculto(srv, '2');
        // El texto es distinto del nombre para no confundir qué se comparó.
        const enviado = await api(srv.base, 'POST', '/groups/' + gid, { message: { kind: 'text', data: 'hola a todos' } }, beto.cookie);
        assert.equal(enviado.status, 200);
        assert.equal(enviado.json.message.from, 'beto2', 'el remitente se ve a sí mismo');

        // Historial del grupo: para los demás llega el alias.
        for (const vista of [ana, cira]) {
            const conHistorial = await api(srv.base, 'GET', '/groups/' + gid, null, vista.cookie);
            assert.equal(conHistorial.status, 200);
            const mensajes = conHistorial.json.messages || [];
            assert.equal(mensajes.length, 1);
            assert.equal(mensajes[0].from, alias, 'el remitente viaja como alias');
            assert.equal(mensajes[0].data, 'hola a todos');
            assert.ok(!JSON.stringify(mensajes).includes('beto2'), 'el nombre no puede aparecer en el payload');

            const conBrief = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, vista.cookie);
            assert.equal(conBrief.json.brief.length, 1);
            assert.equal(conBrief.json.brief[0].from, alias, 'el resumen breve también lleva alias');

            // Lista de conversaciones: el preview del grupo, personalizado.
            const lista = await api(srv.base, 'GET', '/chats/summary', null, vista.cookie);
            const grupo = (lista.json.chats || []).find(c => c.group === gid);
            assert.ok(grupo, 'el grupo aparece en la lista');
            assert.equal(grupo.last.from, alias, 'el preview del chat lleva alias');
            assert.equal(grupo.last.text, 'hola a todos', 'el texto sigue intacto');
        }

        // El propio beto ve su nombre en todas esas vistas.
        const propia = await api(srv.base, 'GET', '/groups/' + gid, null, beto.cookie);
        assert.equal(propia.json.messages[0].from, 'beto2');
        const listaPropia = await api(srv.base, 'GET', '/chats/summary', null, beto.cookie);
        const grupoPropio = (listaPropia.json.chats || []).find(c => c.group === gid);
        assert.equal(grupoPropio.last.from, 'beto2');
    } finally { await stop(srv); }
});

test('el alias abre el perfil solo de quien comparte grupo', async () => {
    const srv = await startServer();
    try {
        const { cira, dani, gid, alias } = await grupoConOculto(srv, '3');
        // Comparte grupo: nombre visible y foto SÍ, @usuario NO.
        const visto = await api(srv.base, 'GET', '/profile?username=' + encodeURIComponent(alias) + '&me=cira3', null, cira.cookie);
        assert.equal(visto.status, 200);
        assert.equal(visto.json.name, 'Beto Secreto', 'el nombre visible se mantiene');
        assert.equal(visto.json.username, alias, 'la respuesta no lleva el @usuario real');
        assert.equal(visto.json.permisos.verUsuario, false);

        // Ajeno al grupo: el alias no es un oráculo de cuentas.
        const ajeno = await api(srv.base, 'GET', '/profile?username=' + encodeURIComponent(alias) + '&me=dani3', null, dani.cookie);
        assert.equal(ajeno.status, 200);
        assert.ok(!ajeno.json.name, 'un no miembro no saca nada del alias');
        assert.equal(ajeno.json.username, alias);

        // Agregar contacto desde el alias funciona para quien comparte grupo…
        const agregado = await api(srv.base, 'POST', '/contacts', { username: alias }, cira.cookie);
        assert.equal(agregado.status, 200);
        // …y no para el ajeno.
        const rechazado = await api(srv.base, 'POST', '/contacts', { username: alias }, dani.cookie);
        assert.equal(rechazado.status, 404, 'sin grupo compartido el alias no identifica a nadie');
    } finally { await stop(srv); }
});

test('las acciones de admin aceptan el alias (ascender, entrar, aprobar)', async () => {
    const srv = await startServer();
    try {
        const { ana, beto, cira, dani, gid, alias } = await grupoConOculto(srv, '5');
        // Ascender por alias: el nombre real no hace falta en la petición.
        const ascendido = await api(srv.base, 'POST', '/groups/' + gid, { approveAdmin: alias }, ana.cookie);
        assert.equal(ascendido.status, 200);
        assert.ok(ascendido.json.admins.includes(alias), 'el admin ve el alias en la lista');
        assert.ok(!JSON.stringify(ascendido.json.admins).includes('beto5'));

        // Solicitud de ingreso: dani (con el @ oculto) pide entrar…
        const conSecreto = await register(srv.base, 'elmo5');
        await api(srv.base, 'POST', '/profile', { username: 'elmo5', privacy: OCULTOS }, conSecreto.cookie);
        const codigo = (await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, ana.cookie)).json.inviteCode;
        assert.equal((await api(srv.base, 'POST', '/groups/' + gid, { join: true, inviteCode: codigo }, conSecreto.cookie)).status, 200);
        // …y el admin ve solo el alias en las solicitudes.
        const conSolicitud = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, ana.cookie);
        const solicitud = conSolicitud.json.joinRequests.find(r => r.userId === conSecreto.json.user.id);
        assert.ok(solicitud, 'la solicitud está pendiente');
        assert.equal(solicitud.username, conSecreto.json.user.id, 'la solicitud viaja con el alias');
        assert.equal(solicitud.verUsuario, false, 'los clientes antiguos saben que no pinten el @');
        // Aprueba por alias.
        assert.equal((await api(srv.base, 'POST', '/groups/' + gid, { approveJoin: conSecreto.json.user.id }, ana.cookie)).status, 200);
        const trasAprobar = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, ana.cookie);
        assert.ok(trasAprobar.json.members.includes(conSecreto.json.user.id), 'entró con su alias');
        assert.equal(trasAprobar.json.joinRequests.length, 0);

        // Y expulsar por alias también.
        const sinBeto = await api(srv.base, 'POST', '/groups/' + gid, { removeMember: alias }, ana.cookie);
        assert.equal(sinBeto.status, 200);
        const final = await api(srv.base, 'GET', '/groups/' + gid + '?light=1', null, ana.cookie);
        assert.ok(!final.json.members.includes(alias), 'el alias ya no está entre los integrantes');
        assert.equal(final.json.membersTotal, 3, 'quedan ana, cira y elmo');
    } finally { await stop(srv); }
});
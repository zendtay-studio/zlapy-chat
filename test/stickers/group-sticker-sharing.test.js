// Stickers creados por una cuenta y enviados a un grupo: ¿los ven los demás
// integrantes? El caso que se reportó fue «creé un sticker, lo envié a un grupo
// y no se ve». Aquí se comprueba el viaje completo: el mensaje viaja con la
// referencia al blob y cada integrante puede descargarlo, igual que con los
// stickers públicos o los del paquete por defecto.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

function webpSquare(size = 512) {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WEBP', 8, 'ascii');
    bytes.write('VP8X', 12, 'ascii');
    bytes.writeUInt32LE(10, 16);
    const dimension = size - 1;
    bytes[24] = bytes[27] = dimension & 0xff;
    bytes[25] = bytes[28] = (dimension >>> 8) & 0xff;
    return bytes;
}

test('un sticker creado sin publicar se ve en el grupo por los demás integrantes', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'sticre1');
        const beto = await register(srv.base, 'sticre2');
        for (const uno of [ana, beto]) assert.ok(uno.cookie, 'falta cookie');
        await api(srv.base, 'POST', '/contacts', { username: 'sticre2' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'sticre1', accept: true }, beto.cookie);

        // Sticker propio, SIN publicar (no sale en el buscador de nadie más).
        const bytes = webpSquare(512);
        const creado = await api(srv.base, 'POST', '/stickers/create', {
            data: `data:image/webp;base64,${bytes.toString('base64')}`
        }, ana.cookie);
        assert.equal(creado.status, 201);
        const sticker = creado.json.sticker;
        assert.equal(sticker, '/stickers/blob/' + crypto.createHash('sha256').update(bytes).digest('hex'));

        const grupo = await api(srv.base, 'POST', '/groups', { name: 'Stickers' }, ana.cookie);
        assert.equal(grupo.status, 200);
        const gid = grupo.json.id;
        assert.equal((await api(srv.base, 'POST', '/groups/' + gid, { addMember: 'sticre2' }, ana.cookie)).status, 200);

        // Enviarlo al grupo: Ana solo necesita tenerlo, no hace falta publicarlo.
        const enviado = await api(srv.base, 'POST', '/groups/' + gid, {
            message: { kind: 'sticker', data: sticker }
        }, ana.cookie);
        assert.equal(enviado.status, 200, 'el remitente puede enviar su propio sticker');
        assert.equal(enviado.json.message.kind, 'sticker');

        // Beto recibe el mensaje con la referencia intacta.
        const vista = await api(srv.base, 'GET', '/groups/' + gid, null, beto.cookie);
        assert.equal(vista.status, 200);
        const mensaje = (vista.json.messages || []).find(m => m.kind === 'sticker');
        assert.ok(mensaje, 'el mensaje de sticker llega al grupo');
        assert.equal(mensaje.data, sticker, 'la referencia al blob viaja en el mensaje');

        // Y puede DESCARGARLO: aquí es donde se rompería si no se repartiera el
        // acceso al blob entre los integrantes.
        const visto = await fetch(srv.base + sticker, {
            headers: { Cookie: `zlapy_session=${encodeURIComponent(beto.cookie)}` }
        });
        assert.equal(visto.status, 200, 'otro integrante debe poder ver el sticker');
        assert.equal(visto.headers.get('content-type'), 'image/webp');
        assert.deepEqual(Buffer.from(await visto.arrayBuffer()), bytes);
    } finally { await stop(srv); }
});

test('un no integrante no puede descargar el sticker del grupo', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'sticre3');
        const beto = await register(srv.base, 'sticre4');
        const cira = await register(srv.base, 'sticre5');
        for (const uno of [ana, beto, cira]) assert.ok(uno.cookie, 'falta cookie');
        await api(srv.base, 'POST', '/contacts', { username: 'sticre4' }, ana.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'sticre3', accept: true }, beto.cookie);

        const bytes = webpSquare(256);
        const sticker = (await api(srv.base, 'POST', '/stickers/create', {
            data: `data:image/webp;base64,${bytes.toString('base64')}`
        }, ana.cookie)).json.sticker;

        const gid = (await api(srv.base, 'POST', '/groups', { name: 'Privado' }, ana.cookie)).json.id;
        await api(srv.base, 'POST', '/groups/' + gid, { addMember: 'sticre4' }, ana.cookie);
        await api(srv.base, 'POST', '/groups/' + gid, { message: { kind: 'sticker', data: sticker } }, ana.cookie);

        // Cira no está en el grupo: el blob sigue siendo privado.
        const ajeno = await fetch(srv.base + sticker, {
            headers: { Cookie: `zlapy_session=${encodeURIComponent(cira.cookie)}` }
        });
        assert.equal(ajeno.status, 404, 'quien no es integrante no descarga el sticker');
    } finally { await stop(srv); }
});

/* La otra pregunta: «¿y a un usuario al que no tengo agregado?». En un chat 1:1
   manda la privacidad «mensajes», que por defecto es «solo contactos»: la
   respuesta llega como denied (el cliente avisa) y el mensaje NO se guarda. Si
   la cuenta abre los mensajes a todos, el sticker viaja igual que en el grupo. */
test('en un chat 1:1 el sticker depende de la privacidad «mensajes» del destinatario', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'sticre6');
        const beto = await register(srv.base, 'sticre7');
        for (const uno of [ana, beto]) assert.ok(uno.cookie, 'falta cookie');

        const bytes = webpSquare(256);
        const sticker = (await api(srv.base, 'POST', '/stickers/create', {
            data: `data:image/webp;base64,${bytes.toString('base64')}`
        }, ana.cookie)).json.sticker;

        // Sin contacto y con la privacidad por defecto («solo contactos»).
        const denegado = await api(srv.base, 'POST', '/send', { to: 'sticre7', kind: 'sticker', data: sticker }, ana.cookie);
        assert.equal(denegado.status, 200);
        assert.equal(denegado.json.denied, true, 'un no contacto no recibe el mensaje');
        const mensajes = await api(srv.base, 'POST', '/messages', { to: 'sticre6' }, beto.cookie);
        assert.equal(mensajes.json.messages.length, 0, 'y no queda nada guardado');

        // Beto abre los mensajes a todos: ahora sí viaja.
        await api(srv.base, 'POST', '/profile', { username: 'sticre7', privacy: { mensajes: { mode: 'all', users: [] } } }, beto.cookie);
        const permitido = await api(srv.base, 'POST', '/send', { to: 'sticre7', kind: 'sticker', data: sticker }, ana.cookie);
        assert.equal(permitido.status, 200);
        assert.equal(permitido.json.denied, undefined, 'con los mensajes abiertos se envía');
        const vistos = await api(srv.base, 'POST', '/messages', { to: 'sticre6' }, beto.cookie);
        assert.equal(vistos.json.messages.length, 1);
        assert.equal(vistos.json.messages[0].kind, 'sticker');
        assert.equal(vistos.json.messages[0].data, sticker);
    } finally { await stop(srv); }
});
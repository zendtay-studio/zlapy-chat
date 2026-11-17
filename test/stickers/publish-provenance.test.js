// A3: publicar un sticker solo es posible si el blob es PROPIO.
//
// El catálogo público de stickers es visible para cualquier cuenta, así que
// publicar un archivo recibido de otra persona (o su avatar, o el medio de su
// historia) lo expondría a todo el mundo. El servidor comprueba la procedencia
// del hash antes de insertar en `public_stickers`.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

/* WebP cuadrado mínimo (el mismo que acepta validStickerUpload). */
function webpSquare512() {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WEBP', 8, 'ascii');
    bytes.write('VP8X', 12, 'ascii');
    bytes.writeUInt32LE(10, 16);
    bytes[24] = bytes[27] = 511 & 0xff;
    bytes[25] = bytes[28] = 511 >>> 8;
    return bytes;
}

async function pareja(srv, sufijo) {
    const ana = await register(srv.base, 'pubana' + sufijo);
    const beto = await register(srv.base, 'pubbeto' + sufijo);
    await api(srv.base, 'POST', '/contacts', { username: 'pubbeto' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'pubana' + sufijo, accept: true }, beto.cookie);
    return { ana, beto };
}

test('un archivo PROPIO se puede publicar; uno recibido de otro, no', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, 'a');
        const data = `data:image/webp;base64,${webpSquare512().toString('base64')}`;

        // Crear sin publicar: siempre permitido (queda como favorito propio).
        const creado = await api(srv.base, 'POST', '/stickers/create', { data }, ana.cookie);
        assert.equal(creado.status, 201);
        assert.equal(creado.json.published, false);

        // Publicar lo propio: permitido.
        const propio = await api(srv.base, 'POST', '/stickers/create',
            { data, publish: true, tags: ['propio', 'ana'] }, ana.cookie);
        assert.equal(propio.status, 201);
        assert.equal(propio.json.published, true);

        // El MISMO archivo subido por beto ahora tiene procedencia ajena
        // (el blob quedó asociado al sticker público de ana): no lo puede
        // publicar beto.
        const ajeno = await api(srv.base, 'POST', '/stickers/create',
            { data, publish: true, tags: ['ajeno', 'beto'] }, beto.cookie);
        assert.equal(ajeno.status, 403, 'un blob con dueño ajeno no se publica');
        assert.equal(ajeno.json.published, undefined);
    } finally { await stop(srv); }
});

test('el recipiente de un adjunto en chat no puede publicarlo', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, 'b');
        const data = `data:image/webp;base64,${webpSquare512().toString('base64')}`;
        const hash = require('crypto').createHash('sha256')
            .update(Buffer.from(webpSquare512().toString('base64'), 'base64')).digest('hex');

        // ana envía el adjunto a beto: el blob queda asociado al mensaje de ana.
        const envio = await api(srv.base, 'POST', '/send',
            { to: 'pubbetob', kind: 'image', hash, data, name: 'sticker.webp', mime: 'image/webp' }, ana.cookie);
        assert.equal(envio.status, 200, JSON.stringify(envio.json).slice(0, 200));

        // beto, que solo lo RECIBIÓ, intenta publicarlo: rechazo.
        const publicado = await api(srv.base, 'POST', '/stickers/create',
            { data, publish: true, tags: ['robado'] }, beto.cookie);
        assert.equal(publicado.status, 403, 'quien recibe un adjunto no puede publicarlo');

        // ana, su autora, sí (el mensaje es suyo).
        const deAna = await api(srv.base, 'POST', '/stickers/create',
            { data, publish: true, tags: ['mio'] }, ana.cookie);
        assert.equal(deAna.status, 201);
        assert.equal(deAna.json.published, true);
    } finally { await stop(srv); }
});

test('el catálogo público sigue sirviendo lo publicado', async () => {
    const srv = await startServer();
    try {
        const { ana } = await pareja(srv, 'c');
        const data = `data:image/webp;base64,${webpSquare512().toString('base64')}`;
        const publicado = await api(srv.base, 'POST', '/stickers/create',
            { data, publish: true, tags: ['catalogo'] }, ana.cookie);
        assert.equal(publicado.status, 201);

        const busqueda = await api(srv.base, 'GET', '/stickers/discover?q=catalogo', null, ana.cookie);
        assert.equal(busqueda.status, 200);
        assert.ok((busqueda.json.stickers || []).some(s => s.sticker === publicado.json.sticker),
            'el sticker publicado aparece en el catálogo');
    } finally { await stop(srv); }
});
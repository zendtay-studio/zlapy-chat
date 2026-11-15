// Miniatura pública de la foto de perfil para el icono de las push.
//
// La foto real viaja cifrada E2E (el servidor no puede generar
// miniaturas), así que el cliente sube aparte un recorte de 128px en
// claro y el servidor lo sirve SIN sesión en una URL con token NO
// adivinable. El token rota en cada subida y el borrado quita la fila:
// las copias cacheadas de la foto anterior mueren solas.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startServer, stop, api, register } = require('../helpers.js');

/* PNG 1x1 válido (un píxel), para no depender de un canvas en el test. */
const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PIXEL_DATA_URL = 'data:image/png;base64,' + PIXEL_PNG;

test('la miniatura de push se sube con sesión, rota token y se sirve pública', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'minia');
        assert.ok(ana.cookie, 'falta cookie de sesión');

        // Sin sesión no se sube nada.
        const sinSesion = await api(srv.base, 'POST', '/profile/push-avatar', { data: PIXEL_DATA_URL });
        assert.equal(sinSesion.status, 401);

        // Subida válida: devuelve la URL con token.
        const subida = await api(srv.base, 'POST', '/profile/push-avatar', { data: PIXEL_DATA_URL }, ana.cookie);
        assert.equal(subida.status, 200);
        assert.ok(subida.json.ok);
        assert.match(subida.json.url, /^\/avatar\/push\/t\/[A-Za-z0-9_-]{20,}\.jpg$/, 'la URL lleva token no adivinable');

        // El servicio de push la descarga SIN cookies: bytes íntegros y caché pública.
        const publica = await fetch(srv.base + subida.json.url);
        assert.equal(publica.status, 200);
        assert.match(publica.headers.get('content-type') || '', /image\/png/);
        assert.match(publica.headers.get('cache-control') || '', /public/);
        assert.ok(Buffer.from(PIXEL_PNG, 'base64').equals(Buffer.from(await publica.arrayBuffer())), 'los bytes servidos son los subidos');

        // Token inventado pero bien formado: 404 (no adivinable).
        const fantasma = await fetch(srv.base + '/avatar/push/t/' + 'x'.repeat(32) + '.jpg');
        assert.equal(fantasma.status, 404);

        // Re-subida: el token ROTA (la URL vieja muere, la nueva sirve).
        const rotada = await api(srv.base, 'POST', '/profile/push-avatar', { data: PIXEL_DATA_URL }, ana.cookie);
        assert.equal(rotada.status, 200);
        assert.notEqual(rotada.json.url, subida.json.url);
        assert.equal((await fetch(srv.base + subida.json.url)).status, 404, 'la URL antigua deja de existir');
        assert.equal((await fetch(srv.base + rotada.json.url)).status, 200);

        // Borrado: sin miniatura, la URL da 404 (queda el identicon).
        const borrado = await api(srv.base, 'POST', '/profile/push-avatar', { data: '' }, ana.cookie);
        assert.equal(borrado.status, 200);
        assert.equal((await fetch(srv.base + rotada.json.url)).status, 404);

        // El identicon de push sigue ahí (fallback de siempre).
        const identicon = await fetch(srv.base + '/avatar/push/minia.svg');
        assert.equal(identicon.status, 200);
        assert.match(identicon.headers.get('content-type') || '', /image\/svg/);
    } finally { await stop(srv); }
});

test('la miniatura valida tipo y tamaño, y el identicon no se rompe', async () => {
    const srv = await startServer();
    try {
        const beto = await register(srv.base, 'minib');
        assert.ok(beto.cookie, 'falta cookie de sesión');

        // Formato no permitido (gif) → 400.
        const gif = await api(srv.base, 'POST', '/profile/push-avatar', { data: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, beto.cookie);
        assert.equal(gif.status, 400);

        // Demasiado grande → 400.
        const enorme = await api(srv.base, 'POST', '/profile/push-avatar', { data: 'data:image/png;base64,' + 'A'.repeat(33000) }, beto.cookie);
        assert.equal(enorme.status, 400);

        // Texto que no es data URL → 400.
        const texto = await api(srv.base, 'POST', '/profile/push-avatar', { data: 'hola' }, beto.cookie);
        assert.equal(texto.status, 400);

        // La ruta antigua del identicon sigue respondiendo y el normal
        // (con sesión) también: nada de esto cambió.
        const pushSvg = await fetch(srv.base + '/avatar/push/minib.svg');
        assert.equal(pushSvg.status, 200);
        const conSesion = await api(srv.base, 'GET', '/avatar/' + beto.json.user.id + '.svg', undefined, beto.cookie);
        assert.equal(conSesion.status, 200);
    } finally { await stop(srv); }
});

// Comprobar que las notificaciones llevan CONTENIDO real (texto del
// mensaje o tipo de adjunto), la foto de perfil como icono y que la ruta
// del avatar de push es pública (la descarga el servicio de push sin
// cookies) mientras la normal sigue exigiendo sesión.
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startServer, stop, api, register } = require('../helpers.js');
const { avatarPushUrl, pushBody } = require('../../src/push/vapid.js');

test('cuerpo de la notificación: texto real o tipo de adjunto', () => {
    assert.equal(pushBody('text', '  Hola   mundo  ', ''), 'Hola mundo');
    assert.equal(pushBody('text', 'línea uno\nlínea dos', ''), 'línea uno línea dos');
    assert.equal(pushBody('text', '', ''), 'Mensaje nuevo');
    assert.equal(pushBody('image', '', 'mi foto'), 'Foto: mi foto');
    assert.equal(pushBody('video', '', ''), 'Video');
    assert.equal(pushBody('audio', '', ''), 'Nota de voz');
    assert.equal(pushBody('sticker', '', ''), 'Stricker');
    assert.equal(pushBody('poll', '', ''), 'Encuesta');
    assert.equal(pushBody('desconocido', '', ''), 'Mensaje nuevo');
    assert.equal(avatarPushUrl('ana'), '/avatar/push/ana.svg');
});

test('el avatar de push es público y el normal exige sesión', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana', 'claveana1234');
        assert.ok(ana.cookie, 'falta cookie de sesión');

        // Sin cookie: el servicio de push descarga el icono.
        const pushSvg = await fetch(srv.base + '/avatar/push/ana.svg');
        assert.equal(pushSvg.status, 200);
        assert.match(pushSvg.headers.get('content-type') || '', /image\/svg/);
        assert.match(pushSvg.headers.get('cache-control') || '', /public/);
        assert.match(await pushSvg.text(), /<svg/);

        const nadie = await fetch(srv.base + '/avatar/push/noexiste.svg');
        assert.equal(nadie.status, 404);

        // La ruta normal NO es pública: no se filtra presencia ni datos.
        const normal = await fetch(srv.base + '/avatar/ana.svg');
        assert.equal(normal.status, 401);

        // Con sesión, la normal sí sirve (no cambió su comportamiento).
        const conSesion = await fetch(srv.base + '/avatar/ana.svg', { headers: { Cookie: 'chatlocal_session=' + ana.cookie } });
        assert.equal(conSesion.status, 200);
    } finally {
        await stop(srv);
    }
});
// Aviso de cambio de clave de cifrado («mensaje del sistema»).
//
// Al regenerar la clave, el hilo con cada contacto sigue existiendo pero lo
// anterior ya no se lee con la clave vieja: cada cliente pinta un mensaje del
// sistema informativo en la conversación. El servidor solo EMPUJA el aviso
// (`keychange`) a los contactos; no guarda nada en sus filas ni en su
// conversación, y a quien no esté conectado no le queda nada pendiente.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register, WsClient } = require('../helpers.js');

async function pareja(srv, sufijo) {
    const ana = await register(srv.base, 'kc' + sufijo);
    const beto = await register(srv.base, 'kcb' + sufijo);
    await api(srv.base, 'POST', '/contacts', { username: 'kcb' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'kc' + sufijo, accept: true }, beto.cookie);
    return { ana, beto };
}

test('cambiar la clave avisa a los contactos; a los demás, no', async () => {
    const srv = await startServer();
    let betoWs = null, ciraWs = null;
    try {
        const { ana, beto } = await pareja(srv, 'a');
        const cira = await register(srv.base, 'kcc'); // sin relación con ana

        betoWs = new WsClient(srv.port, beto.cookie);
        ciraWs = new WsClient(srv.port, cira.cookie);
        await betoWs.connect();
        await ciraWs.connect();

        const regenerada = await api(srv.base, 'POST', '/account/regenerate-key', { password: 'pruebachat1' }, ana.cookie);
        assert.equal(regenerada.status, 200, JSON.stringify(regenerada.json).slice(0, 200));

        const aviso = await betoWs.waitFor('keychange');
        assert.equal(aviso.from, 'kca', 'el aviso llega con el nombre del que cambió la clave');
        assert.ok(aviso.ts > 0, 'lleva su fecha');

        // Una cuenta sin relación no recibe nada.
        const tipos = ciraWs.frames.map(f => f.type);
        assert.equal(tipos.includes('keychange'), false, 'el aviso no sale de los contactos');

        // Y la propia cuenta no se auto-avisa: ese mensaje lo pinta el cliente
        // en cada conversación, no hace falta que el servidor se lo devuelva.
        const propio = await api(srv.base, 'POST', '/account/regenerate-key', { password: 'pruebachat1' }, ana.cookie);
        assert.equal(propio.status, 200);
        // Cada regeneración empuja un aviso (la lectura del socket es
        // asíncrona: se espera al segundo en vez de contarlos a lo bruto).
        const hasta = Date.now() + 5000;
        while (betoWs.frames.filter(f => f.type === 'keychange').length < 2 && Date.now() < hasta)
            await new Promise(r => setTimeout(r, 25));
        assert.equal(betoWs.frames.filter(f => f.type === 'keychange').length, 2,
            'cada regeneración empuja un aviso por contacto');
    } finally {
        if (betoWs) betoWs.destroy();
        if (ciraWs) ciraWs.destroy();
        await stop(srv);
    }
});

test('si la contraseña falla no se avisa a nadie', async () => {
    const srv = await startServer();
    let betoWs = null;
    try {
        const { ana, beto } = await pareja(srv, 'b');
        betoWs = new WsClient(srv.port, beto.cookie);
        await betoWs.connect();

        const fallo = await api(srv.base, 'POST', '/account/regenerate-key', { password: 'no-es-la-mía' }, ana.cookie);
        assert.equal(fallo.status, 401);
        assert.equal(betoWs.frames.some(f => f.type === 'keychange'), false,
            'una clave que NO cambió no puede generar el aviso');
    } finally {
        if (betoWs) betoWs.destroy();
        await stop(srv);
    }
});
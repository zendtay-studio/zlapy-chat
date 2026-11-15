// Puesta al día de acuses al reconectar (estilo Telegram/WhatsApp).
//
// 1) Los mensajes que llegaron con la cuenta fuera quedan "delivered" en
//    cuanto esta vuelve a conectarse: el remitente ve las dos rayitas
//    grises sin esperar a que la otra persona los lea. Antes el acuse de
//    entrega sólo existía para los mensajes recibidos EN VIVO (por WS), y
//    lo llegado ausente se quedaba con una sola rayita hasta la lectura.
// 2) El estado PROPIO (entregado/leído por el otro) que cambió mientras la
//    cuenta estaba fuera se re-empuja al reconectar: el cliente aplica el
//    frame `receipt` (idempotente) y las rayitas no se quedan grises para
//    siempre aunque el push original se perdiera con la app cerrada.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register, WsClient } = require('../helpers.js');

async function pareja(srv, sufijo) {
    const ana = await register(srv.base, 'acusa' + sufijo);
    const beto = await register(srv.base, 'acusab' + sufijo);
    await api(srv.base, 'POST', '/contacts', { username: 'acusab' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'acusa' + sufijo, accept: true }, beto.cookie);
    return { ana, beto };
}

test('lo recibido fuera de línea queda delivered al reconectar y el remitente ve el acuse', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, '1');

        // ana está OFFLINE (sin WS): le manda dos mensajes a beto.
        const m1 = await api(srv.base, 'POST', '/send', { to: 'acusab1', kind: 'text', data: 'uno' }, ana.cookie);
        const m2 = await api(srv.base, 'POST', '/send', { to: 'acusab1', kind: 'text', data: 'dos' }, ana.cookie);
        assert.equal(m1.status, 200);
        assert.equal(m2.status, 200);
        const ids = [m1.json.message.id, m2.json.message.id];

        // ana conecta primero (nada que poner al día: sus envíos siguen 'sent').
        const aw = new WsClient(srv.port, ana.cookie);
        await aw.connect();
        // beto reconecta: la puesta al día marca entregado y ana recibe el acuse.
        const bw = new WsClient(srv.port, beto.cookie);
        await bw.connect();
        const receipt = await aw.waitFor('receipt', 6000);
        assert.equal(receipt.status, 'delivered', 'el acuse de entrega llega al remitente en línea');
        assert.deepEqual([...receipt.ids].sort(), [...ids].sort());

        // Persistido: la copia del remitente ya no es 'sent'.
        const historial = await api(srv.base, 'POST', '/messages', { to: 'acusab1', limit: 20 }, ana.cookie);
        assert.equal(historial.status, 200);
        const estados = Object.fromEntries(historial.json.messages.map(m => [m.id, m.status]));
        assert.equal(estados[ids[0]], 'delivered');
        assert.equal(estados[ids[1]], 'delivered');
    } finally { await stop(srv); }
});

test('el estado propio que cambió fuera de línea se re-empuja al reconectar', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, '2');

        const m1 = await api(srv.base, 'POST', '/send', { to: 'acusab2', kind: 'text', data: 'hola' }, ana.cookie);
        assert.equal(m1.status, 200);
        const id = m1.json.message.id;

        // beto entrega y lee MIENTRAS ana está sin conexión: el push del
        // acuse se pierde para ana.
        await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'delivered' }, beto.cookie);
        await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'read' }, beto.cookie);

        // ana reconecta: la puesta al día le re-empuja el estado 'read'.
        const aw = new WsClient(srv.port, ana.cookie);
        await aw.connect();
        const receipt = await aw.waitFor('receipt', 6000);
        assert.equal(receipt.status, 'read', 'el estado leído sobrevive a la reconexión del remitente');
        assert.deepEqual(receipt.ids, [id]);
        assert.ok(Number.isFinite(receipt.readAt) && receipt.readAt > 0, 'el acuse leído trae su marca de tiempo');
    } finally { await stop(srv); }
});

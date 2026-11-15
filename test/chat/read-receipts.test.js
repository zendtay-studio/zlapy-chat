// Confirmaciones de lectura: apagarlas deja los mensajes del otro en
// GRIS («entregado»), nunca en azul. Es la autoridad del SERVIDOR: aunque
// el cliente envíe el acuse «read», se descifra y se descarta cuando la
// cuenta que lee lo tiene desactivado para ese interlocutor. El acuse
// «delivered» (2 grises) NUNCA se ve afectado.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

async function pareja(srv, sufijo) {
    const ana = await register(srv.base, 'lect' + sufijo);
    const beto = await register(srv.base, 'lectb' + sufijo);
    await api(srv.base, 'POST', '/contacts', { username: 'lectb' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'lect' + sufijo, accept: true }, beto.cookie);
    return { ana, beto };
}

/* Desactiva las confirmaciones de lectura de una cuenta para TODOS. */
async function apagarLecturas(base, cookie, username) {
    const r = await api(base, 'POST', '/profile', { username, privacy: { lecturas: { mode: 'nobody', users: [] } } }, cookie);
    assert.equal(r.status, 200, 'se guarda la privacidad');
}

const estadoDe = async (base, cookie, peer, id) => {
    const h = await api(base, 'POST', '/messages', { to: peer, limit: 20 }, cookie);
    assert.equal(h.status, 200);
    const found = h.json.messages.find(m => m.id === id);
    return found ? found.status : null;
};

test('con las confirmaciones apagadas el acuse «read» se descarta y queda en delivered', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, '1');
        await apagarLecturas(srv.base, ana.cookie, ana.json.user.username);

        // beto manda, ana (con recibos apagados) entrega y lee.
        const m1 = await api(srv.base, 'POST', '/send', { to: 'lect1', kind: 'text', data: 'hola' }, beto.cookie);
        const id = m1.json.message.id;
        const entrega = await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'delivered' }, ana.cookie);
        assert.equal(entrega.status, 200, 'el entregado siempre se acepta');

        // El acuse de lectura se acepta (200) pero NO surte efecto.
        const lectura = await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'read' }, ana.cookie);
        assert.equal(lectura.status, 200, 'el cliente sigue recibiendo 200 (no hay nada que reintentar)');
        assert.equal(await estadoDe(srv.base, beto.cookie, 'lect1', id), 'delivered',
            'el mensaje se queda en «entregado»: el otro lo ve en gris, nunca azul');
        // Y tampoco sube el estado interno de la copia del lector.
        assert.equal(await estadoDe(srv.base, ana.cookie, 'lectb1', id), 'delivered');
    } finally { await stop(srv); }
});

test('con las confirmaciones activas (por defecto) el «read» funciona igual que siempre', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await pareja(srv, '2');
        const m1 = await api(srv.base, 'POST', '/send', { to: 'lect2', kind: 'text', data: 'hola' }, beto.cookie);
        const id = m1.json.message.id;
        const lectura = await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'read' }, ana.cookie);
        assert.equal(lectura.status, 200);
        assert.equal(await estadoDe(srv.base, beto.cookie, 'lect2', id), 'read',
            'por defecto las confirmaciones de lectura están ACTIVADAS');
    } finally { await stop(srv); }
});
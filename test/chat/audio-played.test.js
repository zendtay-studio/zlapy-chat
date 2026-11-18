// Acuse «played» (audio ESCUCHADO), que es distinto de «leído».
//
// Contrato: darle Play a una nota de voz recibida manda `status: "played"`
// con la id REAL del mensaje. El servidor NO cambia el estado del mensaje
// (eso es `read`, los tics azules): solo avisa al emisor para que su burbuja
// de audio pase de atenuada (opacidad 0.5) a normal (1.0). Si llega una id
// que no existe en la tabla (por ejemplo la forma de DOM `a<sin-guiones>`),
// se descarta en silencio: el emisor nunca se enteraría.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { startServer, stop, api, register, WsClient } = require('../helpers.js');

async function pareja(srv, sufijo) {
    const ana = await register(srv.base, 'aud' + sufijo);
    const beto = await register(srv.base, 'audb' + sufijo);
    await api(srv.base, 'POST', '/contacts', { username: 'audb' + sufijo }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'aud' + sufijo, accept: true }, beto.cookie);
    return { ana, beto };
}

/* Estado con el que ve el mensaje cada una de las dos cuentas. */
const estadoDe = async (base, cookie, peer, id) => {
    const h = await api(base, 'POST', '/messages', { to: peer, limit: 20 }, cookie);
    assert.equal(h.status, 200);
    const found = h.json.messages.find(m => m.id === id);
    return found ? found.status : null;
};

/* Igual, pero devuelve el mensaje completo (para mirar `playedAt`). */
const mensajeDe = async (base, cookie, peer, id) => {
    const h = await api(base, 'POST', '/messages', { to: peer, limit: 20 }, cookie);
    assert.equal(h.status, 200);
    return h.json.messages.find(m => m.id === id) || null;
};

test('el «played» avisa al emisor con la id real y NO cambia el estado del mensaje', async () => {
    const srv = await startServer();
    let anaWs = null, betoWs = null;
    try {
        const { ana, beto } = await pareja(srv, '1');
        anaWs = new WsClient(srv.port, ana.cookie);
        betoWs = new WsClient(srv.port, beto.cookie);
        await anaWs.connect();
        await betoWs.connect();

        // beto manda una nota de voz; ana la recibe. (Los adjuntos exigen el
        // hash del medio, como en el flujo real de subida.)
        const bytes = Buffer.from('webm-de-juguete');
        const audio = 'data:audio/webm;base64,' + bytes.toString('base64');
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        const envio = await api(srv.base, 'POST', '/send', { to: 'aud1', kind: 'audio', data: audio, hash }, beto.cookie);
        assert.equal(envio.status, 200, JSON.stringify(envio.json).slice(0, 200));
        const id = envio.json.message.id;

        // ana da Play: el acuse viaja con la id REAL (la que el servidor sabe
        // validar contra su tabla).
        const acuse = await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'played' }, ana.cookie);
        assert.equal(acuse.status, 200);

        // El emisor recibe el aviso: con esa id y ese estado.
        const evento = await betoWs.waitFor('receipt');
        assert.equal(evento.status, 'played');
        assert.deepEqual(evento.ids, [id]);

        /* Escuchado NO es leído: «played» no puede promover el estado (el
           servidor ni siquiera lo persiste: no está en su RANK), así que
           NINGUNA de las dos copias puede aparecer como «leído». */
        for (const [cookie, peer] of [[beto.cookie, 'aud1'], [ana.cookie, 'audb1']]) {
            const estado = await estadoDe(srv.base, cookie, peer, id);
            assert.notEqual(estado, 'read', `${peer} no marca «leído» por escuchar el audio`);
        }

        // Y la lectura normal sigue funcionando después: el «played» no
        // consume ni bloquea el «read».
        const lectura = await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'read' }, ana.cookie);
        assert.equal(lectura.status, 200);
        assert.equal(await estadoDe(srv.base, beto.cookie, 'aud1', id), 'read');
    } finally {
        if (anaWs) anaWs.destroy();
        if (betoWs) betoWs.destroy();
        await stop(srv);
    }
});

test('lo ESCUCHADO sobrevive a la recarga del emisor: queda guardado en el servidor', async () => {
    const srv = await startServer();
    let anaWs = null, betoWs = null;
    try {
        const { ana, beto } = await pareja(srv, '3');
        anaWs = new WsClient(srv.port, ana.cookie);
        betoWs = new WsClient(srv.port, beto.cookie);
        await anaWs.connect();
        await betoWs.connect();

        const bytes = Buffer.from('webm-escuchado-3');
        const envio = await api(srv.base, 'POST', '/send', {
            to: 'aud3', kind: 'audio',
            data: 'data:audio/webm;base64,' + bytes.toString('base64'),
            hash: crypto.createHash('sha256').update(bytes).digest('hex')
        }, beto.cookie);
        assert.equal(envio.status, 200);
        const id = envio.json.message.id;

        // Sin reproducir: el emisor NO lo tiene como escuchado.
        let visto = await mensajeDe(srv.base, beto.cookie, 'aud3', id);
        assert.equal(visto.playedAt, 0, 'antes de reproducirlo no hay nada guardado');

        // ana le da Play.
        const acuse = await api(srv.base, 'POST', '/receipt', { ids: [id], status: 'played' }, ana.cookie);
        assert.equal(acuse.status, 200);
        await betoWs.waitFor('receipt');

        // LA RECARGA: el emisor vuelve a pedir el historial y lo encuentra ya
        // como escuchado, sin depender de los sets locales ni del aviso.
        visto = await mensajeDe(srv.base, beto.cookie, 'aud3', id);
        assert.ok(visto.playedAt > 0, 'queda guardado: el emisor sigue viéndolo des-atenuado');
        // Y no es "leído": el estado no se ha movido.
        assert.notEqual(visto.status, 'read');

        // Y la copia de ana también lo refleja (es el mismo mensaje).
        const deAna = await mensajeDe(srv.base, ana.cookie, 'audb3', id);
        assert.ok(deAna.playedAt > 0);
    } finally {
        if (anaWs) anaWs.destroy();
        if (betoWs) betoWs.destroy();
        await stop(srv);
    }
});
    test('una id que no existe (la forma de DOM) se descarta: el emisor no se entera', async () => {
    const srv = await startServer();
    let anaWs = null, betoWs = null;
    try {
        const { ana, beto } = await pareja(srv, '2');
        anaWs = new WsClient(srv.port, ana.cookie);
        betoWs = new WsClient(srv.port, beto.cookie);
        await anaWs.connect();
        await betoWs.connect();

        const bytes2 = Buffer.from('webm-de-juguete-2');
        const envio = await api(srv.base, 'POST', '/send', {
            to: 'aud2', kind: 'audio',
            data: 'data:audio/webm;base64,' + bytes2.toString('base64'),
            hash: crypto.createHash('sha256').update(bytes2).digest('hex')
        }, beto.cookie);
        assert.equal(envio.status, 200);
        const id = envio.json.message.id;

        // La misma id en su forma de ELEMENTO del DOM ('a' + sin guiones):
        // no es una fila de la tabla de mensajes.
        const formaDom = 'a' + id.replace(/-/g, '');
        const acuse = await api(srv.base, 'POST', '/receipt', { ids: [formaDom], status: 'played' }, ana.cookie);
        assert.equal(acuse.status, 200, 'la API no distingue: responde 200 igual');

        // El eco que vuelve al propio emisor del acuse va con la lista VACÍA:
        // no hay nada que avisar al emisor.
        const eco = await anaWs.waitFor('receipt');
        assert.deepEqual(eco.ids, []);
        assert.equal(eco.status, 'played');

        // beto (el emisor) no recibe ningún aviso de escucha.
        const habriaLlegado = betoWs.frames.some(f => f.type === 'receipt' && f.status === 'played');
        assert.equal(habriaLlegado, false, 'una id inválida nunca llega al emisor');

        // Y el estado del mensaje no se ha movido.
        const estadoFinal = await estadoDe(srv.base, beto.cookie, 'aud2', id);
        assert.notEqual(estadoFinal, 'read', 'una id inválida no mueve el estado');
    } finally {
        if (anaWs) anaWs.destroy();
        if (betoWs) betoWs.destroy();
        await stop(srv);
    }
});
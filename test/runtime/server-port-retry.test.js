// Regresión de la carrera freePort → spawn: otro proceso puede ocupar el
// puerto entre que lo comprobamos y el hijo ejecuta listen().
'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { startServer, stop, api } = require('../helpers.js');

for (const modo of ['503', '200', 'sin respuesta']) {
    test(`startServer reintenta con un ocupante ${modo}`, async t => {
        const createServerReal = net.createServer;
        let bloqueador = null;
        const conexionesBloqueador = new Set();
        const hijos = [];
        let srv = null;
        let yaInyectado = false;
        t.after(async () => {
            net.createServer = createServerReal;
            if (srv) await stop(srv);
            if (bloqueador) {
                for (const socket of conexionesBloqueador) socket.destroy();
                await new Promise(resolve => bloqueador.close(resolve));
            }
        });

        net.createServer = function (...args) {
            const probe = createServerReal.apply(this, args);
            if (yaInyectado) return probe;
            yaInyectado = true;
            const closeReal = probe.close;
            probe.close = function (callback) {
                const port = probe.address().port;
                return closeReal.call(this, () => {
                    // Gana la carrera justo después de liberar el candidato.
                    bloqueador = createServerReal(socket => {
                        conexionesBloqueador.add(socket);
                        socket.on('close', () => conexionesBloqueador.delete(socket));
                        if (modo === 'sin respuesta') return; // sondeo colgado
                        const body = modo === '200' ? '{"ok":true}' : '';
                        socket.end(`HTTP/1.1 ${modo === '200' ? '200 OK' : '503 Service Unavailable'}\r\n` +
                            `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
                    });
                    bloqueador.listen(port, '0.0.0.0', callback);
                });
            };
            return probe;
        };

        srv = await startServer({ onChild: child => hijos.push(child) });
        const health = await api(srv.base, 'GET', '/healthz');
        assert.equal(health.status, 200);
        assert.equal(health.json.ok, true);
        assert.ok(bloqueador, 'la carrera quedó realmente inyectada');
        assert.notEqual(srv.port, bloqueador.address().port, 'el hijo final usa otro puerto');
        assert.ok(hijos.length >= 2, 'hubo un primer hijo fallido y el reintento');
        assert.ok(hijos[0].exitCode !== null || hijos[0].signalCode !== null,
            'el primer hijo terminó antes de devolver el éxito');
    });
}

test('stop reconoce un hijo que ya terminó por señal', async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = 'SIGTERM';
    child.kill = () => { throw new Error('no debe matar un proceso ya terminado'); };

    await Promise.race([
        stop({ child, ownsDataDir: false, dataDir: '' }),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('stop quedó colgado')), 100))
    ]);
});

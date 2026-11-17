// A4: los visores de base de datos (db-viewer y sqliteview) son de SOLO
// LECTURA pero muestran filas REALES: la API exige un token y el Host tiene
// que ser propio (anti DNS rebinding).
'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const dbViewer = require('../../ops/db/db-viewer.js');
const sqliteView = require('../../ops/db/sqliteview.js');

/* Petición cruda por socket: así se puede fijar un Host arbitrario (fetch no
   deja sobrescribir la cabecera Host). */
function rawRequest(port, host, target, token) {
    return new Promise(resolve => {
        const sock = net.connect(port, '127.0.0.1', () => {
            sock.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\n` +
                (token ? `X-Viewer-Token: ${token}\r\n` : '') + 'Connection: close\r\n\r\n');
        });
        let out = '';
        sock.on('data', d => { out += d; });
        sock.on('close', () => resolve(out.split('\r\n')[0]));
        sock.on('error', () => resolve('error'));
        setTimeout(() => { sock.destroy(); resolve('timeout'); }, 3000);
    });
}

const statusLine = line => Number((/^HTTP\/1\.1 (\d+)/.exec(line) || [])[1] || 0);

for (const [nombre, visor, ruta] of [
    ['db-viewer', dbViewer, '/api/schema'],
    ['sqliteview', sqliteView, '/api/overview']
]) {
    test(`${nombre}: la API exige token y el Host propio`, async t => {
        const corriendo = await visor.startServer({
            dbs: { zlapy: null, blob: null },
            token: 'token-de-prueba-123'
        });
        t.after(() => corriendo.server.close());
        const port = corriendo.port;
        const hostPropio = `127.0.0.1:${port}`;

        // Sin token: 401.
        assert.equal(statusLine(await rawRequest(port, hostPropio, ruta)), 401,
            'sin token la API no responde');
        // Con token incorrecto: 401.
        assert.equal(statusLine(await rawRequest(port, hostPropio, ruta, 'otro-token')), 401);
        // Con el token bueno y Host propio: pasa la puerta (200 o 404 de ruta).
        assert.equal(statusLine(await rawRequest(port, hostPropio, ruta, 'token-de-prueba-123')), 200);
        // Token bueno pero Host ajeno: 403 (rebote/DNS rebinding).
        assert.equal(statusLine(await rawRequest(port, 'evil.example.com', ruta, 'token-de-prueba-123')), 403);
        // localhost también es propio.
        assert.equal(statusLine(await rawRequest(port, `localhost:${port}`, ruta, 'token-de-prueba-123')), 200);

        // Los estáticos (sin datos) siguen abiertos: sin ellos la página no
        // podría cargar para pedir el token después.
        const raiz = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(raiz.status, 200, 'la página del visor se sirve sin token');
    });

    test(`${nombre}: un PID ajeno no concede el token`, async t => {
        const corriendo = await visor.startServer({
            dbs: { zlapy: null, blob: null },
            token: 'secreto'
        });
        t.after(() => corriendo.server.close());
        // El token viaja por cabecera, nunca por la query.
        const conQuery = await fetch(`http://127.0.0.1:${corriendo.port}${ruta}?token=secreto`);
        assert.equal(conQuery.status, 401, 'el token en la query no autentica');
    });
}
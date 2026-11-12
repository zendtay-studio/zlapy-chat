// Índice a ciegas de llamadas (calls.peer_hash, v11).
//
// El nombre del par va CIFRADO en reposo (`calls.peer`), así que localizar
// llamadas por nombre (renombrar una cuenta, borrarla) era un barrido
// completo descifrando todo el historial. La columna peer_hash (HMAC del
// nombre con subclave de la llave maestra, src/crypto/peer-index.js) lo
// vuelve O(log n) sin revelar el nombre.
//
// Aquí se comprueba de extremo a extremo contra server.js real: alta de
// llamada, renombre y borrado. Los tres comparten UN servidor y UNA base:
// el test calcula el HMAC en SU proceso y lo compara con el que escribió
// el hijo del servidor — si no derivaran la misma llave maestra (misma
// credencial, misma sal de ESTA base), la comparación fallaría. Es justo
// la propiedad que importa: el índice es estable entre procesos.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, stop, api, register, sessionCookieFrom, WsClient } = require('../helpers.js');
const { peerHash } = require('../../src/crypto/peer-index.js');

const { decField } = require('../../src/crypto/field-crypto.js');

let dataDir;
let srv;

/* Prepara ana y beto como contactos (requisito para llamadas). */
async function prepareContacts(base) {
    const ana = await register(base, 'ana');
    const beto = await register(base, 'beto');
    await api(base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
    await api(base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
    return { ana, beto };
}

/* Ofrece una llamada de beto a ana por WebSocket y espera el aviso. */
async function ofrecerLlamada(srv, ana, beto) {
    const aws = new WsClient(srv.port, ana.cookie);
    const bws = new WsClient(srv.port, beto.cookie);
    await aws.connect(); await bws.connect();
    bws.send({ type: 'call-offer', to: 'ana', callId: 'call-1', video: false });
    await aws.waitFor('call-incoming');
    return { aws, bws };
}

/* Lee todas las filas de llamadas de la base. */
function callRows() {
    const db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    try {
        return db.prepare(`SELECT c.id, u.username AS owner, c.peer, c.peer_hash
            FROM calls c JOIN users u ON u.id = c.owner ORDER BY c.id`).all();
    } finally { db.close(); }
}

test.before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-peer-'));
    srv = await startServer({ dataDir });
    /* La subclave del índice deriva de la llave maestra, que sale de la
       credencial + la sal de ESTA base: apuntar DATA_DIR aquí hace que el
       proceso del test derive exactamente la misma que el servidor. */
    process.env.DATA_DIR = dataDir;
});

test.after(async () => {
    await stop(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('una llamada queda con el par cifrado y su hash de índice correcto', async () => {
    const cuentas = await prepareContacts(srv.base);
    const { aws, bws } = await ofrecerLlamada(srv, cuentas.ana, cuentas.beto);

    // Beto ofrece a ana: DOS filas con el mismo callId, una por extremo
    // (PK (owner, id), v12). Cada una lleva el par del otro, cifrado, con
    // su hash de índice.
    const rows = callRows();
    assert.equal(rows.length, 2, 'cada extremo persiste su registro');
    const deAna = rows.find(r => r.owner === 'ana');
    const deBeto = rows.find(r => r.owner === 'beto');
    assert.ok(deAna && deBeto, 'una fila por cuenta');
    assert.equal(deAna.peer_hash, peerHash('beto'), 'el índice de ana apunta a beto');
    assert.equal(deBeto.peer_hash, peerHash('ana'), 'el índice de beto apunta a ana');
    for (const row of rows) {
        assert.match(row.peer, /^PCE1v2:/, 'el nombre del par va cifrado (sobre PCE), no en claro');
        assert.notEqual(row.peer_hash, 'beto', 'el hash no es el nombre en claro');
    }

    aws.destroy(); bws.destroy();
});

test('renombrar una cuenta actualiza el índice de las llamadas ajenas', async () => {
    const loginBeto = await api(srv.base, 'POST', '/auth/login', { username: 'beto', password: 'pruebachat1' });
    const loginAna = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
    const { aws, bws } = await ofrecerLlamada(srv,
        { cookie: sessionCookieFrom(loginAna.setCookie) },
        { cookie: sessionCookieFrom(loginBeto.setCookie) });

    // Beto pasa a beto2 (exige la contraseña actual): la fila de ANA (par
    // beto) debe quedar apuntando al nombre nuevo, localizada por peer_hash
    // sin descifrar el resto del historial.
    const antes = callRows()[0].peer_hash;
    const cookieBeto = sessionCookieFrom(loginBeto.setCookie);
    const renombre = await api(srv.base, 'POST', '/account/profile',
        { username: 'beto2', currentPassword: 'pruebachat1' }, cookieBeto);
    assert.equal(renombre.status, 200, 'el renombre funciona');
    // Y quien renombra NO queda fuera: el checksum del token lleva el
    // nombre, así que la respuesta re-emite la cookie de sesión.
    const cookieNueva = sessionCookieFrom(renombre.setCookie);
    assert.ok(cookieNueva, 'la respuesta trae cookie nueva');
    const sigue = await api(srv.base, 'GET', '/auth/session', null, cookieNueva);
    assert.equal(sigue.json.authenticated, true, 'el token re-emitido valida tras el renombre');

    const filas = callRows();
    const deAna = filas.find(r => r.owner === 'ana');
    assert.equal(deAna.peer_hash, peerHash('beto2'), 'el índice apunta al nombre nuevo');
    assert.equal(decField('calls.peer', deAna.peer), 'beto2', 'el nombre cifrado también se reescribió');
    assert.notEqual(deAna.peer_hash, antes, 'el hash cambió con el nombre');
    // Buscar por el nombre VIEJO ya no devuelve nada (quedó reindexado).
    assert.equal(filas.filter(r => r.peer_hash === peerHash('beto')).length, 0);
    // La fila del PROPIO renombrado (par ana) NO se toca: su peer es ana.
    const deBeto = filas.find(r => r.owner === 'beto2');
    assert.equal(deBeto.peer_hash, peerHash('ana'), 'el registro del renombrado sigue apuntando a ana');
    assert.equal(decField('calls.peer', deBeto.peer), 'ana', 'y su par cifrado intacto');

    aws.destroy(); bws.destroy();
});

test('tras reiniciar, el historial de CADA extremo sobrevive (v12)', async () => {
    // v12 (PK (owner, id)): antes, la fila del llamador era machacada por la
    // del receptor y al reiniciar solo un historial volvía a cargar.
    await stop(srv);
    srv = await startServer({ dataDir });

    const loginAna = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
    const loginBeto = await api(srv.base, 'POST', '/auth/login', { username: 'beto2', password: 'pruebachat1' });
    const ana = await api(srv.base, 'POST', '/call/log', {}, sessionCookieFrom(loginAna.setCookie));
    const beto = await api(srv.base, 'POST', '/call/log', {}, sessionCookieFrom(loginBeto.setCookie));
    assert.equal(ana.status, 200);
    assert.equal(ana.json.calls.length, 1, 'ana conserva la llamada entrante');
    assert.equal(ana.json.calls[0].dir, 'in');
    assert.equal(ana.json.calls[0].peer, 'beto2');
    assert.equal(beto.json.calls.length, 1, 'beto2 conserva la llamada saliente');
    assert.equal(beto.json.calls[0].dir, 'out');
    assert.equal(beto.json.calls[0].peer, 'ana');
});

test('borrar la cuenta purga las llamadas ajenas por peer_hash', async () => {
    assert.equal(callRows().length, 2, 'siguen las filas del reinicio anterior');

    // Borrar la cuenta exige la contraseña (irreversible).
    const beto2 = await api(srv.base, 'POST', '/auth/login', { username: 'beto2', password: 'pruebachat1' });
    const salida = await api(srv.base, 'POST', '/account/delete',
        { password: 'pruebachat1' }, sessionCookieFrom(beto2.setCookie));
    assert.equal(salida.status, 200, 'la cuenta se borra');

    // Se van las DOS filas: la de ana (par beto2) por peer_hash, y la propia
    // de beto2 por la cascada de su cuenta.
    assert.equal(callRows().length, 0,
        'el historial de ana ya no tiene la llamada hacia la cuenta borrada');
});

// Tests de regresión de la auditoría de seguridad del 2026-10-19.
// Cada test fija un comportamiento que antes era vulnerable: si alguien
// revierte el arreglo, el test falla.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, stop, api, register, WsClient } = require('./helpers.js');

// Dos cuentas que se pueden escribir (contactos) + una tercera sin relación.
async function trio(srv) {
    const ana = await register(srv.base, 'ana');
    const beto = await register(srv.base, 'beto');
    const caco = await register(srv.base, 'caco');
    await api(srv.base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
    await api(srv.base, 'POST', '/contacts', { username: 'dolo' }, caco.cookie);
    await api(srv.base, 'POST', '/contacts/respond', { username: 'caco', accept: true },
        (await register(srv.base, 'dolo')).cookie);
    return { ana, beto, caco };
}

test('un frame WebSocket malformado NO tumba el servidor', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();
        // groupId con un tipo que no es texto: antes lanzaba RangeError en la
        // consulta SQL y el uncaughtException global mataba el proceso.
        ws.send({ type: 'group-typing', groupId: { no: 'soy un objeto' } });
        ws.send({ type: 'group-typing' });
        ws.send({ type: 'call-accept', to: {}, callId: {} });
        await new Promise(r => setTimeout(r, 400));
        ws.destroy();

        assert.equal(srv.child.exitCode, null, 'el proceso debe seguir vivo');
        const health = await api(srv.base, 'GET', '/healthz');
        assert.equal(health.status, 200);
        assert.equal(health.json.ok, true);
    } finally { await stop(srv); }
});

test('la fragmentación WebSocket no bloquea el event loop (recuento O(1))', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();
        // Muchos fragmentos pequeños: el acumulador debe ser O(1) por trozo.
        for (let i = 0; i < 2000; i++) ws.sendRaw(frameOf('a'.repeat(8), i === 0 ? 0x1 : 0x0, i === 1999));
        await new Promise(r => setTimeout(r, 500));
        const health = await api(srv.base, 'GET', '/healthz');
        assert.equal(health.status, 200, 'el servidor debe seguir respondiendo');
        assert.equal(srv.child.exitCode, null);
        ws.destroy();
    } finally { await stop(srv); }
});

function frameOf(payload, opcode, fin) {
    const mask = Buffer.from([1, 2, 3, 4]);
    const head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    return Buffer.concat([head, mask, masked]);
}

test('una cita con id inventado se descarta: no hay XSS ni preview falsificado', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await trio(srv);
        const payload = "x');window.__XSS_MARK__='PWNED';//";
        const sent = await api(srv.base, 'POST', '/send', {
            to: 'beto', kind: 'text', data: 'cita',
            reply: { fromId: 'uuid-inventado', id: payload, preview: 'TEXTO INVENTADO' }
        }, ana.cookie);
        assert.equal(sent.status, 200);

        const history = await api(srv.base, 'POST', '/messages', { to: 'ana' }, beto.cookie);
        const message = (history.json.messages || []).find(m => m.data === 'cita');
        assert.ok(message, 'el mensaje debe llegar');
        assert.equal(message.reply, null, 'una cita que no existe debe descartarse');
        assert.ok(!JSON.stringify(message).includes('PWNED'), 'el payload no debe llegar al cliente');
    } finally { await stop(srv); }
});

test('/seen solo destruye los mensajes de una sola vista', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await trio(srv);
        const sent = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'mensaje normal' }, ana.cookie);
        const id = sent.json.message && sent.json.message.id;
        assert.ok(id, 'el envío debe devolver el id del mensaje');

        const seen = await api(srv.base, 'POST', '/seen', { id }, beto.cookie);
        assert.equal(seen.status, 409, 'un mensaje normal no debe autodestruirse');

        const history = await api(srv.base, 'POST', '/messages', { to: 'beto' }, ana.cookie);
        const message = (history.json.messages || []).find(m => m.id === id);
        assert.ok(message, 'el emisor debe seguir viendo su mensaje');
        assert.equal(message.data, 'mensaje normal', 'el contenido no debe destruirse');
    } finally { await stop(srv); }
});

test('el destinatario no puede borrar el mensaje del emisor (borrado con alcance)', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await trio(srv);
        const sent = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'evidencia' }, ana.cookie);
        const id = sent.json.message && sent.json.message.id;

        const del = await api(srv.base, 'POST', '/msg/delete', { id }, beto.cookie);
        assert.equal(del.status, 200);
        assert.equal(del.json.scope, 'me', 'el receptor solo puede borrarlo para sí');

        const history = await api(srv.base, 'POST', '/messages', { to: 'beto' }, ana.cookie);
        assert.ok((history.json.messages || []).some(m => m.id === id), 'el emisor conserva su mensaje');
        const other = await api(srv.base, 'POST', '/messages', { to: 'ana' }, beto.cookie);
        assert.ok(!(other.json.messages || []).some(m => m.id === id), 'el receptor deja de verlo');
    } finally { await stop(srv); }
});

test('borrar la conversación no destruye el historial del otro interlocutor', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await trio(srv);
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: 'mensaje de ana' }, ana.cookie);
        await api(srv.base, 'POST', '/send', { to: 'ana', kind: 'text', data: 'mensaje de beto' }, beto.cookie);

        const del = await api(srv.base, 'POST', '/chat/delete', { to: 'beto' }, ana.cookie);
        assert.equal(del.status, 200);

        const history = await api(srv.base, 'POST', '/messages', { to: 'ana' }, beto.cookie);
        assert.ok((history.json.messages || []).length > 0, 'beto debe conservar su copia');
    } finally { await stop(srv); }
});

test('borrar la cuenta exige la contraseña correcta', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const sinClave = await api(srv.base, 'POST', '/account/delete', {}, ana.cookie);
        assert.equal(sinClave.status, 400);
        const mala = await api(srv.base, 'POST', '/account/delete', { password: 'incorrecta' }, ana.cookie);
        assert.equal(mala.status, 401);
        const ok = await api(srv.base, 'POST', '/account/delete', { password: 'pruebachat1' }, ana.cookie);
        assert.equal(ok.status, 200);
    } finally { await stop(srv); }
});

test('referenciar el hash de un adjunto ajeno no da acceso a él (IDOR de adjuntos)', async () => {
    const srv = await startServer();
    try {
        const { ana, beto, caco } = await trio(srv);
        const crypto = require('node:crypto');
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const hash = crypto.createHash('sha256').update(Buffer.from(png.split(',')[1], 'base64')).digest('hex');
        const up = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'image', data: png, hash, mime: 'image/png' }, ana.cookie);
        assert.equal(up.status, 200, 'el remitente puede subir su adjunto');

        // caco es contacto de beto (si no, la privacidad lo denegaría antes)
        await api(srv.base, 'POST', '/contacts', { username: 'beto' }, caco.cookie);
        await api(srv.base, 'POST', '/contacts/respond', { username: 'caco', accept: true }, beto.cookie);
        const steal = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'image', hash, mime: 'image/png' }, caco.cookie);
        assert.equal(steal.status, 400, 'referenciar un adjunto ajeno debe rechazarse');

        const read = await fetch(`${srv.base}/blob/${hash}`, { headers: { Cookie: `chatlocal_session=${encodeURIComponent(caco.cookie)}` } });
        assert.equal(read.status, 404, 'no debe poder leer el adjunto ajeno');
    } finally { await stop(srv); }
});

test('los resúmenes de chat se guardan cifrados (no hay texto en claro en la base)', async () => {
    const srv = await startServer();
    try {
        const { ana } = await trio(srv);
        const marker = 'TEXTO-SECRETO-UNICO-42';
        await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'text', data: marker }, ana.cookie);
        await new Promise(r => setTimeout(r, 300));

        const dbFile = path.join(srv.dataDir, 'zlapy.db');
        const raw = Buffer.concat([
            fs.readFileSync(dbFile),
            fs.readFileSync(dbFile + '-wal').catch ? fs.readFileSync(dbFile + '-wal') : Buffer.alloc(0)
        ]).toString('latin1');
        assert.ok(!raw.includes(marker), 'el texto del mensaje no debe aparecer en claro en el fichero de la base');
    } finally { await stop(srv); }
});

test('un mensaje WS de privacidad sin la matriz no reinicia la privacidad', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await trio(srv);
        await api(srv.base, 'POST', '/profile', { username: 'ana', privacy: { foto: { mode: 'nobody', users: [] } } }, ana.cookie);
        const before = await api(srv.base, 'GET', '/profile?username=ana', null, beto.cookie);
        assert.equal(before.json.permisos.verFoto, false, 'la foto debe estar oculta');

        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();
        ws.send({ type: 'privacy', name: 'nombre nuevo' });
        await new Promise(r => setTimeout(r, 400));
        ws.destroy();

        const after = await api(srv.base, 'GET', '/profile?username=ana', null, beto.cookie);
        assert.equal(after.json.permisos.verFoto, false, 'la privacidad no debe reiniciarse a los valores por defecto');
    } finally { await stop(srv); }
});

test('los accesos fallidos de un atacante no dejan fuera a la victima', async () => {
    // Regresion V-06: el contador por cuenta e IP frena con retardo, nunca
    // bloquea. Antes, 8 fallos devolvian 429 y quien compartia red con el
    // atacante (o el propio detras del tunel) se quedaba sin poder entrar.
    const srv = await startServer();
    try {
        await register(srv.base, 'ana');
        for (let i = 0; i < 12; i++)
            await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'malaclave99' });
        // La clave correcta sigue entrando, aunque el ultimo intento haya sido
        // fallido: el acceso legitimo solo tarda unos segundos mas.
        const ok = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
        assert.equal(ok.status, 200);
    } finally { await stop(srv); }
});

test('el perfil solo guarda campos conocidos y acota los textos', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const mass = await api(srv.base, 'POST', '/profile', {
            username: 'ana', addPolicy: 'all', id: 'uuid-falso', name: 'x'.repeat(200), chatAppearance: { wall: 'rojo' }
        }, ana.cookie);
        assert.equal(mass.status, 400, 'los textos fuera de rango se rechazan');

        const ok = await api(srv.base, 'POST', '/profile', { username: 'ana', name: 'Ana' }, ana.cookie);
        assert.equal(ok.status, 200);
        const profile = await api(srv.base, 'GET', '/profile?username=ana', null, ana.cookie);
        assert.equal(profile.json.addPolicy, undefined, 'no se pueden inyectar campos internos');
    } finally { await stop(srv); }
});

test('el proxy de GIPHY exige sesión y el id interno no se entrega a los no contactos', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const caco = await register(srv.base, 'caco');
        const giphy = await api(srv.base, 'GET', '/giphy/search?q=gato', null);
        assert.equal(giphy.status, 401, 'el proxy de stickers no es público');

        const profile = await api(srv.base, 'GET', '/profile?username=ana', null, caco.cookie);
        assert.equal(profile.json.id, undefined, 'el identificador interno no se entrega a un no contacto');
        const key = await api(srv.base, 'GET', '/key?username=ana', null, caco.cookie);
        assert.equal(key.status, 404, 'no se puede pedir la clave de otra cuenta');
    } finally { await stop(srv); }
});

test('el DM exige hash y tipo de contenido válido como el grupo', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await trio(srv);
        const sinHash = await api(srv.base, 'POST', '/send', {
            to: 'beto', kind: 'image', data: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png'
        }, ana.cookie);
        assert.equal(sinHash.status, 400, 'un medio sin hash se rechaza');

        const tipoRaro = await api(srv.base, 'POST', '/send', { to: 'beto', kind: 'inventado', data: 'x' }, ana.cookie);
        assert.equal(tipoRaro.status, 400, 'un tipo fuera de la allowlist se rechaza');
    } finally { await stop(srv); }
});

// Tests de integración WebSocket contra server.js real: handshake, multi-
// dispositivo, límites de frame/buffer, rate limit y limpieza de llamadas al
// desconectar.
const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register, WsClient } = require('./helpers.js');

/* Prepara ana y beto como contactos (necesario para typing/llamadas). */
async function prepareContacts(base) {
    const ana = await register(base, 'ana');
    const beto = await register(base, 'beto');
    await api(base, 'POST', '/contacts', { username: 'beto' }, ana.cookie);
    await api(base, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
    return { ana, beto };
}

test('el upgrade exige cookie de sesión válida', async () => {
    const srv = await startServer();
    try {
        const ws = new WsClient(srv.port, 'token-falso-nada-valido');
        await assert.rejects(() => ws.connect(), /upgrade rechazado|destroyed|timeout/);
    } finally { await stop(srv); }
});

test('multi-dispositivo: dos conexiones de la misma cuenta reciben el mismo evento', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await prepareContacts(srv.base);
        const d1 = new WsClient(srv.port, ana.cookie);
        const d2 = new WsClient(srv.port, ana.cookie);
        const bws = new WsClient(srv.port, beto.cookie);
        await d1.connect();
        await d2.connect();
        await bws.connect();

        bws.send({ type: 'typing', to: 'ana', on: true });

        const e1 = await d1.waitFor('typing');
        const e2 = await d2.waitFor('typing');
        assert.equal(e1.from, 'beto');
        assert.equal(e2.from, 'beto');

        d1.destroy(); d2.destroy(); bws.destroy();
    } finally { await stop(srv); }
});

test('un frame con longitud declarada gigante corta SOLO esa conexión', async () => {
    const srv = await startServer();
    try {
        const { ana } = await prepareContacts(srv.base);
        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();

        // len=127 declarando 2^40 bytes
        const head = Buffer.alloc(10);
        head[0] = 0x81;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(1) << BigInt(40), 2);
        ws.sendRaw(Buffer.concat([head, Buffer.alloc(16, 0x41)]));

        const code = await ws.waitClosed();
        assert.equal(code, 1009, 'debe cerrar con 1009 (message too big)');

        // El servidor sigue vivo y acepta conexiones nuevas
        const health = await api(srv.base, 'GET', '/healthz');
        assert.equal(health.json.ok, true);
        const ws2 = new WsClient(srv.port, ana.cookie);
        await ws2.connect();
        ws2.destroy();
    } finally { await stop(srv); }
});

test('un flood de frames agota el token bucket y cierra la conexión con 1008', async () => {
    const srv = await startServer();
    try {
        const { ana } = await prepareContacts(srv.base);
        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();

        // 800 frames de golpe: la ráfaga inicial es 600
        const frames = [];
        const payload = Buffer.from('{"type":"ping"}');
        const mask = Buffer.from([0, 0, 0, 0]);
        for (let i = 0; i < 800; i++) {
            const head = Buffer.from([0x81, 0x80 | payload.length]);
            const masked = Buffer.from(payload); // máscara 0 = sin cambio
            frames.push(Buffer.concat([head, mask, masked]));
        }
        ws.sendRaw(Buffer.concat(frames));

        const code = await ws.waitClosed();
        assert.equal(code, 1008, 'debe cerrar con 1008 (policy violation)');
        const health = await api(srv.base, 'GET', '/healthz');
        assert.equal(health.json.ok, true);
    } finally { await stop(srv); }
});

test('al desconectarse quien llama, la contraparte recibe call-ended', async () => {
    const srv = await startServer();
    try {
        const { ana, beto } = await prepareContacts(srv.base);
        const aws = new WsClient(srv.port, ana.cookie);
        const bws = new WsClient(srv.port, beto.cookie);
        await aws.connect();
        await bws.connect();

        bws.send({ type: 'call-offer', to: 'ana', callId: 'call-1', video: false });
        const incoming = await aws.waitFor('call-incoming');
        assert.equal(incoming.from, 'beto');

        bws.destroy(); // quien llama se cae
        const ended = await aws.waitFor('call-ended');
        assert.equal(ended.from, 'beto');
        assert.equal(ended.callId, 'call-1');
        aws.destroy();
    } finally { await stop(srv); }
});

test('el ping de la app contesta pong y mantiene la conexión viva', async () => {
    const srv = await startServer();
    try {
        const { ana } = await prepareContacts(srv.base);
        const ws = new WsClient(srv.port, ana.cookie);
        await ws.connect();
        ws.send({ type: 'ping' });
        const pong = await ws.waitFor('pong');
        assert.ok(pong.ts > 0);
        ws.destroy();
    } finally { await stop(srv); }
});

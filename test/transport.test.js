// Cifrado del canal: primitivas, sobre HTTP y frames WebSocket.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

// El cliente es un script de navegador: se carga con `window` para obtener
// ZlapyTransport y se compara contra el crypto nativo de Node.
globalThis.window = globalThis;
require(path.join(__dirname, '..', 'public', 'transport-crypto.js'));
const T = globalThis.ZlapyTransport;

const S = require('../src/crypto/transport.js');
const E = require('../src/realtime/encrypted.js');
const { WsClient, register, startServer, stop } = require('./helpers.js');

// Primitivas

test('sha256 and hkdf match the native implementation', () => {
    for (const payload of ['', 'hola', 'x'.repeat(1000)]) {
        const bytes = new Uint8Array(Buffer.from(payload));
        const mine = Buffer.from(T.sha256(bytes));
        const native = crypto.createHash('sha256').update(payload).digest();
        assert.ok(mine.equals(native), `sha256 de "${payload.slice(0, 10)}"`);
    }
    const ikm = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    const info = Buffer.from('zlapy-transport-v1/session');
    const mine = Buffer.from(T.hkdf(new Uint8Array(ikm), new Uint8Array(salt), new Uint8Array(info), 64));
    const native = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 64));
    assert.ok(mine.equals(native));
});

test('x25519 agrees with the native implementation', () => {
    const alice = crypto.generateKeyPairSync('x25519');
    const bob = crypto.generateKeyPairSync('x25519');
    const alicePrivate = Buffer.from(alice.privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32);
    const alicePublic = Buffer.from(alice.publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
    const bobPublic = Buffer.from(bob.publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);

    assert.ok(Buffer.from(T.publicFromPrivate(new Uint8Array(alicePrivate))).equals(alicePublic));
    const mine = Buffer.from(T.x25519(new Uint8Array(alicePrivate), new Uint8Array(bobPublic)));
    const native = crypto.diffieHellman({ privateKey: alice.privateKey, publicKey: bob.publicKey });
    assert.ok(mine.equals(native));
});

test('chacha20 reproduces the RFC 8439 block vector', () => {
    // RFC 8439 §2.3.2: primer bloque de keystream con contador 1.
    const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const nonce = Buffer.from('000000090000004a00000000', 'hex');
    const expected = '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e';
    const mine = Buffer.from(T.chacha20(new Uint8Array(key), 1, new Uint8Array(nonce), new Uint8Array(32)));
    assert.equal(mine.toString('hex'), expected);
});

// Sobre HTTP

test('the client envelope opens on the server and the response opens on the client', () => {
    const publicKey = S.transportPublicKey();
    const envelope = T.encrypt('POST', '/send', { to: 'leo', data: 'hola' }, publicKey);
    const time = Number(envelope.headers['X-Zlapy-Time']);
    const opened = S.decryptEnvelope({
        method: 'POST',
        path: '/send',
        time,
        ephemeral: T.fromBase64(envelope.headers['X-Zlapy-Ephemeral']),
        nonce: T.fromBase64(envelope.headers['X-Zlapy-Nonce']),
        ciphertext: Buffer.from(envelope.body)
    });
    assert.ok(opened);
    assert.deepEqual(JSON.parse(opened.plaintext.toString()), { to: 'leo', data: 'hola' });

    const response = S.encryptEnvelope(opened.key, { method: 'POST', path: '/send', time, status: 200 }, '{"ok":true}');
    const plain = T.decryptResponse(
        new Uint8Array(response.ciphertext),
        Buffer.from(response.nonce).toString('base64'),
        'POST', '/send', time, 200, opened.key
    );
    assert.equal(plain, '{"ok":true}');
});

test('a modified body, another route or another moment cannot be opened', () => {
    const publicKey = S.transportPublicKey();
    const envelope = T.encrypt('POST', '/send', { data: 'secreto' }, publicKey);
    const time = Number(envelope.headers['X-Zlapy-Time']);
    const base = {
        method: 'POST',
        path: '/send',
        time,
        ephemeral: T.fromBase64(envelope.headers['X-Zlapy-Ephemeral']),
        nonce: T.fromBase64(envelope.headers['X-Zlapy-Nonce']),
        ciphertext: Buffer.from(envelope.body)
    };

    const tampered = Buffer.from(envelope.body);
    tampered[0] ^= 1;
    assert.equal(S.decryptEnvelope({ ...base, ciphertext: tampered }), null);
    assert.equal(S.decryptEnvelope({ ...base, path: '/receipt' }), null);
    assert.equal(S.decryptEnvelope({ ...base, time: time + 1 }), null);
    assert.equal(S.decryptEnvelope({ ...base, nonce: Buffer.alloc(12) }), null);
});

test('websocket frames open in both directions and reject foreign frames', () => {
    const session = T.wsKey(T.randomBytes(32), T.fromBase64(S.transportPublicKey()));
    const socket = {};
    assert.equal(E.acceptHandshake(socket, T.toBase64(session.ephemeralRaw)), true);
    assert.ok(Buffer.from(session.key).equals(socket.zlapy.key));

    const incoming = T.wsSeal(session.key, 0, JSON.stringify({ type: 'typing', on: true }));
    assert.deepEqual(E.openFrame(socket, incoming), { type: 'typing', on: true });

    const outgoing = E.sealFrame(socket, JSON.stringify({ type: 'pong', ts: 1 }));
    assert.equal(JSON.parse(T.wsOpen(session.key, 0, outgoing)).type, 'pong');

    // Un frame de texto sin envolver no se interpreta una vez hay sesión, y un
    // saludo con clave de longitud incorrecta se rechaza.
    assert.equal(E.openFrame(socket, JSON.stringify({ type: 'ping' })), null);
    assert.equal(E.acceptHandshake({}, Buffer.alloc(16).toString('base64')), false);
});

// Integración con el servidor

/* Petición con cuerpo cifrado: devuelve también el texto descifrado. */
async function encryptedApi(base, publicKey, method, pathname, body, cookie) {
    const envelope = T.encrypt(method, pathname, JSON.stringify(body), publicKey);
    const headers = { ...envelope.headers, Origin: base, 'Sec-Fetch-Site': 'same-origin' };
    if (cookie) headers.Cookie = `chatlocal_session=${encodeURIComponent(cookie)}`;
    const response = await fetch(base + pathname, { method, headers, body: envelope.body });
    const setCookie = response.headers.get('set-cookie') || '';
    const sealed = response.headers.get('X-Zlapy-Enc');
    const text = sealed
        ? T.decryptResponse(new Uint8Array(await response.arrayBuffer()), response.headers.get('X-Zlapy-Resp-Nonce'),
            method, pathname, envelope.time, response.status, envelope.key)
        : await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { }
    return { status: response.status, json, text, setCookie, encrypted: Boolean(sealed) };
}

const cookieFrom = setCookie => {
    const match = /chatlocal_session=([^;]+)/.exec(setCookie || '');
    return match ? decodeURIComponent(match[1]) : '';
};

/* Espera un frame de texto que cumpla el predicado. */
function waitForText(ws, predicate, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const found = ws.texts.find(predicate);
            if (found) return resolve(found);
            if (Date.now() - started > timeoutMs)
                return reject(new Error('timeout esperando frame; recibidos: ' + JSON.stringify(ws.texts.map(t => t.slice(0, 24)))));
            setTimeout(tick, 25);
        };
        tick();
    });
}

test('the server publishes its public key and answers encrypted requests', async () => {
    const server = await startServer();
    try {
        const config = await (await fetch(server.base + '/config')).json();
        assert.equal(config.transportAlgorithm, S.TRANSPORT_ALGO);
        assert.equal(Buffer.from(config.transportPublicKey, 'base64').length, 32);

        const health = await (await fetch(server.base + '/healthz')).json();
        assert.equal(health.transportPublicKey, config.transportPublicKey);

        // Registro cifrado: la respuesta vuelve cifrada y con su cookie.
        const registration = await encryptedApi(server.base, config.transportPublicKey, 'POST', '/auth/register',
            { username: 'ana', password: 'pruebachat1' });
        assert.equal(registration.status, 201);
        assert.equal(registration.encrypted, true);
        assert.equal(registration.json.user.username, 'ana');
        const cookie = cookieFrom(registration.setCookie);
        assert.ok(cookie);

        // El cuerpo descifrado no debe aparecer en claro en el tráfico.
        const raw = JSON.stringify(registration.text);
        assert.equal(raw.includes('pruebachat1'), false);

        // Envío cifrado y lectura normal: el mensaje queda igual que siempre.
        const beto = await register(server.base, 'beto');
        await encryptedApi(server.base, config.transportPublicKey, 'POST', '/contacts', { username: 'beto' }, cookie);
        await encryptedApi(server.base, config.transportPublicKey, 'POST', '/contacts/respond', { username: 'ana', accept: true }, beto.cookie);
        const sent = await encryptedApi(server.base, config.transportPublicKey, 'POST', '/send',
            { to: 'beto', kind: 'text', data: 'mensaje cifrado' }, cookie);
        assert.equal(sent.status, 200);
        assert.equal(sent.encrypted, true);
        assert.equal(sent.json.ok, true);

        const history = await encryptedApi(server.base, config.transportPublicKey, 'POST', '/messages', { to: 'beto' }, cookie);
        assert.equal(history.status, 200);
        assert.ok(history.json.messages.some(m => m.data === 'mensaje cifrado'));
    } finally {
        await stop(server);
    }
});

test('a plain request still works and a broken envelope is rejected', async () => {
    const server = await startServer();
    try {
        const config = await (await fetch(server.base + '/config')).json();

        // Compatibilidad: sin cabeceras de sobre nada cambia.
        const plain = await register(server.base, 'carla');
        assert.equal(plain.status, 201);
        assert.ok(plain.cookie);

        // Cuerpo alterado.
        const envelope = T.encrypt('POST', '/auth/login', JSON.stringify({ username: 'carla', password: 'pruebachat1' }), config.transportPublicKey);
        const headers = { ...envelope.headers, Origin: server.base, 'Sec-Fetch-Site': 'same-origin' };
        const tampered = Buffer.from(envelope.body);
        tampered[tampered.length - 1] ^= 1;
        const bad = await fetch(server.base + '/auth/login', { method: 'POST', headers, body: tampered });
        assert.equal(bad.status, 400);
        assert.match(bad.headers.get('content-type') || '', /application\/json/);

        // Sobre dirigido a otra ruta (con sesión, para que llegue al cuerpo).
        const moved = await fetch(server.base + '/receipt', {
            method: 'POST',
            headers: { ...headers, Cookie: `chatlocal_session=${encodeURIComponent(plain.cookie)}` },
            body: envelope.body
        });
        assert.equal(moved.status, 400);

        // Marca de tiempo vieja (replay fuera de la ventana).
        const stale = { ...envelope.headers, 'X-Zlapy-Time': String(Date.now() - 10 * 60_000), Origin: server.base, 'Sec-Fetch-Site': 'same-origin' };
        const old = await fetch(server.base + '/auth/login', { method: 'POST', headers: stale, body: envelope.body });
        assert.equal(old.status, 400);
    } finally {
        await stop(server);
    }
});

test('the websocket accepts a handshake and encrypts from then on', async () => {
    const server = await startServer();
    try {
        const config = await (await fetch(server.base + '/config')).json();
        const ana = await register(server.base, 'ana');
        const beto = await register(server.base, 'beto');

        const ws = new WsClient(server.port, ana.cookie);
        await ws.connect();
        // Antes del saludo el servidor habla en claro (usuarios, historias…).
        await ws.waitFor('users');

        const session = T.wsKey(T.randomBytes(32), T.fromBase64(config.transportPublicKey));
        ws.sendText(JSON.stringify({ type: 'enc', ephemeral: T.toBase64(session.ephemeralRaw) }));

        const confirmation = await waitForText(ws, text => text.startsWith('z1:'));
        assert.equal(JSON.parse(T.wsOpen(session.key, 0, confirmation)).type, 'enc-ok');

        // Ping cifrado: el pong vuelve cifrado con el contador siguiente.
        ws.sendText(T.wsSeal(session.key, 0, JSON.stringify({ type: 'ping' })));
        const pong = await waitForText(ws, text => text.startsWith('z1:') && text !== confirmation);
        assert.equal(JSON.parse(T.wsOpen(session.key, 1, pong)).type, 'pong');

        // Con sesión abierta, un frame en claro se descarta.
        ws.sendText(JSON.stringify({ type: 'ping' }));
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(ws.texts.filter(text => text.startsWith('z1:')).length, 2);
        ws.destroy();

        // Un cliente que no saluda sigue recibiendo sus frames en claro.
        const plain = new WsClient(server.port, beto.cookie);
        await plain.connect();
        const users = await plain.waitFor('users');
        assert.ok(Array.isArray(users.users));
        plain.destroy();
    } finally {
        await stop(server);
    }
});

test('the client opens the sealed response of an XMLHttpRequest', async () => {
    /* El transporte del navegador envuelve fetch Y XMLHttpRequest: los POST con
       barra de progreso (adjuntos, notas de voz, historias) salen cifrados y su
       respuesta vuelve cifrada. Si el cliente no la abre, la subida "falla"
       aunque el servidor la aceptara. */
    const publicKey = S.transportPublicKey();
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'transport.js'), 'utf8');

    const respostaServidor = { body: '{"ok":true}', status: 200 };
    class FakeXHR {
        constructor() {
            this.requestHeaders = {};
            this.responseHeaders = {};
            this.listeners = {};
            this.responseType = '';
            this.status = 0;
            this.response = null;
            this.responseText = '';
        }
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader(name, value) { this.requestHeaders[name] = value; }
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
        getResponseHeader(name) { return this.responseHeaders[String(name).toLowerCase()] || null; }
        send(body) {
            // El servidor abre el sobre y responde cifrado.
            const time = Number(this.requestHeaders['X-Zlapy-Time']);
            const opened = S.decryptEnvelope({
                method: this.method,
                path: new URL(this.url, 'https://ejemplo.local').pathname,
                time,
                ephemeral: T.fromBase64(this.requestHeaders['X-Zlapy-Ephemeral']),
                nonce: T.fromBase64(this.requestHeaders['X-Zlapy-Nonce']),
                ciphertext: Buffer.from(body)
            });
            if (!opened) throw new Error('el servidor no pudo abrir el sobre');
            const path = new URL(this.url, 'https://ejemplo.local').pathname;
            const sealed = S.encryptEnvelope(opened.key, { method: this.method, path, time, status: respostaServidor.status }, respostaServidor.body);
            this.status = respostaServidor.status;
            this.responseHeaders = {
                'x-zlapy-enc': S.TRANSPORT_ALGO,
                'x-zlapy-resp-nonce': Buffer.from(sealed.nonce).toString('base64'),
                'content-type': 'application/octet-stream'
            };
            this.response = new Uint8Array(sealed.ciphertext).buffer;
            for (const fn of this.listeners.load || []) fn.call(this);
        }
    }

    const sandbox = {
        window: null,
        ZlapyTransport: T,
        XMLHttpRequest: FakeXHR,
        fetch: async url => ({ ok: true, json: async () => ({ transportPublicKey: publicKey }) }),
        location: { href: 'https://ejemplo.local/', origin: 'https://ejemplo.local' },
        URL,
        TextDecoder,
        Promise,
        console: { warn() { }, log() { } },
        dispatchEvent() { },
        CustomEvent: class { constructor() { } }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', '/send');
    xhr.send(JSON.stringify({ to: 'leo', kind: 'audio' }));
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(xhr.status, 200);
    assert.equal(xhr.responseText, '{"ok":true}',
        'la respuesta cifrada del XHR debe abrirse y quedar como texto');
});

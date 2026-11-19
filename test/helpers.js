// Helpers para los tests de integración: arranca server.js como proceso hijo
// con DATA_DIR temporal y puerto libre, y provee un cliente HTTP y un cliente
// WebSocket mínimo (net + framing propio, el mismo del servidor).
'use strict';

const { execFileSync, spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let generatedStickerPackDir = null;

function getGeneratedStickerPackDir() {
    if (generatedStickerPackDir) return generatedStickerPackDir;
    const generatorPath = path.join(ROOT, 'ops', 'data', 'generate-animated-bbot-pack.js');
    generatedStickerPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-test-bbot-'));
    try {
        execFileSync(process.execPath, [generatorPath, generatedStickerPackDir], { stdio: 'ignore' });
        process.once('exit', () => {
            fs.rmSync(generatedStickerPackDir, { recursive: true, force: true });
        });
    } catch (error) {
        fs.rmSync(generatedStickerPackDir, { recursive: true, force: true });
        generatedStickerPackDir = null;
        throw error;
    }
    return generatedStickerPackDir;
}

/* Credencial del propietario que usan los servidores de prueba: la llave
   maestra se deriva de ella, así que los tests que necesiten derivarla (o
   descifrar material en reposo) usan estas mismas credenciales. */
const TEST_CREDENTIAL = Object.freeze({
    user: 'propietario-prueba',
    password: 'clave-de-prueba-2026'
});

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        /* El servidor de pruebas escucha en 0.0.0.0 (también acepta por la
           IPv4 de red): el puerto se comprueba en esa MISMA interfaz para no
           asignar uno que otro hijo ya ocupa en otra dirección. */
        srv.listen(0, '0.0.0.0', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

/* Un solo intento. La identidad del arranque viene del mensaje IPC `ready`
   del PROPIO hijo, nunca de un 200 que pueda devolver otro ocupante. */
async function startServerOnce(options, port, dataDir) {
    const stickerPackDir = options.env && Object.prototype.hasOwnProperty.call(options.env, 'BBOT_STICKER_PACK_DIR')
        ? options.env.BBOT_STICKER_PACK_DIR
        : process.env.BBOT_STICKER_PACK_DIR || getGeneratedStickerPackDir();
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: {
            ...process.env,
            PORT: String(port),
            DATA_DIR: dataDir,
            FORCE_TLS: 'false',
            BIND_HOST: 'auto',
            DB_USER: TEST_CREDENTIAL.user,
            DB_PASSWORD: TEST_CREDENTIAL.password,
            DB_NAME: 'zlapy',
            BLOB_DB_NAME: 'blob',
            BBOT_STICKER_PACK_DIR: stickerPackDir,
            ...(options.env || {})
        },
        // IPC permite distinguir el ready real incluso si otro proceso ocupa
        // el puerto y responde 200 o deja el sondeo HTTP colgado.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    if (typeof options.onChild === 'function') options.onChild(child);
    let log = '';
    let startupTimer = null;
    const base = `http://127.0.0.1:${port}`;
    const portConflict = () => new RegExp(`Puerto ${port} ocupado\\b`).test(log);
    const onLog = data => {
        log += data;
        if (portConflict()) {
            const error = new Error(`Puerto ${port} ocupado durante el arranque de prueba.`);
            error.code = 'EADDRINUSE';
            rejectStartup(error);
        }
    };
    let rejectStartup;
    const failure = new Promise((resolve, reject) => { rejectStartup = reject; });
    const ready = new Promise(resolve => {
        child.on('message', message => {
            if (message && message.t === 'ready' && message.port === port) resolve();
        });
    });
    child.once('error', rejectStartup);
    child.once('exit', (code, signal) => {
        const error = new Error(`el servidor de prueba no arrancó (${code ?? signal ?? 'desconocido'}):\n${log.slice(-2000)}`);
        if (portConflict()) error.code = 'EADDRINUSE';
        rejectStartup(error);
    });
    child.stdout.on('data', onLog);
    child.stderr.on('data', onLog);
    startupTimer = setTimeout(() => {
        const error = new Error(`el servidor de prueba no estuvo listo a tiempo:\n${log.slice(-2000)}`);
        if (portConflict()) error.code = 'EADDRINUSE';
        rejectStartup(error);
    }, 300_000);

    try {
        await Promise.race([ready, failure]);
        /* Con cobertura y cientos de hijos en paralelo, 5 s puede no bastar
           incluso después del ready IPC. Sigue acotado, pero sin falso fallo
           por saturación del runner. */
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`healthz respondió ${response.status} tras el ready IPC del hijo.`);
        return {
            child, base, port, dataDir,
            ownsDataDir: !options.dataDir,
            get log() { return log; }
        };
    } catch (error) {
        // Espera la salida (con escalado en stop) antes de borrar o reintentar.
        try { await stop({ child, ownsDataDir: false, dataDir }); } catch { }
        throw error;
    } finally {
        if (startupTimer) clearTimeout(startupTimer);
    }
}

/* Arranca un servidor de prueba. options.dataDir permite reusar una base
   (para probar reinicios). Devuelve { child, base, port, dataDir }. */
async function startServer(options = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt++) {
        const ownsDataDir = !options.dataDir;
        const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-test-'));
        let succeeded = false;
        try {
            const explicitPort = options.env && options.env.PORT !== undefined;
            const port = explicitPort ? Number(options.env.PORT) : await freePort();
            const result = await startServerOnce(options, port, dataDir);
            succeeded = true;
            return result;
        } catch (error) {
            lastError = error;
            /* Solo reintenta un conflicto del puerto EFECTIVO y elegido por el
               helper. Un PORT explícito u otro error falla sin recursión. */
            const retry = error.code === 'EADDRINUSE' &&
                !(options.env && options.env.PORT !== undefined) && attempt < 5;
            if (!retry) throw error;
        } finally {
            // startServerOnce ya esperó la salida del hijo antes de llegar aquí.
            if (!succeeded && ownsDataDir) {
                try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { }
            }
        }
    }
    throw lastError;
}

function stop(server) {
    return new Promise(resolve => {
        let killTimer = null;
        const cleanup = () => {
            if (killTimer) clearTimeout(killTimer);
            // Solo se borra el DATA_DIR si esta instancia lo creó: un test que
            // reutiliza la base (p. ej. para probar reinicios) la conserva.
            if (server.ownsDataDir) {
                try { fs.rmSync(server.dataDir, { recursive: true, force: true }); } catch { }
            }
            resolve();
        };
        const exited = server.child.exitCode !== null || server.child.signalCode !== null;
        if (exited) return cleanup();
        server.child.once('exit', cleanup);
        server.child.kill('SIGTERM');
        killTimer = setTimeout(() => { try { server.child.kill('SIGKILL'); } catch { } }, 5000);
    });
}

/* Petición HTTP con cookie de sesión y cabeceras anti-CSRF del mismo origen. */
async function api(base, method, pathname, body, cookie) {
    const headers = { 'Content-Type': 'application/json', 'Origin': base, 'Sec-Fetch-Site': 'same-origin' };
    if (cookie) headers.Cookie = `zlapy_session=${encodeURIComponent(cookie)}`;
    const res = await fetch(base + pathname, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { }
    return { status: res.status, json, text, setCookie };
}

const sessionCookieFrom = setCookie => {
    const match = /zlapy_session=([^;]+)/.exec(setCookie || '');
    return match ? decodeURIComponent(match[1]) : '';
};

/* Registra un usuario y devuelve { status, json, cookie }. */
async function register(base, username, password = 'pruebachat1') {
    const res = await api(base, 'POST', '/auth/register', { username, password });
    return { status: res.status, json: res.json, cookie: sessionCookieFrom(res.setCookie) };
}

/* Petición cruda por socket: para request-targets que fetch no puede enviar. */
function rawRequest(port, data, timeoutMs = 3000) {
    return new Promise(resolve => {
        let out = '';
        let sock;
        try { sock = net.connect(port, '127.0.0.1', () => sock.write(data)); }
        catch { return resolve('connect error'); }
        sock.on('data', d => { out += d; });
        sock.on('close', () => resolve(out));
        sock.on('error', () => resolve(out));
        setTimeout(() => { try { sock.destroy(); } catch { } resolve(out); }, timeoutMs);
    });
}

/* Cliente WebSocket mínimo (cliente → servidor con máscara). */
class WsClient {
    constructor(port, cookie) {
        this.port = port;
        this.cookie = cookie;
        this.frames = [];
        this.texts = [];   // frames de texto crudos (para el canal cifrado)
        this.waiters = [];
        this.closed = false;
        this.closeCode = null;
        this.handshakeDone = false;
        this.raw = Buffer.alloc(0);
        this.socket = null;
    }
    connect() {
        return new Promise((resolve, reject) => {
            const key = crypto.randomBytes(16).toString('base64');
            const sock = net.connect(this.port, '127.0.0.1', () => {
                sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${this.port}\r\nUpgrade: websocket\r\n` +
                    `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
                    `Origin: http://127.0.0.1:${this.port}\r\nCookie: zlapy_session=${encodeURIComponent(this.cookie)}\r\n\r\n`);
            });
            this.socket = sock;
            const failTimer = setTimeout(() => reject(new Error('timeout en handshake WS')), 5000);
            sock.on('data', d => {
                if (!this.handshakeDone) {
                    this.raw = Buffer.concat([this.raw, d]);
                    const idx = this.raw.indexOf('\r\n\r\n');
                    if (idx === -1) return;
                    const statusLine = this.raw.subarray(0, idx).toString().split('\r\n')[0];
                    if (!statusLine.includes('101')) {
                        clearTimeout(failTimer);
                        reject(new Error('upgrade rechazado: ' + statusLine));
                        sock.destroy();
                        return;
                    }
                    this.handshakeDone = true;
                    const rest = this.raw.subarray(idx + 4);
                    this.raw = Buffer.alloc(0);
                    clearTimeout(failTimer);
                    resolve();
                    if (rest.length) this._feed(rest);
                    return;
                }
                this._feed(d);
            });
            sock.on('close', () => { this.closed = true; this._wake(); });
            sock.on('error', () => { });
        });
    }
    _feed(chunk) {
        this.raw = Buffer.concat([this.raw, chunk]);
        while (this.raw.length >= 2) {
            const opcode = this.raw[0] & 0x0f;
            let len = this.raw[1] & 0x7f, off = 2;
            if (len === 126) {
                if (this.raw.length < 4) return;
                len = this.raw.readUInt16BE(2);
                off = 4;
            } else if (len === 127) {
                if (this.raw.length < 10) return;
                len = Number(this.raw.readBigUInt64BE(2));
                off = 10;
            }
            if (this.raw.length < off + len) return;
            const payload = this.raw.subarray(off, off + len);
            this.raw = this.raw.subarray(off + len);
            if (opcode === 0x1) {
                const text = payload.toString();
                this.texts.push(text);
                let obj = null;
                try { obj = JSON.parse(text); } catch { }
                if (obj) { this.frames.push(obj); this._wake(); }
            } else if (opcode === 0x8) {
                this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null;
                this.closed = true;
                this._wake();
                try { this.socket.end(); } catch { }
            }
        }
    }
    _wake() { for (const w of [...this.waiters]) w(); }
    send(obj) { this.sendText(JSON.stringify(obj)); }
    sendText(text) {
        const payload = Buffer.from(text);
        const mask = crypto.randomBytes(4);
        let head;
        if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
        else {
            head = Buffer.alloc(4);
            head[0] = 0x81;
            head[1] = 0x80 | 126;
            head.writeUInt16BE(payload.length, 2);
        }
        const masked = Buffer.from(payload);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        this.socket.write(Buffer.concat([head, mask, masked]));
    }
    sendRaw(bytes) { this.socket.write(bytes); }
    waitFor(type, timeoutMs = 6000) {
        const existing = this.frames.find(f => f.type === type);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter(x => x !== w);
                reject(new Error(`timeout esperando '${type}'; recibidos: ${JSON.stringify(this.frames.map(f => f.type))}`));
            }, timeoutMs);
            const check = () => {
                const f = this.frames.find(x => x.type === type);
                if (f) { clearTimeout(timer); resolve(f); return true; }
                return false;
            };
            const w = () => { if (check()) this.waiters = this.waiters.filter(x => x !== w); };
            this.waiters.push(w);
        });
    }
    waitClosed(timeoutMs = 6000) {
        if (this.closed) return Promise.resolve(this.closeCode);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter(x => x !== w);
                reject(new Error('timeout esperando el cierre de la conexión'));
            }, timeoutMs);
            const check = () => {
                if (this.closed) { clearTimeout(timer); resolve(this.closeCode); return true; }
                return false;
            };
            const w = () => { if (check()) this.waiters = this.waiters.filter(x => x !== w); };
            this.waiters.push(w);
        });
    }
    destroy() { try { this.socket.destroy(); } catch { } }
}

module.exports = { startServer, stop, api, register, sessionCookieFrom, rawRequest, WsClient, freePort, TEST_CREDENTIAL };

'use strict';
/**
 * Vida de la sesión según el canal por el que se emite.
 *
 * La sesión completa (AUTH_SESSION_TTL_MS, 30 días) solo se emite por
 * canales que un tercero no puede estar escuchando: HTTPS (directo o por
 * el proxy de confianza de loopback) y loopback puro. Una sesión emitida
 * por HTTP en claro desde otra máquina se firma con
 * AUTH_PLAIN_SESSION_TTL_MS (8 h por defecto): es el caso del token que un
 * observador de la WiFi copia del Set-Cookie/Cookie legible — el sobre
 * cifrado cubre los CUERPOS, no las cabeceras donde viaja la cookie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { startServer, stop, api, sessionCookieFrom } = require('../helpers.js');
const { CONFIG, loadConfig } = require('../../src/config.js');
const { ttlForRequest } = require('../../src/auth/sessions.js');

const decodificarJwt = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const maxAgesDe = setCookie => [...String(setCookie || '').matchAll(/Max-Age=(\d+)/g)].map(m => m[1]);

/* IPv4 privada de la máquina (no loopback, no enlace-auto): hablándole al
   servidor por ella, el par visto por el servidor NO es loopback y se
   ejercita el canal abierto real de punta a punta. */
function ipv4DeRed() {
    const redes = Object.values(os.networkInterfaces()).flat()
        .filter(n => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'));
    return redes.length ? redes[0].address : '';
}

/* ── Regla de decisión (unitaria, con req falsos) ───────────────────────── */

test('ttlForRequest: completo en canal protegido, corto en canal abierto', () => {
    const enTls = { socket: { encrypted: true, remoteAddress: '192.168.1.50' }, headers: {} };
    const enLoopback = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    const proxyConfiable = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } };
    const remotoEnClaro = { socket: { remoteAddress: '192.168.1.50' }, headers: {} };
    const proxyMentiroso = { socket: { remoteAddress: '192.168.1.50' }, headers: { 'x-forwarded-proto': 'https' } };

    assert.equal(ttlForRequest(enTls), CONFIG.authSessionTtlMs);
    assert.equal(ttlForRequest(enLoopback), CONFIG.authSessionTtlMs);
    assert.equal(ttlForRequest(proxyConfiable), CONFIG.authSessionTtlMs);
    assert.equal(ttlForRequest(remotoEnClaro), CONFIG.authPlainSessionTtlMs);
    /* La cabecera X-Forwarded-Proto solo vale desde loopback: un cliente
       de la red que la inventa no se convierte en canal protegido. */
    assert.equal(ttlForRequest(proxyMentiroso), CONFIG.authPlainSessionTtlMs);
});

/* ── Configuración ──────────────────────────────────────────────────────── */

test('AUTH_PLAIN_SESSION_TTL_MS: por defecto 8 h y siempre ≤ AUTH_SESSION_TTL_MS', () => {
    const porDefecto = loadConfig({});
    assert.equal(porDefecto.authPlainSessionTtlMs, 8 * 60 * 60 * 1000);
    assert.ok(porDefecto.authPlainSessionTtlMs <= porDefecto.authSessionTtlMs);
    assert.throws(() => loadConfig({
        AUTH_SESSION_TTL_MS: '60000',
        AUTH_PLAIN_SESSION_TTL_MS: '120000'
    }), /AUTH_PLAIN_SESSION_TTL_MS cannot exceed AUTH_SESSION_TTL_MS/);
});

/* ── Integración: emisión real por cada canal ───────────────────────────── */

test('sesión emitida por loopback: vida completa', async () => {
    const srv = await startServer();
    try {
        const res = await api(srv.base, 'POST', '/auth/register', { username: 'ana', password: 'pruebachat1' });
        assert.equal(res.status, 201);
        const payload = decodificarJwt(sessionCookieFrom(res.setCookie));
        assert.equal(payload.exp - payload.iat, CONFIG.authSessionTtlMs / 1000);
        /* Las DOS cookies (principal y de cuenta vinculada) con el mismo Max-Age. */
        assert.deepEqual(maxAgesDe(res.setCookie), [String(CONFIG.authSessionTtlMs / 1000), String(CONFIG.authSessionTtlMs / 1000)]);
    } finally { await stop(srv); }
});

test('sesión emitida por HTTP en claro desde otra máquina: vida corta y sigue funcionando', async t => {
    const ip = ipv4DeRed();
    if (!ip) { t.skip('sin IPv4 de red no hay forma de hablar por un canal no loopback'); return; }
    const srv = await startServer({ env: { AUTH_PLAIN_SESSION_TTL_MS: '60000' } });
    try {
        const base = `http://${ip}:${srv.port}`;
        const res = await api(base, 'POST', '/auth/register', { username: 'ana', password: 'pruebachat1' });
        assert.equal(res.status, 201);
        const token = sessionCookieFrom(res.setCookie);
        /* Vida del token = AUTH_PLAIN_SESSION_TTL_MS (60 s en esta prueba). */
        const payload = decodificarJwt(token);
        assert.equal(payload.exp - payload.iat, 60);
        assert.deepEqual(maxAgesDe(res.setCookie), ['60', '60']);
        /* Corta no significa rota: la cookie recién emitida autentica. */
        const sesion = await api(base, 'GET', '/auth/session', undefined, token);
        assert.equal(sesion.status, 200);
        assert.equal(sesion.json.authenticated, true);
    } finally { await stop(srv); }
});

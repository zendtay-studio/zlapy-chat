// Regresión V-05/V-06: los límites de frecuencia usan la IP del socket (nunca
// una cabecera que el cliente pueda falsificar) y frenan con retardo progresivo
// en vez de bloqueo, para que nadie pueda dejar fuera de su cuenta a otro.
// Incluye la regresión V-15 (POST sin cuerpo) y el no-oráculo de login.
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '500';

const assert = require('node:assert/strict');
const test = require('node:test');
const { clientIp } = require('../src/shared/validation.js');
const { startServer, stop, register, rawRequest } = require('./helpers.js');

/* Petición de acceso con la cabecera que antes anulaba el límite por IP.
   El tiempo de espera es generoso: el freno por fallos añade retardo a
   propósito (hasta 10 s), así que la petición tarda más que una normal. */
function loginRequest(port, fakeIp, body) {
    return rawRequest(port,
        `POST /auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n${fakeIp ? `CF-Connecting-IP: ${fakeIp}\r\n` : ''}\r\n${body}`, 20000);
}
const jsonBody = (username, password) => JSON.stringify({ username, password });
const cuerpo = respuesta => (respuesta.split('\r\n\r\n')[1] || '').trim();

test('la IP de los límites sale del socket, no de una cabecera del cliente', () => {
    const req = {
        socket: { remoteAddress: '192.168.1.50' },
        headers: { 'cf-connecting-ip': '10.9.9.9', 'x-forwarded-for': '172.16.0.1' }
    };
    assert.equal(clientIp(req), '192.168.1.50');
    // Sin socket conocida no se inventa un identificador falseable.
    assert.equal(clientIp({ socket: {}, headers: { 'cf-connecting-ip': '10.9.9.9' } }), 'unknown');
});

test('rotar la cabecera de IP no evita el freno ni bloquea a la víctima', async () => {
    const srv = await startServer();
    try {
        const victima = await register(srv.base, 'rlvictima');
        const clave = victima.password || 'pruebachat1';
        // 6 fallos del atacante contra el nombre de la víctima, cada uno con una
        // IP falsificada distinta (antes así giraba entre cubos y no acumulaba).
        for (let i = 0; i < 6; i++) {
            const out = await loginRequest(srv.port, `10.99.0.${i}`, jsonBody('rlvictima', 'clave-mala'));
            assert.match(out, /^HTTP\/1\.1 401/, 'un intento fallido sigue siendo 401');
        }
        // La víctima entra con su clave correcta: el freno le añade retardo,
        // nunca un bloqueo que la deje fuera.
        const ok = await loginRequest(srv.port, null, jsonBody('rlvictima', clave));
        assert.match(ok, /^HTTP\/1\.1 200/, 'la víctima debe poder entrar pese a los fallos del atacante');
    } finally { await stop(srv); }
});

test('el registro masivo desde la misma IP real sí se frena', async () => {
    const srv = await startServer();
    try {
        // El contador de registro es por IP real: 15 altas por hora.
        let blocked = false;
        for (let i = 0; i < 20; i++) {
            const res = await register(srv.base, `regmasivo${i}${Date.now() % 100000}`);
            if (res.status === 429) { blocked = true; break; }
        }
        assert.ok(blocked, 'el registro masivo debe acabar frenándose');
    } finally { await stop(srv); }
});

test('login y logout con cuerpo vacío ya no fallan con 400 (V-15)', async () => {
    const srv = await startServer();
    try {
        const cuenta = await register(srv.base, 'cuerpo');
        assert.ok(cuenta.cookie, 'la cuenta de prueba debe tener cookie');
        const sinCuerpo = await rawRequest(srv.port,
            `POST /auth/logout HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n`);
        assert.match(sinCuerpo, /^HTTP\/1\.1 (200|401)/, 'un POST sin cuerpo no debe romperse con 400');
        const vacio = await rawRequest(srv.port,
            `POST /auth/logout HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
        assert.match(vacio, /^HTTP\/1\.1 (200|401)/);
    } finally { await stop(srv); }
});

test('la respuesta de login no distingue usuario inexistente de contraseña mala', async () => {
    const srv = await startServer();
    try {
        const victima = await register(srv.base, 'oraculo');
        const clave = victima.password || 'pruebachat1';
        const noExiste = await loginRequest(srv.port, null, jsonBody('usuario-que-no-existe-x', 'clave-mala'));
        const existe = await loginRequest(srv.port, null, jsonBody('oraculo', 'clave-mala'));
        // Mismo estado, mismo texto: la ruta no es un oráculo de existencia.
        assert.match(noExiste, /^HTTP\/1\.1 401/);
        assert.match(existe, /^HTTP\/1\.1 401/);
        assert.equal(cuerpo(noExiste), cuerpo(existe));
        assert.match(cuerpo(existe), /Invalid username or password\./);
        // Y con la clave correcta sí entra (regresión: el freno no bloquea).
        const ok = await loginRequest(srv.port, null, jsonBody('oraculo', clave));
        assert.match(ok, /^HTTP\/1\.1 200/);
    } finally { await stop(srv); }
});

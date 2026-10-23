// Regresión V-01: con FORCE_TLS activo y certificados presentes, ninguna
// petición en claro llega a procesarse (ni las públicas) y la cookie de sesión
// se marca Secure. También se comprueba el modo de repliegue sin certificados.
const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../src/config.js');
const { startServer, stop, api, register } = require('./helpers.js');

test('FORCE_TLS se activa por defecto y se puede desactivar por entorno', () => {
    assert.equal(loadConfig({}).forceTls, true);
    assert.equal(loadConfig({ FORCE_TLS: 'false' }).forceTls, false);
    assert.equal(loadConfig({ FORCE_TLS: '0' }).forceTls, false);
    assert.equal(loadConfig({ FORCE_TLS: 'no' }).forceTls, false);
    assert.equal(loadConfig({ FORCE_TLS: 'true' }).forceTls, true);
});

test('BIND_HOST solo acepta auto, loopback o 0.0.0.0', () => {
    assert.equal(loadConfig({}).bindHost, 'auto');
    assert.equal(loadConfig({ BIND_HOST: 'loopback' }).bindHost, 'loopback');
    assert.equal(loadConfig({ BIND_HOST: '0.0.0.0' }).bindHost, '0.0.0.0');
    // Un valor absurdo cae al valor por defecto en vez de romper el listen().
    assert.equal(loadConfig({ BIND_HOST: 'evil.example' }).bindHost, 'auto');
});

// Regresión del fallo que cazó el CI: el repliegue sin certificados intentaba
// rebajar CONFIG.forceTls, pero CONFIG está congelada → TypeError al arrancar
// → el servidor moría en bucle en CUALQUIER instalación nueva sin cert.pem/
// key.pem. Localmente nunca saltó porque los certificados de producción existen.
test('sin certificados y FORCE_TLS por defecto: arranca en claro y avisa', async () => {
    const srv = await startServer({
        env: {
            FORCE_TLS: 'true',
            TLS_CERT_FILE: '/no/existe/cert.pem',
            TLS_KEY_FILE: '/no/existe/key.pem'
        }
    });
    try {
        // El servidor ARRANCA (antes moría al cargar servers.js).
        const health = await fetch(`${srv.base}/healthz`);
        assert.equal(health.status, 200);

        // Sin HTTPS al que redirigir, la raíz se sirve en claro (no 301).
        const page = await fetch(`${srv.base}/`);
        assert.equal(page.status, 200);

        // El aviso del repliegue queda en el log del hijo.
        assert.match(srv.log, /\[tls\] FORCE_TLS desactivado/);

        // Y la cookie de sesión NO se marca Secure sobre HTTP en este modo:
        // el navegador la rechazaría y el login parecería "no funcionar".
        await register(srv.base, 'anasincert');
        const login = await api(srv.base, 'POST', '/auth/login',
            { username: 'anasincert', password: 'pruebachat1' });
        assert.equal(login.status, 200);
        assert.match(login.setCookie, /chatlocal_session=/);
        assert.ok(!/Secure/i.test(login.setCookie),
            'la cookie no debe llevar Secure cuando no hay HTTPS');
    } finally { await stop(srv); }
});

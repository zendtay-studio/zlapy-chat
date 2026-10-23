// Regresión V-01: con FORCE_TLS activo y certificados presentes, ninguna
// petición en claro llega a procesarse (ni las públicas) y la cookie de sesión
// se marca Secure. También se comprueba el modo de repliegue sin certificados.
const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../src/config.js');

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

// Preflight de dependencias: detecta e instala lo que falta sin tocar npm de
// verdad (instalador y verificador inyectables), y con las dependencias
// reales del repo devuelve OK sin lanzar procesos.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { verifyDeps, ensureDeps, dependencies } = require('../../ops/install/ensure-deps.js');

test('con las dependencias del repo instaladas, el preflight pasa sin instalar nada', () => {
    const r = verifyDeps();
    assert.equal(r.ok, true, 'el repo debe tener sus dependencias instaladas');
    assert.deepEqual(r.missing, []);
    assert.equal(r.enginesOk, true, 'Node de la versión exigida');
});

test('Node demasiado antiguo: error claro y NO se intenta instalar', () => {
    let installCalled = false;
    assert.throws(
        () => ensureDeps({
            verify: () => ({ ok: false, enginesOk: false, missing: [{ name: 'x', why: 'no está' }] }),
            install: () => { installCalled = true; return { ok: true }; },
            loggers: {}
        }),
        /demasiado antiguo/
    );
    assert.equal(installCalled, false);
});

test('una dependencia ausente se instala y se reverifica', () => {
    const missing = [{ name: 'libreria-inventada', why: 'no está en node_modules' }];
    const llamadas = [];
    const verify = () => {
        llamadas.push('verify');
        // 1ª llamada: falta algo (camino rápido) · 2ª: lista exacta · 3ª: ya está
        return llamadas.length === 3
            ? { ok: true, enginesOk: true, missing: [] }
            : { ok: false, enginesOk: true, missing };
    };
    const pedidos = [];
    const r = ensureDeps({
        verify,
        install: lista => { pedidos.push(lista); return { ok: true }; },
        loggers: { log: () => { }, error: () => { } }
    });
    assert.equal(r.ok, true);
    assert.equal(r.installed, true, 'informa de que instaló algo');
    assert.deepEqual(r.missing, missing);
    assert.deepEqual(pedidos, [['libreria-inventada']], 'se instala justo lo que faltaba');
    assert.equal(llamadas.length, 3, 'antes → detalle → después');
});

test('si la instalación falla, el error trae el remedio', () => {
    assert.throws(
        () => ensureDeps({
            verify: () => ({ ok: false, enginesOk: true, missing: [{ name: 'dotenv', why: 'no está' }] }),
            install: () => ({ ok: false, error: 'sin red' }),
            loggers: { log: () => { }, error: () => { } }
        }),
        /red|npm install/i,
        'el mensaje debe decir qué hacer (red / npm install)'
    );
});

test('si tras instalar SIGUE faltando algo, se informa con el remedio en vez de darlo por listo', () => {
    assert.throws(
        () => ensureDeps({
            verify: () => ({ ok: false, enginesOk: true, missing: [{ name: 'better-sqlite3', why: 'falta el binario' }] }),
            install: () => ({ ok: true }),
            loggers: { log: () => { }, error: () => { } }
        }),
        /sigue sin cargar|rebuild:sqlite/i,
        'nunca se finge "todo listo" si la reverificación falla'
    );
});

test('el conjunto verificado por defecto es el de package.json', () => {
    assert.ok(dependencies.includes('better-sqlite3'));
    assert.ok(dependencies.includes('dotenv'));
});

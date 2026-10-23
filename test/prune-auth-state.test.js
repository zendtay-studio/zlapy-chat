// Regresión del crampón de producción (23:00–00:45): el intervalo de limpieza
// de websocket.js referenciaba `loginAttempts` y `registerAttempts` sin
// importarlos, y el ReferenceError mataba al servidor cada 10 minutos — con la
// suite entera en verde, porque los tests paran sus servidores antes de que
// el temporizador dispare. Este test llama a la limpieza DIRECTO.
process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'zlapy-prune-'));

const assert = require('node:assert/strict');
const test = require('node:test');
const { loginAttempts, registerAttempts } = require('../src/http/rate-limit.js');
const { sessionCache } = require('../src/state.js');
// Requerir websocket.js ejecuta la carga de módulos que rompía antes: si un
// identificador del intervalo no está importado, el propio require o la
// llamada de abajo lo destapan al instante.
const { pruneAuthState } = require('../src/realtime/websocket.js');

test('la limpieza periódica de sesiones no tumba el proceso', () => {
    const now = Date.now();
    loginAttempts.set('acct:viejo@1.2.3.4', { count: 3, until: now - 1000 });
    loginAttempts.set('acct:vivo@1.2.3.4', { count: 1, until: now + 60_000 });
    registerAttempts.set('1.2.3.4', { count: 1, until: now - 1000 });
    registerAttempts.set('global:registros', { count: 10, until: now - 1000 });
    sessionCache.set('hashviejo', { userId: 'u1', expiresAt: now - 1000 });
    sessionCache.set('hashvivo', { userId: 'u2', expiresAt: now + 60_000 });

    // Antes del arreglo esto lanzaba "loginAttempts is not defined" (websocket.js:348).
    pruneAuthState(now);

    assert.ok(!loginAttempts.has('acct:viejo@1.2.3.4'), 'el intento caducado se borra');
    assert.ok(loginAttempts.has('acct:vivo@1.2.3.4'), 'el intento vigente se queda');
    assert.ok(!registerAttempts.has('global:registros'), 'el contador global caducado se borra');
    assert.ok(!sessionCache.has('hashviejo'), 'la sesión caducada sale de la caché');
    assert.ok(sessionCache.has('hashvivo'), 'la sesión vigente se queda');
});

test('un error dentro de una familia de limpieza no arrastra a las demás', () => {
    const now = Date.now();
    // entry sin `until`: hace saltar el catch de intentos sin borrar nada.
    registerAttempts.set('1.2.3.4', null);
    sessionCache.set('hashviejo2', { userId: 'u1', expiresAt: now - 1000 });

    // No lanza aunque una familia falle: el proceso sigue vivo.
    pruneAuthState(now);

    assert.ok(!sessionCache.has('hashviejo2'), 'la sesión caducada se limpia aunque los intentos fallen');
    registerAttempts.delete('1.2.3.4');
});

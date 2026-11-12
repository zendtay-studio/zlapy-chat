// Regresión del crampón de producción (23:00–00:45): el intervalo de limpieza
// de websocket.js referenciaba `loginAttempts` y `registerAttempts` sin
// importarlos, y el ReferenceError mataba al servidor cada 10 minutos — con la
// suite entera en verde, porque los tests paran sus servidores antes de que
// el temporizador dispare. Este test llama a la limpieza DIRECTO.
//
// Desde v9 no limpia sesiones: no hay almacén (tokens JWT verificados contra
// users.auth_version), así que la única familia de limpieza son los intentos.
process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'zlapy-prune-'));

const assert = require('node:assert/strict');
const test = require('node:test');
const { loginAttempts, registerAttempts } = require('../src/http/rate-limit.js');
// Requerir websocket.js ejecuta la carga de módulos que rompía antes: si un
// identificador del intervalo no está importado, el propio require o la
// llamada de abajo lo destapan al instante.
const { pruneAuthState } = require('../src/realtime/websocket.js');

test('la limpieza periódica de intentos no tumba el proceso', () => {
    const now = Date.now();
    loginAttempts.set('acct:viejo@1.2.3.4', { count: 3, until: now - 1000 });
    loginAttempts.set('acct:vivo@1.2.3.4', { count: 1, until: now + 60_000 });
    registerAttempts.set('1.2.3.4', { count: 1, until: now - 1000 });
    registerAttempts.set('global:registros', { count: 10, until: now - 1000 });

    // Antes del arreglo esto lanzaba "loginAttempts is not defined" (websocket.js:348).
    pruneAuthState(now);

    assert.ok(!loginAttempts.has('acct:viejo@1.2.3.4'), 'el intento caducado se borra');
    assert.ok(loginAttempts.has('acct:vivo@1.2.3.4'), 'el intento vigente se queda');
    assert.ok(!registerAttempts.has('global:registros'), 'el contador global caducado se borra');
});

test('un error dentro de la limpieza no tumba el proceso', () => {
    const now = Date.now();
    // entry sin `until`: hace saltar el catch de intentos sin borrar nada.
    registerAttempts.set('1.2.3.4', null);

    // No lanza aunque una familia falle: el proceso sigue vivo.
    assert.doesNotThrow(() => pruneAuthState(now));
    registerAttempts.delete('1.2.3.4');
});

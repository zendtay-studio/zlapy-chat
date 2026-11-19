// Sincronización aditiva de `.env` con `.env.example`: solo entran las
// variables y comentarios que faltan; nada de lo que ya existe se reemplaza.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { syncEnvFile } = require('../../ops/config/sync-env-example.js');

function archivos(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-env-sync-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return {
        env: path.join(dir, '.env'),
        example: path.join(dir, '.env.example')
    };
}

test('añade variables y comentarios que faltan, conservando los valores actuales', t => {
    const { env, example } = archivos(t);
    fs.writeFileSync(example, [
        '# cabecera general que no debe duplicarse',
        'PORT=1820',
        '# interfaz de escucha',
        'BIND_HOST=auto',
        '# credencial secreta',
        'DB_PASSWORD='
    ].join('\n'));
    fs.writeFileSync(env, '# mi configuración\nPORT=9999\nDB_USER=mi-usuario\n');

    const resultado = syncEnvFile(env, example);
    assert.deepEqual(resultado.added, ['BIND_HOST', 'DB_PASSWORD']);
    const contenido = fs.readFileSync(env, 'utf8');
    assert.match(contenido, /^PORT=9999$/m, 'el puerto existente no cambia');
    assert.doesNotMatch(contenido, /^PORT=1820$/m, 'no entra el valor de ejemplo si ya existe');
    assert.match(contenido, /^DB_USER=mi-usuario$/m);
    assert.match(contenido, /# interfaz de escucha\nBIND_HOST=auto/, 'el comentario acompaña a su variable');
    assert.match(contenido, /# credencial secreta\nDB_PASSWORD=/);
    assert.doesNotMatch(contenido, /cabecera general/, 'no repite el preámbulo de la plantilla');
    assert.match(contenido, /^# mi configuración/, 'el texto propio se conserva');
});

test('una segunda sincronización no cambia nada ni duplica bloques', t => {
    const { env, example } = archivos(t);
    fs.writeFileSync(example, 'PORT=1820\n# otra variable\nBIND_HOST=auto\n');
    fs.writeFileSync(env, 'PORT=9999\n');

    assert.equal(syncEnvFile(env, example).changed, true);
    const primera = fs.readFileSync(env, 'utf8');
    const segunda = syncEnvFile(env, example);
    assert.equal(segunda.changed, false);
    assert.deepEqual(segunda.added, []);
    assert.equal(fs.readFileSync(env, 'utf8'), primera, 'la segunda pasada es idempotente');
    assert.equal((primera.match(/BIND_HOST=auto/g) || []).length, 1);
});

test('una variable comentada en el archivo real se considera ausente', t => {
    const { env, example } = archivos(t);
    fs.writeFileSync(example, '# puerto actual\nPORT=1820\n');
    fs.writeFileSync(env, '#PORT=3000\n');

    const resultado = syncEnvFile(env, example);
    assert.deepEqual(resultado.added, ['PORT']);
    const contenido = fs.readFileSync(env, 'utf8');
    assert.match(contenido, /^#PORT=3000$/m, 'el comentario viejo se conserva');
    assert.match(contenido, /^PORT=1820$/m, 'se añade la asignación activa');
});

test('un archivo vacío recibe la plantilla completa y queda con permisos 0600', t => {
    const { env, example } = archivos(t);
    const plantilla = '# ejemplo\nPORT=1820\n# credencial\nDB_USER=\n';
    fs.writeFileSync(example, plantilla);
    fs.writeFileSync(env, '');

    const resultado = syncEnvFile(env, example);
    assert.deepEqual(resultado.added, ['PORT', 'DB_USER']);
    assert.equal(fs.readFileSync(env, 'utf8'), plantilla);
    assert.equal(fs.statSync(env).mode & 0o777, 0o600);
});

test('sin plantilla se informa del error en vez de inventar valores', t => {
    const { env, example } = archivos(t);
    fs.writeFileSync(env, 'PORT=9999\n');
    assert.throws(() => syncEnvFile(env, example), /No existe la plantilla/);
    assert.equal(fs.readFileSync(env, 'utf8'), 'PORT=9999\n');
});

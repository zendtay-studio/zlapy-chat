// Puerto por defecto de la instalación: 1820, no 3000. Este último es muy
// común en desarrollo local y colisiona con otros servidores. El valor se
// define una vez en src/config.js y la plantilla, el supervisor y la doc lo
// acompañan; una variable PORT explícita sigue teniendo prioridad.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DEFAULTS, loadConfig } = require('../../src/config.js');

const RAIZ = path.join(__dirname, '..', '..');
const leer = ruta => fs.readFileSync(path.join(RAIZ, ruta), 'utf8');

test('sin PORT el servidor escucha en 1820', () => {
    assert.equal(DEFAULTS.PORT, 1820);
    assert.equal(loadConfig({}).port, 1820);
});

test('una PORT explícita sigue mandando sobre el valor por defecto', () => {
    assert.equal(loadConfig({ PORT: '3000' }).port, 3000, 'se puede elegir otro puerto sin tocar el código');
    assert.equal(loadConfig({ PORT: '1820' }).port, 1820);
});

test('las plantillas de entorno y túnel apuntan al mismo puerto', () => {
    assert.match(leer('.env.example'), /^PORT=1820$/m);
    assert.match(leer('zty.yml.example'), /service: http:\/\/localhost:1820/);
    assert.match(leer('ops/runtime/supervisor.js'), /readInt\('PORT', 1820\)/, 'el supervisor no se queda comprobando el puerto viejo');
});

test('la documentación de instalación no anuncia 3000 como puerto actual', () => {
    assert.match(leer('README.md'), /\| `PORT` \| `1820` \|/);
    assert.match(leer('docs/INSTALACION.md'), /\| `PORT` \| `1820` \|/);
    assert.match(leer('docs/API.md'), /por defecto `1820`/);
    assert.doesNotMatch(leer('README.md'), /puerto 3000|localhost:3000/);
    assert.doesNotMatch(leer('docs/INSTALACION.md'), /puerto 3000|Puerto 3000|localhost:3000/);
});
// Una sola versión para toda la app: `/js/build.js` alimenta el nombre de la
// caché del service worker (`zlapy-vN`) y la pantalla Ajustes > Información
// técnica. Si alguien vuelve a escribir el número a mano en `sw.js` o en el
// HTML, el número visible y el cacheado se separan: este test lo impide.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const RAIZ = path.join(__dirname, '..', '..');
const leer = ruta => fs.readFileSync(path.join(RAIZ, ruta), 'utf8');

test('build.js define la versión y la fecha', () => {
    const contexto = vm.createContext({ self: {} });
    vm.runInContext(leer('public/js/build.js'), contexto, { filename: 'build.js' });
    const { ZLAPY_BUILD, ZLAPY_BUILD_DATE } = contexto.self;
    assert.match(String(ZLAPY_BUILD), /^\d+$/, 'la versión es numérica: la caché se llama zlapy-vN');
    assert.ok(String(ZLAPY_BUILD_DATE).trim().length > 0, 'hay fecha de compilación');
});

test('el service worker nombra su caché con la versión de build.js', () => {
    const sw = leer('public/js/sw.js');
    assert.match(sw, /importScripts\('\/js\/build\.js'\)/, 'el worker importa la versión');
    assert.match(sw, /const CACHE = 'zlapy-v' \+ ZLAPY_BUILD;/, 'la caché se deriva, no se escribe a mano');
    assert.doesNotMatch(sw, /const CACHE = 'zlapy-v\d+'/, 'no queda una versión literal en sw.js');
    assert.ok(sw.includes("'/js/build.js'"), 'build.js viaja en el SHELL offline');
});

test('Información técnica lee la versión de build.js (sin duplicarla)', () => {
    const index = leer('public/index.html');
    assert.match(index, /<script src="\/js\/build\.js"><\/script>/, 'index.html carga la versión');
    assert.match(index, /const APP_BUILD_VERSION = String\(window\.ZLAPY_BUILD \|\| '0'\)/);
    assert.match(index, /const APP_BUILD_DATE = String\(window\.ZLAPY_BUILD_DATE/);
    assert.doesNotMatch(index, /const APP_BUILD_VERSION = \d+;/, 'no queda un número escrito a mano');
});

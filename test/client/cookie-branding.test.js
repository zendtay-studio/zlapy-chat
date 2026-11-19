// El frontend usa las cookies HttpOnly del mismo origen; no debe conservar
// nombres de la marca antigua ni descartar credenciales al hablar con la API.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function archivosFuentes(directorio) {
    return fs.readdirSync(directorio, { withFileTypes: true }).flatMap(entry => {
        const ruta = path.join(directorio, entry.name);
        if (entry.isDirectory()) return archivosFuentes(ruta);
        return /\.(?:html|js|css|webmanifest)$/.test(entry.name) ? [ruta] : [];
    });
}

test('el frontend no referencia chatlocal_* ni bloquea las cookies nuevas', () => {
    const fuentes = archivosFuentes(PUBLIC);
    assert.ok(fuentes.length > 0);
    for (const archivo of fuentes) {
        const contenido = fs.readFileSync(archivo, 'utf8');
        assert.doesNotMatch(contenido, /chatlocal_/, path.relative(PUBLIC, archivo));
        assert.doesNotMatch(contenido, /credentials\s*:\s*['"]omit['"]/,
            `${path.relative(PUBLIC, archivo)} no debe descartar las cookies del mismo origen`);
    }
    const transporte = fs.readFileSync(path.join(PUBLIC, 'js', 'transport.js'), 'utf8');
    assert.match(transporte, /global\.fetch\s*=\s*async function/,
        'el canal sigue usando fetch con las credenciales por defecto del mismo origen');
    assert.match(transporte, /nativeFetch\(input, init\)/,
        'las peticiones conservan las opciones y credenciales del navegador');
});

// ID personalizada del grupo: se normaliza mientras se escribe, se valida
// con las reglas DEL SERVIDOR y el enlace de vista previa se arma con el host
// real de la instalación (no con un dominio inventado).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { RE_ID, MIN, MAX, normalizarId, idValida, problemaId, rutaGrupo, enlaceCorto } = require('../../public/js/group-id.js');

const RAIZ = path.join(__dirname, '..', '..');
const leer = ruta => fs.readFileSync(path.join(RAIZ, ruta), 'utf8');

test('las reglas son las del servidor', () => {
    /* `src/shared/validation.js`: `[a-z0-9_-]{3,32}` y sin `g_`. Si allá
       cambian, aquí también (el cliente solo avisa antes de enviar). */
    assert.equal(RE_ID.source, String.raw`^[a-z0-9_-]{3,32}$`);
    assert.equal(MIN, 3);
    assert.equal(MAX, 32);
});

test('lo tecleado se normaliza: minúsculas, sin acentos ni símbolos', () => {
    assert.equal(normalizarId('Equipo QA'), 'equipoqa');
    assert.equal(normalizarId('Équipo-Ñ'), 'equipo-n');
    assert.equal(normalizarId('  Equipo_1  '), 'equipo_1');
    assert.equal(normalizarId('a'.repeat(50)), 'a'.repeat(MAX));
    assert.equal(normalizarId(null), '');
});

test('vacío es legal (el grupo se queda con su ID interna)', () => {
    assert.equal(idValida(''), false, 'no es una ID, pero no es un error');
    assert.equal(problemaId(''), '', 'sin texto no hay nada que avisar');
});

test('una ID válida no avisa de nada', () => {
    assert.equal(idValida('equipo-qa'), true);
    assert.equal(idValida('a_b-c9'), true);
    assert.equal(problemaId('equipo-qa'), '');
});

test('una ID corta o con prefijo reservado se explica', () => {
    assert.equal(idValida('ab'), false);
    assert.match(problemaId('ab'), /al menos 3/);
    assert.equal(idValida('g_interno'), false, 'el prefijo g_ es de los grupos internos');
    assert.match(problemaId('g_interno'), /g_/);
});

test('el enlace se arma con la ruta corta del grupo', () => {
    assert.equal(rutaGrupo('equipo-qa'), '/?open=group:equipo-qa');
    assert.equal(rutaGrupo('Equipo QA'), '/?open=group:equipoqa');
});

test('la vista previa usa el host que se le pase', () => {
    /* Zlapy corre en red local: el enlace real es el de esta instalación. */
    assert.equal(enlaceCorto('equipo', 'https://192.168.1.5:1820'), 'https://192.168.1.5:1820/?open=group:equipo');
    assert.equal(enlaceCorto('tu-id', 'http://localhost:1820'), 'http://localhost:1820/?open=group:tu-id');
});

test('sin host explícito se usa el origen de la página', () => {
    const anterior = globalThis.location;
    globalThis.location = { origin: 'https://zlapy.local:8443' };
    try {
        assert.equal(enlaceCorto('equipo'), 'https://zlapy.local:8443/?open=group:equipo');
    } finally {
        globalThis.location = anterior;
    }
});

test('el acordeón del grupo usa el host, no zlapy.app', () => {
    const html = leer('public/group-create.html');
    assert.match(html, /id="customIdDetails"/, 'la ID va en su propio acordeón');
    assert.match(html, /class="advanced id-advanced"/, 'plegada como «Privacidad y permisos»');
    assert.doesNotMatch(html, /zlapy\.app/, 'no queda un dominio inventado en el HTML');
    const js = leer('public/js/group-create.js');
    assert.match(js, /idApi\.enlaceCorto\(/, 'la vista previa sale del módulo (host real)');
    assert.doesNotMatch(js, /zlapy\.app/, 'ni en el JS');
});
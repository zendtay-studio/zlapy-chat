// Orden y contenido del inicio de Ajustes (la lista de secciones).
//
// La reorganización estilo WhatsApp separa el COMPORTAMIENTO del chat
// («Chats»: audios, ediciones, reacciones) del ASPECTO («Apariencia»: fondo,
// temas, colores y tamaño del texto). Este test lee `public/index.html` y
// comprueba que la lista, los títulos y las ramas de pintado siguen cuadrando:
// una fila sin rama sería una opción muerta, y el espejo de cámara volvería a
// colarse en «Chats» si alguien mueve el bloque sin querer.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const INDEX = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

/* Ids de la lista, en el orden en que se pintan. */
function hubOrder() {
    const block = INDEX.match(/const rows = \[\s*\n\s*\['perfil'([\s\S]*?)\n\s*\];/);
    assert.ok(block, 'el inicio de Ajustes conserva su lista `rows`');
    return ['perfil', ...[...block[1].matchAll(/\['([a-z]+)'/g)].map(m => m[1])];
}

test('el inicio de Ajustes va de la persona a los datos técnicos', () => {
    assert.deepEqual(hubOrder(), [
        'perfil', 'cuenta', 'priv', 'chats', 'apariencia',
        'notif', 'media', 'datos', 'version'
    ], 'orden: perfil → cuenta → privacidad → chats → apariencia → avisos → equipo → almacenamiento → técnico');
});

test('cada fila del inicio tiene su rama de pintado (ninguna opción muerta)', () => {
    const ramas = new Set([...INDEX.matchAll(/settingsSection === '([a-z]+)'/g)].map(m => m[1]));
    /* «perfil» abre el editor de perfil, que se integra como columna en
       escritorio; no necesita rama propia en este switch. */
    for (const id of hubOrder().filter(id => id !== 'perfil')) {
        assert.ok(ramas.has(id), `la fila «${id}» tiene contenido`);
    }
});

test('los títulos de la cabecera acompañan a los nombres nuevos', () => {
    const titles = INDEX.match(/perfil: 'Perfil', cuenta: 'Cuenta', priv: '([^']+)',[\s\S]*?datos: '([^']+)'/);
    assert.ok(titles, 'el mapa de títulos existe');
    assert.equal(titles[1], 'Privacidad y seguridad');
    assert.equal(titles[2], 'Datos y almacenamiento');
    assert.match(INDEX, /apariencia: 'Apariencia'/, '«Apariencia» tiene título propio');
});

test('Chats es comportamiento y Apariencia es aspecto', () => {
    const desde = INDEX.indexOf("if (settingsSection === 'chats') {");
    const hasta = INDEX.indexOf("if (settingsSection === 'media') {");
    assert.ok(desde > 0 && hasta > desde, 'las dos ramas existen y están en orden');
    const chats = INDEX.slice(desde, hasta);
    assert.doesNotMatch(chats, /swCamEspejo/, 'el espejo de cámara NO vive en Chats');
    assert.match(chats, /swAutoPlay/, 'Chats lleva el autoplay de audios');
    assert.match(chats, /swEditResalte/, 'Chats lleva el resalte de ediciones');
    assert.match(chats, /rxSlots/, 'Chats lleva las reacciones rápidas');

    const apariencia = INDEX.slice(INDEX.indexOf("if (settingsSection === 'apariencia') {"), desde);
    assert.match(apariencia, /chatAppearancePreview/, 'Apariencia lleva la vista previa');
    assert.match(apariencia, /id="chatFontSize"/, 'Apariencia lleva el tamaño del texto');
    assert.doesNotMatch(apariencia, /swAutoPlay/, 'el autoplay no se duplica en Apariencia');
});

test('el espejo de cámara está en Video y voz, con su cableado', () => {
    const desde = INDEX.indexOf("if (settingsSection === 'media') {");
    const hasta = INDEX.indexOf("if (settingsSection === 'notif') {");
    const media = INDEX.slice(desde, hasta);
    assert.match(media, /id="swCamEspejo"/, 'la fila del espejo está en Video y voz');
    assert.match(media, /espejo_llamada/, 'el interruptor guarda el ajuste');
    assert.match(media, /aplicarEspejoLlamada\(\)/, 'y lo aplica a la vista previa de la llamada');
});

// El chat y los paneles de información van enmarcados en escritorio: margen,
// radio 20 y sombra, como en Ajustes. El commit 728dc48 quitó ese marco para
// dejarlos a sangre; esta prueba evita que desaparezca otra vez sin querer.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const index = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const css = index.slice(index.indexOf('<style>'), index.indexOf('</style>'));

/* Solo el tramo de escritorio que maqueta el marco: desde el @media que
   contiene el topbar hasta el reinicio de :root.narrow. Así la prueba no se
   confunde con las reglas móviles, que sí van a sangre a propósito. */
const inicio = css.lastIndexOf('@media (min-width:769px) {', css.indexOf('#sidebar > .topbar'));
const fin = css.indexOf(':root.narrow #chat,', inicio);
assert.ok(inicio >= 0 && fin > inicio, 'existe el tramo de maquetación de escritorio');
const escritorio = css.slice(inicio, fin).replace(/\s+/g, ' ');

test('el chat conserva su carcasa: margen, radio 20 y sombra', () => {
    assert.match(escritorio, /#chat \{ margin: 10px 12px 10px 0; border: 0; border-radius: 20px; box-shadow: 0 12px 32px #0003 \}/);
});

test('contacto, grupo y stickers conservan la misma carcasa', () => {
    assert.match(escritorio, /#contactPanel\.on, #groupPanel\.on, #stickerCreatorLayer\.on \{ margin-block: 10px; border: 0; border-radius: 20px; box-shadow: 0 12px 32px #0003 \}/);
    for (const panel of ['#contactPanel.on', '#groupPanel.on', '#stickerCreatorLayer.on']) {
        assert.ok(escritorio.includes(`${panel} { margin-left: 0; margin-right: 12px }`), `${panel} deja su margen exterior`);
    }
});

test('al abrir un panel el chat no queda pegado al borde de la ventana', () => {
    assert.match(escritorio, /#chat:has\(~ #contactPanel\.on\), #chat:has\(~ #groupPanel\.on\), #chat:has\(~ #stickerCreatorLayer\.on\) \{ margin-right: 8px \}/);
});

test('el marco es solo de escritorio: en móvil se reinicia a sangre', () => {
    const movil = css.slice(css.indexOf(':root.narrow #chat,')).replace(/\s+/g, ' ');
    assert.match(movil, /margin: 0; border: 0; border-radius: 0; box-shadow: none/);
});

test('restaurar el marco no reintroduce el desborde del panel de contacto', () => {
    /* 68c522e quitó el width pelado de .cpInner en este @media porque entre
       769 y 1024 px se salía 80 px del panel. No se restaura con el marco. */
    assert.doesNotMatch(escritorio, /#contactPanel \.cpInner \{ width: var\(--info-width, 400px\) \}/);
    assert.match(escritorio, /#groupPanel \.gpInner \{ width: min\(var\(--info-width, 400px\), 320px\) \}/);
});
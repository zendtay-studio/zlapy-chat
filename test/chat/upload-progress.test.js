// Regresión de la burbuja de progreso al enviar un collage (varias fotos).
//
// Las fotos sueltas, los vídeos y las notas de voz muestran una burbuja
// temporal con el avance de la subida. El collage se enviaba con `fetch` y
// sin burbuja, así que no daba ninguna señal mientras preparaba y subía las
// imágenes. Ahora usa el mismo camino que el resto de medios.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

test('el collage muestra una burbuja de subida con progreso', () => {
    const bloque = CLIENT.slice(CLIENT.indexOf('async function sendImageGallery'));
    const fin = bloque.indexOf('async function sendDraft');
    const cuerpo = fin > 0 ? bloque.slice(0, fin) : bloque;
    assert.ok(cuerpo.length > 0, 'debe existir sendImageGallery');

    assert.match(cuerpo, /insertConversationMessage\(mediaKey, temp\)/,
        'la burbuja aparece de inmediato en la conversación');
    assert.match(cuerpo, /uploadState: 'preparing'/,
        'la burbuja informa mientras se comprimen y preparan las fotos');
    assert.equal((cuerpo.match(/xhrPost\(/g) || []).length, 2,
        'el envío directo y el de grupo usan XHR para poder medir la subida');
    assert.equal((cuerpo.match(/setUploadProgress\(temp, progress\)/g) || []).length, 2,
        'ambos envíos actualizan el progreso de la burbuja');
    assert.match(cuerpo, /removeTemp\(\)/,
        'la burbuja temporal se retira cuando el collage ya se envió');
});

// La fecha flotante (la píldora con el día que se está leyendo) solo aparece
// al desplazarse HACIA ARRIBA, es decir, adentrándose en el pasado. En cuanto
// se baja hacia lo reciente se esconde: ahí los mensajes son de hoy y la
// píldora solo estorba.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { haciaArriba } = require('../../public/js/fecha-flotante.js');

const RAIZ = path.join(__dirname, '..', '..');
const leer = ruta => fs.readFileSync(path.join(RAIZ, ruta), 'utf8');

test('subir sí muestra la fecha flotante', () => {
    assert.equal(haciaArriba(300, 100), true, 'retroceder hacia el pasado la pinta');
    assert.equal(haciaArriba(1, 0), true, 'un píxel ya cuenta como subir');
});

test('bajar la esconde: no se vuelve a pintar', () => {
    assert.equal(haciaArriba(100, 300), false, 'ir hacia abajo no la pinta');
    assert.equal(haciaArriba(100, 100), false, 'quedarse quieto tampoco');
});

test('sin posición anterior no se inventa una dirección', () => {
    /* `null` es el estado tras abrir el chat o tras un recolocamiento
       programático (cargar mensajes antiguos): no hay dirección que
       interpretar, así que la píldora se queda fuera. */
    assert.equal(haciaArriba(null, 100), false);
    assert.equal(haciaArriba(undefined, 100), false);
});

test('index.html compara la dirección y la esconde al bajar', () => {
    const index = leer('public/index.html');
    assert.match(index, /<script src="\/js\/fecha-flotante\.js"><\/script>/, 'la página carga el módulo');
    assert.match(index, /fechaFlotTop = box\.scrollTop;/, 'se guarda la posición anterior');
    assert.match(index, /if \(!window\.ZlapyFechaFlotante\.haciaArriba\(previo, box\.scrollTop\)\) \{ ocultarFechaFlotante\(\); return; \}/,
        'al no subir se esconde en vez de repintar');
    assert.doesNotMatch(index, /haciaAbajo/, 'no queda la dirección invertida');
    assert.match(leer('public/js/sw.js'), /'\/js\/fecha-flotante\.js'/, 'el módulo viaja en el shell offline');
});

test('ir al fondo marca la referencia de dirección', () => {
    /* Abrir un chat o recibir un mensaje manda la lista al fondo: sin marcar
       esa posición, el primer gesto del usuario se compararía contra un 0 y
       la píldora podría aparecer al ir hacia abajo. */
    const index = leer('public/index.html');
    assert.match(index, /fechaFlotTop = el\.scrollTop;/, 'el scroll al fondo fija la referencia');
});
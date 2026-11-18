// Fila de historias: primero los contactos, luego las ajenas por tandas.
// La lógica vive en `public/js/story-row.js` para poder probarla sin
// navegador; el pintado (HTML y avatares) se queda en `index.html`.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { PAGE, layout, page } = require('../../public/js/story-row.js');

const RAIZ = path.join(__dirname, '..', '..');
const leer = ruta => fs.readFileSync(path.join(RAIZ, ruta), 'utf8');
const historia = (from, ts) => ({ from, ts, kind: 'text', text: 'hola' });

test('las historias de los contactos van antes que las del servidor', () => {
    /* La ajena es más reciente y aun así va después: el orden no es solo
       «lo nuevo primero», es «mis contactos primero». */
    const reparto = layout({
        stories: [historia('ajena', 900), historia('ana', 100)],
        contacts: [{ username: 'ana' }],
        me: 'yo'
    });
    assert.deepEqual(reparto.contacts, ['ana']);
    assert.deepEqual(reparto.server, ['ajena']);
});

test('dentro de cada tramo, primero lo no visto y luego por nombre', () => {
    const reparto = layout({
        stories: [historia('ana', 100), historia('beto', 200), historia('celia', 300)],
        contacts: ['ana', 'beto', 'celia'],
        me: 'yo',
        seen: { ana: 100 } // ana ya vista; beto y celia no
    });
    assert.deepEqual(reparto.contacts, ['beto', 'celia', 'ana']);
    assert.deepEqual({ ...reparto.freshByUser }, { ana: 0, beto: 1, celia: 1 });
});

test('las historias propias no se mezclan con contactos ni con ajenas', () => {
    const reparto = layout({
        stories: [historia('yo', 100), historia('ana', 100)],
        contacts: ['yo', 'ana'],
        me: 'yo'
    });
    assert.equal(reparto.mine.length, 1);
    assert.deepEqual(reparto.contacts, ['ana']);
    assert.deepEqual(reparto.server, []);
});

test('acepta contactos como nombres sueltos o como objetos', () => {
    const reparto = layout({
        stories: [historia('ana', 100), historia('beto', 100), historia('zoe', 100)],
        contacts: ['ana', { username: 'beto' }, null, {}],
        me: 'yo'
    });
    assert.deepEqual(reparto.contacts, ['ana', 'beto']);
    assert.deepEqual(reparto.server, ['zoe']);
});

test('un `Set` de contactos sirve igual que la lista', () => {
    /* `index.html` recuerda los contactos en un Set para que el filtro del
       buscador no reclasifique a nadie. */
    const reparto = layout({
        stories: [historia('ana', 100), historia('zoe', 100)],
        contacts: new Set(['ana']),
        me: 'yo'
    });
    assert.deepEqual(reparto.contacts, ['ana']);
    assert.deepEqual(reparto.server, ['zoe']);
});

test('las entradas inválidas no inventan usuarios', () => {
    const reparto = layout({
        stories: [null, {}, { from: '' }, { from: 'ana', ts: 5 }],
        contacts: null,
        me: 'yo',
        seen: null
    });
    assert.deepEqual(reparto.contacts, []);
    assert.deepEqual(reparto.server, ['ana']);
    assert.deepEqual(reparto.mine, []);
});

test('las ajenas se sirven por tandas y el resto queda oculto', () => {
    const ajenas = Array.from({ length: 20 }, (_, i) => `u${String(i).padStart(2, '0')}`);
    const primera = page(ajenas, 0);
    assert.equal(primera.visible.length, PAGE);
    assert.equal(primera.hidden, 20 - PAGE);
    assert.deepEqual(primera.visible, ajenas.slice(0, PAGE));

    const segunda = page(ajenas, PAGE);
    assert.equal(segunda.visible.length, PAGE * 2);
    assert.equal(segunda.hidden, 20 - PAGE * 2);

    const todas = page(ajenas, PAGE * 10);
    assert.deepEqual(todas.visible, ajenas);
    assert.equal(todas.hidden, 0);
});

test('sin historias ajenas no hay «+» que enseñar', () => {
    const tanda = page([], 0);
    assert.deepEqual(tanda.visible, []);
    assert.equal(tanda.hidden, 0);
});

test('index.html pinta contactos enteros y pagina solo las ajenas', () => {
    const index = leer('public/index.html');
    assert.match(index, /<script src="\/js\/story-row\.js"><\/script>/, 'la página carga el módulo');
    assert.match(index, /window\.ZlapyStoryRow\.layout\(\{/, 'el reparto sale del módulo');
    assert.match(index, /window\.ZlapyStoryRow\.page\(reparto\.server, storiesRowExtra\)/, 'solo se pagina la lista ajena');
    assert.match(index, /function showMoreStories\(\)/, 'el «+» carga otra tanda');
    assert.match(index, /class="storyAv more"/, 'la tanda siguiente tiene su botón al final');
    assert.match(leer('public/js/sw.js'), /'\/js\/story-row\.js'/, 'el módulo viaja en el shell offline');
});

test('convive con los otros scripts CLÁSICOS de la página', () => {
    /* Mismo motivo que en presence.js: los <script> sin `type=module`
       comparten el ámbito léxico global. Un `const` repetido dejaría la API
       sin instalar y la fila de historias reventaría. */
    const contexto = vm.createContext({ window: {} });
    for (const nombre of ['system-messages.js', 'presence.js', 'story-row.js']) {
        assert.doesNotThrow(
            () => vm.runInContext(leer(`public/js/${nombre}`), contexto, { filename: nombre }),
            `${nombre} se carga sin chocar con los anteriores`
        );
    }
    assert.equal(typeof contexto.window.ZlapyStoryRow.layout, 'function');
    assert.equal(typeof contexto.window.ZlapyPresence.lastSeenLabel, 'function');
    assert.equal(typeof contexto.window.ZlapySystemLabels.systemDayLabel, 'function');
});

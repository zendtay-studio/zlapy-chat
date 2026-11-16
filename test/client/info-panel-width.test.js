// Ancho de los paneles de información (#contactPanel y #groupPanel): el
// contenido (.cpInner / .gpInner) NUNCA puede medir más que su panel.
// El bug que motivó este test: entre 769 y 1024 px el panel se recortaba a
// 320 px, pero una regla dentro de `@media (min-width: 769px)` le devolvía
// 400 px al contenido, así que se salía 80 px por la derecha.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const index = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const css = index.slice(index.indexOf('<style>'), index.indexOf('</style>'));

/* Escáner lineal de bloques: devuelve { selector, condicion, cuerpo } para
   cada regla de primer nivel y las anidadas, con la pila de condiciones. */
function reglasCSS(texto) {
    const salida = [];
    const pila = [];
    let inicio = 0;
    for (let i = 0; i < texto.length; i++) {
        if (texto[i] === '{') {
            const cabecera = texto.slice(inicio, i).trim();
            pila.push(cabecera);
            inicio = i + 1;
        } else if (texto[i] === '}') {
            const cuerpo = texto.slice(inicio, i).trim();
            const cabecera = pila.pop() || '';
            const condiciones = pila.filter(c => /@media|@supports/.test(c));
            if (!/@media|@supports|@keyframes|@font-face|@layer|@property/.test(cabecera))
                salida.push({
                    selector: cabecera,
                    condicion: condiciones.join(' y '),
                    cuerpo
                });
            inicio = i + 1;
        }
    }
    return salida;
}

const deAncho = reglasCSS(css).filter(r => /\.cpInner|\.gpInner/.test(r.selector))
    .map(r => ({ ...r, width: (/(?:^|;)\s*width\s*:\s*([^;]+)/.exec(r.cuerpo) || [])[1] }))
    .filter(r => r.width);

test('el ancho del contenido se declara con el recorte, no con el ancho pelado', () => {
    assert.ok(deAncho.length >= 4, `se esperaban varias reglas de ancho, hay ${deAncho.length}`);
    for (const regla of deAncho) {
        /* Dentro de un medio de ancho MÍNIMO (≥769px) un ancho pelado es la
           firma del bug: pisa el recorte de ≤1024px y desborda el panel. */
        if (/min-width: *769px/.test(regla.condicion))
            assert.match(regla.width, /^min\(/,
                `${regla.selector} dentro de «${regla.condicion}» mide ${regla.width}`);
    }
});

test('los dos paneles se recortan igual en pantallas estrechas', () => {
    const recorte = deAncho.filter(r => /max-width: *1024px/.test(r.condicion));
    assert.equal(recorte.length, 2, 'contacto y grupo deben recortarse los dos');
    assert.deepEqual(new Set(recorte.map(r => r.width.trim())),
        new Set(['min(var(--info-width, 400px), 320px)']));
});

test('la versión móvil estira el contenido al panel completo', () => {
    const movil = deAncho.filter(r => /max-width: *768px/.test(r.condicion));
    assert.ok(movil.length >= 2, 'en móvil el contenido ocupa el panel entero');
    for (const regla of movil) assert.equal(regla.width.trim(), '100%');
});
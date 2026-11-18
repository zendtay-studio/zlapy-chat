// Escalera de la última conexión («Ult. vez…»). Vive en public/js/presence.js
// y la comparten el chat, la creación de grupos, los detalles del grupo y la
// vista de perfil: un solo texto que mantener.
//
// El «ahora» se inyecta, así que la medianoche y los escalones se fijan sin
// depender del reloj de la máquina (y sin depender del idioma del navegador:
// la hora se compara con la MISMA llamada a toLocaleTimeString).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { lastSeenLabel, MUCHO_TIEMPO } = require('../../public/js/presence.js');

/* Ahora las 12:00 del 17 de junio de 2026 (huso local de la máquina). */
const AHORA = new Date(2026, 5, 17, 12, 0, 0);
const aLas = (dia, hora, min = 0, mes = 5) => new Date(2026, mes, dia, hora, min, 0).getTime();
const hora = fecha => fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

test('hoy y ayer conservan la HORA exacta', () => {
    assert.equal(lastSeenLabel(aLas(17, 9, 5), AHORA), `Ult. vez hoy a las ${hora(new Date(2026, 5, 17, 9, 5))}`);
    assert.equal(lastSeenLabel(aLas(16, 22, 40), AHORA), `Ult. vez ayer a las ${hora(new Date(2026, 5, 16, 22, 40))}`);
});

test('de 2 a 6 días se dice «recientemente»', () => {
    for (const dia of [15, 14, 11]) {
        assert.equal(lastSeenLabel(aLas(dia, 9), AHORA), 'Ult. vez recientemente', `el día ${dia}`);
    }
});

test('de 7 a 34 días se dice «hace unas semanas»', () => {
    for (const dia of [10, 1, 20]) {
        const marca = dia === 20
            ? new Date(2026, 4, 28, 9).getTime()   // 28 de mayo: 20 días
            : aLas(dia, 9);
        assert.equal(lastSeenLabel(marca, AHORA), 'Ult. vez hace unas semanas',
            `la marca ${new Date(marca).toDateString()}`);
    }
});

test('a partir de 35 días se dice «hace mucho tiempo»', () => {
    const viejo = new Date(2026, 3, 20, 9).getTime(); // 20 de abril: 58 días
    assert.equal(lastSeenLabel(viejo, AHORA), 'Ult. vez hace mucho tiempo');
    assert.equal(lastSeenLabel(viejo, AHORA), MUCHO_TIEMPO, 'la constante es la que usa el chat con la presencia oculta');
    assert.equal(lastSeenLabel(new Date(2024, 0, 1).getTime(), AHORA), MUCHO_TIEMPO, 'un año también es mucho tiempo');
});

test('una marca inválida no inventa una frase', () => {
    assert.equal(lastSeenLabel(null, AHORA), '');
    assert.equal(lastSeenLabel(undefined, AHORA), '');
    assert.equal(lastSeenLabel('no-es-fecha', AHORA), '');
});

test('una marca en el futuro (reloj desajustado) se trata como hoy', () => {
    const manana = new Date(2026, 5, 18, 10, 15).getTime();
    assert.equal(lastSeenLabel(manana, AHORA), `Ult. vez hoy a las ${hora(new Date(manana))}`);
});

test('el escalón cambia a medianoche, no 24 h después', () => {
    /* 23:59 de ayer y 00:01 de hoy son días distintos aunque solo disten 2
       minutos: el primero es «ayer» y el segundo «hoy». */
    assert.match(lastSeenLabel(new Date(2026, 5, 16, 23, 59).getTime(), AHORA), /^Ult\. vez ayer a las /);
    assert.match(lastSeenLabel(new Date(2026, 5, 17, 0, 1).getTime(), AHORA), /^Ult\. vez hoy a las /);
});

test('la frase va abreviada: «Ult. vez», no el «Última vez» completo', () => {
    /* La lista de chats es estrecha y el subtítulo tiene que caber: la
       abreviatura es deliberada, en TODOS los escalones. */
    for (const marca of [aLas(17, 9), aLas(16, 9), aLas(15, 9), aLas(10, 9), new Date(2026, 0, 1).getTime()]) {
        assert.match(lastSeenLabel(marca, AHORA), /^Ult\. vez /);
        assert.doesNotMatch(lastSeenLabel(marca, AHORA), /^Última vez /);
    }
    assert.match(MUCHO_TIEMPO, /^Ult\. vez /);
});

test('convive con system-messages.js: los dos se cargan como scripts CLÁSICOS', () => {
    /* En el navegador cada <script> sin `type=module` comparte el ámbito
       léxico global: si los dos declaran `const DIA_MS`, el segundo lanza
       «Identifier has already been declared» y su API nunca se instala. Ese
       fue el fallo real que dejó la lista de chats sin contactos. El IIFE de
       presence.js lo evita; aquí se ejecuta la misma secuencia del HTML. */
    const contexto = vm.createContext({ window: {} });
    const leer = nombre => fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', nombre), 'utf8');
    vm.runInContext(leer('system-messages.js'), contexto, { filename: 'system-messages.js' });
    assert.doesNotThrow(
        () => vm.runInContext(leer('presence.js'), contexto, { filename: 'presence.js' }),
        'presence.js puede declarar sus propias constantes sin chocar'
    );
    assert.equal(typeof contexto.window.ZlapyPresence.lastSeenLabel, 'function', 'la API del chat queda instalada');
    assert.equal(typeof contexto.window.ZlapySystemLabels.systemDayLabel, 'function', 'la de los mensajes del sistema sigue viva');
});

// Etiquetas y lista de pintado de los mensajes del sistema (Hoy / Ayer /
// Antier / día de la semana / fecha real) y los separadores por cambio de día.
//
// La lógica es pura y vive en public/js/system-messages.js: el "ahora" se
// inyecta, así que la medianoche se puede fijar sin depender del reloj.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { dayKey, systemDayLabel, buildRenderList, unreadLabel } = require('../../public/js/system-messages.js');

/* Ahora las 12:00 del 17 de junio de 2026 (huso local de la máquina). */
const AHORA = new Date(2026, 5, 17, 12, 0, 0);
const at = (dia, hora = 12, min = 0) => new Date(2026, 5, dia, hora, min, 0).getTime();
const idSeparador = ts => 'day-' + dayKey(ts);

test('el separador es Hoy / Ayer / Antier con el día natural LOCAL', () => {
    assert.equal(systemDayLabel(at(17, 0, 1), AHORA), 'Hoy', 'a las 00:01 ya es «hoy»');
    assert.equal(systemDayLabel(at(17, 23, 59), AHORA), 'Hoy');
    assert.equal(systemDayLabel(at(16, 23, 59), AHORA), 'Ayer');
    assert.equal(systemDayLabel(at(15, 12), AHORA), 'Antier');
    /* Anteriores: la FECHA REAL. Se compara por forma y no por texto: el
       idioma lo pone el navegador (en la prueba corre el de la máquina). */
    const junio = systemDayLabel(new Date(2026, 4, 3, 9).getTime(), AHORA);
    assert.match(junio, /3/, 'lleva el día');
    assert.doesNotMatch(junio, /2026/, 'el año no se repite si es el vigente');
    const otroAnio = systemDayLabel(new Date(2024, 0, 2, 9).getTime(), AHORA);
    assert.match(otroAnio, /2024/, 'de otro año sí se muestra');
});

test('del tercer día al sexto se dice el DÍA DE LA SEMANA; al séptimo, la fecha', () => {
    /* AHORA es el 17 de junio de 2026: 3→6 días atrás son el 14, 13, 12 y 11
       (domingo a jueves), y el 10 ya repite el nombre de la semana pasada. */
    for (const dia of [14, 13, 12, 11]) {
        const fecha = new Date(2026, 5, dia, 9);
        const nombre = fecha.toLocaleDateString([], { weekday: 'long' });
        assert.equal(systemDayLabel(fecha.getTime(), AHORA),
            nombre[0].toLocaleUpperCase() + nombre.slice(1), `el día ${dia} es su día de la semana`);
    }
    const haceUnaSemana = new Date(2026, 5, 10, 9);
    assert.equal(systemDayLabel(haceUnaSemana.getTime(), AHORA),
        haceUnaSemana.toLocaleDateString([], { day: 'numeric', month: 'long' }),
        'a los siete días vuelve la fecha');
});

test('la escalera aguanta el cambio de año', () => {
    const enero = new Date(2026, 0, 2, 12, 0, 0);  // 2 de enero de 2026
    const finDeAnio = new Date(2025, 11, 30, 9);   // 30 de diciembre: 3 días
    assert.equal(systemDayLabel(new Date(2026, 0, 1, 9).getTime(), enero), 'Ayer');
    assert.equal(systemDayLabel(new Date(2025, 11, 31, 9).getTime(), enero), 'Antier');
    const nombre = finDeAnio.toLocaleDateString([], { weekday: 'long' });
    assert.equal(systemDayLabel(finDeAnio.getTime(), enero),
        nombre[0].toLocaleUpperCase() + nombre.slice(1), 'sigue mandando el día de la semana');
    const viejo = new Date(2025, 11, 20, 9);
    assert.match(systemDayLabel(viejo.getTime(), enero), /2025/, 'de otro año se muestra el año');
});

test('la medianoche es local: 23:59 y 00:01 son días distintos', () => {
    assert.notEqual(dayKey(at(16, 23, 59)), dayKey(at(17, 0, 1)));
    assert.equal(systemDayLabel(at(16, 23, 59), AHORA), 'Ayer');
    assert.equal(systemDayLabel(at(17, 0, 1), AHORA), 'Hoy', 'al cruzar las 00:00 pasa a «Hoy» solo');
});

test('la lista de pintado inserta un separador en cada cambio de día', () => {
    const m1 = { id: 'm1', kind: 'text', ts: at(1, 8) };    // 1 de junio
    const m2 = { id: 'm2', kind: 'text', ts: at(16, 11) };  // ayer
    const m3 = { id: 'm3', kind: 'text', ts: at(16, 23) };  // ayer
    const m4 = { id: 'm4', kind: 'text', ts: at(17, 9) };   // hoy
    const m5 = { id: 'm5', kind: 'text', ts: at(17, 10) };  // hoy
    /* La lista sale de más antiguo a más nuevo, como se pinta el chat. */
    const lista = buildRenderList([m5, m4, m3, m2, m1], [], AHORA);
    assert.deepEqual(lista.map(m => m.kind),
        ['system', 'text', 'system', 'text', 'text', 'system', 'text', 'text']);
    assert.deepEqual(lista.map(m => m.id || m.text),
        ['day-' + dayKey(at(1, 8)), 'm1',
            'day-' + dayKey(at(16, 11)), 'm2', 'm3',
            'day-' + dayKey(at(17, 9)), 'm4', 'm5']);
    /* Etiqueta de cada separador, en orden: fecha real, «Ayer», «Hoy».
       Un solo separador por día aunque los mensajes se repitan. */
    assert.deepEqual(lista.filter(m => m.kind === 'system').map(m => m.text),
        [systemDayLabel(at(1, 8), AHORA), 'Ayer', 'Hoy']);
    // El separador hereda la marca de tiempo del primer mensaje del día.
    assert.equal(lista[2].ts, at(16, 11), 'el de «Ayer» lleva la hora del primero del día');
});

test('los avisos de la sesión se mezclan por hora y sin separador delante', () => {
    const mensajes = [{ id: 'm1', kind: 'text', ts: at(16, 9) }];
    const avisos = [
        { id: 'sys-bloqueo', kind: 'system', text: 'Has bloqueado a x.', ts: at(16, 10) },
        { id: 'sys-clave', kind: 'system', text: 'El código de seguridad cambió.', ts: at(17, 9) }
    ];
    const lista = buildRenderList(mensajes, avisos, AHORA);
    assert.deepEqual(lista.map(m => m.id || m.text),
        ['day-' + dayKey(at(16, 9)), 'm1', 'sys-bloqueo', 'sys-clave']);
    assert.equal(lista[2].id, 'sys-bloqueo', 'el aviso cae donde toca por su hora, sin separador delante');
});

test('sin mensajes ni avisos, nada que pintar (se queda la lista tal cual)', () => {
    assert.deepEqual(buildRenderList([], [], AHORA), []);
    // Solo avisos: se pintan, sin separador (no hay mensaje que los preceda).
    const soloAvisos = buildRenderList([], [{ id: 'sys-1', kind: 'system', text: 'Has bloqueado a x.', ts: at(17, 9) }], AHORA);
    assert.equal(soloAvisos.length, 1);
    assert.equal(soloAvisos[0].text, 'Has bloqueado a x.');
});

test('el contador de no leídos singulariza y pluraliza', () => {
    assert.equal(unreadLabel(0), '');
    assert.equal(unreadLabel(1), '1 mensaje no leído');
    assert.equal(unreadLabel(2), '2 mensajes no leídos');
    assert.equal(unreadLabel(37), '37 mensajes no leídos');
});

test('el separador de no leídos va ANCLADO al primer mensaje pendiente', () => {
    const leido = { id: 'm1', kind: 'text', ts: at(16, 23) };
    const primeroPendiente = { id: 'm2', kind: 'text', ts: at(17, 9) };
    const segundoPendiente = { id: 'm3', kind: 'text', ts: at(17, 10) };
    const aviso = { id: 'unread-ana', kind: 'system', text: '2 mensajes no leídos', ts: at(17, 9), beforeId: 'm2' };
    const lista = buildRenderList([leido, primeroPendiente, segundoPendiente], [aviso], AHORA);
    // Va JUSTO DELANTE del primero pendiente, no al final por su fecha.
    assert.deepEqual(lista.map(m => m.id || m.text),
        ['day-' + dayKey(at(16, 23)), 'm1',
            'day-' + dayKey(at(17, 9)), 'unread-ana', 'm2', 'm3']);
    // Si el mensaje ancla ya no está (borrado), el aviso sigue pintándose.
    const sinAncla = buildRenderList([leido, segundoPendiente], [aviso], AHORA);
    assert.ok(sinAncla.some(m => m.id === 'unread-ana'), 'un aviso huérfanno no se pierde');
});

test('reabrir sin pendientes no deja rastro del contador', () => {
    // Es lo que hace el cliente: si no hay pendientes, quita el ancla.
    const aviso = { id: 'unread-ana', kind: 'system', text: '2 mensajes no leídos', ts: at(17, 9), beforeId: 'm2' };
    const sinPendientes = buildRenderList([{ id: 'm1', kind: 'text', ts: at(16, 23) }], [], AHORA);
    assert.equal(sinPendientes.some(m => m.id === 'unread-ana'), false);
    assert.equal(aviso.beforeId, 'm2');
});
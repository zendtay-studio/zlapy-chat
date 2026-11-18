/* Etiquetas y lista de pintado de los MENSAJES DEL SISTEMA.
 *
 * Vive en su propio fichero (y no inline en index.html) por una razón:
 * esta lógica es PURA — fecha y mensajes entran, texto y lista salen —, así
 * que se puede probar en Node sin navegador ni servidor, con un "ahora"
 * inyectado para fijar la medianoche. El cliente la usa desde
 * `window.ZlapySystemLabels`.
 *
 * Reglas (estilo WhatsApp):
 *   - separador: «Hoy», «Ayer», «Antier» o la fecha real, comparando el día
 *     NATURAL LOCAL de cada mensaje con el del anterior;
 *   - siempre con la zona horaria del usuario (el `Date` del navegador ya
 *     corre en ella: nada que configurar).
 */
'use strict';

const DIA_MS = 86400000;

/* Medianoche LOCAL de una fecha: recorta la hora, no resta 24 h (con el
   cambio de hora de octubre/marzo, restar horas daría el día equivocado). */
const medianoche = fecha => new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()).getTime();

/* Clave del día natural local: dos marcas del mismo día comparten clave
   aunque estén a distinta hora o en distinto huso que el servidor. */
const dayKey = ts => {
    const fecha = new Date(ts);
    return Number.isFinite(fecha.getTime())
        ? `${fecha.getFullYear()}-${fecha.getMonth()}-${fecha.getDate()}`
        : '';
};

function systemDayLabel(ts, ahora = new Date()) {
    const dia = new Date(ts);
    if (!Number.isFinite(dia.getTime())) return '';
    const atras = Math.round((medianoche(ahora) - medianoche(dia)) / DIA_MS);
    if (atras === 0) return 'Hoy';
    if (atras === 1) return 'Ayer';
    if (atras === 2) return 'Antier';
    const opciones = { day: 'numeric', month: 'long' };
    if (dia.getFullYear() !== ahora.getFullYear()) opciones.year = 'numeric';
    return dia.toLocaleDateString([], opciones);
}

/* Lista de pintado: los mensajes de la conversación MÁS los avisos de la
   sesión (bloqueo, cambio de clave), ordenados por tiempo, con un separador
   delante de cada cambio de día.
   Un aviso puede ir ANCLADO a un mensaje (`beforeId`): se pinta justo
   delante de él. Así se coloca el de «N mensajes no leídos», que marca el
   límite entre lo ya leído y lo pendiente sin depender de las fechas. */
function buildRenderList(messages, events = [], ahora = new Date()) {
    const reales = Array.isArray(messages) ? messages : [];
    const avisos = Array.isArray(events) ? events : [];
    if (!reales.length && !avisos.length) return reales;
    const anclados = new Map();
    for (const ev of avisos) if (ev && ev.beforeId) anclados.set(ev.beforeId, ev);
    const lista = [];
    let diaPrevio = null;
    for (const m of [...reales, ...avisos.filter(e => !e.beforeId)].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
        if (m.kind === 'system') { lista.push(m); continue; }
        const clave = dayKey(m.ts);
        if (clave && clave !== diaPrevio) {
            diaPrevio = clave;
            lista.push({ id: 'day-' + clave, kind: 'system', text: systemDayLabel(m.ts, ahora), ts: m.ts });
        }
        if (anclados.has(m.id)) lista.push(anclados.get(m.id));
        lista.push(m);
    }
    // Anclados cuyo mensaje ya no está (borrado mientras tanto): al final.
    for (const ev of anclados.values()) if (!lista.includes(ev)) lista.push(ev);
    return lista;
}

/* Texto del separador de no leídos: «1 mensaje no leído» / «N mensajes no
   leídos». */
function unreadLabel(count) {
    const n = Number(count) || 0;
    if (n <= 0) return '';
    return n === 1 ? '1 mensaje no leído' : `${n} mensajes no leídos`;
}

const api = { dayKey, systemDayLabel, buildRenderList, unreadLabel };
if (typeof window === 'object' && window) window.ZlapySystemLabels = api;
if (typeof module === 'object' && module.exports) module.exports = api;
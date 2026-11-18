/* Texto de la ÚLTIMA CONEXIÓN («Ult. vez…»), en un solo sitio.
 *
 * Vive aparte (y no repetido en index.html, group-create.js y
 * group-details.js) porque las tres pantallas enseñaban la misma escalera y
 * cualquier retoque de texto había que hacerlo tres veces. Aquí es pura:
 * una marca de tiempo y un «ahora» inyectable entran, una frase sale; así se
 * puede probar en Node sin navegador ni servidor.
 *
 * Escalera:
 *   · hoy        → «Ult. vez hoy a las 10:42»   (la hora exacta es útil)
 *   · ayer       → «Ult. vez ayer a las 10:42»
 *   · 2–6 días   → «Ult. vez recientemente»
 *   · 7–34 días  → «Ult. vez hace unas semanas»
 *   · 35+ días   → «Ult. vez hace mucho tiempo»
 *
 * Sin marca (oculta por privacidad o nunca conectado) no hay nada que
 * calcular: cada pantalla decide su respaldo, que en el chat es
 * «Ult. vez hace mucho tiempo» (constante MUCHO_TIEMPO).
 *
 * Va dentro de un IIFE a propósito: es un <script> CLÁSICO y sus `const`
 * compartirían el ámbito léxico global con los de `system-messages.js`
 * (`DIA_MS`, `medianoche`, `api`). Sin el envoltorio, el segundo script de la
 * página no llega a ejecutarse (SyntaxError: Identifier already declared) y
 * `window.ZlapyPresence` nunca existe.
 */
(() => {
    'use strict';

    const DIA_MS = 86400000;

    /* Frase para quien no comparte su última conexión: no se puede ser más
       preciso sin inventar, y el «hace mucho tiempo» no filtra nada. */
    const MUCHO_TIEMPO = 'Ult. vez hace mucho tiempo';

    /* El día NATURAL local, recortado por calendario (no restando 24 h: con
       el cambio de hora, restar horas daría el día equivocado). */
    const medianoche = fecha => new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()).getTime();

    /**
     * Frase de última conexión para una marca de tiempo.
     *
     * @param {number|string|Date} lastSeen
     * @param {Date} [ahora] se inyecta en las pruebas para fijar la medianoche
     * @returns {string} la frase, o '' si la marca no es una fecha válida
     */
    function lastSeenLabel(lastSeen, ahora = new Date()) {
        /* `new Date(null)` es la época (1970), no una fecha inválida: sin este
           guardo, un perfil sin presencia acabaría diciendo «hace mucho tiempo»
           como si fuera un dato real. */
        if (lastSeen == null || lastSeen === '') return '';
        const fecha = new Date(lastSeen);
        if (!Number.isFinite(fecha.getTime())) return '';
        const time = fecha.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const daysAgo = Math.round((medianoche(ahora) - medianoche(fecha)) / DIA_MS);
        /* Una marca en el futuro (reloj desajustado) se trata como «hoy»: no
           tiene sentido decir que alguien se conectó «mañana». */
        if (daysAgo <= 0) return `Ult. vez hoy a las ${time}`;
        if (daysAgo === 1) return `Ult. vez ayer a las ${time}`;
        if (daysAgo < 7) return 'Ult. vez recientemente';
        if (daysAgo < 35) return 'Ult. vez hace unas semanas';
        return MUCHO_TIEMPO;
    }

    const api = { lastSeenLabel, MUCHO_TIEMPO };
    if (typeof window === 'object' && window) window.ZlapyPresence = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})();

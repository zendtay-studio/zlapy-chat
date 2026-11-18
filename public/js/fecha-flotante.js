/* Dirección del desplazamiento de la lista de mensajes.
 *
 * La fecha flotante (la píldora que dice qué día se está leyendo) solo sale
 * cuando el usuario va HACIA ARRIBA, es decir, adentrándose en el pasado. Al
 * bajar hacia lo reciente la píldora estorba: justo ahí no hace falta, los
 * mensajes recientes son de hoy, así que se esconde en cuanto se baja.
 *
 * Se compara la posición ANTERIOR con la actual: si no hay anterior (chat
 * recién abierto, o recolocamiento programático tras cargar mensajes viejos)
 * no hay dirección que interpretar y no se muestra nada.
 *
 * Va dentro de un IIFE porque es un <script> CLÁSICO y no debe compartir
 * `const` con los otros scripts de la página.
 */
(() => {
    'use strict';

    /**
     * ¿El desplazamiento va hacia arriba (hacia el pasado)?
     *
     * @param {number|null} previo altura de scroll anterior (`null` = se
     *   acaba de abrir el chat o el scroll lo movió el programa)
     * @param {number} actual altura de scroll ahora
     * @returns {boolean} true solo si se retrocedió de verdad
     */
    function haciaArriba(previo, actual) {
        if (previo === null || previo === undefined) return false;
        return Number(actual) < Number(previo);
    }

    const api = { haciaArriba };
    if (typeof window === 'object' && window) window.ZlapyFechaFlotante = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})();
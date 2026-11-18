/* ID personalizado del grupo: normalizar mientras se escribe y derivar el
 * enlace corto que se muestra como vista previa.
 *
 * Las reglas son las DEL SERVIDOR (`src/shared/validation.js`:
 * `[a-z0-9_-]{3,32}`, sin empezar por `g_`), repetidas aquí solo para poder
 * avisar en la pantalla antes de enviar: quien manda es el servidor. Si un
 * día cambian las de allá, hay que cambiarlas aquí también (el test de
 * cliente lo señala).
 *
 * El enlace se arma con el HOST REAL de la app (`location.origin`), no con
 * un dominio inventado: Zlapy se usa en red local y cada instalación cuelga
 * de su propia dirección.
 *
 * Va dentro de un IIFE porque es un <script> CLÁSICO y no debe compartir
 * `const` con los otros scripts de la página.
 */
(() => {
    'use strict';

    const RE_ID = /^[a-z0-9_-]{3,32}$/;
    const MIN = 3;
    const MAX = 32;

    /**
     * Limpia lo que se teclea: sin acentos, sin mayúsculas, sin espacios ni
     * símbolos. Devuelve el texto tal y como se guardaría en el servidor.
     */
    function normalizarId(valor) {
        return String(valor == null ? '' : valor)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '')
            .slice(0, MAX);
    }

    /**
     * ¿Es una ID personalizable válida? Vacío no es válido, pero es LEGAL:
     * el grupo se queda con su identificador interno.
     */
    function idValida(valor) {
        const limpio = normalizarId(valor);
        return RE_ID.test(limpio) && !limpio.startsWith('g_');
    }

    /** Motivo (o cadena vacía) para explicar por qué aún no vale. */
    function problemaId(valor) {
        const escrito = String(valor == null ? '' : valor);
        const limpio = normalizarId(valor);
        if (!limpio) return '';
        if (limpio !== escrito) return 'Se ajusta sola: minúsculas, letras, números, guiones y guiones bajos.';
        if (limpio.startsWith('g_')) return 'El prefijo g_ está reservado para los grupos internos.';
        if (limpio.length < MIN) return `Añade al menos ${MIN} caracteres (llevas ${limpio.length}).`;
        if (!RE_ID.test(limpio)) return 'Solo letras minúsculas, números, guiones y guiones bajos.';
        return '';
    }

    /** Ruta que abre el grupo: `/?open=group:<id>` (la del enlace corto). */
    function rutaGrupo(valor) {
        return '/?open=group:' + normalizarId(valor);
    }

    /**
     * Enlace completo de vista previa. Sin base explícita se usa el origen
     * de la página (`http://192.168.1.5:1820`, el que sea): así el enlace que
     * se ve es el que de verdad funciona al compartirlo.
     */
    function enlaceCorto(valor, base) {
        const origen = base || (typeof location === 'object' && location && location.origin) || '';
        return origen + rutaGrupo(valor);
    }

    const api = { RE_ID, MIN, MAX, normalizarId, idValida, problemaId, rutaGrupo, enlaceCorto };
    if (typeof window === 'object' && window) window.ZlapyGroupId = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})();
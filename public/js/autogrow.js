/* Textarea que crece con su contenido.
 *
 *   ZlapyAutoGrow.grow(elemento, { minHeight, maxHeight })
 *   ZlapyAutoGrow.attach('#id', { maxHeight })
 *
 * Se aplica al CARGAR (no solo al escribir): si el texto viene puesto de
 * antemano, el alto se ajusta desde el primer momento.
 */
(function (global) {
    'use strict';

    function grow(textarea, options) {
        if (!textarea) return null;
        const opts = options || {};
        const max = Number(opts.maxHeight) > 0 ? Number(opts.maxHeight) : 320;
        const min = Number(opts.minHeight) > 0 ? Number(opts.minHeight) : 0;
        const apply = () => {
            textarea.style.height = 'auto';
            const needed = textarea.scrollHeight;
            const next = Math.min(max, Math.max(min, needed));
            textarea.style.height = next + 'px';
            textarea.style.overflowY = needed > max ? 'auto' : 'hidden';
        };
        textarea.addEventListener('input', apply);
        apply();
        return apply;
    }

    function attach(target, options) {
        const elements = typeof target === 'string'
            ? Array.from(document.querySelectorAll(target))
            : (target ? (Array.isArray(target) ? target : [target]) : []);
        return elements.map(element => grow(element, options));
    }

    global.ZlapyAutoGrow = { grow, attach };
})(window);

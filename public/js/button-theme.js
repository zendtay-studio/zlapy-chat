/* Jerarquía de botones: derivados del acento del tema.
   theme.css define los tokens por defecto (tema bosque) y este componente los
   recalca cuando la cuenta elige otra apariencia: un MISMO botón primario
   tiene que funcionar con el acento claro de Coral y con el bosque oscuro.

   · Acento CLARO (Coral #f4a58c, luma .48): ya es un relleno legible, se usa
     TAL CUAL con su tinta oscura (--accent-ink). Mezclarlo con la tinta lo
     apagaba a cobre, que no es el color del tema.
   · Acento OSCURO (bosque #25483c, luma .05): sobre el fondo casi negro daría
     1.9:1, es decir un botón invisible; se aclara hacia blanco hasta los 6-9:1
     que pide WCAG AA y la tina pasa a oscura.

   La secundaria siempre es gris CON un(20-45% de acento: presente en el tema
   sin competir con la primaria. Se carga detrás de appearance.js, que ya ha
   pintado --accent desde la cache del dispositivo (sin parpadeo). */
(() => {
    'use strict';

    const clamp255 = value => Math.max(0, Math.min(255, Math.round(value)));
    const lin = channel => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance = hex => {
        const n = parseInt(String(hex).slice(1), 16);
        const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };

    /* Límite por luminancia: por debajo el acento es demasiado oscuro para
       rellenar un botón sobre el fondo (Coral 0.48 queda libre; el bosque
       0.05 se aclara). */
    const CLARO_DESDE = 0.3;
    /* La secundaria NO se mezcla con el acento: un acento oscuro lo dejaba a
       1.09:1 del fondo, es decir invisible. Se usa el gris del resto de la
       interfaz (surface-raised), que sí se distingue (1.5:1) y mantiene el
       borde y el texto con contraste de sobra. */
    const aplicar = accent => {
        if (typeof accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(accent)) return null;
        const claro = luminance(accent) >= CLARO_DESDE;
        const style = document.documentElement.style;
        style.setProperty('--ok-fill', claro ? accent : `color-mix(in srgb, ${accent} 45%, #ffffff)`);
        style.setProperty('--ok-ink', claro ? 'var(--accent-ink)' : '#0b141a');
        style.setProperty('--ok-edge', claro
            ? `color-mix(in srgb, ${accent} 88%, #000000)`
            : `color-mix(in srgb, ${accent} 45%, var(--ok-fill))`);
        style.setProperty('--sec-fill', 'var(--surface-raised)');
        style.setProperty('--sec-line', 'var(--line)');
        return claro;
    };

    window.ZlapyButtonTheme = aplicar;
    /* Pintado sincrónico con el acento que appearance.js dejó en :root (o con
       el de theme.css si nadie lo tocó todavía).
       CUIDADO: dentro de la hoja de estilos este script va con defer, así que
       en :root puede leerse la VARIABLE DECLARADA ('var(--accent) 45%,
       #ffffff'), no un hex. Por eso solo se aplica si ya hay un hex de verdad:
       si no, se queda el default de theme.css y luego llega el cambio real
       cuando appearance.js resuelve la sesión. */
    const leido = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (/^#[0-9a-f]{6}$/i.test(leido)) aplicar(leido);
})();
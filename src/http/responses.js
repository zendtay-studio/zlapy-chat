/**
 * Respuestas y cabeceras de seguridad.
 *
 * Centraliza las cabeceras que accompany a toda respuesta (CSP por petición,
 * HSTS y aislamiento de origen, COOP/CORP) y el envoltorio JSON con su
 * caché desactivada.
 */
'use strict';

// Cabeceras de seguridad
/* Cabeceras de seguridad para TODAS las respuestas.
 * CSP: la app usa scripts/estilos inline (SPA de un archivo), así que se
 * permite 'unsafe-inline' en script/style; las imágenes pueden venir de
 * data:/blob: (locales) y de giphy (stickers). */
const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    // SAMEORIGIN (no DENY): la app enmarca sus PROPIAS páginas (historias y
    // visor de una vez van en iframes). Sigue bloqueando el clickjacking de
    // terceros.
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    // Cabeceras de aislamiento: cámara y micrófono solo para el propio origen.
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), fullscreen=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
};
/* CSP por petición: connect-src se limita al origen propio (el cliente abre
   el WebSocket contra location.host) en vez de dejar pasar cualquier ws:/wss:.
   El host se valida antes de meterse en la cabecera (viene del cliente). */
const CSP_HOST_RE = /^[a-zA-Z0-9.\-]{1,253}(:\d{1,5})?$/;
const cspFor = host => {
    const safe = typeof host === 'string' && CSP_HOST_RE.test(host) ? host : '';
    const ws = safe ? ` ws://${safe} wss://${safe}` : '';
    return "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        `img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self' data: blob:${ws}; ` +
        "font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
};
const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...securityHeaders });
    res.end(JSON.stringify(obj));
};


module.exports = {
    securityHeaders,
    CSP_HOST_RE,
    cspFor,
    json,
};

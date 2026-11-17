/**
 * Allowlist de Host.
 *
 * Decide si una cabecera `Host` que llega del cliente es "propia" del
 * servidor. La usan dos sitios que NO deben confiar en ese valor:
 *
 *   · el 301 a HTTPS cuando FORCE_TLS está activo: si se aceptara cualquier
 *     Host, una petición manipulada haría que el navegador saltara a un
 *     dominio AJENO (`Location: https://evil/…`), con la sesión de por medio;
 *   · la CSP (connect-src incluye el host propio).
 *
 * Se aceptan loopback, literales IP (v4/v6) y los hosts que el operador
 * declare en TLS_HOSTS (separados por comas). Un DNS rebinding (dominio
 * ajeno que resuelve a la IP del servidor) se queda fuera.
 */
'use strict';

const net = require('node:net');

const EXTRA_HOSTS = new Set(
    String(process.env.TLS_HOSTS || '')
        .split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
);

const hostAllowed = rawHost => {
    if (typeof rawHost !== 'string' || !rawHost) return false;
    let hostname;
    try { hostname = new URL(`http://${rawHost}`).hostname.toLowerCase(); }
    catch { return false; }
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    if (hostname === 'localhost' || hostname === '::1') return true;
    if (net.isIP(hostname)) return true;
    return EXTRA_HOSTS.has(hostname);
};

module.exports = { hostAllowed, EXTRA_HOSTS };
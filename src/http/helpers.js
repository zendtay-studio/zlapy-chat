/**
 * Ayudas HTTP.
 *
 * Aporta los tipos MIME de los ficheros estáticos, el rechazo con 429 cuando
 * se agota un límite de frecuencia y la decodificación segura de segmentos
 * de ruta.
 */
'use strict';

const { messageRateLimiter } = require('./rate-limit.js');
const { json } = require('./responses.js');
const { MESSAGE_LIMITS } = require('../shared/limits.js');

// Tipos MIME de los ficheros estáticos
const mimeMap = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json',
    '.webmanifest': 'application/manifest+json'
};

// Límites de frecuencia en las respuestas
function rejectRateLimitedMessage(res, accountId) {
    const result = messageRateLimiter.consume(accountId);
    if (result.allowed) return false;
    const retryAfter = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    json(res, 429, { error: `Límite alcanzado: máximo ${MESSAGE_LIMITS.messagesPerMinute} mensajes por minuto.`, retryAfter });
    return true;
}

/* Límite genérico por cuenta: el de mensajes solo cubre el envío de
   mensajes, así que las rutas caras (proxy de GIPHY, escritura de perfil,
   publicación de historias) llevan su propia cota. */
function rejectRateLimited(res, limiter, key, limit, what) {
    const result = limiter.consume(key);
    if (result.allowed) return false;
    const retryAfter = Math.ceil(result.retryAfterMs / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    json(res, 429, { error: `Límite alcanzado: máximo ${limit} ${what}.`, retryAfter });
    return true;
}

const safeDecodeSegment = raw => { try { return decodeURIComponent(raw); } catch { return null; } };


module.exports = {
    mimeMap,
    rejectRateLimitedMessage,
    rejectRateLimited,
    safeDecodeSegment,
};

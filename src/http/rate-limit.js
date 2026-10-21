/**
 * Límites de frecuencia.
 *
 * Centraliza los contadores de intentos (acceso y registro) y los límites por
 * cuenta que aplican a las rutas caras, además del límite de envío de
 * mensajes.
 */
'use strict';

const { MESSAGE_LIMITS, createMessageRateLimiter } = require('../shared/limits.js');

// Intentos de acceso y de registro, para frenar la fuerza bruta.
const loginAttempts = new Map();
const registerAttempts = new Map();
const messageRateLimiter = createMessageRateLimiter();
// Límites por cuenta para las rutas caras (proxy de GIPHY, perfil, historias).
const giphyLimiter = createMessageRateLimiter(30, 60 * 1000);
const profileLimiter = createMessageRateLimiter(10, 60 * 1000);
const storyLimiter = createMessageRateLimiter(15, 60 * 1000);
setInterval(() => messageRateLimiter.prune(), MESSAGE_LIMITS.messageWindowMs).unref();
setInterval(() => { giphyLimiter.prune(); profileLimiter.prune(); storyLimiter.prune(); }, 60 * 1000).unref();

module.exports = {
    loginAttempts,
    registerAttempts,
    messageRateLimiter,
    giphyLimiter,
    profileLimiter,
    storyLimiter,
};

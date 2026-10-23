/**
 * Límites de frecuencia.
 *
 * Centraliza los contadores de intentos (acceso y registro) y los límites por
 * cuenta que aplican a las rutas caras, además del límite de envío de
 * mensajes.
 */
'use strict';

const { MESSAGE_LIMITS, createMessageRateLimiter } = require('../shared/limits.js');
const { ORPHAN_SWEEP_INTERVAL_MS, sweepOrphanBlobs } = require('../db/transactions.js');

// Intentos de acceso y de registro, para frenar la fuerza bruta.
const loginAttempts = new Map();
const registerAttempts = new Map();
const messageRateLimiter = createMessageRateLimiter();
// Límites por cuenta para las rutas caras (proxy de GIPHY, perfil, historias).
const giphyLimiter = createMessageRateLimiter(30, 60 * 1000);
const profileLimiter = createMessageRateLimiter(10, 60 * 1000);
const storyLimiter = createMessageRateLimiter(15, 60 * 1000);
// Consultas de historias (view/like): baratas de enviar, caras de atender.
const storyViewLimiter = createMessageRateLimiter(60, 60 * 1000);
// Solicitudes de contacto: crean avisos (y pushes) en la cuenta ajena.
const contactLimiter = createMessageRateLimiter(20, 60 * 1000);
// Creación de grupos: escribe fila de grupo, miembros y ajustes de política.
const groupCreateLimiter = createMessageRateLimiter(10, 60 * 1000);
setInterval(() => messageRateLimiter.prune(), MESSAGE_LIMITS.messageWindowMs).unref();
setInterval(() => { giphyLimiter.prune(); profileLimiter.prune(); storyLimiter.prune(); storyViewLimiter.prune(); contactLimiter.prune(); groupCreateLimiter.prune(); }, 60 * 1000).unref();
/* Limpieza perezosa de los contadores de acceso y registro: las entradas cuya
   ventana ya venció no significan nada y ocupan memoria. El barrido no toca el
   contador global mientras su ventana siga viva (es el que frena la rotación
   de direcciones, así que no debe poder borrarse desde fuera). */
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) {
        if (!entry || entry.until <= now) loginAttempts.delete(key);
        else if (key.startsWith('acct:') && entry.count >= 8) loginAttempts.set(key, entry);
    }
    for (const [key, entry] of registerAttempts) {
        if (!entry || entry.until <= now) registerAttempts.delete(key);
    }
}, 60 * 1000).unref();

/* Barrido periódico de adjuntos huérfanos (blobs sin ninguna referencia de
   acceso). Acotado en tamaño para no congelar el servicio. */
setInterval(() => {
    try { sweepOrphanBlobs(); } catch (error) { console.error('[blobs] barrido de huérfanos:', error.message); }
}, ORPHAN_SWEEP_INTERVAL_MS).unref();

module.exports = {
    loginAttempts,
    registerAttempts,
    messageRateLimiter,
    giphyLimiter,
    profileLimiter,
    storyLimiter,
    storyViewLimiter,
    contactLimiter,
    groupCreateLimiter,
};

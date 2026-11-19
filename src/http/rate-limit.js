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
const { CONFIG } = require('../config.js');
/* Todos los topes salen de la configuración (.env): RATE_LIMIT_<NOMBRE>_PER_MINUTE. */
const RL = CONFIG.rateLimits || {};

// Intentos de acceso y de registro, para frenar la fuerza bruta.
const loginAttempts = new Map();
const registerAttempts = new Map();
const messageRateLimiter = createMessageRateLimiter();
// Límites por cuenta para las rutas caras (proxy de GIPHY, perfil, historias).
const giphyLimiter = createMessageRateLimiter(RL.giphy || 30, 60 * 1000);
const stickerCreateLimiter = createMessageRateLimiter(RL.stickerCreate || 10, 60 * 1000);
const profileLimiter = createMessageRateLimiter(RL.profile || 10, 60 * 1000);
/* Regeneración de clave: re-cifra TODO el contenido del usuario, así que
   lleva tope propio de 5/min (BUG-012): antes compartía limiter con el
   guardado de perfil y el tope real era 10/min aún diciendo el mensaje 5. */
const keyRegenLimiter = createMessageRateLimiter(RL.keyRegen || 5, 60 * 1000);
const storyLimiter = createMessageRateLimiter(RL.story || 15, 60 * 1000);
// Consultas de historias (view/like): baratas de enviar, caras de atender.
const storyViewLimiter = createMessageRateLimiter(RL.storyView || 60, 60 * 1000);
// Solicitudes de contacto: crean avisos (y pushes) en la cuenta ajena.
const contactLimiter = createMessageRateLimiter(RL.contact || 20, 60 * 1000);
// Creación de grupos: escribe fila de grupo, miembros y ajustes de política.
const groupCreateLimiter = createMessageRateLimiter(RL.groupCreate || 10, 60 * 1000);
/* Ofertas de llamada por WS: cada una escribe dos filas en la base y, si el
   destinatario está offline, lanza una petición push externa. Sin cota, una
   sola cuenta podía multiplicar las ofertas reabriendo conexiones (hasta ~8
   conexiones × 200 fps) y saturar SQLite y el servicio de push. */
const callOfferLimiter = createMessageRateLimiter(RL.callOffer || 5, 60 * 1000);
/* Preferencias de chat: un solo POST acepta hasta 200 destinos y resuelve
   cada grupo contra la base (o la caché); sin cota era un generador de
   SELECTs barato para cualquier cuenta. */
const chatPrefsLimiter = createMessageRateLimiter(RL.chatPrefs || 20, 60 * 1000);
/* Verificaciones de contraseña (cambiar identidad/contraseña y borrar la
   cuenta): cada intento ejecuta un scrypt completo (~64 ms de CPU). La rollback
   de sesión no basta —una pestaña abierta o una cookie robada pasaban— y sin
   cota el endpoint era un DoS de proceso barato. */
const passwordCheckLimiter = createMessageRateLimiter(RL.passwordCheck || 5, 60 * 1000);
/* Acuses de entrega (/receipt): cada uno recorre hasta 500 ids, descifra cada
   fila (PCE3, MTProto 2.0) y toca resúmenes: sin cota era el multiplicador
   barato de escritura más caro del chat. SECOA-I-004. */
const receiptLimiter = createMessageRateLimiter(RL.receipt || 120, 60 * 1000);
const reactionLimiter = createMessageRateLimiter(RL.reaction || 120, 60 * 1000);
/* Clave pública (/key): guardarla reescribe TODA la fila del usuario
   (perfil, ajustes, contactos, grupos vistos…). Sin cota, una sesión válida
   martilleando la ruta era un DoS de escrituras barato (M3). */
const keyUploadLimiter = createMessageRateLimiter(RL.keyUpload || 30, 60 * 1000);
/* Cota BASE para TODAS las rutas de API (no estáticos). Antes las lecturas
   autenticadas y los endpoints públicos no tenían ninguna: cualquiera podía
   martillear /config, /avatar/push o /chats/summary sin tope.
   - autenticado: 600 peticiones/min por cuenta (10/s);
   - sin sesión: 300 peticiones/min por IP (5/s).
   Las rutas de autenticación NO pasan por aquí: tienen sus propios frenos,
   más estrictos (retardo progresivo por cuenta e IP, cortacircuitos por IP
   y tope de registros por hora), así que nunca quedan más sueltas que el
   resto de la API.
   /healthz está EXENTO: el supervisor lo sondea cada segundo y cuenta
   cualquier 4xx como «servicio caído», así que un 429 por cuota
   reiniciaría un servicio que está sano. */
const apiLimiter = createMessageRateLimiter(RL.api || 600, 60 * 1000);
const publicApiLimiter = createMessageRateLimiter(RL.public || 300, 60 * 1000);
/* Autenticación: cota más estricta que la base (60/min por IP, configurable
   con RATE_LIMIT_AUTH_PER_MINUTE). Se suma a los frenos ya existentes de
   fuerza bruta (retardo progresivo, cortacircuitos y tope de registros). */
const authLimiter = createMessageRateLimiter(RL.auth || 60, 60 * 1000);
setInterval(() => messageRateLimiter.prune(), MESSAGE_LIMITS.messageWindowMs).unref();
setInterval(() => { giphyLimiter.prune(); stickerCreateLimiter.prune(); profileLimiter.prune(); keyRegenLimiter.prune(); storyLimiter.prune(); storyViewLimiter.prune(); contactLimiter.prune(); groupCreateLimiter.prune(); callOfferLimiter.prune(); chatPrefsLimiter.prune(); passwordCheckLimiter.prune(); receiptLimiter.prune(); reactionLimiter.prune(); keyUploadLimiter.prune(); apiLimiter.prune(); publicApiLimiter.prune(); authLimiter.prune(); }, 60 * 1000).unref();
/* Limpieza perezosa de los contadores de acceso y registro: las entradas cuya
   ventana ya venció no significan nada y ocupan memoria. Incluye el freno por
   IP (`brk:...`) con su enfriamiento corto y el contador por cuenta e IP
   (los legítimos se limpian al acertar el login). */
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
    stickerCreateLimiter,
    profileLimiter,
    keyRegenLimiter,
    storyLimiter,
    storyViewLimiter,
    contactLimiter,
    groupCreateLimiter,
    callOfferLimiter,
    chatPrefsLimiter,
    passwordCheckLimiter,
    receiptLimiter,
    reactionLimiter,
    keyUploadLimiter,
    apiLimiter,
    publicApiLimiter,
    authLimiter,
};

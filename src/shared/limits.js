/**
 * Límites de mensajes y contadores de frecuencia.
 *
 * Agrupa los topes de tamaño del contenido y el limitador de frecuencia por
 * cuenta (ventana deslizante), más el conteo de caracteres por punto de
 * código.
 */

const { CONFIG } = require('../config.js');
const MESSAGE_LIMITS = Object.freeze({
    directMessageCharacters: CONFIG.directMessageCharacters,
    groupMessageCharacters: CONFIG.groupMessageCharacters,
    storyCharacters: CONFIG.storyCharacters,
    profileDescriptionCharacters: CONFIG.profileDescriptionCharacters,
    messagesPerMinute: CONFIG.messagesPerMinute,
    messageWindowMs: CONFIG.messageWindowMs
});

/* Cuenta caracteres (puntos de código, no bytes ni unidades UTF-16).
 * `stopAt` corta el conteo antes: materializar 24 millones de caracteres con
 * Array.from reservaba ~200 MB de heap por petición. */
function characterCount(value, stopAt = Infinity) {
    if (typeof value !== 'string') return 0;
    let n = 0;
    for (const _ of value) {
        if (++n > stopAt) return n;
    }
    return n;
}

function createMessageRateLimiter(limit = MESSAGE_LIMITS.messagesPerMinute, windowMs = MESSAGE_LIMITS.messageWindowMs, now = Date.now) {
    const timestampsByAccount = new Map();

    return {
        consume(accountId) {
            const currentTime = now();
            const cutoff = currentTime - windowMs;
            let bucket = timestampsByAccount.get(accountId);
            if (!bucket) {
                bucket = { timestamps: [], start: 0 };
                timestampsByAccount.set(accountId, bucket);
            }

            while (bucket.start < bucket.timestamps.length && bucket.timestamps[bucket.start] <= cutoff) bucket.start++;
            const count = bucket.timestamps.length - bucket.start;
            if (count >= limit) {
                return { allowed: false, retryAfterMs: Math.max(1, bucket.timestamps[bucket.start] + windowMs - currentTime) };
            }

            if (bucket.start && bucket.start * 2 >= bucket.timestamps.length) {
                bucket.timestamps = bucket.timestamps.slice(bucket.start);
                bucket.start = 0;
            }
            bucket.timestamps.push(currentTime);
            return { allowed: true, retryAfterMs: 0 };
        },
        delete(accountId) {
            timestampsByAccount.delete(accountId);
        },
        prune() {
            const cutoff = now() - windowMs;
            for (const [accountId, bucket] of timestampsByAccount) {
                while (bucket.start < bucket.timestamps.length && bucket.timestamps[bucket.start] <= cutoff) bucket.start++;
                if (bucket.start === bucket.timestamps.length) timestampsByAccount.delete(accountId);
            }
        }
    };
}

module.exports = { MESSAGE_LIMITS, characterCount, createMessageRateLimiter };

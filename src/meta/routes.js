// Rutas de metadatos y salud
'use strict';

const { CONFIG } = require('../config.js');
const { TRANSPORT_ALGO, transportPublicKey } = require('../crypto/transport.js');
const { blobDb, db } = require('../db/database.js');
const { SCHEMA_VERSION } = require('../db/schema.js');
const { json } = require('../http/responses.js');
const { MESSAGE_LIMITS } = require('../shared/limits.js');

// Límites de la aplicación y clave pública del cifrado de transporte. Es
// pública a propósito: el cliente la usa para abrir una sesión cifrada.
function getConfig(req, res, url, data, actor) {
    return json(res, 200, {
    directMessageCharacters: MESSAGE_LIMITS.directMessageCharacters,
    groupMessageCharacters: MESSAGE_LIMITS.groupMessageCharacters,
    storyCharacters: MESSAGE_LIMITS.storyCharacters,
    profileDescriptionCharacters: MESSAGE_LIMITS.profileDescriptionCharacters,
    maxAudioDurationMs: CONFIG.maxAudioDurationMs,
    storyTtlMs: CONFIG.storyTtlMs,
    noteTtlMs: CONFIG.noteTtlMs,
    maxMessageDataChars: CONFIG.maxMessageDataChars,
    maxGalleryItems: CONFIG.maxGalleryItems,
    maxGalleryEncodedChars: CONFIG.maxGalleryEncodedChars,
    transportAlgorithm: TRANSPORT_ALGO,
    transportPublicKey: transportPublicKey()
    });
}

// Comprobación de salud: ambas bases responden. Incluye la clave pública para
// que un cliente pueda empezar a cifrar sin pedir /config.
function getHealthz(req, res, url, data, actor) {
    try {
    db.prepare('SELECT 1').get();
    blobDb.prepare('SELECT 1').get();
    return json(res, 200, {
        ok: true,
        schema: SCHEMA_VERSION,
        uptime: Math.round(process.uptime()),
        transportAlgorithm: TRANSPORT_ALGO,
        transportPublicKey: transportPublicKey()
    });
    } catch {
    return json(res, 503, { ok: false, error: 'database unavailable' });
    }
}


module.exports = {
    getConfig,
    getHealthz,
};

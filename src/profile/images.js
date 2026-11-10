/**
 * Imágenes de perfil y del chat (avatar, fondo) en el almacén de blobs.
 *
 * Antes, la foto de perfil y el fondo del chat se guardaban como data-URL en
 * la fila de la cuenta: texto plano legible en el fichero de la base (y la
 * fila crecía un 33 % al cifrarla). Ahora van al almacén de blobs, que ya
 * cifra el contenido en reposo y verifica su hash; en la base solo queda la
 * referencia (el SHA-256 del contenido), que no revela la imagen.
 *
 * La API para el cliente no cambia: el perfil sigue devolviendo `avatar` como
 * data-URL y los ajustes del chat siguen devolviendo `image`. El servidor
 * lee el blob y lo sirve igual que antes.
 */
'use strict';

const crypto = require('node:crypto');
const {
    MEDIA_FALLBACK_DATA_URL,
    blobQuotaOk,
    readBlob,
    storeBlob
} = require('../chat/media.js');

/* Tipos que el almacén rechaza (HTML/SVG/JS: contenido activo). El avatar
   llega del cliente, así que la validación es la misma que la de los
   adjuntos. */
const DATA_URL_RE = /^data:([^,]*);base64,([a-z0-9+/]*={0,2})$/i;

/**
 * Guarda una imagen (data-URL) en el almacén de blobs cifrado.
 *
 * @param {string} dataUrl  contenido `data:image/...;base64,...`
 * @param {object} [options] {userId} para comprobar la cuota de la cuenta
 * @returns {string} el hash del blob, o '' si no se pudo guardar
 */
function storeImage(dataUrl, { userId } = {}) {
    if (typeof dataUrl !== 'string' || !dataUrl) return '';
    const match = dataUrl.match(DATA_URL_RE);
    if (!match) return '';
    let bytes;
    try { bytes = Buffer.from(match[2], 'base64'); }
    catch { return ''; }
    if (!bytes.length) return '';
    if (userId && !blobQuotaOk(userId, bytes.length)) return '';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!storeBlob(hash, dataUrl)) return '';
    return hash;
}

/**
 * Lee una imagen del almacén y la devuelve como data-URL.
 *
 * @param {string} hash referencia guardada en la fila
 * @returns {string} data-URL, o '' si no está o no se puede leer
 */
function readImage(hash) {
    if (typeof hash !== 'string' || !hash) return '';
    try {
        const value = readBlob(hash);
        if (typeof value === 'string') return value;
        console.warn(`[blobs] Falta la imagen ${hash}; se usa la imagen de respaldo.`);
    } catch (error) {
        console.error(`[blobs] No se pudo leer la imagen ${hash}; se usa la imagen de respaldo:`, error.message);
    }
    return MEDIA_FALLBACK_DATA_URL;
}

module.exports = {
    storeImage,
    readImage
};

/**
 * Validación de galerías de imágenes.
 *
 * Comprueba los elementos de una galería (hash, MIME, dimensiones), respeta
 * el tope de elementos y de tamaño codificado, y guarda en el almacén de
 * blobs los adjuntos que llegan con su contenido.
 */

const { CONFIG } = require('../config.js');
const IMAGE_MIME_TYPE = /^image\/(jpeg|png|webp|gif|avif)$/i;

function validateGallery(user, input, blobAvailableTo, storeBlob) {
    if (!Array.isArray(input) || input.length < 2 || input.length > CONFIG.maxGalleryItems) return null;

    let encodedBytes = 0;
    const gallery = [];
    for (const item of input) {
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(item.hash) ||
            typeof item.mime !== 'string' || !IMAGE_MIME_TYPE.test(item.mime) ||
            (item.data !== undefined && typeof item.data !== 'string')) return null;

        if (item.data) {
            encodedBytes += item.data.length;
            if (encodedBytes > CONFIG.maxGalleryEncodedChars || !storeBlob(item.hash, item.data)) return null;
        } else if (!blobAvailableTo(user, item.hash)) {
            return null;
        }

        gallery.push({
            hash: item.hash.toLowerCase(),
            mime: item.mime.slice(0, 120),
            width: Number.isInteger(item.width) ? Math.max(1, Math.min(12000, item.width)) : 0,
            height: Number.isInteger(item.height) ? Math.max(1, Math.min(12000, item.height)) : 0
        });
    }
    return gallery;
}

module.exports = { validateGallery };

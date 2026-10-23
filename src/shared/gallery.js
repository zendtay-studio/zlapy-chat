/**
 * Validación de galerías de imágenes.
 *
 * Comprueba los elementos de una galería (hash, MIME, dimensiones), respeta el
 * tope de elementos y de tamaño codificado. **No escribe nada**: antes guardaba
 * los blobs durante la validación, de modo que una galería que acababa
 * rechazada (por el límite de frecuencia, por ejemplo) dejaba adjuntos
 * huérfanos que ocupaban disco para siempre. Ahora valida y devuelve la
 * galería; quien la acepte llama a `storeGallery` para escribir los blobs.
 */

const { CONFIG } = require('../config.js');
const IMAGE_MIME_TYPE = /^image\/(jpeg|png|webp|gif|avif)$/i;

/* Valida una galería sin tocar el almacén. Devuelve el array normalizado
   (con el contenido en `data` para quien lo vaya a guardar) o null. */
function validateGallery(user, input, blobAvailableTo) {
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
            if (encodedBytes > CONFIG.maxGalleryEncodedChars) return null;
        } else if (!blobAvailableTo(user, item.hash)) {
            return null;
        }

        gallery.push({
            hash: item.hash.toLowerCase(),
            mime: item.mime.slice(0, 120),
            width: Number.isInteger(item.width) ? Math.max(1, Math.min(12000, item.width)) : 0,
            height: Number.isInteger(item.height) ? Math.max(1, Math.min(12000, item.height)) : 0,
            data: typeof item.data === 'string' ? item.data : ''
        });
    }
    return gallery;
}

/* Escribe en el almacén los blobs que venían con contenido. Se llama SOLO
   cuando la petición ya ha pasado todas las validaciones, justo antes de
   guardar el mensaje: así un rechazo nunca deja basura en disco.
   Devuelve false si algún contenido no pasa la verificación del hash. */
function storeGallery(gallery, storeBlob) {
    if (!Array.isArray(gallery)) return false;
    for (const item of gallery) {
        if (!item.data) continue;
        if (!storeBlob(item.hash, item.data)) return false;
    }
    return true;
}

module.exports = { validateGallery, storeGallery };

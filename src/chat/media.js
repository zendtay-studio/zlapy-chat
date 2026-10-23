/**
 * Adjuntos.
 *
 * Guarda los blobs cifrados en reposo y verifica el hash SHA-256 del
 * contenido, de modo que un adjunto referenciado por hash no pueda cambiar
 * por el camino. El acceso se decide por conversación, grupo o historia:
 * conocer el hash no da acceso al archivo.
 */
'use strict';

const crypto = require('crypto');
const { decryptAtRest, encryptAtRest } = require('../crypto/setup.js');
const { Stmt } = require('../db/statements.js');
const { profiles, users } = require('../state.js');
const { permite } = require('../users/privacy.js');

// Blobs (adjuntos)
const blobHashOk = h => typeof h === 'string' && /^[a-f0-9]{64}$/i.test(h);

/* Cuota de almacenamiento por cuenta y global, en bytes ya descifrados.
   Sin ella, una sesión válida puede llenar el disco del servidor (cada
   petición admite ~18 MB de galería) y tumbar el servicio para todos. */
const BLOB_QUOTA_PER_USER_BYTES = 512 * 1024 * 1024;   // 512 MB por cuenta
const BLOB_QUOTA_GLOBAL_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB en total

/* Espacio ocupado por los adjuntos a los que apunta una cuenta (los que
   referencia desde sus conversaciones, grupos o historias). La suma real es
   algo costosa (un hash por adjunto), así que se memoriza unos segundos: la
   cuota se comprueba en cada envío con adjunto y no hace falta recalcularla
   en cada petición. */
const cuotaCache = new Map();
const CUOTA_CACHE_MS = 15 * 1000;
function blobBytesOfUser(userId) {
    const ahora = Date.now();
    const cached = cuotaCache.get(userId);
    if (cached && cached.hasta > ahora) return cached.bytes;
    let bytes = 0;
    for (const { hash } of Stmt.userBlobHashes.all(userId, userId, userId, userId)) {
        const row = Stmt.blobSize.get(hash);
        if (row) bytes += Number(row.bytes || 0);
    }
    cuotaCache.set(userId, { bytes, hasta: ahora + CUOTA_CACHE_MS });
    return bytes;
}
/* Fuera de la caché cuando cambian los adjuntos de esa cuenta (envío o
   borrado), para que la cuota no dé un número obsoleto. */
function invalidateBlobQuota(userId) { if (userId) cuotaCache.delete(userId); }
function blobBytesGlobal() {
    const row = Stmt.blobBytesGlobal.get();
    return row ? Number(row.bytes || 0) : 0;
}

/* ¿Qepa este adjunto dentro de la cuota? Se comprueba antes de escribir: es
   la última barrera antes de tocar disco. */
function blobQuotaOk(userId, extraBytes) {
    if (!userId || !(extraBytes > 0)) return true;
    if (blobBytesGlobal() + extraBytes > BLOB_QUOTA_GLOBAL_BYTES) return false;
    return blobBytesOfUser(userId) + extraBytes <= BLOB_QUOTA_PER_USER_BYTES;
}

function storeBlob(hash, value) {
    if (!blobHashOk(hash) || typeof value !== 'string') return false;
    const match = value.match(/^data:[^,]*;base64,([a-z0-9+/]*={0,2})$/i);
    if (!match) return false;
    const bytes = Buffer.from(match[1], 'base64');
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash.toLowerCase()) return false;
    Stmt.insertBlob.run(hash.toLowerCase(), encryptAtRest(value));
    return true;
}

function readBlob(hash) {
    const row = Stmt.getBlob.get(hash.toLowerCase());
    if (!row) return null;
    return decryptAtRest(row.data);
}

function blobAvailableTo(user, hash) {
    if (!user || !blobHashOk(hash)) return false;
    const h = hash.toLowerCase();
    if (Stmt.getBlobAccessChat.get(h, user.id, user.id)) return true;
    /* Adjuntos de grupo: accede quien estaba en el grupo cuando se publicó.
       Los anteriores a esta regla no tienen foto de miembros, así que para
       ellos se mantiene la pertenencia actual (no se puede perder el acceso a
       lo ya compartido). */
    if (Stmt.blobAccessMemberCount.get(h).c > 0) {
        if (Stmt.getBlobAccessGroup.get(h, user.id)) return true;
    } else if (Stmt.getBlobAccessGroupByCurrentMembership.get(h, user.id)) return true;
    const storyRow = Stmt.getBlobAccessStory.get(h);
    if (storyRow) {
        const owner = users.get(storyRow.story_user);
        if (owner && permite(profiles[owner.username], 'historias', user.username)) return true;
    }
    return false;
}

module.exports = {
    blobHashOk,
    storeBlob,
    readBlob,
    blobAvailableTo,
    blobQuotaOk,
    blobBytesOfUser,
    blobBytesGlobal,
    invalidateBlobQuota,
    BLOB_QUOTA_PER_USER_BYTES,
    BLOB_QUOTA_GLOBAL_BYTES,
};

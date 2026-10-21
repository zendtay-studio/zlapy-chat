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
    if (Stmt.getBlobAccessGroup.get(h, user.id)) return true;
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
};

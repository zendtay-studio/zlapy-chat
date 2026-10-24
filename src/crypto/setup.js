/**
 * Cifrado: llave maestra, cifrado en reposo y clave por usuario.
 *
 * Crea una sola vez (al cargar el módulo) la llave maestra y la comparte con
 * todos los módulos, para que todos usen exactamente la misma llave.
 */
'use strict';

const crypto = require('crypto');

const { getMasterKeyBytes } = require('./master-key.js');
const { createMessageCrypto } = require('./message-crypto.js');
const { createUserAuthKeys } = require('./user-auth-keys.js');
const { db } = require('../db/database.js');
const { Stmt } = require('../db/statements.js');

const masterKey = crypto.createSecretKey(getMasterKeyBytes());
const messageCrypto = createMessageCrypto(masterKey.export(), {
    // La semilla de firma sale de la auth_key del usuario cuando ya existe.
    // MODELO REAL: la auth_key se guarda CIFRADA con la llave maestra
    // (encryptAtRest → PCE1), así que la maestra es la raíz de confianza
    // completa y quien la obtenga recupera todas las auth_key y firma el
    // contenido de cualquiera. La separación de semillas solo tiene valor
    // ante fuga de la base SIN fuga de la llave maestra. La semilla maestra
    // solo cubre el instante extraño en que el usuario aún no tiene auth_key
    // (p. ej. antes del primer mensaje); ya NO es una segunda firma válida
    // para verificación cuando la auth_key existe.
    signingKeyFor: userId => {
        const rec = authKeyRecord(userId);
        return rec ? rec.key : masterKey.export();
    }
});

const { encryptAtRest, decryptAtRest } = messageCrypto;

// Clave de cifrado de contenido por usuario (auth_key, AES-256-GCM)
// y helpers de cifrado por usuario.
const authKeys = createUserAuthKeys({ db, Stmt, encryptAtRest, decryptAtRest, onAuthKeyCreated: userId => messageCrypto.forgetSigningKey(userId) });

const {
    authKeyRecord, ensureAuthKey,
    encryptForUser, decryptForUser, messageContextBytes
} = authKeys;

module.exports = {
    masterKey,
    messageCrypto,
    encryptAtRest,
    decryptAtRest,
    authKeys,
    authKeyRecord,
    ensureAuthKey,
    encryptForUser,
    decryptForUser,
    messageContextBytes
};

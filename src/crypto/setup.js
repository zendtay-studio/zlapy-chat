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
    // La semilla de firma sale de la auth_key del usuario (modelo en la nube de
    // MTProto 2.0): la llave maestra por sí sola no permite derivar ni
    // falsificar la identidad de nadie. Si el usuario todavía no tiene
    // auth_key, se usa la llave maestra como semilla.
    signingKeyFor: userId => {
        const rec = authKeyRecord(userId);
        return rec ? rec.key : masterKey.export();
    }
});

const { encryptAtRest, decryptAtRest } = messageCrypto;

// Clave de cifrado por usuario (auth_key de MTProto 2.0) y helpers de cifrado
// por usuario. Comparte implementacion con el script de migracion manual
// (ops/migrate-to-mtproto.js), de forma que lo que migra uno se lee igual en el
// otro.
const authKeys = createUserAuthKeys({ db, Stmt, encryptAtRest, decryptAtRest });

const {
    authKeyRecord, ensureAuthKey, rotateSaltIfNeeded,
    encryptForUser, decryptForUser, messageContextBytes
} = authKeys;
;

module.exports = {
    masterKey,
    messageCrypto,
    encryptAtRest,
    decryptAtRest,
    authKeys,
    authKeyRecord,
    ensureAuthKey,
    rotateSaltIfNeeded,
    encryptForUser,
    decryptForUser,
    messageContextBytes
};

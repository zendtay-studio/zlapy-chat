/**
 * Cifrado: llave maestra, cifrado en reposo y clave por usuario.
 *
 * Crea una sola vez (al cargar el módulo) la llave maestra y la comparte con
 * todos los módulos, para que todos usen exactamente la misma llave.
 */
'use strict';

const crypto = require('crypto');

const { ensureOwnerCredential } = require('./owner-key.js');
const { createMessageCrypto } = require('./message-crypto.js');
const { createUserAuthKeys, AuthKeyUnreadableError } = require('./user-auth-keys.js');
const { db } = require('../db/database.js');
const { Stmt } = require('../db/statements.js');

/* Abre la base con la credencial del propietario. En una instalación nueva
   la inicializa (sal + keycheck) con esa credencial. */
const ownerCredential = ensureOwnerCredential();
const masterKey = crypto.createSecretKey(ownerCredential.key);
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
    authKeyRecord, authKeyState, ensureAuthKey,
    encryptForUser, decryptForUser, messageContextBytes
} = authKeys;

/**
 * Auditoría de las auth_key al arrancar (SOLO LECTURA).
 *
 * Comprueba, con la llave maestra que tiene el proceso, si cada
 * `user_auth_keys.auth_key` se descifra. Es el diagnóstico temprano de una
 * desincronización: si la llave del `.env` no es la que cifró las filas,
 * la cuenta que la tiene no puede guardar su perfil ni leer su contenido,
 * y eso (hasta ahora) solo se manifestaba como un 500 más tarde.
 *
 * @returns {{total: number, ok: number, ilegibles: Array<{user_id: string, username: string}>}}
 */
function auditAuthKeys() {
    const filas = db.prepare('SELECT user_id, auth_key FROM user_auth_keys').all();
    const nombres = new Map(db.prepare('SELECT id, username FROM users').all().map(fila => [fila.id, fila.username]));
    const ilegibles = [];
    let ok = 0;
    for (const fila of filas) {
        let plain = null;
        try { plain = decryptAtRest(fila.auth_key); } catch { }
        if (typeof plain === 'string' && plain.length > 0) { ok++; continue; }
        ilegibles.push({ user_id: fila.user_id, username: nombres.get(fila.user_id) || '(desconocido)' });
    }
    return { total: filas.length, ok, ilegibles };
}

module.exports = {
    masterKey,
    ownerCredential,
    messageCrypto,
    encryptAtRest,
    decryptAtRest,
    authKeys,
    authKeyRecord,
    authKeyState,
    ensureAuthKey,
    encryptForUser,
    decryptForUser,
    messageContextBytes,
    auditAuthKeys,
    AuthKeyUnreadableError
};

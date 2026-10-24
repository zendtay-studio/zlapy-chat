/**
 * Gestión de la clave de cifrado por usuario (auth_key) y helpers de cifrado
 * por usuario.
 *
 * La auth_key son 2048 bits aleatorios, se guarda CIFRADA con la llave
 * maestra (PCE1) y cifra todo el contenido del usuario. El armazón MTProto
 * (sal rotada, session_id, msg_id monotono) se eliminó: no se verificaba en
 * el descifrado y no aportaba nada sobre AES-256-GCM.
 */
'use strict';

const crypto = require('crypto');
const mtproto = require('./mtproto');

const AUTH_KEY_CACHE_MAX = 500;

function createUserAuthKeys({ db, Stmt, encryptAtRest, decryptAtRest, onAuthKeyCreated }) {
    if (!db || !Stmt) throw new TypeError('createUserAuthKeys necesita db y Stmt.');
    if (typeof encryptAtRest !== 'function' || typeof decryptAtRest !== 'function')
        throw new TypeError('createUserAuthKeys necesita las funciones de cifrado en reposo.');

    const authKeyCache = new Map();

    /* Clave cargada de la base (la auth_key viaja cifrada con la llave
     * maestra del servidor). */
    function authKeyRecord(userId) {
        const cached = authKeyCache.get(userId);
        if (cached) return cached;
        const row = Stmt.getAuthKey.get(userId);
        if (!row) return null;
        let key = null;
        try { key = Buffer.from(decryptAtRest(row.auth_key), 'hex'); } catch { }
        if (!key || key.length !== mtproto.AUTH_KEY_BYTES) return null;
        const rec = { key, keyId: row.key_id };
        if (authKeyCache.size >= AUTH_KEY_CACHE_MAX) authKeyCache.delete(authKeyCache.keys().next().value);
        authKeyCache.set(userId, rec);
        return rec;
    }

    /* Devuelve la auth_key del usuario, creandola si todavia no existe. */
    function ensureAuthKey(userId) {
        const existing = authKeyRecord(userId);
        if (existing) return existing;
        const key = mtproto.generateAuthKey();
        const keyId = mtproto.authKeyId(key);
        const now = Date.now();
        Stmt.insertAuthKey.run(userId, encryptAtRest(key.toString('hex')), keyId, now, now);
        const rec = { key, keyId };
        if (authKeyCache.size >= AUTH_KEY_CACHE_MAX) authKeyCache.delete(authKeyCache.keys().next().value);
        authKeyCache.set(userId, rec);
        /* Al CREAR la clave (primera vez del usuario, o regeneración) el par
         * de firma cacheado pudo derivar de la semilla maestra (de aplica
         * mientras la auth_key no existía): hay que invalidar la caché, o
         * TODAS las firmas de ese usuario saldrían de ahí para siempre. */
        if (typeof onAuthKeyCreated === 'function') {
            try { onAuthKeyCreated(userId); } catch { }
        }
        return rec;
    }

    /* Cifra un contenido con la auth_key del usuario (AES-256-GCM). */
    function encryptForUser(userId, plain) {
        if (typeof plain !== 'string' || plain === '') return plain;
        const rec = ensureAuthKey(userId);
        return mtproto.encrypt(rec.key, plain).blob;
    }

    /* Descifra un contenido: PCE3 con la auth_key del usuario; cualquier otra
     * cadena pasa por el descifrado en reposo (PCE1/llano) tal cual. Devuelve
     * null si no se puede descifrar. */
    function decryptForUser(userId, blob) {
        if (typeof blob !== 'string' || blob === '') return blob;
        if (blob.startsWith('PCE3:')) {
            const rec = authKeyRecord(userId);
            if (!rec) return null;
            const out = mtproto.decrypt(rec.key, blob);
            return out ? out.body.toString('utf8') : null;
        }
        return decryptAtRest(blob);
    }

    /* Contexto del mensaje ligado al cifrado (AAD): impide que una fila
     * movida de chat o de autor siga siendo valida. */
    function messageContextBytes(row) {
        return Buffer.from(JSON.stringify({
            domain: 'zlapy/message-context/v4',
            id: row.id, chat: row.chat, ts: row.ts,
            fromId: row.from_id, toId: row.to_id || '', kind: row.kind,
            cryptoGroupId: row.crypto_group_id || ''
        }), 'utf8');
    }

    return {
        authKeyRecord,
        ensureAuthKey,
        encryptForUser,
        decryptForUser,
        messageContextBytes,
        authKeyCache
    };
}

module.exports = { createUserAuthKeys, AUTH_KEY_CACHE_MAX };

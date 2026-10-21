/**
 * Gestión de la clave de cifrado por usuario (auth_key del modelo en la nube
 * de MTProto 2.0) y helpers de cifrado por usuario.
 *
 * Vive en su propio módulo para que el servidor y el script de migración
 * manual (`ops/migrate-to-mtproto.js`) usen EXACTAMENTE la misma
 * implementación: si divergieran, lo que migra el script no lo podría leer el
 * servidor.
 */
'use strict';

const crypto = require('crypto');
const mtproto = require('./mtproto');

const AUTH_KEY_CACHE_MAX = 500;
const SALT_ROTATION_MS = 30 * 60 * 1000;   // MTProto: la sal se rota cada 30 minutos

function createUserAuthKeys({ db, Stmt, encryptAtRest, decryptAtRest }) {
    if (!db || !Stmt) throw new TypeError('createUserAuthKeys necesita db y Stmt.');
    if (typeof encryptAtRest !== 'function' || typeof decryptAtRest !== 'function')
        throw new TypeError('createUserAuthKeys necesita las funciones de cifrado en reposo.');

    const authKeyCache = new Map();
    const randomUint64 = () => Number(crypto.randomBytes(8).readBigUInt64LE(0) & 0x7fffffffffffffffn);

    /* Clave cargada de la base (la propia auth_key se guarda cifrada con la
     * llave maestra del servidor, como Telegram guarda las claves de autorizacion). */
    function authKeyRecord(userId) {
        const cached = authKeyCache.get(userId);
        if (cached) return cached;
        const row = Stmt.getAuthKey.get(userId);
        if (!row) return null;
        let key = null;
        try { key = Buffer.from(decryptAtRest(row.auth_key), 'hex'); } catch { }
        if (!key || key.length !== mtproto.AUTH_KEY_BYTES) return null;
        const rec = {
            key, keyId: row.key_id, salt: Number(row.salt), sessionId: Number(row.session_id),
            lastMsgId: row.last_msg_id || '0', saltAt: Date.now()
        };
        if (authKeyCache.size >= AUTH_KEY_CACHE_MAX) authKeyCache.delete(authKeyCache.keys().next().value);
        authKeyCache.set(userId, rec);
        return rec;
    }

    /* Devuelve la auth_key del usuario, creandola si todavia no existe. */
    function ensureAuthKey(userId) {
        const existing = authKeyRecord(userId);
        if (existing) return existing;
        const key = mtproto.generateAuthKey();
        const now = Date.now();
        const salt = randomUint64();
        const sessionId = randomUint64();
        const keyId = mtproto.authKeyId(key);
        Stmt.insertAuthKey.run(userId, encryptAtRest(key.toString('hex')), keyId, salt, sessionId, '0', now, now);
        const rec = { key, keyId, salt, sessionId, lastMsgId: '0', saltAt: now };
        if (authKeyCache.size >= AUTH_KEY_CACHE_MAX) authKeyCache.delete(authKeyCache.keys().next().value);
        authKeyCache.set(userId, rec);
        return rec;
    }

    function rotateSaltIfNeeded(userId, rec) {
        if (Date.now() - (rec.saltAt || 0) < SALT_ROTATION_MS) return rec;
        rec.salt = randomUint64();
        rec.saltAt = Date.now();
        try { Stmt.updateAuthKeySalt.run(rec.salt, Date.now(), userId); } catch { }
        return rec;
    }

    /* Cifra un contenido con la auth_key del usuario (esquema MTProto 2.0). */
    function encryptForUser(userId, plain) {
        if (typeof plain !== 'string' || plain === '') return plain;
        const rec = rotateSaltIfNeeded(userId, ensureAuthKey(userId));
        const msgId = mtproto.nextMsgId(rec.lastMsgId);
        rec.lastMsgId = msgId;
        try { Stmt.updateAuthKeyMsgId.run(msgId, Date.now(), userId); } catch { }
        return mtproto.encrypt(rec.key, plain, { salt: rec.salt, sessionId: rec.sessionId, msgId, seqNo: 0 }).blob;
    }

    /* Descifra un contenido: PCE3 con la auth_key del usuario; PCE1 (legado)
     * con la llave maestra. Devuelve null si no se puede descifrar. */
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

    /* Contexto del mensaje ligado al cifrado (mismo papel que el AAD del
     * esquema heredado): impide que una fila movida de chat o de autor siga
     * siendo valida. */
    function messageContextBytes(row) {
        return Buffer.from(JSON.stringify({
            domain: 'zlapy/message-context/v3',
            id: row.id, chat: row.chat, ts: row.ts,
            fromId: row.from_id, toId: row.to_id || '', kind: row.kind,
            cryptoGroupId: row.crypto_group_id || ''
        }), 'utf8');
    }

    return {
        authKeyRecord,
        ensureAuthKey,
        rotateSaltIfNeeded,
        encryptForUser,
        decryptForUser,
        messageContextBytes,
        randomUint64,
        authKeyCache,
        SALT_ROTATION_MS
    };
}

module.exports = { createUserAuthKeys, AUTH_KEY_CACHE_MAX, SALT_ROTATION_MS };

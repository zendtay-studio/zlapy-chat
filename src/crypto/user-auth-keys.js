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

const mtproto = require('./mtproto');

const AUTH_KEY_CACHE_MAX = 500;

/* Error de dominio: la fila de `user_auth_keys` existe pero NO se descifra
 * con la llave maestra actual. Suele significar dos cosas muy distintas:
 *
 *   · la llave maestra del `.env` no es la que cifró esa fila (se giró la
 *     llave con el servidor vivo: el proceso viejo seguía escribiendo con
 *     la anterior), o
 *   · la fila quedó corrupta.
 *
 * Antes esto se manifestaba como `UNIQUE constraint failed:
 * user_auth_keys.user_id`: `ensureAuthKey` no distinguía "no hay fila" de
 * "hay fila ilegible" y en el segundo caso intentaba un INSERT que
 * reventaba con un error de SQLite que no explicaba nada. Con este error
 * el operador sabe exactamente qué pasar (restaurar la llave del respaldo o
 * resetear la fila de esa cuenta). */
class AuthKeyUnreadableError extends Error {
    constructor(userId, cause) {
        super(`La auth_key del usuario ${userId} existe pero no se descifra con la llave maestra actual. ` +
            'O la llave del .env no es la que la cifró (se giró con el servidor en marcha) o la fila está corrupta. ' +
            'Arregla la fila con `npm run repair -- --apply` o restaura la llave maestra del respaldo.');
        this.name = 'AuthKeyUnreadableError';
        this.code = 'AUTH_KEY_UNREADABLE';
        this.userId = userId;
        if (cause) this.cause = cause;
    }
}

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

    /* Igual que `authKeyRecord`, pero distingue los tres estados:
     *   'ok'       → la fila existe y se descifra
     *   'ausente'  → no hay fila: se puede crear sin más
     *   'ilegible' → hay fila y NO se descifra con la llave actual
     * Es lo que permite que `ensureAuthKey` no intente un INSERT a ciegas
     * sobre una fila que ya existe. */
    function authKeyState(userId) {
        const cached = authKeyCache.get(userId);
        if (cached) return { state: 'ok', record: cached };
        const row = Stmt.getAuthKey.get(userId);
        if (!row) return { state: 'ausente', record: null };
        let key = null;
        try { key = Buffer.from(decryptAtRest(row.auth_key), 'hex'); } catch { }
        if (!key || key.length !== mtproto.AUTH_KEY_BYTES)
            return { state: 'ilegible', record: null };
        const rec = { key, keyId: row.key_id };
        if (authKeyCache.size >= AUTH_KEY_CACHE_MAX) authKeyCache.delete(authKeyCache.keys().next().value);
        authKeyCache.set(userId, rec);
        return { state: 'ok', record: rec };
    }

    /* Devuelve la auth_key del usuario, creandola si todavia no existe. */
    function ensureAuthKey(userId) {
        const { state, record } = authKeyState(userId);
        if (state === 'ok') return record;
        /* Fila presente pero ilegible: NO se inserta nada (sería un
         * `UNIQUE constraint failed` que oculta la causa real) y NO se
         * regenera la clave en silencio (dejaría sin descifrar todo el
         * contenido del usuario). Se lanza un error que sí explica qué
         * pasa. */
        if (state === 'ilegible') throw new AuthKeyUnreadableError(userId);
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
        authKeyState,
        ensureAuthKey,
        encryptForUser,
        decryptForUser,
        messageContextBytes,
        authKeyCache
    };
}

module.exports = { createUserAuthKeys, AuthKeyUnreadableError, AUTH_KEY_CACHE_MAX };

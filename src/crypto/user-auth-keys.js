/**
 * Gestión de la clave de cifrado por usuario (auth_key) y helpers de cifrado
 * por usuario.
 *
 * La auth_key son 2048 bits aleatorios, se guarda CIFRADA con la llave
 * maestra (PCE1) y cifra todo el contenido del usuario con el esquema
 * MTProto 2.0 (PCE3 / PCE3A, AES-256-IGE con el armazón completo).
 */
'use strict';

const mtproto = require('./mtproto');
const { aadAuthKey } = require('./aad.js');

const AUTH_KEY_CACHE_MAX = 500;

/* Sobres de contenido por usuario: `PCE3A:` es el PCE3 con contexto (AAD),
   `PCE3:` el de siempre (sin contexto, legado y aún legible). */
const PCE3 = mtproto.ENVELOPE_PCE3;
const PCE3A = 'PCE3A:';

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

    /* M7: la auth_key viaja cifrada con la llave maestra ATADA a su usuario
     * (AAD). Un sobre copiado de otra fila no descifra: antes cualquier
     * `auth_key` cifrada valía en cualquier otra fila de la tabla, así que
     * copiar una fila ajena bastaba para secuestrar el contenido de esa
     * cuenta. Los valores heredados (sin AAD) se siguen leyendo y se re-atan
     * al volver a escribir la fila. */
    const encAuthKey = (userId, plain) => encryptAtRest(plain, aadAuthKey(userId));
    const decAuthKey = (userId, blob) => {
        const conAad = decryptAtRest(blob, aadAuthKey(userId));
        return typeof conAad === 'string' ? conAad : decryptAtRest(blob);
    };

    /* Clave cargada de la base (la auth_key viaja cifrada con la llave
     * maestra del servidor). */
    function authKeyRecord(userId) {
        const cached = authKeyCache.get(userId);
        if (cached) return cached;
        const row = Stmt.getAuthKey.get(userId);
        if (!row) return null;
        let key = null;
        try { key = Buffer.from(decAuthKey(userId, row.auth_key), 'hex'); } catch { }
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
        try { key = Buffer.from(decAuthKey(userId, row.auth_key), 'hex'); } catch { }
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
        Stmt.insertAuthKey.run(userId, encAuthKey(userId, key.toString('hex')), keyId, now, now);
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

    /* Cifra un contenido con la auth_key del usuario (PCE3, MTProto 2.0).
     *
     * M1: con `context`, el sobre se marca `PCE3A:` y el contexto viaja como
     * AAD autenticado: el texto cifrado solo se puede abrir en SU pieza (el
     * nombre de ESTE perfil, la historia de ESTA cuenta y ESTE instante, el
     * resumen de ESTE chat…). Sin contexto se emite el `PCE3:` de siempre,
     * que se sigue leyendo igual. */
    function encryptForUser(userId, plain, context = null) {
        if (typeof plain !== 'string' || plain === '') return plain;
        const rec = ensureAuthKey(userId);
        const blob = mtproto.encrypt(rec.key, plain, context).blob;
        return context ? PCE3A + blob.slice(PCE3.length) : blob;
    }

    /* Descifra un contenido: PCE3A (con contexto) o PCE3 (legado, sin AAD);
     * cualquier otra cadena pasa por el descifrado en reposo (PCE1/llano)
     * tal cual. Devuelve null si no se puede descifrar.
     *
     * Compatibilidad: lo escrito antes de atar el contexto sigue abriéndose.
     * Para un `PCE3:` se prueba primero SIN contexto (así era como se cifró)
     * y, si fallara, con el que se pase; un `PCE3A:` exige el contexto. */
    function decryptForUser(userId, blob, context = null) {
        if (typeof blob !== 'string' || blob === '') return blob;
        if (blob.startsWith(PCE3A)) {
            if (!context) return null;
            const rec = authKeyRecord(userId);
            if (!rec) return null;
            const out = mtproto.decrypt(rec.key, PCE3 + blob.slice(PCE3A.length), context);
            return out ? out.body.toString('utf8') : null;
        }
        if (blob.startsWith(PCE3)) {
            const rec = authKeyRecord(userId);
            if (!rec) return null;
            const sinContexto = mtproto.decrypt(rec.key, blob);
            if (sinContexto) return sinContexto.body.toString('utf8');
            if (!context) return null;
            const conContexto = mtproto.decrypt(rec.key, blob, context);
            return conContexto ? conContexto.body.toString('utf8') : null;
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

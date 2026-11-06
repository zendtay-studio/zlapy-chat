/**
 * Credencial del propietario: de DB_USER + DB_PASSWORD a la llave maestra.
 *
 * La llave maestra ya no es un valor aleatorio guardado en el `.env`: es el
 * RESULTADO de derivar (con scrypt) la credencial del propietario. Eso hace
 * que la credencial sea la única fuente de la llave y que cambiarla obligue
 * a re-cifrar todo el material que dependía de ella.
 *
 * Lo que vive en la tabla `meta` (que ya existía; no se añade ninguna tabla
 * nueva):
 *
 *   · owner_user        → el DB_USER con el que se derivó la llave
 *   · kdf_salt          → sal de 16 bytes (base64), única por instalación
 *   · kdf_params        → {alg, N, r, p, dkLen} de la derivación
 *   · keycheck          → "zlapy-keycheck-v1" cifrado con la llave: es la
 *                         COMPROBACIÓN de que la credencial es la correcta
 *                         (si no descifra, la credencial es de otra base o
 *                         está mal escrita)
 *   · key_id            → huella HMAC de la llave: identifica la
 *                         instalación sin revelar nada
 *   · integrity_manifest → digest HMAC del material que ATA la credencial a
 *                         esta base (sal, parámetros, keycheck, usuario,
 *                         key_id): detecta que alguien manipuló el enlace
 *                         credencial ↔ base
 *
 * Nada de esto es reversible sin la credencial: sin DB_USER + DB_PASSWORD la
 * base es un montón de bytes inservibles.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { deriveMasterKey, SCRYPT_PARAMS } = require('./kdf.js');
const { createMessageCrypto } = require('./message-crypto.js');

const META = Object.freeze({
    user: 'owner_user',
    salt: 'kdf_salt',
    params: 'kdf_params',
    check: 'keycheck',
    keyId: 'key_id',
    manifest: 'integrity_manifest'
});

/* Texto conocido que se cifra con la llave y se vuelve a descifrar para
   comprobar que la credencial es la de esta base. */
const KEYCHECK_PLAINTEXT = 'zlapy-keycheck-v1';

const INTEGRITY_DOMAIN = 'zlapy/integrity/v1';

/* ────────────────────────── Base de datos ────────────────────────── */

/**
 * Ejecuta una función sobre la base de datos de la instalación.
 *
 * Reutiliza la conexión ya abierta por el servidor (si la hay) y, si no,
 * abre la suya. `readOnly` fuerza una conexión de solo lectura (auditorías
 * y scripts que no deben escribir).
 *
 * @param {Function} fn   recibe el handle de la base
 * @param {object} [options] {readOnly, dbPath}
 * @returns {*} lo que devuelva fn
 */
function withDb(fn, { readOnly = false, dbPath } = {}) {
    if (!dbPath) {
        try {
            const { db } = require('../db/database.js');
            if (db && db.open) return fn(db);
        } catch (error) { /* la base aún no está abierta: se abre aquí */ }
    }
    const { DB_PATH } = require('../config.js');
    const target = dbPath || DB_PATH;
    const Database = require('better-sqlite3');
    const db = new Database(target, readOnly ? { readonly: true, fileMustExist: true } : {});
    try { return fn(db); }
    finally { try { db.close(); } catch (error) { /* best-effort */ } }
}

/** Lee una fila de `meta`. */
function readMetaValue(key, options = {}) {
    return withDb(db => {
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row ? row.value : null;
    }, options);
}

/** Escribe una fila de `meta`. */
function writeMetaValue(key, value, options = {}) {
    return withDb(db => {
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
    }, options);
}

/** Lee varias filas de `meta` de una vez. */
function readMetaRows(keys, options = {}) {
    return withDb(db => {
        const out = {};
        const stmt = db.prepare('SELECT value FROM meta WHERE key = ?');
        for (const key of keys) {
            const row = stmt.get(key);
            out[key] = row ? row.value : null;
        }
        return out;
    }, options);
}

/* ────────────────────────── Credencial ────────────────────────── */

/**
 * Lee la credencial del propietario del entorno.
 *
 * `DB_USER` + `DB_PASSWORD`, o `DB_USER` + `DB_PASSWORD_FILE` (la contraseña
 * en un fichero 0600, para no dejarla escrita en el `.env`).
 *
 * @param {object} [env] por defecto process.env
 * @returns {{user: string, password: string, source: string}|null}
 */
function readCredential(env = process.env) {
    const user = typeof env.DB_USER === 'string' ? env.DB_USER.trim() : '';
    if (!user) return null;
    const file = typeof env.DB_PASSWORD_FILE === 'string' ? env.DB_PASSWORD_FILE.trim() : '';
    if (file) {
        let password = '';
        try { password = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, ''); }
        catch (error) {
            throw new Error(`No se pudo leer DB_PASSWORD_FILE (${file}): ${error.message}`);
        }
        if (!password) return null;
        return { user, password, source: file };
    }
    const password = typeof env.DB_PASSWORD === 'string' ? env.DB_PASSWORD : '';
    if (!password) return null;
    return { user, password, source: 'DB_PASSWORD' };
}

/* Huella de la credencial (HMAC con dominio fijo): sirve para detectar que
   la credencial cambió sin guardar la contraseña en ningún sitio. */
function credentialFingerprint(credential) {
    if (!credential || !credential.user || !credential.password) return null;
    return crypto.createHmac('sha256', Buffer.from('zlapy/credential/v1', 'utf8'))
        .update(`${credential.user}\0${credential.password}`, 'utf8')
        .digest('hex');
}

/* ────────────────────────── Derivación ────────────────────────── */

/**
 * Lee de `meta` la sal y los parámetros de la derivación.
 *
 * @returns {{salt: Buffer, params: object}|null} null si la base no tiene
 *          credencial (instalación sin inicializar).
 */
function readKdfMaterial(options = {}) {
    const rows = readMetaRows([META.salt, META.params], options);
    if (!rows[META.salt]) return null;
    let params = SCRYPT_PARAMS;
    if (rows[META.params]) {
        try {
            const parsed = JSON.parse(rows[META.params]);
            if (parsed && typeof parsed === 'object') params = { ...SCRYPT_PARAMS, ...parsed };
        } catch { /* params corruptos: se usan los de por defecto */ }
    }
    let salt;
    try { salt = Buffer.from(String(rows[META.salt]), 'base64'); }
    catch { return null; }
    if (salt.length < 8) return null;
    return { salt, params };
}

/**
 * Deriva la llave maestra de una credencial con la sal de `meta`.
 *
 * @param {{user: string, password: string}} credential
 * @param {{salt: Buffer, params: object}} material
 * @returns {Buffer} 32 bytes
 */
function deriveFromCredential(credential, material) {
    return deriveMasterKey(credential.user, credential.password, material.salt, material.params);
}

/**
 * Deriva la llave maestra y comprueba que corresponde a esta base.
 *
 * @param {object} [options] {credential, dbPath}
 * @returns {{key: Buffer, credential: object, material: object}}
 * @throws {Error} si no hay credencial, si la base no está inicializada o si
 *         el keycheck no descifra (credenciales incorrectas).
 */
function unlockMasterKey(options = {}) {
    const credential = options.credential || readCredential();
    if (!credential)
        throw new Error('Falta la credencial del propietario: pon DB_USER y DB_PASSWORD en el .env ' +
            '(o DB_PASSWORD_FILE con la contraseña en un fichero) y ejecuta `npm run owner -- init` si la base es nueva.');
    const material = readKdfMaterial({ dbPath: options.dbPath });
    if (!material)
        throw new Error('Esta base de datos no tiene credencial de propietario (meta.kdf_salt ausente): ' +
            'ejecuta `npm run owner -- init` para inicializarla.');
    const key = deriveFromCredential(credential, material);
    if (!verifyKeycheck(key, options))
        throw new Error('La credencial no corresponde a esta base de datos: el keycheck no descifra. ' +
            'Comprueba DB_USER y DB_PASSWORD (y que esta base sea la de esta instalación).');
    return { key, credential, material };
}

/* ────────────────────────── Verificaciones ────────────────────────── */

/**
 * Comprueba el keycheck: descifra "zlapy-keycheck-v1" con la llave.
 *
 * @param {Buffer} key
 * @param {object} [options] {dbPath}
 * @returns {boolean}
 */
function verifyKeycheck(key, options = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) return false;
    const stored = readMetaValue(META.check, options);
    if (!stored) return false;
    const cryptoFor = createMessageCrypto(key);
    const plain = cryptoFor.decryptAtRest(stored);
    return typeof plain === 'string' && plain === KEYCHECK_PLAINTEXT;
}

/**
 * Filas de `meta` que atan la credencial a esta base.
 *
 * Se devuelven como pares [clave, valor] SIN escribir nada: así quien llama
 * puede escribirlas en la MISMA transacción que el re-cifrado (la migración)
 * y evitar la ventana en la que la base tendría sal nueva con keycheck viejo.
 *
 * @param {Buffer} key
 * @param {object} options {user, salt, params}
 * @returns {Array<[string, string]>}
 */
function keyMaterialRows(key, { user, salt, params = SCRYPT_PARAMS } = {}) {
    const cryptoFor = createMessageCrypto(key);
    return [
        [META.check, cryptoFor.encryptAtRest(KEYCHECK_PLAINTEXT)],
        [META.user, String(user)],
        [META.salt, Buffer.from(salt).toString('base64')],
        [META.params, JSON.stringify({ alg: 'scrypt', ...params })],
        [META.keyId, keyId(key)]
    ];
}

/**
 * Escribe el keycheck de una llave (y el resto de metadatos de derivación).
 *
 * @param {Buffer} key
 * @param {object} options {user, salt, params, dbPath}
 */
function writeKeyMaterial(key, { user, salt, params = SCRYPT_PARAMS, dbPath } = {}) {
    for (const [clave, valor] of keyMaterialRows(key, { user, salt, params }))
        writeMetaValue(clave, valor, { dbPath });
}

/**
 * Huella de la llave: HMAC con dominio propio, 12 bytes en hex.
 *
 * Identifica la instalación (para logs y para comprobar que dos bases son la
 * misma) sin revelar nada de la llave.
 *
 * @param {Buffer} key
 * @returns {string}
 */
function keyId(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) return '';
    return crypto.createHmac('sha256', Buffer.from('zlapy/key-id/v1', 'utf8'))
        .update(key).digest('hex').slice(0, 24);
}

/**
 * Digest de integridad del material que ATA la credencial a esta base.
 *
 * Cubre SOLO las filas de `meta` que definen el enlace credencial ↔ base
 * (`owner_user`, `kdf_salt`, `kdf_params`, `keycheck`, `key_id`): son las
 * que un atacante con acceso al fichero (y sin la credencial) tendría que
 * reescribir para re-vincular la base a OTRA credencial.
 *
 * NO cubren el resto de `meta` (`crypto_version`, `schema_version`, la
 * VAPID…) ni las `auth_key` de usuarios: cambian con el uso normal
 * (cada arranque, cada registro) y un digest que caduca a la primera
 * escritura no detecta nada: sólo hace llorar al lobo. Ese material lo
 * comprueba la auditoría en profundidad (`npm run owner -- check`), que
 * verifica que TODO se descifra con la credencial actual.
 *
 * @param {Buffer} key
 * @param {object} [options] {dbPath}
 * @returns {string} hex
 */
function computeIntegrityManifest(key, options = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) return '';
    const subkey = Buffer.from(crypto.hkdfSync(
        'sha256', key, Buffer.alloc(0), Buffer.from(INTEGRITY_DOMAIN, 'utf8'), 32
    ));
    /* `options.rows` son los pares [clave, valor] de las filas que todavía
       no se han escrito (la migración calcula el manifiesto ANTES de la
       transacción, para que salga todo junto). Sin `rows` se leen de la
       base. Se ordenan por clave para que el digest no dependa del orden
       de lectura. */
    const filas = options.rows
        ? [...options.rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        : withDb(db => db.prepare('SELECT key, value FROM meta WHERE key IN (?, ?, ?, ?, ?) ORDER BY key')
            .all(META.user, META.salt, META.params, META.check, META.keyId), options)
            .map(fila => [fila.key, fila.value]);
    const partes = filas.map(([clave, valor]) => `met|${clave}|${valor || ''}`);
    return crypto.createHmac('sha256', subkey).update(partes.join('\n'), 'utf8').digest('hex');
}

/**
 * Escribe el manifiesto de integridad de una llave.
 *
 * @param {Buffer} key
 * @param {object} [options] {dbPath}
 * @returns {string} el digest escrito
 */
function writeIntegrityManifest(key, options = {}) {
    const digest = computeIntegrityManifest(key, options);
    if (digest) writeMetaValue(META.manifest, digest, options);
    return digest;
}

/**
 * Comprueba el manifiesto de integridad guardado.
 *
 * @param {Buffer} key
 * @param {object} [options] {dbPath}
 * @returns {{ok: boolean, esperado: string|null, calculado: string}}
 */
function checkIntegrityManifest(key, options = {}) {
    const esperado = readMetaValue(META.manifest, options);
    const calculado = computeIntegrityManifest(key, options);
    return { ok: !!esperado && esperado === calculado, esperado, calculado };
}

/**
 * Abre la base con la credencial del propietario, inicializándola si es
 * una instalación nueva.
 *
 * Dos casos:
 *
 *   · La base YA tiene credencial (meta.kdf_salt): se deriva la llave y se
 *     comprueba el keycheck. Si no descifra, la credencial es incorrecta → error.
 *   · La base es NUEVA (sin credencial y sin datos): se inicializa con la
 *     credencial del `.env` (sal nueva + keycheck) y se sigue.
 *
 * La inicialización automática sólo ocurre en una base SIN datos: si la base
 * tiene contenido pero no tiene credencial (estado inconsistente), es un
 * error que hay que resolver a mano, no algo que se "arregle" derivando una
 * llave nueva (eso deja los datos ilegibles para siempre).
 *
 * @param {object} [options] {credential, dbPath}
 * @returns {{key: Buffer, credential: object, material: object, nuevo: boolean}}
 */
function ensureOwnerCredential(options = {}) {
    const credential = options.credential || readCredential();
    if (!credential)
        throw new Error('Falta la credencial del propietario: pon DB_USER y DB_PASSWORD en el .env ' +
            '(o DB_PASSWORD_FILE con la contraseña en un fichero) y arranca el servidor.');
    const material = readKdfMaterial({ dbPath: options.dbPath });
    if (material) {
        const abierto = unlockMasterKey({ ...options, credential });
        return { ...abierto, nuevo: false };
    }
    // Sin credencial en la base: sólo se inicializa si NO hay datos.
    if (baseConDatos({ dbPath: options.dbPath }))
        throw new Error('Esta base de datos tiene datos pero no tiene credencial de propietario (meta.kdf_salt ausente): ' +
            'no se puede inicializar sin dejar los datos ilegibles. Repárala con `npm run owner -- credential` ' +
            'o empieza de cero con `npm run owner -- reset --yes`.');
    const salt = crypto.randomBytes(16);
    const key = deriveMasterKey(credential.user, credential.password, salt, SCRYPT_PARAMS);
    writeKeyMaterial(key, { user: credential.user, salt, params: SCRYPT_PARAMS, dbPath: options.dbPath });
    writeIntegrityManifest(key, { dbPath: options.dbPath });
    return { key, credential, material: { salt, params: SCRYPT_PARAMS }, nuevo: true };
}

/**
 * ¿La base tiene material que dependa de una llave maestra?
 *
 * No basta con contar cuentas: una base sin usuarios pero con adjuntos,
 * VAPID o campos cifrados (restauración parcial, purga de cuentas) también
 * es "con datos". Derivar una llave nueva encima los volvería ilegibles
 * para siempre, así que se usa el mismo detector que el motor de
 * re-cifrado (incluye auth_keys, grupos, meta, campos y blobs) y, si algo
 * no se puede leer, se asume que HAY datos: es el camino seguro.
 *
 * @param {object} [options] {dbPath, blobPath}
 * @returns {boolean}
 */
function baseConDatos(options = {}) {
    const { hasMasterDataAtRest } = require('../../ops/reencrypt-master.js');
    let dbPath = options.dbPath;
    let blobPath = options.blobPath;
    if (!dbPath || !blobPath) {
        const { DB_PATH, BLOB_DB_PATH } = require('../config.js');
        dbPath = dbPath || DB_PATH;
        blobPath = blobPath || BLOB_DB_PATH;
    }
    return hasMasterDataAtRest(dbPath, blobPath);
}

module.exports = {
    META,
    KEYCHECK_PLAINTEXT,
    withDb,
    readMetaValue,
    writeMetaValue,
    readMetaRows,
    readCredential,
    credentialFingerprint,
    readKdfMaterial,
    deriveFromCredential,
    unlockMasterKey,
    ensureOwnerCredential,
    baseConDatos,
    verifyKeycheck,
    keyMaterialRows,
    writeKeyMaterial,
    keyId,
    computeIntegrityManifest,
    writeIntegrityManifest,
    checkIntegrityManifest
};

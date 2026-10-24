/**
 * Rotación de la llave maestra con re-cifrado completo.
 *
 * Cuando la base YA tiene datos, `npm run key -- --force` no debe dejar
 * huérfano el almacenamiento (sobres ilegibles): aquí vive el mecanismo
 * para que la llave nueva entre y TODO lo que dependía de la anterior se
 * re-cifre consigo, de una sola vez y con reversión.
 *
 * Qué guarda cifrado en reposo CON la maestra (enumeración a la fecha;
 * `PCE1v2:` sobres actuales, `PCE1:` heredados que siguen legibles):
 *
 *   · data/zlapy.db  →  user_auth_keys.auth_key   (la `auth_key` de usuario, envuelta)
 *   · data/zlapy.db  →  groups.keys_cipher        (material E2E del grupo)
 *   · data/zlapy.db  →  meta.value (key `vapid`)  (la clave VAPID)
 *   · data/blob.db   →  blobs.data               (contenido de adjuntos)
 *
 * Todo lo demás (mensajes, resúmenes, notas, historias…) va con la
 * `auth_key` de SU usuario: no depende de la maestra en pantalla y, por
 * tanto, no cambia en la rotación.
 *
 * Los valores en claro que pudiera haber en esas mismas columnas (texto
 * legacy sin cifrar) se re-cifran con la llave nueva: es subida de
 * seguridad gratis, ya que el servidor los leía igualmente con
 * `decryptAtRest` (que devuelve en claro lo que no es sobre).
 *
 * Estrategia anti-estado-medio:
 *
 *   1. VERIFICACIÓN con la llave vieja (sólo lectura): si un solo sobre
 *      dependiente de la maestra no se descifra, se ABORTA sin escribir
 *      nada — significa que el `.env` no contiene la llave que cifró
 *      esos datos.
 *   2. Copia del `.env` → `.env.master-bak` (0600, atómica). Con esta
 *      copia, una muerte a mitad de camino (corte de luz, SIGKILL) deja
 *      el camino de restaurar el `.env` a la llave vieja; SQLite restaura
 *      sus transacciones interrumpidas por sí mismo al reabrir la base,
 *      así que el par (.env, bases) vuelve a ser el de antes.
 *   3. `.env` ← llave nueva (atómica).
 *   4. `zlapy.db` en UNA transacción SQLite (atómica): re-cifrar las
 *      `auth_key` de usuarios, `keys_cipher` de grupos y la fila `meta`.
 *      Si la transacción lanza, mejor-sqlite3 no deja parches.
 *   5. `blob.db` idem.
 *   6. Éxito → se borra la copia de respaldo del paso 2.
 *
 * Reversión: si algo falla en 4/5 (p. ej. blob.db tras haber confirmado
 * zlapy.db), la copia del `.env` SÓLO no alcanza — las filas ya confirmadas
 * quedarían con la llave nueva y el `.env` con la vieja. Por eso cada fila
 * lleva guardado su valor ORIGINAL y la reversión ejecuta transacciones
 * compensadoras que reescriben los originales antes de restaurar el `.env`.
 * Resultado ante un fallo manejado (espacio lleno, disco lento…): el estado
 * queda exactamente como antes de empezar y el error se propaga claro.
 *
 * Ventana sin protección: un SIGKILL o corte de luz a mitad DEJA el proceso
 * a medias env/DB con su respaldo — la operación dura milisegundos, pero no
 * hay contrato de reanudación: si el servidor no pudiera leer las bases
 * tras un arranque con muerte inoportuna, restaúrase `.env.master-bak` a
 * `.env` y las bases desde `npm run backup` antes de reintentar. (Túnel
 * largo para una app autoalojada: el kill-safety completo exige persistir
 * la llave nueva DENTRO de SQLite — se decohere con la semántica de
 * arranque autogenerada.)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { writeSecretFile, setEnvValue } = require('./env-writer.js');

const MASTER_KEY_NAME = 'CHAT_MASTER_KEY';
const BACKUP_SUFFIX = '.master-bak';

// Detecta sobres que dependen de la maestra: PCE1v2 (formato actual, AES
// con subclave HKDF + AAD) y PCE1 (formato heredado, AES directo). El resto
// (null o texto en claro) se trata como en claro.
const isMasterEnvelope = value =>
    typeof value === 'string' && (value.startsWith('PCE1v2:') || value.startsWith('PCE1:'));

const assertBuffer32 = (label, value) => {
    if (!Buffer.isBuffer(value) || value.length !== 32)
        throw new Error(`${label} debe ser un Buffer de exactamente 32 bytes.`);
};

/**
 * ¿Hay material que dependa de la maestra en este `data/`? Se usa en el
 * CLI para decidir: sin datos, `--force` mantiene el comportamiento
 * clásico (sustituir la línea del `.env` y punto); con datos hay que
 * re-cifrar. Es un chequeo ONLY-READ y no requiere el arranque del
 * servidor.
 */
function hasMasterDataAtRest(dbPath, blobPath) {
    if (fs.existsSync(blobPath)) {
        const blobDb = new Database(blobPath, { readonly: true, fileMustExist: true });
        try {
            const fila = blobDb.prepare('SELECT COUNT(*) AS total FROM blobs').get();
            if (Number(fila && fila.total) > 0) return true;
        } catch { /* blob.db sin tabla: está vacía */ }
        finally { try { blobDb.close(); } catch { } }
    }
    if (!fs.existsSync(dbPath)) return false;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        // Sin placeholders: undefined explícito a .get() lanza en
        // better-sqlite3 y haría saltar el catch de «asume datos».
        const hay = sql => {
            const fila = db.prepare(sql).get();
            return Number(fila && fila.total) > 0;
        };
        // Cuentas: misma semántica que el fail-fast del servidor (usuarios > 0).
        if (hay('SELECT COUNT(*) AS total FROM users')) return true;
        // auth_keys por si hubiera un estado no alcanzable sin usuarios.
        if (hay('SELECT COUNT(*) AS total FROM user_auth_keys')) return true;
        // Material de grupos en envoltorio de maestra.
        if (hay('SELECT COUNT(*) AS total FROM groups WHERE keys_cipher IS NOT NULL')) return true;
        // meta con sobre (VAPID).
        if (hay("SELECT COUNT(*) AS total FROM meta WHERE value LIKE 'PCE1v2:%' OR value LIKE 'PCE1:%'")) return true;
        return false;
    } catch { /* esquema a medias → asume datos: es el camino seguro */ return true; }
    finally { try { db.close(); } catch { } }
}

/**
 * Lee y descifra (con la llave vieja) TODO lo dependiente de la maestra,
 * sin escribir nada. Devuelve el plan de re-cifrado; lanza si algo resulta
 * ilegible: girar la llave con los dados del `.env` de otro sería
 * irreversible e inaceptable.
 */
function collectPlan({ dbPath, blobPath, oldCrypto, newCrypto }) {
    const plan = {
        authKeys: [], groups: [], meta: [], blobs: [],
        wrapped: { authKeys: [], groups: [], meta: [], blobs: [] },
        // Los valores TAL CUAL estaban (para la reversión compensada).
        originals: { authKeys: [], groups: [], meta: [], blobs: [] }
    };
    // plain = null si la columna era NULL (groups.keys_cipher admite null),
    // texto en claro si lo era, o texto PLAIN tras descifrar el sobre.
    const plainOf = stored => (isMasterEnvelope(stored) ? oldCrypto.decryptAtRest(stored) : stored);
    // Re-envuelve: null queda null; en claro se ahora cifra (subida de
    // seguridad); en claro heredado gana el sobre con la llave nueva.
    const wrappedOf = plain => (typeof plain === 'string' ? newCrypto.encryptAtRest(plain) : null);

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        for (const fila of db.prepare('SELECT user_id, auth_key FROM user_auth_keys').all()) {
            const plain = plainOf(fila.auth_key);
            if (isMasterEnvelope(fila.auth_key) && typeof plain !== 'string')
                throw new Error(`La auth_key de user_auth_keys (user ${fila.user_id}) no se descifra con la llave del .env: no se puede girar la llave sin ella. Restaura primero la llave maestra del respaldo.`);
            plan.authKeys.push({ id: fila.user_id, plain });
            plan.wrapped.authKeys.push({ id: fila.user_id, cipher: wrappedOf(plain) });
            plan.originals.authKeys.push({ id: fila.user_id, cipher: fila.auth_key });
        }
        for (const fila of db.prepare('SELECT id, keys_cipher FROM groups WHERE keys_cipher IS NOT NULL').all()) {
            const plain = plainOf(fila.keys_cipher);
            if (isMasterEnvelope(fila.keys_cipher) && typeof plain !== 'string')
                throw new Error(`El material E2E del grupo ${fila.id} (groups.keys_cipher) no se descifra con la llave del .env. Restaura primero la llave maestra del respaldo.`);
            plan.groups.push({ id: fila.id, plain });
            plan.wrapped.groups.push({ id: fila.id, cipher: wrappedOf(plain) });
            plan.originals.groups.push({ id: fila.id, cipher: fila.keys_cipher });
        }
        for (const fila of db.prepare('SELECT key, value FROM meta').all()) {
            if (!isMasterEnvelope(fila.value)) continue;   // en claro (schema_version…): no es de la maestra
            const plain = plainOf(fila.value);
            if (typeof plain !== 'string')
                throw new Error(`meta['${fila.key}'] no se descifra con la llave del .env. Restaura primero la llave maestra del respaldo.`);
            plan.meta.push({ key: fila.key, plain });
            plan.wrapped.meta.push({ key: fila.key, cipher: wrappedOf(plain) });
            plan.originals.meta.push({ key: fila.key, cipher: fila.value });
        }
    } finally { try { db.close(); } catch { } }

    // blob.db puede no existir todavía (instalación que aún no recibió adjuntos).
    if (fs.existsSync(blobPath)) {
        const blobDb = new Database(blobPath, { readonly: true, fileMustExist: true });
        try {
            for (const fila of blobDb.prepare('SELECT hash, data FROM blobs').all()) {
                const plain = plainOf(fila.data);
                if (isMasterEnvelope(fila.data) && typeof plain !== 'string')
                    throw new Error(`Un adjunto de blobs (hash ${String(fila.hash).slice(0, 12)}…) no se descifra con la llave del .env. Restaura primero la llave maestra del respaldo.`);
                plan.blobs.push({ hash: fila.hash, plain });
                plan.wrapped.blobs.push({ hash: fila.hash, cipher: wrappedOf(plain) });
                plan.originals.blobs.push({ hash: fila.hash, cipher: fila.data });
            }
        } finally { try { blobDb.close(); } catch { } }
    }
    return plan;
}

/** Reescribe el `.env` con el valor CHAT_MASTER_KEY guardado en `desde`. */
const escribirLlaveDesde = (envPath, desde) => {
    const match = fs.readFileSync(desde, 'utf8').match(/^[ \t]*CHAT_MASTER_KEY[ \t]*=[ \t]*(.*)$/m);
    // Si el respaldo no tenía asignación (imposible en la práctica: se ha
    // generado tras el paso de escritura), se deja vacía: el servidor
    // dirá lo suyo.
    setEnvValue(envPath, MASTER_KEY_NAME, match ? match[1] : '');
};

/**
 * Motor de la rotación: verificación → respaldo `.env` → llave nueva →
 * re-cifrado de `zlapy.db` (una transacción) → re-cifrado de `blob.db`
 * (otra) → limpiar respaldo. Cualquier fallo tras haber escrito restaura
 * el `.env` del respaldo antes de propagar.
 *
 * @param {object} options
 * @param {string} options.dbPath      data/zlapy.db
 * @param {string} options.blobPath    data/blob.db (puede no existir)
 * @param {string} options.envPath     ruta del `.env`
 * @param {Buffer} options.oldKey      llave actual (32 bytes)
 * @param {Buffer} options.newKey      llave nueva (32 bytes)
 * @param {Function} options.cryptoFactory  `createMessageCrypto(key)`
 *        (inyectada para no requerir el arranque entero del servidor)
 * @returns {{authKeys:number, groups:number, meta:number, blobs:number}}
 */
function rotateMasterKey(options) {
    const { dbPath, blobPath, envPath, oldKey, newKey, cryptoFactory } = options;
    assertBuffer32('La llave maestra actual', oldKey);
    assertBuffer32('La llave maestra nueva', newKey);

    // 1) Verificación completa con la vieja: nada escribe todavía.
    const plan = collectPlan({ dbPath, blobPath, oldCrypto: cryptoFactory(oldKey), newCrypto: cryptoFactory(newKey) });

    // 2) Respaldo del `.env` para el retorno al estado previo.
    const backupPath = `${envPath}${BACKUP_SUFFIX}`;
    if (fs.existsSync(backupPath)) {
        throw new Error(`Ya existe ${path.basename(backupPath)} de una rotación anterior interrumpida. ` +
            `Restaura (o borra) ese fichero antes de rotar otra vez.`);
    }
    if (fs.existsSync(envPath)) writeSecretFile(backupPath, fs.readFileSync(envPath));

    try {
        // 3) La llave nueva entra en el `.env`.
        setEnvValue(envPath, MASTER_KEY_NAME, newKey.toString('base64'));

        // 4) zlapy.db: auth_keys, material de grupos y meta (VAPID), todo en
        //    una transacción: los valores de `plan.wrapped` ya fueron
        //    calculados in-memoria con la llave nueva.
        if (fs.existsSync(dbPath)) {
            const db = new Database(dbPath, { fileMustExist: true });
            try {
                const aplicar = db.transaction(() => {
                    const uak = db.prepare('UPDATE user_auth_keys SET auth_key = ? WHERE user_id = ?');
                    for (const fila of plan.wrapped.authKeys) uak.run(fila.cipher, fila.id);
                    const grp = db.prepare('UPDATE groups SET keys_cipher = ? WHERE id = ?');
                    for (const fila of plan.wrapped.groups) grp.run(fila.cipher, fila.id);
                    const met = db.prepare('UPDATE meta SET value = ? WHERE key = ?');
                    for (const fila of plan.wrapped.meta) met.run(fila.cipher, fila.key);
                });
                aplicar();
            } finally { try { db.close(); } catch { } }
        }

        // 5) blob.db: contenido de los adjuntos.
        if (fs.existsSync(blobPath)) {
            const blobDb = new Database(blobPath, { fileMustExist: true });
            try {
                const aplicar = blobDb.transaction(() => {
                    const up = blobDb.prepare('UPDATE blobs SET data = ? WHERE hash = ?');
                    for (const fila of plan.wrapped.blobs) up.run(fila.cipher, fila.hash);
                });
                aplicar();
            } finally { try { blobDb.close(); } catch { } }
        }

        // 6) Éxito: la copia de respaldo ya no hace falta.
        fs.rmSync(backupPath, { force: true });
        return {
            authKeys: plan.authKeys.length,
            groups: plan.groups.length,
            meta: plan.meta.length,
            blobs: plan.blobs.length
        };
    } catch (error) {
        // Reversión compensada: reescribir los valores ORIGINALES en las
        // bases (idempotente: tanto da la transacción que hubiera fallado,
        // reescribir el original sobre filas ya originales no cambia nada)
        // y sólo entonces restaurar el `.env` — así el par (.env, bases)
        // vuelve a ser coherente con la llave vieja.
        try { restaurarOriginals(dbPath, blobPath, plan.originals); }
        catch (falloCompensacion) { error.message += ` (ADVERTENCIA: falló la reversión de las bases: ${falloCompensacion.message})`; }
        try { escribirLlaveDesde(envPath, backupPath); fs.rmSync(backupPath, { force: true }); }
        catch (falloRestauracion) {
            error.message += ` (ADVERTENCIA: falló la restauración del .env desde ${path.basename(backupPath)}: ${falloRestauracion.message})`;
        }
        throw error;
    }
}

/** Transacciones compensadoras: cada base vuelve a sus valores originales. */
function restaurarOriginals(dbPath, blobPath, originals) {
    if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { fileMustExist: true });
        try {
            const revertir = db.transaction(() => {
                const uak = db.prepare('UPDATE user_auth_keys SET auth_key = ? WHERE user_id = ?');
                for (const fila of originals.authKeys) uak.run(fila.cipher, fila.id);
                const grp = db.prepare('UPDATE groups SET keys_cipher = ? WHERE id = ?');
                for (const fila of originals.groups) grp.run(fila.cipher, fila.id);
                const met = db.prepare('UPDATE meta SET value = ? WHERE key = ?');
                for (const fila of originals.meta) met.run(fila.cipher, fila.key);
            });
            revertir();
        } finally { try { db.close(); } catch { } }
    }
    if (fs.existsSync(blobPath)) {
        const blobDb = new Database(blobPath, { fileMustExist: true });
        try {
            const revertir = blobDb.transaction(() => {
                const up = blobDb.prepare('UPDATE blobs SET data = ? WHERE hash = ?');
                for (const fila of originals.blobs) up.run(fila.cipher, fila.hash);
            });
            revertir();
        } finally { try { blobDb.close(); } catch { } }
    }
}

module.exports = { rotateMasterKey, hasMasterDataAtRest, isMasterEnvelope };

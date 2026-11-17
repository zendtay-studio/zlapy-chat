/**
 * Re-cifrado completo del dominio de la llave maestra.
 *
 * Cuando la credencial del propietario cambia, la llave maestra cambia
 * (se deriva de la credencial), y con ella TODOS los datos que dependían
 * de ella. Este módulo es el motor de esa migración: lee, descifra con la
 * llave vieja, cifra con la nueva y escribe, con reversión si algo falla.
 *
 * Qué guarda cifrado en reposo CON la maestra:
 *
 *   · data/zlapy.db  →  user_auth_keys.auth_key   (la `auth_key` de usuario, envuelta)
 *   · data/zlapy.db  →  groups.keys_cipher        (material E2E del grupo)
 *   · data/zlapy.db  →  meta.value                (VAPID, keycheck, manifiesto…)
 *   · data/zlapy.db  →  campos sueltos por columna (ver FIELD_TABLES)
 *   · data/blob.db   →  blobs.data               (contenido de adjuntos)
 *
 * Todo lo demás (mensajes, resúmenes, notas, historias…) va con la
 * `auth_key` de SU usuario (PCE3, extremo a extremo): no depende de la
 * maestra y, por tanto, no cambia.
 *
 * Estrategia anti-estado-medio:
 *
 *   1. VERIFICACIÓN con la llave vieja (sólo lectura): si un solo sobre
 *      dependiente de la maestra no se descifra, se ABORTA sin escribir
 *      nada — significa que la credencial actual NO es la que cifró esos
 *      datos, y re-cifrar a ciegas los dejaría ilegibles para siempre.
 *   2. Todo el re-cifrado ocurre dentro de transacciones SQLite (atómicas):
 *      si una falla, no queda parche.
 *   3. Si una base ya se confirmó y la otra falla, se ejecutan
 *      transacciones compensadoras que reescriben los valores ORIGINALES,
 *      dejando el par de bases exactamente como estaba.
 *
 * El `.env` NO se toca aquí: lo escribe el CLI (`ops/auth/owner-credentials.js`)
 * AL FINAL, cuando el re-cifrado ya está confirmado. Si el CLI muriera a
 * mitad, el `.env` seguiría con la credencial vieja y el keycheck fallaría
 * en el arranque → fail-fast explícito, nunca datos a medias.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { FIELD_TABLES, aadOf } = require('../../src/crypto/field-crypto.js');
const { META } = require('../../src/crypto/owner-key.js');
const { aadAuthKey, aadBlob, aadGroupKeys, aadMeta } = require('../../src/crypto/aad.js');
const { assertServerStopped, resolvePidFile, serverIsRunning, acquireMaintenanceLock } = require('../runtime/server-gate.js');

/* Filas de `meta` que atan la credencial a esta base: quien llama puede
   reescribirlas en la MISMA transacción que el re-cifrado (`metaRows`), así
   no existe la ventana en la que la base tendría sal nueva con keycheck
   viejo (ninguna credencial la abriría). */
const CREDENTIAL_KEYS = new Set([META.user, META.salt, META.params, META.check, META.keyId, META.manifest]);

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
 * ¿Hay material que dependa de la maestra en este `data/`?
 *
 * Chequeo ONLY-READ: no necesita la credencial ni arrancar el servidor.
 *
 * @param {string} dbPath
 * @param {string} blobPath
 * @returns {boolean}
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
        // meta con sobre (VAPID, keycheck…).
        if (hay("SELECT COUNT(*) AS total FROM meta WHERE value LIKE 'PCE1v2:%' OR value LIKE 'PCE1:%'")) return true;
        // Campos sueltos cifrados por columna.
        for (const { table, columns } of FIELD_TABLES) {
            const cond = columns.map(c => `"${c}" LIKE 'PCE1v2:%' OR "${c}" LIKE 'PCE1:%'`).join(' OR ');
            if (hay(`SELECT COUNT(*) AS total FROM ${table} WHERE ${cond}`)) return true;
        }
        return false;
    } catch { /* esquema a medias → asume datos: es el camino seguro */ return true; }
    finally { try { db.close(); } catch { } }
}

/**
 * Lee y descifra (con la llave vieja) TODO lo dependiente de la maestra,
 * sin escribir nada. Devuelve el plan de re-cifrado; lanza si algo resulta
 * ilegible: migrar con datos que no descifran sería irreversible.
 *
 * @param {object} options
 * @param {string} options.dbPath
 * @param {string} options.blobPath
 * @param {object} options.oldCrypto  createMessageCrypto(llaveVieja)
 * @param {object} options.newCrypto  createMessageCrypto(llaveNueva)
 * @returns {object} plan de re-cifrado
 */
function collectPlan({ dbPath, blobPath, oldCrypto, newCrypto }) {
    const plan = {
        authKeys: [], groups: [], meta: [], blobs: [], fields: [],
        wrapped: { authKeys: [], groups: [], meta: [], blobs: [], fields: [] },
        // Los valores TAL CUAL estaban (para la reversión compensada).
        originals: { authKeys: [], groups: [], meta: [], blobs: [], fields: [], credential: [] }
    };
    // plain = null si la columna era NULL (groups.keys_cipher admite null),
    // texto en claro si lo era, o texto PLAIN tras descifrar el sobre.
    const plainOf = stored => (isMasterEnvelope(stored) ? oldCrypto.decryptAtRest(stored) : stored);
    // Re-envuelve: null queda null; en claro se ahora cifra (subida de
    // seguridad); en claro heredado gana el sobre con la llave nueva.
    const wrappedOf = plain => (typeof plain === 'string' ? newCrypto.encryptAtRest(plain) : null);
    /* M7: lectura y escritura CON el contexto de cada pieza. La lectura prueba
       primero con el AAD y, si el valor se escribió antes de atarlo, lo reintenta
       sin él (compatibilidad); la escritura SIEMPRE lo lleva. Sin esto, una
       rotación de la llave maestra perdería el AAD de todo lo ya escrito (o
       fallaría al no poder leer lo que sí era suyo). */
    const plainOfCtx = (stored, aad) => {
        if (!isMasterEnvelope(stored)) return stored;
        const conAad = oldCrypto.decryptAtRest(stored, aad);
        return typeof conAad === 'string' ? conAad : oldCrypto.decryptAtRest(stored);
    };
    const wrappedOfCtx = (plain, aad) => (typeof plain === 'string' ? newCrypto.encryptAtRest(plain, aad) : null);

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        for (const fila of db.prepare('SELECT user_id, auth_key FROM user_auth_keys').all()) {
            // M7: la auth_key va atada a su usuario.
            const plain = plainOfCtx(fila.auth_key, aadAuthKey(fila.user_id));
            if (isMasterEnvelope(fila.auth_key) && typeof plain !== 'string')
                throw new Error(`La auth_key de user_auth_keys (user ${fila.user_id}) no se descifra con la credencial actual: no se puede migrar sin ella.`);
            plan.authKeys.push({ id: fila.user_id, plain });
            plan.wrapped.authKeys.push({ id: fila.user_id, cipher: wrappedOfCtx(plain, aadAuthKey(fila.user_id)) });
            plan.originals.authKeys.push({ id: fila.user_id, cipher: fila.auth_key });
        }
        for (const fila of db.prepare('SELECT id, keys_cipher FROM groups WHERE keys_cipher IS NOT NULL').all()) {
            // M7: el material del grupo va atado a su gid.
            const plain = plainOfCtx(fila.keys_cipher, aadGroupKeys(fila.id));
            if (isMasterEnvelope(fila.keys_cipher) && typeof plain !== 'string')
                throw new Error(`El material E2E del grupo ${fila.id} (groups.keys_cipher) no se descifra con la credencial actual.`);
            plan.groups.push({ id: fila.id, plain });
            plan.wrapped.groups.push({ id: fila.id, cipher: wrappedOfCtx(plain, aadGroupKeys(fila.id)) });
            plan.originals.groups.push({ id: fila.id, cipher: fila.keys_cipher });
        }
        for (const fila of db.prepare('SELECT key, value FROM meta').all()) {
            // Las filas que atan la credencial (sal, keycheck…) se guardan
            // aparte: quien llama puede reescribirlas en la MISMA transacción
            // (metaRows) y la reversión tiene que devolverlas tal cual
            // estaban, sean o no sobres cifrados.
            if (CREDENTIAL_KEYS.has(fila.key)) {
                plan.originals.credential.push([fila.key, fila.value]);
                if (isMasterEnvelope(fila.value)) {
                    // M7: cada fila de meta con sobre va atada a su clave.
                    const plain = plainOfCtx(fila.value, aadMeta(fila.key));
                    if (typeof plain !== 'string')
                        throw new Error(`meta['${fila.key}'] no se descifra con la credencial actual.`);
                    plan.meta.push({ key: fila.key, plain });
                    plan.wrapped.meta.push({ key: fila.key, cipher: wrappedOfCtx(plain, aadMeta(fila.key)) });
                    plan.originals.meta.push({ key: fila.key, cipher: fila.value });
                }
                continue;
            }
            if (!isMasterEnvelope(fila.value)) continue;   // en claro (schema_version…): no es de la maestra
            const plain = plainOfCtx(fila.value, aadMeta(fila.key));
            if (typeof plain !== 'string')
                throw new Error(`meta['${fila.key}'] no se descifra con la credencial actual.`);
            plan.meta.push({ key: fila.key, plain });
            plan.wrapped.meta.push({ key: fila.key, cipher: wrappedOfCtx(plain, aadMeta(fila.key)) });
            plan.originals.meta.push({ key: fila.key, cipher: fila.value });
        }
        // Campos sueltos por columna (avatar/wallpaper van en blobs: esto es
        // texto: nombres de grupos, invitaciones, Stickers, silenciados…).
        for (const { table, columns } of FIELD_TABLES) {
            const rows = db.prepare(`SELECT rowid, ${columns.map(c => `"${c}"`).join(', ')} FROM ${table}`).all();
            for (const row of rows) {
                for (const column of columns) {
                    const stored = row[column];
                    if (typeof stored !== 'string' || stored === '') continue;
                    const aad = aadOf(`${table}.${column}`);
                    const esSobre = isMasterEnvelope(stored);   // PCE1v2 y PCE1 heredado
                    const plain = esSobre ? oldCrypto.decryptAtRest(stored, aad) : stored;
                    if (esSobre && typeof plain !== 'string')
                        throw new Error(`El campo ${table}.${column} (fila ${row.rowid}) no se descifra con la credencial actual.`);
                    plan.fields.push({ table, rowid: row.rowid, column, plain });
                    plan.wrapped.fields.push({
                        table, rowid: row.rowid, column,
                        cipher: newCrypto.encryptAtRest(plain, aad)
                    });
                    plan.originals.fields.push({ table, rowid: row.rowid, column, cipher: stored });
                }
            }
        }
    } finally { try { db.close(); } catch { } }

    // blob.db puede no existir todavía (instalación que aún no recibió adjuntos).
    if (fs.existsSync(blobPath)) {
        const blobDb = new Database(blobPath, { readonly: true, fileMustExist: true });
        try {
            for (const fila of blobDb.prepare('SELECT hash, data FROM blobs').all()) {
                // M7: el contenido de cada blob va atado a su hash.
                const plain = plainOfCtx(fila.data, aadBlob(fila.hash));
                if (isMasterEnvelope(fila.data) && typeof plain !== 'string')
                    throw new Error(`Un adjunto de blobs (hash ${String(fila.hash).slice(0, 12)}…) no se descifra con la credencial actual.`);
                plan.blobs.push({ hash: fila.hash, plain });
                plan.wrapped.blobs.push({ hash: fila.hash, cipher: wrappedOfCtx(plain, aadBlob(fila.hash)) });
                plan.originals.blobs.push({ hash: fila.hash, cipher: fila.data });
            }
        } finally { try { blobDb.close(); } catch { } }
    }
    return plan;
}

/**
 * Auditoría SOLO LECTURA: qué material NO se descifra con la llave actual.
 *
 * `collectPlan` aborta en cuanto encuentra un sobre ilegible (para no
 * migrar a ciegas). Esta función es la variante que NO aborta: enumera
 * TODO lo ilegible y lo devuelve, para que el operador vea el alcance real
 * del problema antes de decidir. No escribe nada.
 *
 * @param {object} options
 * @param {string} options.dbPath
 * @param {string} options.blobPath
 * @param {Function} options.cryptoFactory  createMessageCrypto(key)
 * @param {Buffer} options.key              llave con la que se comprueba
 */
function auditMasterKey({ dbPath, blobPath, cryptoFactory, key }) {
    assertBuffer32('La llave maestra', key);
    const crypto = cryptoFactory(key);
    /* M7: cada pieza se comprueba con SU contexto (AAD). Un valor escrito
       antes de atarlo se acepta también: la auditoría no debe dar falsos
       positivos precisamente en el momento en que el operador necesita
       saber qué está roto de verdad. */
    const legible = (valor, aad) => {
        if (!isMasterEnvelope(valor)) return true;      // en claro: no depende de la maestra
        if (aad && typeof crypto.decryptAtRest(valor, aad) === 'string') return true;
        return typeof crypto.decryptAtRest(valor) === 'string';
    };

    const reporte = {
        ok: true,
        authKeys: { ok: 0, ilegibles: [] },
        groups: { ok: 0, ilegibles: [] },
        meta: { ok: 0, ilegibles: [] },
        blobs: { ok: 0, ilegibles: [] },
        campos: { ok: 0, ilegibles: [] },
        /* Cuentas cuyo contenido (PCE3) depende de una auth_key ilegible:
           es el radio de impacto real de una desincronización. */
        contenido: { ilegibles: [] }
    };

    if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const nombres = new Map(db.prepare('SELECT id, username FROM users').all().map(f => [f.id, f.username]));
            for (const fila of db.prepare('SELECT user_id, auth_key FROM user_auth_keys').all()) {
                if (legible(fila.auth_key, aadAuthKey(fila.user_id))) { reporte.authKeys.ok++; continue; }
                reporte.authKeys.ilegibles.push(fila.user_id);
                const mensajes = db.prepare('SELECT COUNT(*) AS total FROM messages WHERE from_id = ? OR to_id = ?')
                    .get(fila.user_id, fila.user_id);
                const perfil = db.prepare(
                    "SELECT COUNT(*) AS total FROM user_profiles WHERE user_id = ? AND (display_name LIKE 'PCE3%' OR bio LIKE 'PCE3%' OR note LIKE 'PCE3%')"
                ).get(fila.user_id);
                const notas = db.prepare('SELECT COUNT(*) AS total FROM user_notes WHERE user_id = ?').get(fila.user_id);
                reporte.contenido.ilegibles.push({
                    user_id: fila.user_id,
                    username: nombres.get(fila.user_id) || '(desconocido)',
                    mensajes: Number(mensajes.total),
                    camposPerfil: Number(perfil.total),
                    notas: Number(notas.total)
                });
            }
            for (const fila of db.prepare('SELECT id, keys_cipher FROM groups WHERE keys_cipher IS NOT NULL').all()) {
                if (legible(fila.keys_cipher, aadGroupKeys(fila.id))) reporte.groups.ok++;
                else reporte.groups.ilegibles.push(fila.id);
            }
            for (const fila of db.prepare('SELECT key, value FROM meta').all()) {
                if (!isMasterEnvelope(fila.value)) continue;
                if (legible(fila.value, aadMeta(fila.key))) reporte.meta.ok++;
                else reporte.meta.ilegibles.push(fila.key);
            }
            for (const { table, columns } of FIELD_TABLES) {
                const rows = db.prepare(`SELECT rowid, ${columns.map(c => `"${c}"`).join(', ')} FROM ${table}`).all();
                for (const row of rows) {
                    for (const column of columns) {
                        const stored = row[column];
                        if (typeof stored !== 'string' || stored === '') continue;
                        if (!isMasterEnvelope(stored)) { reporte.campos.ok++; continue; }
                        if (legible(stored, aadOf(`${table}.${column}`))) reporte.campos.ok++;
                        else reporte.campos.ilegibles.push({ tabla: table, columna: column, fila: row.rowid });
                    }
                }
            }
        } catch (error) {
            reporte.ok = false;
            reporte.error = error.message;
        } finally { try { db.close(); } catch { } }
    }

    if (fs.existsSync(blobPath)) {
        const blobDb = new Database(blobPath, { readonly: true, fileMustExist: true });
        try {
            for (const fila of blobDb.prepare('SELECT hash, data FROM blobs').all()) {
                if (legible(fila.data, aadBlob(fila.hash))) reporte.blobs.ok++;
                else reporte.blobs.ilegibles.push(fila.hash);
            }
        } catch (error) {
            reporte.ok = false;
            reporte.error = reporte.error || error.message;
        } finally { try { blobDb.close(); } catch { } }
    }

    reporte.ok = reporte.ok &&
        reporte.authKeys.ilegibles.length === 0 &&
        reporte.groups.ilegibles.length === 0 &&
        reporte.meta.ilegibles.length === 0 &&
        reporte.blobs.ilegibles.length === 0 &&
        reporte.campos.ilegibles.length === 0;
    return reporte;
}

/**
 * Ruta del fichero de PID y comprobación de "servidor vivo" viven ahora en
 * ops/runtime/server-gate.js, compartidos por TODAS las operaciones de
 * mantenimiento (M5): antes cada script tenía su propia copia, con su propia
 * idea de qué PID comprobar.
 */

/**
 * Motor del re-cifrado: verificación → re-cifrado transaccional de
 * `zlapy.db` → re-cifrado transaccional de `blob.db`. Si una base ya se
 * confirmó y la otra falla, se ejecutan las transacciones compensadoras
 * que devuelven los valores originales.
 *
 * NO escribe el `.env`: eso lo hace el CLI, al final, con la credencial
 * nueva.
 *
 * @param {object} options
 * @param {string} options.dbPath      data/zlapy.db
 * @param {string} options.blobPath    data/blob.db (puede no existir)
 * @param {Buffer} options.oldKey      llave actual (32 bytes)
 * @param {Buffer} options.newKey      llave nueva (32 bytes)
 * @param {Function} options.cryptoFactory  `createMessageCrypto(key)`
 * @param {string} [options.pidFile]
 * @returns {{authKeys:number, groups:number, meta:number, blobs:number, campos:number}}
 */
function rotateMasterKey(options) {
    const { dbPath, pidFile } = options;

    // 0) El servidor debe estar PARADO (compuerta común, M5).
    assertServerStopped({ pidFile, dbPath }, {
        motivo: 'Deténlo antes de migrar la credencial: si sigue vivo, seguiría cifrando con la llave anterior ' +
            'y dejaría filas que la llave nueva no descifra.'
    });
    // 0b) Nadie más puede estar tocando las bases (M10): un re-cifrado en
    // paralelo con otro (o con una reparación de auth_keys) corrompe la base.
    const candado = acquireMaintenanceLock({ dbPath, etiqueta: 'reencrypt-master' });
    try {
        return rotateMasterKeyLocked(options);
    } finally {
        candado.release();
    }
}

function rotateMasterKeyLocked(options) {
    const { dbPath, blobPath, oldKey, newKey, cryptoFactory, metaRows = [] } = options;
    assertBuffer32('La llave maestra actual', oldKey);
    assertBuffer32('La llave maestra nueva', newKey);

    // 1) Verificación completa con la vieja: nada escribe todavía.
    const plan = collectPlan({ dbPath, blobPath, oldCrypto: cryptoFactory(oldKey), newCrypto: cryptoFactory(newKey) });

    try {
        // 2) zlapy.db: auth_keys, material de grupos, meta y campos sueltos,
        //    todo en UNA transacción (los valores de `plan.wrapped` ya
        //    fueron calculados en memoria con la llave nueva).
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
                    for (const fila of plan.wrapped.fields)
                        db.prepare(`UPDATE ${fila.table} SET "${fila.column}" = ? WHERE rowid = ?`).run(fila.cipher, fila.rowid);
                    /* Las filas de la credencial (sal, keycheck, manifiesto…) van
                       DENTRO de la misma transacción: tras un corte a mitad, la
                       base abre con la credencial NUEVA (y el .env viejo da un
                       fail-fast claro), nunca con NINGUNA. */
                    const cred = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
                    for (const [clave, valor] of metaRows) cred.run(clave, valor);
                });
                aplicar();
            } finally { try { db.close(); } catch { } }
        }

        // 3) blob.db: contenido de los adjuntos.
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

        return {
            authKeys: plan.authKeys.length,
            groups: plan.groups.length,
            meta: plan.meta.length,
            blobs: plan.blobs.length,
            campos: plan.fields.length
        };
    } catch (error) {
        // Reversión compensada: reescribir los valores ORIGINALES en las
        // bases (idempotente) y propagar el error.
        try { restaurarOriginals(dbPath, blobPath, plan.originals); }
        catch (falloCompensacion) { error.message += ` (ADVERTENCIA: falló la reversión de las bases: ${falloCompensacion.message})`; }
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
                for (const fila of originals.fields)
                    db.prepare(`UPDATE ${fila.table} SET "${fila.column}" = ? WHERE rowid = ?`).run(fila.cipher, fila.rowid);
                /* Las filas de la credencial vuelven TAL CUAL estaban (sean o
                   no sobres cifrados): sin esto, la reversión dejaría la sal
                   nueva con el keycheck viejo. */
                const cred = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
                for (const [clave, valor] of originals.credential) cred.run(clave, valor);
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

module.exports = {
    rotateMasterKey,
    hasMasterDataAtRest,
    isMasterEnvelope,
    auditMasterKey,
    serverIsRunning,
    resolvePidFile,
    collectPlan,
    FIELD_TABLES
};

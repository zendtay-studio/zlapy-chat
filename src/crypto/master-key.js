/**
 * Llave maestra del servidor.
 *
 * Obtiene la llave de 32 bytes que cifra los datos en reposo: la lee de
 * CHAT_MASTER_KEY o del fichero `.zlapymasterkey`, la genera si no existe
 * ninguna y se niega a arrancar si falta la llave de una base con datos.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BLOB_DB_PATH, CONFIG, DB_PATH, ROOT } = require('../config.js');

// Cifrado en reposo (llave maestra)
const MASTER_KEY_PATH = path.join(ROOT, '.zlapymasterkey');

/**
 * ¿La base de datos ya contiene datos de verdad?
 *
 * No basta con que exista el fichero: una base recién creada (sólo con el
 * esquema, sin cuentas) es tan inofensiva como no tener base, y en ese caso se
 * puede generar la llave maestra sin riesgo. Se cuentan las filas de `users`
 * porque toda instalación con contenido tiene al menos una cuenta.
 *
 * Si la base no se puede leer (por ejemplo, `better-sqlite3` sin compilar en
 * Android) se asumen datos: es el camino seguro, porque generar una llave
 * nueva con datos cifrados los volvería ilegibles.
 *
 * @param {{dbPath?: string, blobPath?: string}} options rutas alternativas
 *        (sólo para las pruebas).
 */
function baseDeDatosConDatos(options = {}) {
    const dbPath = options.dbPath || DB_PATH;
    const blobPath = options.blobPath || BLOB_DB_PATH;
    const usaRutasPorDefecto = !options.dbPath && !options.blobPath;
    if (!fs.existsSync(dbPath) && !fs.existsSync(blobPath)) return false;
    let db = null;
    let abiertaAqui = false;
    try {
        // Si el módulo de datos ya está cargado, se usa su conexión (es la que
        // tiene el esquema aplicado). Si no, se abre en sólo lectura.
        if (usaRutasPorDefecto) {
            try { db = require('../db/database.js').db; } catch (error) { db = null; }
        }
        if (!db) {
            const Database = require('better-sqlite3');
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
            abiertaAqui = true;
        }
        const fila = db.prepare('SELECT COUNT(*) AS total FROM users').get();
        return Number(fila && fila.total) > 0;
    } catch (error) {
        return true;
    } finally {
        if (db && abiertaAqui) { try { db.close(); } catch (error) { /* best-effort */ } }
    }
}

const getMasterKeyBytes = () => {
    if (CONFIG.chatMasterKey) {
        const key = Buffer.from(CONFIG.chatMasterKey, 'base64');
        if (key.length !== 32) throw new Error('CHAT_MASTER_KEY must encode exactly 32 bytes.');
        if (fs.existsSync(MASTER_KEY_PATH)) {
            console.warn(`[crypto] CHAT_MASTER_KEY (del .env) tiene prioridad sobre ${path.relative(ROOT, MASTER_KEY_PATH)}.`);
        }
        return key;
    }
    const keyFileExists = fs.existsSync(MASTER_KEY_PATH);
    // Fail-fast: si ya existe una base de datos con datos y la llave maestra no
    // está disponible, se aborta. Regenerarla en silencio haría irreversibles
    // todos los mensajes, historias y adjuntos cifrados con la llave anterior.
    if (!keyFileExists && baseDeDatosConDatos())
        throw new Error(`Falta ${MASTER_KEY_PATH} (o CHAT_MASTER_KEY) y ya existe una base de datos con datos. ` +
            'Restaura la llave maestra desde tu respaldo antes de arrancar: una llave nueva haría ' +
            'ilegibles todos los mensajes, historias y adjuntos cifrados con la anterior. ' +
            'Si es una instalación nueva, borra la carpeta "data" (o el fichero data/zlapy.db) y vuelve a arrancar.');
    if (keyFileExists) {
        const key = fs.readFileSync(MASTER_KEY_PATH);
        if (key.length !== 32) throw new Error(`${MASTER_KEY_PATH} must contain exactly 32 bytes.`);
        try { fs.chmodSync(MASTER_KEY_PATH, 0o600); } catch { }
        return key;
    }
    // Instalación nueva (base vacía o inexistente): se genera la llave y se
    // guarda en `.zlapymasterkey` para que el servidor arranque sin pasos
    // manuales. El fichero está en `.gitignore` y lo copia `npm run backup`.
    const b = crypto.randomBytes(32);
    try {
        fs.writeFileSync(MASTER_KEY_PATH, b, { mode: 0o600, flag: 'wx' });
        try { fs.chmodSync(MASTER_KEY_PATH, 0o600); } catch { }
        console.log(`[crypto] llave maestra generada en ${path.relative(ROOT, MASTER_KEY_PATH)} (primera instalación).`);
        return b;
    } catch (e) {
        /* Carrera de primera instalación: otro proceso (los servidores de
           prueba arrancan en paralelo, y lo mismo valdría para una op manual
           junto al supervisor) creó la llave entre nuestra comprobación de
           existencia y esta escritura exclusiva. La llave es un SECRETO
           COMPARTIDO, no un valor por proceso: se usa la del ganador. */
        if (e.code !== 'EEXIST') throw e;
        // La escritura del ganador puede no haber completado todavía: se
        // reintenta la lectura unos instantes antes de darla por inválida.
        for (let intento = 0; intento < 50; intento++) {
            try {
                const key = fs.readFileSync(MASTER_KEY_PATH);
                if (key.length === 32) {
                    try { fs.chmodSync(MASTER_KEY_PATH, 0o600); } catch { }
                    return key;
                }
            } catch { }
            // Espera activa mínima: dos procesos arrancando a la vez.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        throw new Error(`${MASTER_KEY_PATH} must contain exactly 32 bytes.`);
    }
};

module.exports = {
    getMasterKeyBytes,
    baseDeDatosConDatos,
};

/**
 * Llave maestra del servidor.
 *
 * Obtiene la llave de 32 bytes que cifra los datos en reposo. Vive SIEMPRE
 * en el `.env` (`CHAT_MASTER_KEY`, base64): el servidor la genera él mismo
 * en el primer arranque de una instalación nueva (base sin datos) y la
 * guarda ahí. No hay fichero de llave aparte: un único lugar del que se
 * copia el respaldo.
 *
 * Fail-fast: si la base ya contiene datos y la llave no está, se niega a
 * arrancar — regenerarla en silencio haría ilegibles todos los mensajes,
 * historias y adjuntos cifrados con la llave anterior.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BLOB_DB_PATH, CONFIG, DB_PATH, ROOT } = require('../config.js');
const { ensureEnvFile, setEnvValue } = require('../../ops/generate-master-key.js');

const ENV_PATH = path.join(ROOT, '.env');

/** Lee y decodifica el valor de `CHAT_MASTER_KEY` directamente del `.env`
 * (sin depender de la caché de CONFIG, que se cargó al arrancar el proceso
 * y no ve la clave que acabamos de escribir). Devuelve Buffer de 32 bytes o
 * null si la asignación está vacía. Un valor malformado lanza: sin llave
 * mejor no seguir. */
function readKeyFromEnvFile(envPath = ENV_PATH) {
    if (!fs.existsSync(envPath)) return null;
    // `[ \t]*`, no `\s*`: en JS el `\s` cruza saltos de línea y el valor de
    // una línea puede "engullir" el comentario siguiente como si fuera suyo.
    const match = fs.readFileSync(envPath, 'utf8').match(/^[ \t]*CHAT_MASTER_KEY[ \t]*=[ \t]*(.*)$/m);
    if (match === null) return null;
    const value = match[1].trim().replace(/^["']|["']$/g, '').trim();
    if (!value) return null;
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32)
        throw new Error('CHAT_MASTER_KEY must encode exactly 32 bytes.');
    return key;
}

/**
 * ¿La base de datos ya contiene datos de verdad?
 *
 * No basta con que exista el fichero: una base recién creada (sólo con el
 * esquema, sin cuentas) es tan inofensiva como no tener base, y en ese caso
 * se puede generar la llave maestra sin riesgo. Se cuentan las filas de
 * `users` porque toda instalación con contenido tiene al menos una cuenta.
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
    // 1) La llave del entorno (.env) manda.
    if (CONFIG.chatMasterKey) {
        const key = Buffer.from(CONFIG.chatMasterKey, 'base64');
        if (key.length !== 32) throw new Error('CHAT_MASTER_KEY must encode exactly 32 bytes.');
        return key;
    }

    // 2) Sin llave y con datos: no se genera nada, se pide la llave del
    //    respaldo. Un `npm run key -- --force` aquí haría irreversible la
    //    pérdida de TODOS los datos, así que este error es el único camino
    //    disponible.
    if (baseDeDatosConDatos())
        throw new Error(`No hay CHAT_MASTER_KEY en ${path.relative(ROOT, ENV_PATH)} y la base de datos ya contiene datos. ` +
            'Restaura la clave maestra desde tu respaldo y pégala en el .env (CHAT_MASTER_KEY=...) antes de arrancar: ' +
            'una clave nueva haría ilegibles todos los mensajes, historias y adjuntos cifrados con la anterior. ' +
            'Si es una instalación nueva, borra la carpeta "data" (o el fichero data/zlapy.db) y vuelve a arrancar.');

    // 3) Instalación nueva (base vacía o inexistente): se genera la llave y
    //    se guarda en el .env. Reconstruir el arranque con una sola lectura:
    //    el supervisor o varios servidores de prueba pueden arrancar a la
    //    vez, y la llave es un SECRETO COMPARTIDO, no un valor por proceso:
    //    si otro proceso escribió la suya primero, se ADOPTA la del
    //    ganador (todos los que arranquen después leerán la misma).
    ensureEnvFile(ENV_PATH);
    for (let intento = 0; intento < 20; intento++) {
        // Otro proceso acaso ganó la carrera entre la carga de CONFIG y
        // aquí: releer el fichero antes de generar.
        const adoptada = readKeyFromEnvFile();
        if (adoptada) {
            console.log('[crypto] llave maestra leída de CHAT_MASTER_KEY (.env).');
            return adoptada;
        }
        const key = crypto.randomBytes(32);
        const encoded = key.toString('base64');
        setEnvValue(ENV_PATH, 'CHAT_MASTER_KEY', encoded);
        // Verificación post-escritura: si otra instalación escribió nuestra
        // entrada casi al mismo tiempo, adoptamos la SUYA (la que quedó
        // en disco, que es la que usará el siguiente arranque).
        let ganadora = null;
        try { ganadora = readKeyFromEnvFile(); } catch { }
        if (ganadora && !ganadora.equals(key)) continue;        // Coherencia interna del proceso: dotenv cargó el `.env` antes de
        // que la clave existiera.
        process.env.CHAT_MASTER_KEY = encoded;
        console.log(`[crypto] llave maestra generada y guardada en CHAT_MASTER_KEY (${path.relative(ROOT, ENV_PATH)}) — primera instalación.`);
        console.log('[crypto] Respaldo sugerido: guarda una copia del .env junto a tus respaldos de base (npm run backup).');
        return key;
    }
    throw new Error('No se pudo fijar CHAT_MASTER_KEY en el .env de forma segura (varios arrancadores compitiendo).');
};

module.exports = {
    getMasterKeyBytes,
    baseDeDatosConDatos,
    readKeyFromEnvFile
};

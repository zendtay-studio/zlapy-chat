/**
 * Llave maestra del servidor.
 *
 * La llave maestra ya NO es un valor aleatorio guardado en el `.env`: es el
 * resultado de derivar la credencial del propietario (DB_USER + DB_PASSWORD)
 * con scrypt. `src/crypto/owner-key.js` explica el modelo; aquí solo se
 * conecta con el arranque y con el vigilante.
 *
 * Fail-fast: sin credencial, con la base sin inicializar o con una credencial
 * que no descifra el keycheck, el arranque falla con un mensaje accionable.
 * En ningún caso se genera una llave nueva: una llave nueva sobre datos
 * existentes los volvería ilegibles para siempre (el incidente que motivó
 * todo este rediseño).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { BLOB_DB_PATH, CONFIG, DB_PATH, ROOT } = require('../config.js');
const { credentialFingerprint, ensureOwnerCredential, readCredential } = require('./owner-key.js');

const ENV_PATH = path.join(ROOT, '.env');

/**
 * ¿La base de datos ya contiene datos de verdad?
 *
 * No basta con que exista el fichero: una base recién creada (sólo con el
 * esquema, sin cuentas) es tan inofensiva como no tener base. Se cuentan las
 * filas de `users` porque toda instalación con contenido tiene al menos una
 * cuenta.
 *
 * Si la base no se puede leer se asumen datos: es el camino seguro.
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

/**
 * La llave maestra de este proceso.
 *
 * Se deriva de la credencial del `.env` y se comprueba contra el keycheck de
 * la base. En una instalación NUEVA (base sin credencial y sin datos) la
 * inicializa con esa credencial. Lanza con un mensaje accionable si algo no
 * cuadra.
 *
 * @returns {Buffer} 32 bytes
 */
const getMasterKeyBytes = () => ensureOwnerCredential().key;

/**
 * Lee la credencial del `.env` (fichero, no entorno del proceso).
 *
 * El vigilante necesita leer el FICHERO: el entorno del proceso no cambia
 * cuando alguien edita el `.env`, y lo que hay que detectar es exactamente
 * ese cambio.
 *
 * @param {string} [envPath]
 * @returns {{user: string, password: string, source: string}|null}
 */
function readCredentialFromEnvFile(envPath = ENV_PATH) {
    if (!fs.existsSync(envPath)) return null;
    const texto = fs.readFileSync(envPath, 'utf8');
    const valor = nombre => {
        const match = texto.match(new RegExp(`^[ \\t]*${nombre}[ \\t]*=[ \\t]*(.*)$`, 'm'));
        if (!match) return '';
        return match[1].trim().replace(/^["']|["']$/g, '').trim();
    };
    const user = valor('DB_USER');
    if (!user) return null;
    const archivo = valor('DB_PASSWORD_FILE');
    if (archivo) {
        const ruta = path.isAbsolute(archivo) ? archivo : path.join(ROOT, archivo);
        try {
            const password = fs.readFileSync(ruta, 'utf8').replace(/\r?\n$/, '');
            if (!password) return null;
            return { user, password, source: ruta };
        } catch { return null; }
    }
    const password = valor('DB_PASSWORD');
    if (!password) return null;
    return { user, password, source: 'DB_PASSWORD' };
}

/**
 * Vigila la credencial del `.env` mientras el servidor está vivo.
 *
 * Por qué: la llave maestra se carga UNA vez, al arrancar. Si alguien cambia
 * la credencial con el servidor en marcha (la migración re-cifra las bases,
 * pero el proceso vivo sigue escribiendo con la llave que tiene en memoria),
 * el resultado es una base con dos llaves: las filas viejas quedan ilegibles
 * y las nuevas se cifran con la que ya no está en el `.env`. Es exactamente
 * la desincronización que sufrió esta instalación.
 *
 * Qué hace: relee la credencial del `.env` cada `intervalMs` y compara su
 * huella. Si cambia, avisa y llama a `onChange` (por defecto: salir con
 * código 75 = EX_TEMPFAIL, para que el supervisor lo reinicie ya con la
 * credencial nueva).
 *
 * @param {object} options
 * @param {object} options.credential  credencial con la que arrancó el proceso
 * @param {string} [options.envPath]   ruta del `.env` que se vigila
 * @param {number} [options.intervalMs] cada cuánto se comprueba
 * @param {Function} [options.onChange] qué hacer si la credencial cambia
 * @returns {{stop: Function, check: Function}}
 */
function watchCredentialFile({ credential, envPath = ENV_PATH, intervalMs = 15000, onChange } = {}) {
    /* La huella de REFERENCIA es la del FICHERO al arrancar, no la del
       entorno del proceso: un servidor puede recibir la credencial por
       variables de entorno (pruebas, contenedores) con un `.env` que diga
       otra cosa, y eso NO es un cambio de credencial — es un arranque
       distinto. Lo que hay que detectar es que el FICHERO cambió respecto
       a lo que él mismo decía cuando este proceso arrancó.
       Sin credencial en el fichero (arranque sólo por entorno) la huella
       es null y el vigilante nunca dispara: no hay nada que vigilar. */
    const huellaInicial = credentialFingerprint(credential || readCredentialFromEnvFile(envPath));
    const avisar = typeof onChange === 'function' ? onChange : () => { process.exit(75); };
    /* El aviso se emite UNA vez: si el proceso no sale (porque `onChange` no
       lo mata), no tiene sentido seguir diciendo lo mismo cada 15 s. */
    let avisada = false;

    const check = () => {
        if (avisada) return false;
        if (!huellaInicial) return false;
        let actual = null;
        let legible = true;
        try { actual = credentialFingerprint(readCredentialFromEnvFile(envPath)); }
        catch { legible = false; }
        /* Un error de lectura (escritura atómica a medias, FS raro) no es
           alarma: se reintenta en el siguiente ciclo. Pero una credencial
           que YA NO ESTÁ (fichero legible, credencial ausente) sí: sin
           ella el arranque siguiente no abriría, y este proceso tiene que
           enterarse ahora, no al reiniciar. */
        if (!legible) return false;
        if (actual && actual === huellaInicial) return false;
        console.error(actual
            ? '[crypto] La credencial del .env cambió con el servidor en marcha: este proceso seguiría cifrando con la llave anterior. '
              + 'Se sale para reiniciar con la credencial nueva (código 75).'
            : '[crypto] La credencial del .env desapareció con el servidor en marcha. '
              + 'Se sale para que el arranque siguiente falle de forma explícita (código 75).');
        avisada = true;
        try { avisar(); } catch { process.exit(75); }
        return true;
    };

    const timer = setInterval(check, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return { stop: () => clearInterval(timer), check };
}

module.exports = {
    getMasterKeyBytes,
    baseDeDatosConDatos,
    readCredential,
    readCredentialFromEnvFile,
    watchCredentialFile,
    CONFIG
};

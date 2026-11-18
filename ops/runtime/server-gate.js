/**
 * Puerta común de mantenimiento.
 *
 * Las operaciones destructivas sobre las bases (re-cifrar la llave maestra,
 * reparar auth_keys, cambiar la credencial del propietario) comparten tres
 * necesidades:
 *
 *   1. SABER si el servidor sigue vivo: si lo está, seguiría escribiendo con
 *      la llave que tiene en memoria y la base acabaría con dos llaves
 *      mezcladas. Cada script tenía su propia copia de esta comprobación, con
 *      su propia idea de qué PID comprobar (y sus propias divergencias).
 *   2. EXIGIR que esté parado, con un único mensaje y el mismo criterio.
 *   3. NO poder solaparse con otra operación igual: dos re-cifrados a la vez
 *      (o un re-cifrado mientras se reparan las auth_keys) corrompen la base.
 *      El candado es O_EXCL sobre un fichero del propio directorio de datos:
 *      el sistema operativo garantiza que solo un proceso lo consigue.
 *
 * También vive aquí la escritura ATÓMICA del fichero de PID del supervisor:
 * antes se escribía el PID a pelo y se le daban los permisos después, así que
 * durante ese hueco otro proceso podía leer un fichero vacío o truncado y
 * concluir que no había servidor (o peor, leer un PID a medio escribir).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_PID_FILE = path.join(ROOT, '.zlapy.pid');

/* Ruta del candado de mantenimiento.
 *
 * Se deriva de la BASE, no del fichero de PID: así dos instalaciones
 * distintas (o dos pruebas con `--db` diferentes) no se pisan el candado, y
 * un candado heredado de una base borrada se detecta como huérfano. */
function lockFilePath(dbPath) {
    const base = dbPath ? path.resolve(path.dirname(path.dirname(dbPath))) : ROOT;
    return path.join(base, '.zlapy.maint.lock');
}

/**
 * Ruta del fichero de PID: se deriva de la ruta de la base para que una
 * instalación de pruebas en un directorio temporal NO se confunda con el
 * servidor de producción (que vive en otra raíz).
 *
 * @param {object} [options]
 * @param {string} [options.dbPath]
 * @param {string} [options.pidFile]
 * @returns {string}
 */
function resolvePidFile({ dbPath, pidFile } = {}) {
    const raiz = dbPath ? path.dirname(path.dirname(dbPath)) : ROOT;
    if (pidFile) return path.isAbsolute(pidFile) ? pidFile : path.join(raiz, pidFile);
    const delEntorno = process.env.SUPERVISOR_PID_FILE;
    if (delEntorno) return path.isAbsolute(delEntorno) ? delEntorno : path.join(raiz, delEntorno);
    /* La raíz manda: una instalación de pruebas en un directorio temporal no
       debe mirar el PID del servidor de producción del repo. */
    return path.join(raiz, '.zlapy.pid');
}

/**
 * ¿Hay un servidor de Zlapy VIVO con esta instalación?
 *
 * El PID guardado solo se acepta si el proceso sigue existiendo Y su línea de
 * comandos es la de este proyecto: un PID reciclado por otro programa no debe
 * bloquear una operación de mantenimiento legítima (y un `.zlapy.pid` de una
 * instalación borrada, tampoco).
 *
 * @param {object} [options]
 * @param {string} [options.pidFile]
 * @param {string} [options.dbPath]
 * @returns {{vivo: boolean, pid?: number, detalle?: string}}
 */
function serverIsRunning({ pidFile, dbPath } = {}) {
    const ruta = resolvePidFile({ dbPath, pidFile });
    let pid = 0;
    try { pid = Number.parseInt(fs.readFileSync(ruta, 'utf8').trim(), 10); }
    catch { return { vivo: false }; }
    if (!Number.isInteger(pid) || pid <= 0) return { vivo: false };
    let cmdline = '';
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); }
    catch { return { vivo: false }; }
    if (!/server\.js|ops\/supervisor\.js/.test(cmdline))
        return { vivo: false, pid, detalle: 'el PID guardado ya no es un servidor de Zlapy' };
    return { vivo: true, pid, detalle: cmdline };
}

/**
 * Compuerta común: aborta si el servidor está vivo.
 *
 * @param {object} [options]igual que serverIsRunning
 * @param {{silencioso?: boolean, motivo?: string}} [opts]
 * @returns {{vivo: boolean, pid?: number}} el resultado de serverIsRunning
 * @throws {Error} si el servidor está en marcha
 */
function assertServerStopped(options = {}, opts = {}) {
    const vivo = serverIsRunning(options);
    if (vivo.vivo) {
        const motivo = opts.motivo
            ? opts.motivo
            : 'Deténlo antes de esta operación: si sigue vivo, seguiría usando la llave que tiene en memoria.';
        throw new Error(`Hay un servidor de Zlapy en marcha (pid ${vivo.pid}). ${motivo}`);
    }
    return vivo;
}

/**
 * Candado EXCLUSIVO de mantenimiento (M10): O_EXCL sobre un fichero del
 * directorio de datos. El sistema operativo garantiza que un solo proceso lo
 * consigue; el resto recibe EEXIST y debe salir.
 *
 * Devuelve `release()`; el candado se suelta también al morir el proceso
 * (SIGINT/SIGTERM/exit), pero se deja el fichero en disco a propósito: si
 * otro proceso tiene el candado CON mayúsculas, borrarlo desde el perdedor
 * rompería la exclusión.
 *
 * @param {object} [options]igual que serverIsRunning
 * @param {string} [options.etiqueta] qué operación es, para el mensaje
 * @returns {{ruta: string, release: Function}}
 * @throws {Error} si otra operación ya lo tiene
 */
function acquireMaintenanceLock(options = {}) {
    const ruta = lockFilePath(options.dbPath);
    let fd = null;
    try {
        // 'wx' = O_CREAT | O_EXCL: falla si ya existe.
        fd = fs.openSync(ruta, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, etiqueta: options.etiqueta || '', ts: Date.now() }) + '\n');
        fs.fsyncSync(fd);
    } catch (error) {
        try { if (fd !== null) fs.closeSync(fd); } catch { /* ya cerrado */ }
        if (error.code === 'EEXIST') {
            let anterior = null;
            try { anterior = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { anterior = null; }
            // Reentrancia: el candado es de ESTE mismo proceso (la operación
            // externa llamó a otra que también lo pide). No es un conflicto.
            if (anterior && anterior.pid === process.pid) {
                if (fd !== null) { try { fs.closeSync(fd); } catch { } fd = null; }
                return { ruta, soltado: true, release: () => { } };
            }
            /* Dueño vivo: se acepta SOLO si el proceso sigue existiendo Y es
               uno de los nuestros. Un PID reciclado por otro programa no debe
               bloquear una operación legítima (y un candado de una base
               borrada, tampoco). */
            let duenio = 'otro proceso';
            if (anterior && Number.isInteger(anterior.pid)) {
                const cmdline = (() => {
                    try { return fs.readFileSync(`/proc/${anterior.pid}/cmdline`, 'utf8'); } catch { return ''; }
                })();
                if (!/(owner-credentials|reencrypt-master|repair-.*)\.js/.test(cmdline)) {
                    // Candado huérfano (el dueño murió o su PID se recicló):
                    // se limpia y se reintenta una vez.
                    try { fs.unlinkSync(ruta); } catch { /* otro lo borró primero */ }
                    return acquireMaintenanceLock(options);
                }
                duenio = `pid ${anterior.pid}${anterior.etiqueta ? ` (${anterior.etiqueta})` : ''}`;
            }
            throw new Error(`Hay otra operación de mantenimiento en curso (${duenio}). ` +
                'Espera a que termine antes de lanzar esta.');
        }
        throw error;
    }
    let soltado = false;
    const release = () => {
        if (soltado) return;
        soltado = true;
        try { fs.unlinkSync(ruta); } catch { /* ya no está */ }
    };
    // Sin dejar huérfanos: cualquier salida del proceso suelta el candado.
    process.once('exit', release);
    process.once('SIGINT', release);
    process.once('SIGTERM', release);
    return { ruta, release };
}

/**
 * Escritura ATÓMICA del fichero de PID (M10): temporal con 0600 + rename.
 * Un lector concurrente nunca ve un fichero vacío ni truncado.
 *
 * @param {string} ruta fichero de PID
 * @param {number|string|null} pid el PID del hijo, o null/vacío para borrarlo
 */
function writePidFile(ruta, pid) {
    const file = String(ruta || DEFAULT_PID_FILE);
    if (pid === null || pid === undefined || pid === '') {
        try { fs.unlinkSync(file); } catch { /* ya no está */ }
        return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    let fd = null;
    try {
        fd = fs.openSync(tmp, 'w', 0o600);
        fs.writeSync(fd, String(pid));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, file);
    } catch (error) {
        try { if (fd !== null) fs.closeSync(fd); } catch { /* ya cerrado */ }
        try { fs.unlinkSync(tmp); } catch { /* no llegó a crearse */ }
        throw error;
    }
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
}

module.exports = {
    DEFAULT_PID_FILE,
    resolvePidFile,
    serverIsRunning,
    assertServerStopped,
    acquireMaintenanceLock,
    writePidFile
};
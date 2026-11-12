/**
 * Respaldo consistente de Zlapy.
 *
 * Copia las dos bases con la API de backup de SQLite (seguro incluso con el
 * servidor corriendo y WAL activo). La llave maestra NO está en las bases: se
 * deriva de la credencial del propietario (`DB_USER` + `DB_PASSWORD` del
 * `.env`), así que el respaldo copia TAMBIÉN ese fichero (como
 * `credencial.env`): sin la credencial, los mensajes, historias y adjuntos
 * del respaldo son irrecuperables.
 *
 * Uso:
 *   npm run backup                → backups/zlapy-backup-<fecha-hora>/
 *   npm run backup -- /ruta/dir   → respaldo en /ruta/dir
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { DB_PATH, BLOB_DB_PATH, ENV_PATH, ROOT } = require('../../src/config.js');

const dest = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(ROOT, 'backups', `zlapy-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);

// Permisos del respaldo: el directorio y las copias contienen la base de
// datos completa (usuarios, sesiones, hashes de contraseña, mensajes
// cifrados) y la credencial que la descifra. Deben ser tan privados como el
// directorio de datos (0700), no más. Se fijan de forma incondicional, sin
// depender del umask.
const BACKUP_DIR_MODE = 0o700;
const BACKUP_FILE_MODE = 0o600;

// `mkdirSync` sólo aplica `mode` al crear el directorio (si ya existe
// conserva el suyo), y el umask puede recortarlo: se fuerza con chmod.
function ensurePrivateDirectory(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: BACKUP_DIR_MODE });
    try { fs.chmodSync(dir, BACKUP_DIR_MODE); } catch (e) { /* best-effort */ }
}

// Los ficheros que crea `db.backup()` nacen con el modo por defecto del
// proceso (0644 con umask 022): se restringen a 0600.
function restrictFile(filePath) {
    try { fs.chmodSync(filePath, BACKUP_FILE_MODE); } catch (e) { /* best-effort */ }
}

async function backupDatabase(source, name) {
    if (!fs.existsSync(source)) {
        console.log(`[backup] ${name} no existe, se omite`);
        return;
    }
    const db = new Database(source, { readonly: true });
    const target = path.join(dest, name);
    try {
        await db.backup(target);
    } finally {
        db.close();
    }
    restrictFile(target);
    console.log(`[backup] ${name}: OK`);
}

function copiarCredencial() {
    if (!fs.existsSync(ENV_PATH)) {
        console.log('[backup] AVISO: no hay .env: el respaldo NO incluye la credencial.');
        console.log('        Sin ella (DB_USER + DB_PASSWORD), el contenido es irrecuperable.');
        return;
    }
    const target = path.join(dest, 'credencial.env');
    fs.copyFileSync(ENV_PATH, target);
    restrictFile(target);
    console.log('[backup] credencial.env: OK (la credencial del propietario)');
}

async function main() {
    if (fs.existsSync(dest) && fs.readdirSync(dest).length)
        throw new Error(`el destino ya existe y no está vacío: ${dest}`);
    ensurePrivateDirectory(dest);
    console.log(`[backup] destino: ${dest}`);

    await backupDatabase(DB_PATH, path.basename(DB_PATH));
    await backupDatabase(BLOB_DB_PATH, path.basename(BLOB_DB_PATH));
    copiarCredencial();

    console.log('[backup] listo.');
    console.log('         Restaurar: 1) parar el servidor, 2) copiar los .db a la carpeta de');
    console.log('         datos (DATA_DIR), 3) copiar credencial.env como .env (es la MISMA');
    console.log('         credencial con la que se cifraron estos datos), 4) arrancar y');
    console.log('         comprobar /healthz.');
}

main().catch(error => {
    console.error('[backup] Falló:', error.message);
    process.exit(1);
});

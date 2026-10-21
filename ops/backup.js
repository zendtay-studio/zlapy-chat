/**
 * Respaldo consistente de Zlapy.
 *
 * Copia las dos bases con la API de backup de SQLite (seguro incluso con el
 * servidor corriendo y WAL activo) y la llave maestra, que siempre debe
 * guardarse junto a las bases: sin ella, los mensajes, historias y adjuntos
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
const { loadConfig } = require('../src/config.js');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const CONFIG = loadConfig(process.env);

const ROOT = path.join(__dirname, '..');
const DATA = CONFIG.dataDir ? path.resolve(CONFIG.dataDir) : path.join(ROOT, 'data');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(ROOT, 'backups', `zlapy-backup-${stamp}`);

// Permisos del respaldo: el directorio y las copias contienen la base de
// datos completa (usuarios, sesiones, hashes de contraseña, mensajes
// cifrados). Deben ser tan privados como el directorio de datos (0700), no
// más. Se fijan de forma incondicional, sin depender del umask.
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

async function backupDatabase(file, name) {
    const source = path.join(DATA, file);
    if (!fs.existsSync(source)) {
        console.log(`[backup] ${file} no existe, se omite`);
        return;
    }
    const db = new Database(source, { readonly: true });
    const target = path.join(dest, file);
    try {
        await db.backup(target);
    } finally {
        db.close();
    }
    restrictFile(target);
    console.log(`[backup] ${name}: OK`);
}

async function main() {
    if (fs.existsSync(dest) && fs.readdirSync(dest).length)
        throw new Error(`el destino ya existe y no está vacío: ${dest}`);
    ensurePrivateDirectory(dest);
    console.log(`[backup] destino: ${dest}`);

    await backupDatabase('zlapy.db', 'zlapy.db');
    await backupDatabase('blob.db', 'blob.db');

    if (CONFIG.chatMasterKey) {
        console.log('[backup] AVISO: la llave maestra viene de CHAT_MASTER_KEY (.env).');
        console.log('        Guarda también una copia de esa clave junto a este respaldo:');
        console.log('        sin ella, mensajes/historias/adjuntos son irrecuperables.');
    } else {
        const keyPath = path.join(ROOT, '.zlapymasterkey');
        if (fs.existsSync(keyPath)) {
            fs.copyFileSync(keyPath, path.join(dest, '.zlapymasterkey'));
            fs.chmodSync(path.join(dest, '.zlapymasterkey'), 0o600);
            console.log('[backup] .zlapymasterkey: OK');
        } else {
            console.log('[backup] AVISO: no se encontró .zlapymasterkey.');
        }
    }

    console.log('[backup] listo.');
    console.log('         Restaurar: 1) parar el servidor, 2) copiar los .db a la carpeta de');
    console.log('         datos (DATA_DIR), 3) copiar .zlapymasterkey a la raíz del proyecto');
    console.log('         (o definir CHAT_MASTER_KEY), 4) arrancar y comprobar /healthz.');
}

main().catch(error => {
    console.error('[backup] Falló:', error.message);
    process.exit(1);
});

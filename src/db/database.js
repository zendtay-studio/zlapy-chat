/**
 * Apertura y preparación de la base de datos.
 *
 * Abre las dos bases SQLite (datos y adjuntos) con WAL, aplica el esquema y
 * comprueba que el formato de cifrado guardado en la base sea compatible con
 * este servidor.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BLOB_DB_PATH, CONFIG, DB_PATH } = require('../config.js');
const { ensureSchema } = require('./schema.js');

// SQLite — apertura y esquema

/* La carpeta de datos se crea si no existe: en una instalacion nueva el
 * directorio `data/` no viene en el repositorio y SQLite no lo crea por su
 * cuenta (falla con "unable to open database file"). */
for (const dir of new Set([path.dirname(DB_PATH), path.dirname(BLOB_DB_PATH)]))
    fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma(`busy_timeout = ${CONFIG.sqliteBusyTimeoutMs}`);
db.pragma(`cache_size = -${CONFIG.sqliteCacheSizeKb}`);
db.pragma('temp_store = MEMORY');

const blobDb = new Database(BLOB_DB_PATH);
blobDb.pragma('journal_mode = WAL');
blobDb.pragma('synchronous = NORMAL');
blobDb.pragma('foreign_keys = ON');
blobDb.pragma(`busy_timeout = ${CONFIG.sqliteBusyTimeoutMs}`);
blobDb.pragma(`cache_size = -${CONFIG.sqliteCacheSizeKb}`);
blobDb.pragma('temp_store = MEMORY');
blobDb.exec(`
CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    data TEXT NOT NULL
);
`);

// Esquema v3 — se aplica y ya
// El esquema completo (tablas normalizadas, CHECK y claves ajenas con
// ON DELETE CASCADE) vive en src/db/schema.js, que es la única fuente de
// verdad y está cubierto por test/schema.test.js.
// No hay migraciones: `ensureSchema` aplica el esquema de forma
// idempotente (CREATE TABLE/INDEX IF NOT EXISTS) y registra la versión.
{
    // Guarda mínima: si la base declara un formato de cifrado que este
    // servidor no entiende, se aborta con un mensaje claro en vez de
    // corromper lecturas en silencio.
    let metaCrypto = null;
    try {
        const metaExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
        if (metaExists) metaCrypto = db.prepare('SELECT value FROM meta WHERE key = ?').get('crypto_version')?.value ?? null;
    } catch { }
    if (metaCrypto !== null && metaCrypto !== '2')
        throw new Error(`Formato de cifrado de la base no compatible (crypto_version=${metaCrypto}). ` +
            'Restáurala desde tus respaldos (backups/) o arranca con una base nueva.');
}
ensureSchema(db);

const messageSchema = new Set(db.pragma('table_info(messages)').map(column => column.name));
for (const column of ['crypto_version', 'crypto_group_id', 'signature', 'signing_public_key']) {
    if (!messageSchema.has(column))
        throw new Error(`Database schema is incompatible: messages.${column} is missing.`);
}

/* Las sentencias preparadas viven en src/db/statements.js: se compilan una
 * vez al arrancar, porque better-sqlite3 no cachea db.prepare entre llamadas. */

module.exports = {
    db,
    blobDb,
    messageSchema,
};

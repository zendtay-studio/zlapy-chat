/**
 * Visor de tablas de Zlapy (simple y bonito).
 *
 * Servidor HTTP de SOLO LECTURA para ver `data/zlapy.db` y
 * `data/zlapy-blob.db` como tablas navegables, con la misma estética que
 * docs/esquema: barra superior, panel de tablas, rejilla de datos y pie de
 * leyenda. No dibuja grafos: para eso está ops/db/db-viewer.js.
 *
 * Uso:
 *   npm run sqliteview                        → http://127.0.0.1:3002
 *   SQLITEVIEW_PORT=3010 npm run sqliteview   → otro puerto
 *   npm run sqliteview -- --snapshot          → ve una COPIA temporal
 *
 * Detalles de seguridad:
 *   - Abre las bases con `readonly: true` (y `fileMustExist`): nunca escribe.
 *     Si la apertura readonly falla (WAL sin `-shm` tras un cierre brusco),
 *     cae a una copia temporal 0700/0600 que se borra al salir.
 *   - Escucha por defecto solo en 127.0.0.1 y en el puerto 3002 (distinto del
 *     servidor y del visor de grafos): no interfiere con `npm start`.
 *   - El material sensible (hashes de contraseña, auth_key, llaves de grupo,
 *     blobs) se enmascara salvo que la petición pida `reveal=1`.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { DB_PATH, BLOB_DB_PATH } = require('../../src/config.js');

const STATIC_DIR = path.join(__dirname, 'sqliteview');

/* ---------------- configuración ---------------- */

const readInt = (raw, fallback, min, max) => {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (value === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
};

const HOST = String(process.env.SQLITEVIEW_HOST === undefined ? '127.0.0.1' : process.env.SQLITEVIEW_HOST).trim() || '127.0.0.1';
const PORT = readInt(process.env.SQLITEVIEW_PORT, 3002, 1, 65535);
const DEFAULT_LIMIT = 100;
const LIMIT_MAX = 500;

// Columnas cuyo valor no se muestra salvo petición explícita (reveal=1).
const SENSITIVE_COLUMNS = {
    users: ['password_hash', 'password_salt'],
    user_auth_keys: ['auth_key', 'key_id'],
    user_keys: ['key_cipher'],
    groups: ['keys_cipher', 'invite_code'],
    blobs: ['data'],
    push_subs: ['data']
};

const MASK = '••••••••';

function isSensitive(table, column) {
    const columns = SENSITIVE_COLUMNS[table];
    return !!columns && columns.includes(column);
}

function maskValue(table, column, value, reveal) {
    if (!reveal && isSensitive(table, column) && value !== null && value !== undefined) {
        return MASK;
    }
    return value;
}

/* ---------------- utilidades SQL ---------------- */

function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

function tableNames(db) {
    return db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(row => row.name);
}

function columnInfo(db, table) {
    return db.pragma(`table_info(${quoteIdent(table)})`)
        .map(col => ({
            name: col.name,
            type: String(col.type || '').toUpperCase(),
            notnull: !!col.notnull,
            pk: col.pk > 0,
            pkOrder: col.pk,
            default: col.dflt_value === null ? null : String(col.dflt_value)
        }));
}

function foreignKeyGroups(db, table) {
    const byId = new Map();
    for (const row of db.pragma(`foreign_key_list(${quoteIdent(table)})`)) {
        if (!byId.has(row.id)) byId.set(row.id, []);
        byId.get(row.id).push(row);
    }
    const groups = [];
    for (const rows of byId.values()) {
        rows.sort((a, b) => a.seq - b.seq);
        groups.push({
            table: rows[0].table,
            from: rows.map(r => r.from),
            to: rows.map(r => r.to),
            onDelete: String(rows[0].on_delete || '').toUpperCase()
        });
    }
    return groups;
}

function fkGroupFor(fkGroups, column) {
    const fk = fkGroups.find(group => group.from.includes(column));
    if (!fk) return null;
    return { table: fk.table, columns: fk.from, toColumn: fk.to[fk.from.indexOf(column)] };
}

/* ---------------- apertura de las bases ---------------- */

function openDatabaseFile(file, { snapshot = false } = {}) {
    if (!file || !fs.existsSync(file)) return { db: null, tempDir: null };

    if (!snapshot) {
        try {
            return { db: new Database(file, { readonly: true, fileMustExist: true }), tempDir: null };
        } catch {
            // se intenta por el modo copia
        }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-sqliteview-'));
    try { fs.chmodSync(tempDir, 0o700); } catch { /* best-effort */ }
    const target = path.join(tempDir, 'copia.db');
    for (const suffix of ['', '-wal', '-shm']) {
        const source = file + suffix;
        if (fs.existsSync(source)) fs.copyFileSync(source, target + suffix);
        try { fs.chmodSync(target + suffix, 0o600); } catch { /* best-effort */ }
    }
    // Escritura a propósito: sin ella SQLite no puede recuperar el WAL de la
    // copia. El visor jamás ejecuta INSERT/UPDATE/DELETE.
    return { db: new Database(target), tempDir };
}

function openDatabases(options = {}) {
    const zlapyFile = options.zlapyPath || DB_PATH;
    const blobFile = options.blobPath || BLOB_DB_PATH;

    if (!fs.existsSync(zlapyFile) && !fs.existsSync(blobFile)) {
        throw new Error(
            `no se encontró ninguna base de datos:\n` +
            `  ${zlapyFile}\n  ${blobFile}\n` +
            `¿Arrancaste el servidor alguna vez? Las bases se crean en data/ al primer arranque.`
        );
    }

    const opened = { zlapy: null, blob: null, snapshots: [] };
    const names = ['zlapy', 'blob'];
    const files = [zlapyFile, blobFile];

    for (let i = 0; i < names.length; i++) {
        try {
            const result = openDatabaseFile(files[i], options);
            opened[names[i]] = result ? result.db : null;
            if (result && result.tempDir) opened.snapshots.push(result.tempDir);
        } catch (error) {
            throw new Error(`no se pudo abrir ${files[i]}: ${error.message}`);
        }
    }
    return opened;
}

function closeDatabases(opened) {
    if (!opened) return;
    for (const db of [opened.zlapy, opened.blob]) {
        if (!db) continue;
        try { db.close(); } catch { /* ya cerrada */ }
    }
    for (const dir of opened.snapshots || []) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

function findTable(dbs, table) {
    if (typeof table !== 'string' || !/^[A-Za-z0-9_ .$-]{1,80}$/.test(table)) return null;
    for (const label of ['zlapy', 'blob']) {
        const db = dbs[label];
        if (!db) continue;
        if (tableNames(db).includes(table)) return { label, db };
    }
    return null;
}

/* ---------------- payloads ---------------- */

const FILE_LABELS = { zlapy: 'zlapy.db', blob: 'zlapy-blob.db' };

function overviewPayload(dbs) {
    const tables = [];
    let totalRows = 0;
    let totalColumns = 0;

    for (const label of ['zlapy', 'blob']) {
        const db = dbs[label];
        if (!db) continue;
        for (const table of tableNames(db)) {
            const columns = columnInfo(db, table);
            const rows = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n;
            totalRows += rows;
            totalColumns += columns.length;
            tables.push({
                name: table,
                db: label,
                file: FILE_LABELS[label],
                rows,
                columns: columns.map(col => ({
                    name: col.name,
                    type: col.type || 'ANY',
                    notnull: col.notnull,
                    pk: col.pk
                }))
            });
        }
    }

    return {
        files: FILE_LABELS,
        tables,
        totals: { tables: tables.length, columns: totalColumns, rows: totalRows }
    };
}

function rowsPayload(dbs, table, options = {}) {
    const found = findTable(dbs, table);
    if (!found) return null;

    const offset = readInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = readInt(options.limit, DEFAULT_LIMIT, 1, LIMIT_MAX);
    const reveal = options.reveal === true;

    const cols = columnInfo(found.db, table);
    const fkGroups = foreignKeyGroups(found.db, table);
    const total = found.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n;
    const selects = ['rowid AS __rid', ...cols.map(col => quoteIdent(col.name))];
    const rows = found.db.prepare(
        `SELECT ${selects.join(', ')} FROM ${quoteIdent(table)} ORDER BY rowid LIMIT ? OFFSET ?`
    ).all(limit, offset);

    return {
        table,
        db: found.label,
        file: FILE_LABELS[found.label],
        total,
        offset,
        limit,
        columns: cols.map(col => ({
            name: col.name,
            type: col.type || 'ANY',
            notnull: col.notnull,
            pk: col.pk,
            default: col.default,
            sensitive: isSensitive(table, col.name),
            ref: fkGroupFor(fkGroups, col.name)
        })),
        rows: rows.map(row => {
            const values = {};
            for (const col of cols) values[col.name] = maskValue(table, col.name, row[col.name], reveal);
            return { __rid: row.__rid, values };
        })
    };
}

/* ---------------- servidor HTTP ---------------- */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
};

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify(payload));
}

const sendError = (res, status, message) => sendJson(res, status, { error: message });

function staticResponse(pathname) {
    let file;
    if (pathname === '/' || pathname === '/index.html') file = path.join(STATIC_DIR, 'index.html');
    else if (pathname === '/sqliteview.css') file = path.join(STATIC_DIR, 'sqliteview.css');
    else if (pathname === '/sqliteview.js') file = path.join(STATIC_DIR, 'sqliteview.js');
    else return null;

    let body;
    try {
        body = fs.readFileSync(file);
    } catch {
        return null;
    }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    return { status: 200, type, body };
}

function createHandler(dbs) {
    return (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return sendError(res, 405, 'método no permitido: el visor solo acepta GET');
        }

        const url = new URL(req.url || '/', 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);

        if (!pathname.startsWith('/api/')) {
            const asset = staticResponse(pathname);
            if (!asset) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('404 - no encontrado');
            }
            res.writeHead(asset.status, {
                'Content-Type': asset.type,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            return req.method === 'HEAD' ? res.end() : res.end(asset.body);
        }

        const reveal = url.searchParams.get('reveal') === '1';

        try {
            if (pathname === '/api/overview') {
                return sendJson(res, 200, overviewPayload(dbs));
            }

            if (pathname.startsWith('/api/table/')) {
                const table = pathname.slice('/api/table/'.length);
                if (!table) return sendError(res, 400, 'falta el nombre de la tabla');
                const payload = rowsPayload(dbs, table, {
                    offset: url.searchParams.get('offset'),
                    limit: url.searchParams.get('limit'),
                    reveal
                });
                if (!payload) return sendError(res, 404, `tabla no encontrada: ${table}`);
                return sendJson(res, 200, payload);
            }

            return sendError(res, 404, `ruta desconocida: ${pathname}`);
        } catch (error) {
            return sendError(res, 500, `error consultando la base: ${error.message}`);
        }
    };
}

function startServer(options = {}) {
    const dbs = {
        zlapy: options.zlapy ?? options.dbs?.zlapy ?? null,
        blob: options.blob ?? options.dbs?.blob ?? null,
        snapshots: options.dbs?.snapshots || []
    };
    const host = options.host || HOST;
    const port = options.port === undefined ? PORT : options.port;

    const server = http.createServer(createHandler(dbs));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            const address = server.address();
            resolve({
                server,
                port: typeof address === 'object' && address ? address.port : port,
                host,
                dbs
            });
        });
    });
}

/* ---------------- arranque ---------------- */

async function main() {
    const snapshot = process.argv.includes('--snapshot');

    let opened;
    try {
        opened = openDatabases({ snapshot });
    } catch (error) {
        console.error(`[sqliteview] ${error.message}`);
        process.exit(1);
    }

    if (opened.snapshots.length) {
        console.log('[sqliteview] modo copia: se ve una copia temporal de las bases (no se tocan los originales)');
    }

    let running;
    try {
        running = await startServer({ dbs: { zlapy: opened.zlapy, blob: opened.blob, snapshots: opened.snapshots } });
    } catch (error) {
        closeDatabases(opened);
        if (error.code === 'EADDRINUSE') {
            console.error(`[sqliteview] puerto ${PORT} ocupado. Usa SQLITEVIEW_PORT=3010 npm run sqliteview`);
        } else {
            console.error(`[sqliteview] no se pudo abrir el puerto ${PORT}: ${error.message}`);
        }
        process.exit(1);
    }

    const overview = overviewPayload(opened);
    console.log(`✅ Visor de tablas en http://${running.host}:${running.port}`);
    console.log(`   ${overview.totals.tables} tablas · ${overview.totals.rows.toLocaleString('es-ES')} filas · ${overview.totals.columns} columnas`);
    console.log('   Solo lectura. Ctrl+C para parar. Muestra datos reales: no lo publiques con el túnel.');

    const shutdown = () => {
        running.server.close(() => {
            closeDatabases(opened);
            process.exit(0);
        });
        setTimeout(() => { closeDatabases(opened); process.exit(0); }, 3000).unref();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, shutdown);
    }
}

module.exports = {
    SENSITIVE_COLUMNS,
    isSensitive,
    maskValue,
    quoteIdent,
    tableNames,
    columnInfo,
    foreignKeyGroups,
    openDatabases,
    closeDatabases,
    findTable,
    overviewPayload,
    rowsPayload,
    createHandler,
    startServer
};

if (require.main === module) {
    main();
}

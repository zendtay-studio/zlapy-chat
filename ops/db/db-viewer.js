/**
 * Visor de la base de datos de Zlapy.
 *
 * Servidor HTTP opcional y de SOLO LECTURA para inspeccionar `data/zlapy.db` y
 * `data/blob.db`: mapa de grafos 2D/3D de los datos (nodos = filas, aristas =
 * claves ajenas reales entre filas) y explorador de tablas paginado. Se
 * arranca a mano cuando se quiere mirar; no lo lanza el servidor ni el
 * supervisor.
 *
 * Uso:
 *   npm run dbview                    → http://127.0.0.1:3001
 *   VIEWER_PORT=3010 npm run dbview   → otro puerto
 *   VIEWER_HOST=0.0.0.0 npm run dbview→ abre a la red (bajo tu responsabilidad)
 *   npm run dbview -- --snapshot       → ve una COPIA temporal de las bases
 *
 * Detalles de seguridad:
 *   - Abre las bases con `readonly: true` (y `fileMustExist`): nunca crea ni
 *     escribe. Si la apertura readonly falla (WAL sin `-shm`, típico de un
 *     cierre brusco del servidor), cae a una copia temporal 0700/0600 que se
 *     borra al salir.
 *   - Escucha por defecto solo en 127.0.0.1 y en un puerto distinto del
 *     servidor (3001): no interfiere con `npm start`.
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

const STATIC_DIR = path.join(__dirname, 'db-viewer');

/* ---------------- configuración ---------------- */

const readInt = (raw, fallback, min, max) => {
    const value = String(raw === undefined || raw === null ? '' : raw).trim();
    if (value === '') return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        console.warn(`[dbview] valor "${value}" fuera de rango (${min}..${max}); se usa ${fallback}`);
        return fallback;
    }
    return parsed;
};

const HOST = String(process.env.VIEWER_HOST === undefined ? '127.0.0.1' : process.env.VIEWER_HOST).trim() || '127.0.0.1';
const PORT = readInt(process.env.VIEWER_PORT, 3001, 1, 65535);
// Tope de filas por tabla en el grafo: con miles de nodos el layout deja de
// ser útil. El explorador de tablas pagina sobre TODAS las filas igualmente.
const GRAPH_LIMIT = readInt(process.env.VIEWER_GRAPH_LIMIT, 300, 10, 50_000);
const ROWS_LIMIT_MAX = 500;

// Columnas cuyo valor no se muestra salvo petición explícita (`reveal=1`).
// La base guarda hashes y material cifrado con las llaves maestra/por usuario:
// verlos es innecesario para entender la estructura y los datos.
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

// Un nombre de tabla o columna entre comillas dobles, escapando las internas.
// Los nombres NUNCA se interpolan desde la query string: antes se validan
// contra sqlite_master (isSafeTableName).
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

// Agrupa las filas de PRAGMA foreign_key_list por id: una FK compuesta viene
// como varias filas con el mismo id y `seq` ordenado.
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

function primaryColumns(db, table) {
    return columnInfo(db, table)
        .filter(col => col.pk)
        .sort((a, b) => a.pkOrder - b.pkOrder)
        .map(col => col.name);
}

// Referencia declarada (FK) de una columna concreta, si la tiene.
function fkGroupFor(fkGroups, column) {
    const fk = fkGroups.find(group => group.from.includes(column));
    if (!fk) return null;
    return { table: fk.table, columns: fk.from, toColumn: fk.to[fk.from.indexOf(column)] };
}

/* ---------------- apertura de las bases ---------------- */

// Abre un fichero en solo lectura. Si eso falla (WAL sin `-shm` tras un cierre
// brusco), hace una copia temporal completa (db + -wal + -shm) y la abre en
// escritura, que es el modo que permite a SQLite recuperar el WAL. La copia
// vive en un directorio 0700 con ficheros 0600 y se borra al cerrar.
function openDatabaseFile(file, { snapshot = false } = {}) {
    if (!file || !fs.existsSync(file)) return null;

    if (!snapshot) {
        try {
            return { db: new Database(file, { readonly: true, fileMustExist: true }), tempDir: null };
        } catch {
            // se intenta por el modo copia (las copias se registran en snapshots)
        }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-viewer-'));
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

// Devuelve { zlapy, blob, snapshots } con las conexiones (null si no existe
// el fichero) y los directorios temporales que hay que borrar al salir.
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

// ¿Existe la tabla (en cualquiera de las dos bases)? Cierra la puerta a
// inyección y a nombres inventados: solo se acepta lo que hay en sqlite_master.
function findTable(dbs, table) {
    if (typeof table !== 'string' || !/^[A-Za-z0-9_ .$-]+$/.test(table)) return null;
    for (const label of ['zlapy', 'blob']) {
        const db = dbs[label];
        if (!db) continue;
        if (tableNames(db).includes(table)) return { label, db };
    }
    return null;
}

/* ---------------- payloads ---------------- */

function databaseCounts(db) {
    let tables = 0;
    let rows = 0;
    for (const name of tableNames(db)) {
        tables++;
        rows += db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get().n;
    }
    return { tables, rows };
}

// Etiqueta legible de una fila: se prefiere una columna con nombre natural
// (username, name, id…); si no hay texto, el rowid.
const LABEL_PREFERENCE = ['username', 'display_name', 'name', 'id', 'key', 'hash', 'endpoint', 'chat', 'peer_key', 'token_hash'];

function pickLabelColumn(cols) {
    for (const wanted of LABEL_PREFERENCE) {
        const col = cols.find(c => c.name === wanted && c.type.includes('TEXT'));
        if (col) return col.name;
    }
    const text = cols.find(c => c.type.includes('TEXT'));
    return text ? text.name : null;
}

function shortenLabel(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (text.length <= 28) return text;
    return `${text.slice(0, 14)}…${text.slice(-6)}`;
}

function loadNodes(db, label, table, limit) {
    const cols = columnInfo(db, table);
    const pkCols = primaryColumns(db, table);
    const labelCol = pickLabelColumn(cols);

    const selects = ['rowid AS __rid'];
    pkCols.forEach((col, i) => selects.push(`${quoteIdent(col)} AS __pk_${i}`));
    if (labelCol) selects.push(`${quoteIdent(labelCol)} AS __label`);

    const rows = db.prepare(`SELECT ${selects.join(', ')} FROM ${quoteIdent(table)} LIMIT ?`).all(limit);
    return rows.map(row => {
        const pk = {};
        pkCols.forEach((col, i) => { pk[col] = row[`__pk_${i}`]; });
        return {
            id: `${table}:${row.__rid}`,
            db: label,
            table,
            rid: row.__rid,
            pk,
            label: labelCol === null ? `#${row.__rid}` : (shortenLabel(row.__label) || `#${row.__rid}`)
        };
    });
}

function schemaPayload(dbs) {
    const tables = [];
    for (const label of ['zlapy', 'blob']) {
        const db = dbs[label];
        if (!db) continue;
        for (const table of tableNames(db)) {
            const columns = columnInfo(db, table);
            const fkGroups = foreignKeyGroups(db, table);
            const total = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get().n;
            tables.push({
                name: table,
                db: label,
                rows: total,
                columns: columns.map(col => ({
                    name: col.name,
                    type: col.type || 'ANY',
                    notnull: col.notnull,
                    pk: col.pk,
                    sensitive: isSensitive(table, col.name),
                    default: col.default,
                    // FK declarada sobre esta columna, para que la UI la enlace.
                    ref: fkGroupFor(fkGroups, col.name)
                })),
                refs: fkGroups.map(fk => ({
                    columns: fk.from,
                    table: fk.table,
                    toColumns: fk.to,
                    onDelete: fk.onDelete
                }))
            });
        }
    }
    return { tables, sensitiveColumns: SENSITIVE_COLUMNS };
}

// Grafo de datos: nodos = filas, aristas = filas relacionadas por FK real.
// Además deduce aristas por NOMBRE de columna contra claves primarias de una
// sola columna (p. ej. messages.hash → blobs.hash, que el esquema guarda como
// texto y no como FK); se devuelven con kind 'inferred' para poder ocultarlas.
function graphPayload(dbs, limit) {
    const nodes = [];
    const tables = new Map(); // table → { db, label, cols, pkCols, index }
    const edges = [];

    for (const label of ['zlapy', 'blob']) {
        const db = dbs[label];
        if (!db) continue;
        for (const table of tableNames(db)) {
            const loaded = loadNodes(db, label, table, limit);
            nodes.push(...loaded);

            const cols = columnInfo(db, table);
            const pkCols = primaryColumns(db, table);
            const index = new Map();
            for (const node of loaded) {
                index.set(JSON.stringify(pkCols.map(col => node.pk[col])), node.id);
            }
            tables.set(table, { db, label, cols, pkCols, index });
        }
    }

    const addEdges = (table, info, fromCols, toTable, onDelete, kind) => {
        const target = tables.get(toTable);
        if (!target || fromCols.length === 0) return;
        const selects = ['rowid AS __rid', ...fromCols.map(col => `${quoteIdent(col)} AS ${quoteIdent('v_' + col)}`)];
        let rows;
        try {
            rows = info.db.prepare(
                `SELECT ${selects.join(', ')} FROM ${quoteIdent(table)} LIMIT ?`
            ).all(limit);
        } catch {
            return; // columna inexistente en esta tabla: no debería pasar
        }
        for (const row of rows) {
            const values = fromCols.map(col => row['v_' + col]);
            if (values.some(v => v === null || v === undefined || v === '')) continue;
            const targetId = target.index.get(JSON.stringify(values));
            if (!targetId) continue;
            edges.push({
                from: `${table}:${row.__rid}`,
                to: targetId,
                columns: fromCols,
                kind,
                onDelete: onDelete || null
            });
        }
    };

    for (const [table, info] of tables) {
        const declared = new Set();
        for (const fk of foreignKeyGroups(info.db, table)) {
            for (const col of fk.from) declared.add(col);
            addEdges(table, info, fk.from, fk.table, fk.onDelete, 'fk');
        }
        // Deducción conservadora: misma columna que la PK simple de otra tabla.
        for (const col of info.cols) {
            if (declared.has(col.name)) continue;
            for (const [other, otherInfo] of tables) {
                if (other === table) continue;
                if (otherInfo.pkCols.length === 1 && otherInfo.pkCols[0] === col.name) {
                    addEdges(table, info, [col.name], other, null, 'inferred');
                }
            }
        }
    }

    return { nodes, edges, limit };
}

function rowsPayload(dbs, table, options = {}) {
    const found = findTable(dbs, table);
    if (!found) return null;

    const offset = Math.max(0, readInt(options.offset, 0, 0, Number.MAX_SAFE_INTEGER));
    const limit = readInt(options.limit, 100, 1, ROWS_LIMIT_MAX);
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
        total,
        offset,
        limit,
        columns: cols.map(col => ({
            name: col.name,
                type: col.type || 'ANY',
                notnull: col.notnull,
                pk: col.pk,
                sensitive: isSensitive(table, col.name),
                default: col.default,
                // FK declarada sobre esta columna, para que la UI la enlace.
                ref: fkGroupFor(fkGroups, col.name)
        })),
        rows: rows.map(row => {
            const out = { __rid: row.__rid };
            for (const col of cols) out[col.name] = maskValue(table, col.name, row[col.name], reveal);
            return out;
        })
    };
}

function rowPayload(dbs, table, rid, options = {}) {
    const found = findTable(dbs, table);
    if (!found) return null;
    const target = readInt(rid, -1, 0, Number.MAX_SAFE_INTEGER);
    if (target < 0) return null;

    const cols = columnInfo(found.db, table);
    const selects = ['rowid AS __rid', ...cols.map(col => quoteIdent(col.name))];
    const row = found.db.prepare(
        `SELECT ${selects.join(', ')} FROM ${quoteIdent(table)} WHERE rowid = ?`
    ).get(target);
    if (!row) return null;

    const out = { table, db: found.label, rid: row.__rid, row: {} };
    for (const col of cols) out.row[col.name] = maskValue(table, col.name, row[col.name], options.reveal === true);
    return out;
}

/* ---------------- servidor HTTP ---------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
}

function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}

// Sirve el SPA: tres ficheros fijos, sin recorrer rutas ni colarse del
// directorio.
function staticResponse(pathname) {
    let file;
    if (pathname === '/' || pathname === '/index.html') file = path.join(STATIC_DIR, 'index.html');
    else if (pathname === '/viewer.css') file = path.join(STATIC_DIR, 'viewer.css');
    else if (pathname === '/viewer.js') file = path.join(STATIC_DIR, 'viewer.js');
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
            sendError(res, 405, 'método no permitido: el visor solo acepta GET');
            return;
        }

        const url = new URL(req.url || '/', 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);

        // Estáticos
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

        // API
        const reveal = url.searchParams.get('reveal') === '1';

        try {
            if (pathname === '/api/schema') {
                return sendJson(res, 200, schemaPayload(dbs));
            }

            if (pathname === '/api/graph') {
                const limit = readInt(url.searchParams.get('limit'), GRAPH_LIMIT, 10, ROWS_LIMIT_MAX * 200);
                return sendJson(res, 200, graphPayload(dbs, limit));
            }

            if (pathname === '/api/table' || pathname.startsWith('/api/table/')) {
                let table = pathname.startsWith('/api/table/') ? pathname.slice('/api/table/'.length) : url.searchParams.get('name');
                if (!table) {
                    return sendError(res, 400, 'falta el nombre de la tabla (?name=… o /api/table/<nombre>)');
                }
                const payload = rowsPayload(dbs, table, {
                    offset: url.searchParams.get('offset'),
                    limit: url.searchParams.get('limit'),
                    reveal
                });
                if (!payload) return sendError(res, 404, `tabla no encontrada: ${table}`);
                return sendJson(res, 200, payload);
            }

            if (pathname.startsWith('/api/row/')) {
                const parts = pathname.slice('/api/row/'.length).split('/');
                if (parts.length !== 2) return sendError(res, 400, 'ruta esperada: /api/row/<tabla>/<rowid>');
                const payload = rowPayload(dbs, parts[0], parts[1], { reveal });
                if (!payload) return sendError(res, 404, 'fila no encontrada');
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
        console.error(`[dbview] ${error.message}`);
        process.exit(1);
    }

    if (opened.snapshots.length) {
        console.log('[dbview] modo copia: se ve una copia temporal de las bases (no se tocan los originales)');
    }

    let running;
    try {
        running = await startServer({ dbs: { zlapy: opened.zlapy, blob: opened.blob, snapshots: opened.snapshots } });
    } catch (error) {
        closeDatabases(opened);
        if (error.code === 'EADDRINUSE') {
            console.error(`[dbview] puerto ${PORT} ocupado. Usa VIEWER_PORT=3010 npm run dbview`);
        } else {
            console.error(`[dbview] no se pudo abrir el puerto ${PORT}: ${error.message}`);
        }
        process.exit(1);
    }

    const counts = [];
    if (opened.zlapy) {
        const c = databaseCounts(opened.zlapy);
        counts.push(`zlapy.db: ${c.tables} tablas · ${c.rows.toLocaleString('es-ES')} filas`);
    }
    if (opened.blob) {
        const c = databaseCounts(opened.blob);
        counts.push(`blob.db: ${c.tables} tablas · ${c.rows.toLocaleString('es-ES')} filas`);
    }

    console.log(`✅ Visor de base de datos en http://${running.host}:${running.port}`);
    for (const line of counts) console.log(`   ${line}`);
    console.log('   Solo lectura. Ctrl+C para parar. Muestra datos reales: no lo publiques con el túnel.');

    const shutdown = () => {
        running.server.close(() => {
            closeDatabases(opened);
            process.exit(0);
        });
        // Si el cierre se cuelga, se sale igualmente (sin dejar huérfano).
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
    primaryColumns,
    openDatabases,
    closeDatabases,
    findTable,
    schemaPayload,
    graphPayload,
    rowsPayload,
    rowPayload,
    createHandler,
    startServer
};

// Solo arranca si se ejecuta directamente: los tests importan las funciones.
if (require.main === module) {
    main();
}

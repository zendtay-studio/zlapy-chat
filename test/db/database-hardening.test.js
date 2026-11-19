// Configuración de durabilidad y espera ante escritores concurrentes.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const dotenv = require('dotenv');
const { db, blobDb } = require('../../src/db/database.js');
const { CONFIG, DEFAULTS, loadConfig } = require('../../src/config.js');

test('SQLite espera 15 s por defecto y la plantilla coincide', () => {
    assert.equal(DEFAULTS.SQLITE_BUSY_TIMEOUT_MS, 15_000);
    assert.equal(loadConfig({}).sqliteBusyTimeoutMs, 15_000);
    const ejemplo = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.env.example')));
    assert.equal(Number(ejemplo.SQLITE_BUSY_TIMEOUT_MS), 15_000);
    assert.equal(db.pragma('busy_timeout', { simple: true }), CONFIG.sqliteBusyTimeoutMs);
    assert.equal(blobDb.pragma('busy_timeout', { simple: true }), CONFIG.sqliteBusyTimeoutMs);
});

test('las dos bases usan synchronous=FULL para no perder commits al caer el SO', () => {
    // PRAGMA synchronous: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA.
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    assert.equal(blobDb.pragma('synchronous', { simple: true }), 2);
});

test('una escritura espera a que otro conexión suelte el bloqueo en vez de fallar', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-sqlite-busy-'));
    const filename = path.join(dir, 'contienda.db');
    const principal = new Database(filename);
    principal.pragma('journal_mode = WAL');
    principal.pragma(`busy_timeout = ${loadConfig({}).sqliteBusyTimeoutMs}`);
    principal.exec('CREATE TABLE datos (valor TEXT)');
    let worker = null;
    t.after(async () => {
        try { principal.close(); } catch { }
        if (worker) await worker.terminate();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
        const db = new Database(workerData);
        db.pragma('journal_mode = WAL');
        db.exec('BEGIN IMMEDIATE');
        parentPort.postMessage('bloqueada');
        setTimeout(() => {
            db.exec('ROLLBACK');
            db.close();
            parentPort.postMessage('liberada');
        }, 250);
    `, { eval: true, workerData: filename });
    await new Promise((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
    });

    const inicio = Date.now();
    assert.doesNotThrow(() => principal.prepare('INSERT INTO datos (valor) VALUES (?)').run('escrito'));
    assert.ok(Date.now() - inicio >= 100, 'realmente esperó al otro escritor');
    assert.equal(principal.prepare('SELECT valor FROM datos').get().valor, 'escrito');
    await worker.terminate();
    worker = null;
});

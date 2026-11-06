const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const dotenv = require('dotenv');
const { execFile } = require('node:child_process');
const { DEFAULTS, loadConfig } = require('../src/config.js');

/* Resuelve BLOB_DB_PATH en un proceso aparte: la compatibilidad con el
   blob.db de las versiones anteriores se decide al cargar src/config.js y
   depende de lo que haya en el disco de DATA_DIR. */
function blobPathEnProceso(t, dataDir) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e',
            `process.env.BLOB_DB_NAME='';console.log(require('./src/config.js').BLOB_DB_PATH)`,
        ], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dataDir, BLOB_DB_NAME: '' } },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    });
}

test('.env.example contains a valid configuration and expected defaults', () => {
    const examplePath = path.join(__dirname, '..', '.env.example');
    const env = dotenv.parse(fs.readFileSync(examplePath));
    const config = loadConfig(env);
    assert.equal(config.port, DEFAULTS.PORT);
    assert.equal(config.maxAudioDurationMs, DEFAULTS.MAX_AUDIO_DURATION_MS);
    assert.equal(config.sqliteCacheSizeKb, DEFAULTS.SQLITE_CACHE_SIZE_KB);
});

test('loads validated configurable defaults and supports .env overrides', () => {
    const config = loadConfig({ MESSAGE_RATE_LIMIT: '8', MAX_AUDIO_DURATION_MS: '90000' });
    assert.equal(config.port, DEFAULTS.PORT);
    assert.equal(config.messagesPerMinute, 8);
    assert.equal(config.maxAudioDurationMs, 90_000);
});

test('rejects invalid values and incompatible request size limits', () => {
    assert.throws(() => loadConfig({ PORT: '0' }), /PORT must be between/);
    assert.throws(() => loadConfig({ MESSAGE_RATE_LIMIT: 'many' }), /MESSAGE_RATE_LIMIT must be an integer/);
    assert.throws(() => loadConfig({
        MAX_HTTP_BODY_BYTES: '1024',
        MAX_MESSAGE_DATA_CHARS: '1025'
    }), /MAX_MESSAGE_DATA_CHARS cannot exceed/);
});

test('el nombre de la base de adjuntos se deriva del de la principal si no se fija', () => {
    const porDefecto = loadConfig({});
    assert.equal(porDefecto.dbName, 'zlapy');
    assert.equal(porDefecto.blobDbName, 'zlapy-blob');
    const personalizado = loadConfig({ DB_NAME: 'michat' });
    assert.equal(personalizado.dbName, 'michat');
    assert.equal(personalizado.blobDbName, 'michat-blob');
    const explicito = loadConfig({ DB_NAME: 'michat', BLOB_DB_NAME: 'adjuntos' });
    assert.equal(explicito.blobDbName, 'adjuntos');
});

test('un blob.db de una versión anterior se conserva (no se pierden los adjuntos)', async t => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zlapy-blob-legacy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Sin blob.db antiguo: vale el nombre derivado (<DB_NAME>-blob).
    assert.match(await blobPathEnProceso(t, dir), /zlapy-blob\.db$/);
    // Con un blob.db de la versión anterior en el disco: se sigue usando.
    fs.writeFileSync(path.join(dir, 'blob.db'), '');
    assert.match(await blobPathEnProceso(t, dir), /[\\/]blob\.db$/);
    // Pero si BLOB_DB_NAME se fija a mano, manda siempre.
    const explicito = await new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e',
            `console.log(require('./src/config.js').BLOB_DB_PATH)`,
        ], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir, BLOB_DB_NAME: 'adjuntos' } },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
    });
    assert.match(explicito, /adjuntos\.db$/);
});

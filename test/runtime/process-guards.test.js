// Guardas de proceso: un error global NO fatal no tumba el servidor y queda
// registrado; uno FATAL sí lo cierra con código 1. Verificado con procesos
// hijos reales (no hay hooks de prueba en código de producción).
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
const GUARDS = path.join(ROOT, 'src', 'process-guards.js');

/* Hijo que instala las guardas, lanza el error indicado y se mantiene vivo. */
function hijoQueExplota(mensaje, codigo) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-guard-'));
    const script = `
        const g = require(${JSON.stringify(GUARDS)});
        g.installProcessGuards();
        setTimeout(() => {
            const e = new Error(${JSON.stringify(mensaje)});
            if (${JSON.stringify(codigo)}) e.code = ${JSON.stringify(codigo)};
            throw e;
        }, 60);
        setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, DATA_DIR: dataDir }, stdio: 'ignore' });
    return { child, logFile: path.join(dataDir, 'log', 'errors.log'), dataDir };
}

const espera = ms => new Promise(r => setTimeout(r, ms));

test('un error NO fatal deja el proceso vivo y lo registra en data/log/errors.log', async t => {
    const { child, logFile, dataDir } = hijoQueExplota('fallo de prueba no fatal', null);
    t.after(() => {
        try { child.kill('SIGKILL'); } catch { }
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await espera(1500);
    assert.equal(child.exitCode, null, 'el proceso sigue vivo: un error aislado no tumba el servidor');

    child.kill('SIGKILL');
    assert.equal(fs.existsSync(logFile), true, 'el error quedó en disco');
    const texto = fs.readFileSync(logFile, 'utf8');
    assert.match(texto, /uncaughtException/, 'registra el tipo de error');
    assert.match(texto, /fallo de prueba no fatal/, 'registra el mensaje');
});

test('un error FATAL (ENOSPC: disco lleno) cierra el proceso con código 1', async t => {
    const { child, logFile, dataDir } = hijoQueExplota('espacio agotado simulado', 'ENOSPC');
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

    const code = await new Promise(resolve => {
        child.on('exit', (c, signal) => resolve(c === null ? signal : c));
        setTimeout(() => resolve('timeout'), 8000).unref();
    });
    assert.equal(code, 1, 'salida limpia con error para que lo levante el supervisor');
    assert.match(fs.readFileSync(logFile, 'utf8'), /FATAL/, 'el registro marca que fue fatal');
});

test('las guardas detectan un SQLITE corrupto como fatal', () => {
    const { isFatal } = require('../../src/process-guards.js');
    assert.equal(isFatal({ code: 'SQLITE_CORRUPT' }), true);
    assert.equal(isFatal({ message: 'database disk image is malformed' }), true);
    assert.equal(isFatal({ code: 'ENOSPC' }), true);
    assert.equal(isFatal(new TypeError('x.y is not a function')), false, 'un bug corriente NO es fatal: se sigue sirviendo');
});

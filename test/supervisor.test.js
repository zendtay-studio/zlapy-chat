// Prueba de humo del supervisor: arranca, comprueba /healthz, mata al hijo
// y verifica que el supervisor lo reinicia. Usa un puerto y un DATA_DIR
// temporales para no tocar datos reales.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3987;

function get(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, { timeout: 5000 }, response => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => resolve({ status: response.statusCode, body }));
        });
        request.on('timeout', () => { request.destroy(); reject(new Error('timeout')); });
        request.on('error', reject);
    });
}

function waitFor(fn, timeout = 30000, step = 500) {
    const deadline = Date.now() + timeout;
    return (async function attempt() {
        try { const value = await fn(); if (value) return value; } catch { }
        if (Date.now() >= deadline) throw new Error('tiempo de espera agotado');
        await new Promise(resolve => setTimeout(resolve, step));
        return attempt();
    })();
}

test('el supervisor arranca el servidor y lo reinicia si muere', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-sup-'));
    const pidFile = path.join(dataDir, 'server.pid');
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

    const supervisor = spawn(process.execPath, [path.join(ROOT, 'ops', 'supervisor.js')], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PORT: String(PORT),
            DATA_DIR: dataDir,
            SUPERVISOR_PID_FILE: pidFile,
            SUPERVISOR_HEALTH_MS: '3000',
            SUPERVISOR_BACKOFF_MS: '300',
            SUPERVISOR_STARTUP_MS: '30000'
        }
    });
    t.after(() => {
        // SIGTERM permite al supervisor propagar el cierre a su hijo; si se
        // usa SIGKILL el hijo queda huérfano y el runner no termina.
        try { supervisor.kill('SIGTERM'); } catch { }
        setTimeout(() => {
            try {
                const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
                if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
            } catch { }
            try { supervisor.kill('SIGKILL'); } catch { }
        }, 3000).unref();
    });

    const health = await waitFor(async () => {
        try { return (await get(`http://127.0.0.1:${PORT}/healthz`)).status === 200; } catch { return false; }
    });
    assert.equal(health, true, 'el servidor debe responder /healthz');

    const childPid = await waitFor(() => {
        try {
            const raw = fs.readFileSync(pidFile, 'utf8').trim();
            const pid = Number(raw);
            return Number.isInteger(pid) && pid > 0 ? pid : null;
        } catch { return null; }
    });
    assert.ok(childPid, 'el supervisor debe publicar el PID del hijo');

    process.kill(childPid, 'SIGKILL');

    const revived = await waitFor(async () => {
        try { return (await get(`http://127.0.0.1:${PORT}/healthz`)).status === 200; } catch { return false; }
    }, 40000);
    assert.equal(revived, true, 'el supervisor debe reiniciar el servidor');
});

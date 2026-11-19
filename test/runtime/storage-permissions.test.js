// Los respaldos contienen bases y credenciales: ni sus directorios ni sus
// ficheros pueden quedar legibles para otros usuarios locales.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { hardenStoragePermissions } = require('../../ops/config/secure-storage.js');

const modo = ruta => fs.statSync(ruta).mode & 0o777;

test('endurece datos y TODO el árbol de respaldos sin seguir symlinks', t => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-permisos-'));
    t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
    const data = path.join(raiz, 'data');
    const backups = path.join(raiz, 'backups');
    const anidado = path.join(backups, 'manual', 'interno');
    const dbPath = path.join(data, 'zlapy.db');
    const blobPath = path.join(data, 'blob.db');
    const envPath = path.join(raiz, '.env');
    const respaldo = path.join(anidado, 'chat.db.migrated.bak');
    const externo = path.join(raiz, 'externo.txt');
    fs.mkdirSync(anidado, { recursive: true, mode: 0o755 });
    fs.mkdirSync(data, { mode: 0o755 });
    for (const archivo of [dbPath, blobPath, envPath, respaldo, externo]) {
        fs.writeFileSync(archivo, 'prueba');
        // El modo de writeFileSync queda sometido al umask; la precondición
        // debe ser explícita para que la prueba también funcione con umask 077.
        fs.chmodSync(archivo, 0o644);
    }
    fs.chmodSync(backups, 0o755);
    fs.chmodSync(path.join(backups, 'manual'), 0o755);
    fs.chmodSync(anidado, 0o755);
    fs.symlinkSync(externo, path.join(backups, 'enlace-externo'));

    hardenStoragePermissions({ dataDir: data, backupDir: backups, envPath, dbPaths: [dbPath, blobPath] });

    assert.equal(modo(data), 0o700);
    assert.equal(modo(backups), 0o700);
    assert.equal(modo(path.join(backups, 'manual')), 0o700);
    assert.equal(modo(anidado), 0o700);
    for (const archivo of [dbPath, blobPath, envPath, respaldo]) assert.equal(modo(archivo), 0o600);
    assert.equal(modo(externo), 0o644, 'un symlink dentro de backups no toca su destino');
});

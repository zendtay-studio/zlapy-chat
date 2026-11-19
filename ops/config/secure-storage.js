/**
 * Endurecimiento de permisos del almacenamiento local.
 *
 * Las bases, la credencial y cualquier respaldo deben quedar solo accesibles
 * para su propietario. El recorrido de backups no sigue enlaces simbólicos:
 * un enlace colocado ahí nunca debe cambiar permisos fuera de ese árbol.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function hardenStoragePermissions({ dataDir, backupDir, envPath, dbPaths = [] }) {
    const errors = [];
    const restrict = (target, mode) => {
        try {
            if (target && fs.existsSync(target)) fs.chmodSync(target, mode);
        } catch (error) { errors.push(error); }
    };

    restrict(dataDir, 0o700);
    for (const dbPath of dbPaths) restrict(dbPath, 0o600);
    restrict(envPath, 0o600);

    const visitBackup = directory => {
        restrict(directory, 0o700);
        let entries;
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
        catch (error) { errors.push(error); return; }
        for (const entry of entries) {
            // Ni chmod ni lectura recursiva a través de un symlink.
            if (entry.isSymbolicLink()) continue;
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) visitBackup(target);
            else if (entry.isFile()) restrict(target, 0o600);
        }
    };

    try {
        if (backupDir && fs.existsSync(backupDir) && fs.lstatSync(backupDir).isDirectory())
            visitBackup(backupDir);
    } catch (error) { errors.push(error); }
    return errors;
}

module.exports = { hardenStoragePermissions };

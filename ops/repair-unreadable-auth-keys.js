#!/usr/bin/env node
/**
 * Reparación de auth_keys que NO se descifran con la llave maestra actual.
 *
 * Qué arregla
 *   Una fila de `user_auth_keys` puede quedar cifrada con una llave
 *   distinta de la que hay ahora en el `.env`. El caso típico: se giró la
 *   llave maestra con el servidor EN MARCHA. El motor de rotación re-cifra
 *   las filas que existían en ese momento, pero el proceso viejo seguía
 *   vivo con la llave anterior en memoria y siguió escribiendo: las filas
 *   nuevas quedaron con la llave vieja y son ilegibles.
 *
 *   Con una fila ilegible:
 *     · el perfil de esa cuenta no se puede guardar (500), y
 *     · su contenido (PCE3: perfil, notas, mensajes) es irrecuperable.
 *
 * Qué hace
 *   Para cada cuenta con auth_key ilegible:
 *     1. copia de seguridad de `data/zlapy.db` (API de backup de SQLite),
 *     2. borra la fila de `user_auth_keys` (el servidor generará una clave
 *        nueva y limpia en el siguiente arranque o al primer guardado),
 *     3. borra los campos de perfil cifrados con esa clave (nombre, bio,
 *        nota), porque si no quedan ilegibles para siempre: la cuenta
 *        vuelve a mostrar su nombre de usuario y el usuario puede volver a
 *        escribir el que quiera.
 *
 * Qué NO hace
 *   No inventa el contenido perdido. Los mensajes, notas y el nombre
 *   anterior de esa cuenta NO se pueden recuperar con esta llave: hacen
 *   falta la llave maestra antigua (la del respaldo) o el texto original.
 *
 * Cómo se usa
 *   node ops/repair-unreadable-auth-keys.js            # simulación: no escribe nada
 *   node ops/repair-unreadable-auth-keys.js --apply    # repara de verdad
 *
 * Recomendaciones
 *   · Para el servidor antes de reparar (o después: el supervisor lo
 *     reinicia solo, y la clave nueva se crea en memoria).
 *   · Cada cuenta se verifica ANTES y DESPUÉS de tocarla.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../src/config.js');
const { createMessageCrypto } = require('../src/crypto/message-crypto.js');
const { unlockMasterKey } = require('../src/crypto/owner-key.js');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const DATA = path.dirname(DB_PATH);

if (!fs.existsSync(DB_PATH)) {
    console.error(`No se encuentra ${DB_PATH}: no hay nada que reparar.`);
    process.exit(1);
}

/* La llave maestra sale de la credencial del propietario (DB_USER +
   DB_PASSWORD en el .env): si esa credencial no abre la base, no hay forma de
   saber qué filas son ilegibles. */
let key = null;
try {
    key = unlockMasterKey({ dbPath: DB_PATH }).key;
} catch (error) {
    console.error(`No se pudo desbloquear la base con la credencial del propietario: ${error.message}`);
    process.exit(1);
}
const crypto = createMessageCrypto(key);

/* ¿La fila de auth_key de esta cuenta se descifra con la llave actual? */
const authKeyLegible = authKey => {
    if (typeof authKey !== 'string' || !authKey) return false;
    let plain = null;
    try { plain = crypto.decryptAtRest(authKey); } catch { }
    if (typeof plain !== 'string') return false;
    return /^[0-9a-f]{512}$/i.test(plain);
};

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const usuarios = new Map(
    db.prepare('SELECT id, username FROM users').all().map(fila => [fila.id, fila.username])
);

const ilegibles = db.prepare('SELECT user_id, auth_key FROM user_auth_keys').all()
    .filter(fila => !authKeyLegible(fila.auth_key))
    .map(fila => ({ userId: fila.user_id, username: usuarios.get(fila.user_id) || '(desconocido)' }));

if (ilegibles.length === 0) {
    console.log('Todas las auth_key se descifran con la llave actual: no hay nada que reparar.');
    db.close();
    process.exit(0);
}

console.log(`auth_key ilegibles con la llave actual: ${ilegibles.length}`);
for (const fila of ilegibles) {
    const mensajes = db.prepare('SELECT COUNT(*) AS total FROM messages WHERE from_id = ? OR to_id = ?')
        .get(fila.userId, fila.userId);
    const perfil = db.prepare(
        "SELECT COUNT(*) AS total FROM user_profiles WHERE user_id = ? AND (display_name LIKE 'PCE3:%' OR bio LIKE 'PCE3:%' OR note LIKE 'PCE3:%')"
    ).get(fila.userId);
    const notas = db.prepare('SELECT COUNT(*) AS total FROM user_notes WHERE user_id = ?').get(fila.userId);
    console.log(`  · ${fila.username} (${fila.userId}): ${Number(mensajes.total)} mensajes, ${Number(perfil.total)} campos de perfil, ${Number(notas.total)} notas — irrecuperables con esta llave`);
}

if (!APPLY) {
    console.log('Simulación: no se ha escrito nada. Repite con --apply para repararlo de verdad.');
    db.close();
    process.exit(0);
}

// Respaldo antes de escribir: la API de backup de SQLite da una copia
// consistente aunque hubiera actividad.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(DATA, `zlapy.db.bak-${stamp}`);
db.backup(backupPath).then(() => {
    try { fs.chmodSync(backupPath, 0o600); } catch { /* best-effort */ }
    console.log(`respaldo: ${backupPath}`);

    const reparar = db.transaction(lista => {
        for (const fila of lista) {
            db.prepare('DELETE FROM user_auth_keys WHERE user_id = ?').run(fila.userId);
            // Los campos cifrados con la clave perdida se vacían: si no,
            // seguirían siendo PCE3 ilegibles y la cuenta no podría
            // guardar su perfil nunca más.
            db.prepare("UPDATE user_profiles SET display_name = '', bio = '', note = '', note_ts = 0 WHERE user_id = ?")
                .run(fila.userId);
            db.prepare('DELETE FROM user_notes WHERE user_id = ?').run(fila.userId);
        }
    });

    try {
        reparar(ilegibles);
    } catch (error) {
        db.close();
        console.error('No se pudo reparar:', error.message);
        process.exit(1);
    }

    // Verificación posterior: la fila debe haber desaparecido y el perfil
    // debe quedar limpio (la clave nueva la generará el servidor).
    const pendientes = db.prepare('SELECT user_id, auth_key FROM user_auth_keys').all()
        .filter(fila => !authKeyLegible(fila.auth_key)).length;
    console.log(`Reparadas ${ilegibles.length} cuentas. auth_key ilegibles que quedan: ${pendientes}`);
    console.log('La cuenta vuelve a mostrar su nombre de usuario; el usuario puede escribir otro nombre y se cifrará con la clave nueva.');
    db.close();
}).catch(error => {
    console.error('No se pudo hacer el respaldo:', error.message);
    db.close();
    process.exit(1);
});

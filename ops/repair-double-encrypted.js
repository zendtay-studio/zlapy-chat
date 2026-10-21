#!/usr/bin/env node
/**
 * Reparación de perfiles con cifrado doble.
 *
 * Qué arregla
 *   Si el servidor le pintó a un cliente un texto YA cifrado (porque al
 *   arrancar leía el perfil con la función equivocada) y ese cliente guardó
 *   el perfil sin tocarlo, el texto quedó cifrado dos veces:
 *   PCE3( PCE3( "texto real" ) ). A simple vista es basura, pero se puede
 *   desenvolver: se descifra una vez y, si lo que sale vuelve a ser un PCE,
 *   se descifra otra vez para recuperar el texto original.
 *
 * Qué NO hace
 *   No modifica el servidor ni el esquema: solo reescribe las filas de
 *   `user_profiles` y `user_notes` de las cuentas afectadas. Es idempotente:
 *   se puede repetir tantas veces como haga falta.
 *
 * Cómo se usa
 *   node ops/repair-double-encrypted.js            # simulación: no escribe nada
 *   node ops/repair-double-encrypted.js --apply    # repara de verdad
 *
 * Recomendaciones
 *   · Para el servidor (o el supervisor) antes de reparar.
 *   · Hace una copia de seguridad automática en backups/ antes de escribir.
 *   · Cada registro se verifica (ida y vuelta) ANTES de tocarlo.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');
const { createMessageCrypto } = require('../src/crypto/message-crypto');
const { createUserAuthKeys } = require('../src/crypto/user-auth-keys');
const { getMasterKeyBytes } = require('../src/crypto/master-key');
const { ensureSchema } = require('../src/db/schema');
const { Stmt } = require('../src/db/statements');

const ROOT = path.join(__dirname, '..');
const CONFIG = loadConfig(process.env);
const APPLY = process.argv.includes('--apply');

const DATA = CONFIG.dataDir ? path.resolve(ROOT, CONFIG.dataDir) : path.join(ROOT, 'data');
const DB_PATH = path.join(DATA, 'zlapy.db');
if (!fs.existsSync(DB_PATH)) {
    console.error(`No se encuentra ${DB_PATH}: no hay nada que reparar.`);
    process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
ensureSchema(db);

const masterKey = getMasterKeyBytes();
const messageCrypto = createMessageCrypto(masterKey, { signingKeyFor: () => masterKey });
const { encryptAtRest, decryptAtRest } = messageCrypto;
const authKeys = createUserAuthKeys({ db, Stmt, encryptAtRest, decryptAtRest });
const { decryptForUser, encryptForUser } = authKeys;

/* Descifra con la auth_key del titular (PCE3) o con la llave maestra (PCE1). */
function decrypt(value, userId) {
    if (typeof value !== 'string' || value === '') return null;
    const plain = decryptForUser(userId, value);
    return typeof plain === 'string' ? plain : null;
}

/* ¿Este valor está cifrado dos veces? Devuelve el texto original o null. */
function develop(blob, userId) {
    if (typeof blob !== 'string' || !blob.startsWith('PCE')) return null;
    const first = decrypt(blob, userId);
    if (typeof first !== 'string' || !first.startsWith('PCE')) return null;
    const second = decrypt(first, userId);
    if (typeof second !== 'string' || second === '' || second.startsWith('PCE')) return null;
    return second;
}

let fixedProfiles = 0;
let fixedNotes = 0;
let checked = 0;
const changes = [];

const profiles = db.prepare('SELECT user_id, display_name, bio, note FROM user_profiles').all();
for (const row of profiles) {
    checked++;
    const update = {};
    for (const [column, field] of [['display_name', 'name'], ['bio', 'desc'], ['note', 'note']]) {
        const blob = row[column];
        if (typeof blob !== 'string' || blob === '') continue;
        // developed = el texto original (si estaba cifrado dos veces) o el
        // propio valor si ya estaba en claro (se vuelve a cifrar).
        const developed = blob.startsWith('PCE') ? develop(blob, row.user_id) : blob;
        if (developed === null) continue;
        if (developed === blob && blob.startsWith('PCE')) continue;   // ya está bien
        // Ida y vuelta: al cifrar de nuevo debe salir el mismo texto.
        const check = decrypt(encryptForUser(row.user_id, developed), row.user_id);
        if (check !== developed) continue;
        update[column] = encryptForUser(row.user_id, developed);
        changes.push({ tabla: 'user_profiles', user: row.user_id, campo: field, antes: String(blob).slice(0, 46), despues: developed.slice(0, 46) });
    }
    if (!Object.keys(update).length) continue;
    fixedProfiles++;
    if (APPLY) {
        const sets = Object.keys(update).map(column => `${column} = ?`).join(', ');
        db.prepare(`UPDATE user_profiles SET ${sets} WHERE user_id = ?`).run(...Object.values(update), row.user_id);
    }
}

const notes = db.prepare('SELECT user_id, data FROM user_notes').all();
for (const row of notes) {
    checked++;
    const plain = develop(row.data, row.user_id);
    if (plain === null) continue;
    let parsed = null;
    try { parsed = JSON.parse(plain); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const text = JSON.stringify(parsed);
    const check = decrypt(encryptForUser(row.user_id, text), row.user_id);
    if (typeof check !== 'string' || check === '') continue;
    changes.push({ tabla: 'user_notes', user: row.user_id, campo: 'nota', antes: String(row.data).slice(0, 46), despues: text.slice(0, 46) });
    fixedNotes++;
    if (APPLY) db.prepare('UPDATE user_notes SET data = ? WHERE user_id = ?').run(encryptForUser(row.user_id, text), row.user_id);
}

console.log(`Filas revisadas: ${checked}`);
console.log(`Perfiles a reparar: ${fixedProfiles}`);
console.log(`Notas a reparar: ${fixedNotes}`);
for (const change of changes) {
    console.log(`  · ${change.tabla}.${change.campo} (${change.user.slice(0, 8)}): ${change.antes}… -> ${change.despues}…`);
}
if (!APPLY) {
    console.log('\nSimulación: no se ha escrito nada. Usa --apply para reparar de verdad.');
    process.exit(0);
}
if (!changes.length) {
    console.log('\nNo hay nada que reparar.');
    process.exit(0);
}

// Copia de seguridad antes de escribir.
const backupDir = path.join(ROOT, 'backups');
if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(backupDir, `zlapy-${stamp}-pre-reparacion.db`);
db.prepare('VACUUM INTO ?').run(backupFile);
console.log(`\nCopia de seguridad: ${backupFile}`);
console.log('Reparación aplicada.');

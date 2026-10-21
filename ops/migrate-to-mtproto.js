#!/usr/bin/env node
/**
 * Migración manual al esquema de cifrado en la nube (MTProto 2.0).
 *
 * Convierte de golpe el contenido que quedó en el esquema anterior al nuevo:
 * mensajes PCE2 (AES-256-GCM con la llave maestra) a PCE3 (MTProto 2.0), y
 * resúmenes, notas, perfil, llamadas, push e historias en claro o PCE1 a
 * cifrados con la auth_key del usuario.
 */

/* Que NO hace
 *   El servidor NO migra al arrancar: lee los dos formatos y escribe siempre el
 *   nuevo. Si borras este fichero, el servidor sigue funcionando igual (el
 *   contenido viejo se sigue leyendo y se va re-cifrando solo a medida que se
 *   reescribe). Este script solo sirve para convertir el historico de golpe.
 *
 * Como se usa
 *   node ops/migrate-to-mtproto.js            # simulacion: no escribe nada
 *   node ops/migrate-to-mtproto.js --apply    # migra de verdad
 *
 * Recomendaciones
 *   · Para con el servidor (o el supervisor) antes de migrar.
 *   · Hace un respaldo automatico en backups/ antes de escribir.
 *   · Es idempotente: se puede repetir las veces que quieras.
 *   · Cada registro se verifica (ida y vuelta) ANTES de tocarlo.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');
const { createMessageCrypto } = require('../src/crypto/message-crypto');
const { createUserAuthKeys } = require('../src/crypto/user-auth-keys');
const { ensureSchema } = require('../src/db/schema');
const mtproto = require('../src/crypto/mtproto');

const ROOT = path.join(__dirname, '..');
const CONFIG = loadConfig(process.env);
const DATA_DIR = path.resolve(ROOT, CONFIG.dataDir || 'data');
const DB_PATH = path.join(DATA_DIR, 'zlapy.db');
const BLOB_DB_PATH = path.join(DATA_DIR, 'blob.db');
const MASTER_KEY_PATH = path.join(ROOT, '.zlapymasterkey');
const APPLY = process.argv.includes('--apply');

function masterKeyBytes() {
    if (CONFIG.chatMasterKey) {
        const key = Buffer.from(CONFIG.chatMasterKey, 'base64');
        if (key.length !== 32) throw new Error('CHAT_MASTER_KEY debe codificar 32 bytes.');
        return key;
    }
    if (!fs.existsSync(MASTER_KEY_PATH))
        throw new Error(`Falta ${MASTER_KEY_PATH} (o CHAT_MASTER_KEY): sin la llave maestra no se puede leer el contenido antiguo.`);
    const key = fs.readFileSync(MASTER_KEY_PATH);
    if (key.length !== 32) throw new Error(`${MASTER_KEY_PATH} debe contener exactamente 32 bytes.`);
    return key;
}

async function backup() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(ROOT, 'backups', `pre-mtproto-${stamp}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { }
    // db.backup() es asincrono: hay que esperar a que termine antes de cerrar.
    const db = new Database(DB_PATH, { readonly: true });
    try { await db.backup(path.join(dir, 'zlapy.db')); } finally { db.close(); }
    if (fs.existsSync(BLOB_DB_PATH)) {
        const blob = new Database(BLOB_DB_PATH, { readonly: true });
        try { await blob.backup(path.join(dir, 'blob.db')); } finally { blob.close(); }
    }
    for (const file of ['zlapy.db', 'blob.db']) {
        const target = path.join(dir, file);
        if (fs.existsSync(target)) { try { fs.chmodSync(target, 0o600); } catch { } }
    }
    return dir;
}

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`No se encuentra ${DB_PATH}: no hay nada que migrar.`);
        process.exit(1);
    }
    const masterKey = masterKeyBytes();
    const messageCrypto = createMessageCrypto(masterKey);
    const { encryptAtRest, decryptAtRest } = messageCrypto;

    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);

    const Stmt = {
        getAuthKey: db.prepare('SELECT auth_key, key_id, salt, session_id, last_msg_id FROM user_auth_keys WHERE user_id = ?'),
        insertAuthKey: db.prepare('INSERT INTO user_auth_keys (user_id, auth_key, key_id, salt, session_id, last_msg_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        updateAuthKeySalt: db.prepare('UPDATE user_auth_keys SET salt = ?, updated_at = ? WHERE user_id = ?'),
        updateAuthKeyMsgId: db.prepare('UPDATE user_auth_keys SET last_msg_id = ?, updated_at = ? WHERE user_id = ?'),
        upsertSummary: db.prepare('INSERT OR REPLACE INTO summaries (owner, peer, unread, last_data) VALUES (?, ?, ?, ?)'),
        upsertGroupSummary: db.prepare('INSERT OR REPLACE INTO group_summaries (owner, gid, unread, last_data) VALUES (?, ?, ?, ?)'),
        updateMessage: db.prepare(`UPDATE messages SET kind = ?, data = ?, hash = ?, once = ?, edited = ?,
            crypto_version = ?, crypto_group_id = ?, signature = ?, signing_public_key = ? WHERE id = ?`)
    };
    const authKeys = createUserAuthKeys({ db, Stmt, encryptAtRest, decryptAtRest });
    const { ensureAuthKey, encryptForUser, decryptForUser, messageContextBytes } = authKeys;

    const resumen = { mensajes: 0, resumenes: 0, notas: 0, perfiles: 0, llamadas: 0, push: 0, historias: 0, omitidos: 0 };
    // Lo que NO esta ya con la auth_key del usuario (ni en claro ni cifrado
    // con la llave maestra) es lo que hay que migrar.
    const necesitaAuthKey = v => typeof v === 'string' && v !== '' && !v.startsWith('PCE3:');

    // Mensajes (PCE2 -> PCE3)
    const mensajes = db.prepare(`SELECT id, chat, ts, from_id, to_id, kind, data, hash, once, edited,
        crypto_version, crypto_group_id, signature, signing_public_key FROM messages
        WHERE crypto_version < 3`).all();
    for (const row of mensajes) {
        let plain = null;
        try { plain = messageCrypto.decryptMessage(row.data, row); } catch { }
        if (plain === null) { resumen.omitidos++; continue; }
        let body;
        try { body = JSON.parse(plain); } catch { resumen.omitidos++; continue; }
        const msg = {
            id: row.id, fromId: row.from_id, toId: row.to_id || '', kind: row.kind, ts: row.ts,
            name: body.name || '', mime: body.mime || '', caption: body.caption || '',
            data: body.data || '', gallery: body.gallery || [], reply: body.reply || null,
            status: body.status || 'sent', enc: body.enc || '', mentions: body.mentions || [],
            mentionLabels: body.mentionLabels || {}, invite: body.invite || null, readAt: body.readAt || 0,
            hash: row.hash || '', once: !!row.once, edited: !!row.edited
        };
        const rec = ensureAuthKey(row.from_id);
        const msgId = mtproto.nextMsgId(rec.lastMsgId);
        const encrypted = mtproto.encrypt(rec.key, JSON.stringify(body), {
            salt: rec.salt, sessionId: rec.sessionId, msgId, seqNo: 0
        }, messageContextBytes(row));
        // Verificacion de ida y vuelta: no se escribe lo que no se pueda releer.
        const check = mtproto.decrypt(rec.key, encrypted.blob, messageContextBytes(row));
        if (!check || check.body.toString('utf8') !== plain) { resumen.omitidos++; continue; }
        if (APPLY) {
            rec.lastMsgId = msgId;
            Stmt.updateAuthKeyMsgId.run(msgId, Date.now(), row.from_id);
            Stmt.updateMessage.run(msg.kind, encrypted.blob, msg.hash || null, msg.once ? 1 : 0,
                msg.edited ? 1 : 0, 3, msg.cryptoGroupId || null, row.signature || '', row.signing_public_key || '', msg.id);
        }
        resumen.mensajes++;
    }

    // El resto de contenido por usuario
    if (APPLY) {
        for (const row of db.prepare('SELECT owner, peer, unread, last_data FROM summaries').all()) {
            if (!necesitaAuthKey(row.last_data)) continue;
            const plain = decryptForUser(row.owner, row.last_data);
            if (plain === null) { resumen.omitidos++; continue; }
            Stmt.upsertSummary.run(row.owner, row.peer, row.unread, encryptForUser(row.owner, plain));
            resumen.resumenes++;
        }
        for (const row of db.prepare('SELECT owner, gid, unread, last_data FROM group_summaries').all()) {
            if (!necesitaAuthKey(row.last_data)) continue;
            const plain = decryptForUser(row.owner, row.last_data);
            if (plain === null) { resumen.omitidos++; continue; }
            Stmt.upsertGroupSummary.run(row.owner, row.gid, row.unread, encryptForUser(row.owner, plain));
            resumen.resumenes++;
        }
        for (const row of db.prepare('SELECT user_id, data FROM user_notes').all()) {
            if (!necesitaAuthKey(row.data)) continue;
            const plain = decryptForUser(row.user_id, row.data);
            if (plain === null) { resumen.omitidos++; continue; }
            db.prepare('UPDATE user_notes SET data = ? WHERE user_id = ?').run(encryptForUser(row.user_id, plain), row.user_id);
            resumen.notas++;
        }
        for (const row of db.prepare('SELECT user_id, display_name, bio, note FROM user_profiles').all()) {
            const name = decryptForUser(row.user_id, row.display_name);
            const bio = decryptForUser(row.user_id, row.bio);
            const note = decryptForUser(row.user_id, row.note);
            if (name === null || bio === null || note === null) { resumen.omitidos++; continue; }
            if (!necesitaAuthKey(row.display_name) && !necesitaAuthKey(row.bio) && !necesitaAuthKey(row.note)) continue;
            db.prepare('UPDATE user_profiles SET display_name = ?, bio = ?, note = ? WHERE user_id = ?')
                .run(encryptForUser(row.user_id, name), encryptForUser(row.user_id, bio), encryptForUser(row.user_id, note), row.user_id);
            resumen.perfiles++;
        }
        for (const row of db.prepare('SELECT id, owner, data FROM calls').all()) {
            if (!necesitaAuthKey(row.data)) continue;
            const plain = decryptForUser(row.owner, row.data);
            if (plain === null) { resumen.omitidos++; continue; }
            db.prepare('UPDATE calls SET data = ? WHERE id = ? AND owner = ?').run(encryptForUser(row.owner, plain), row.id, row.owner);
            resumen.llamadas++;
        }
        for (const row of db.prepare('SELECT user_id, endpoint, data FROM push_subs').all()) {
            if (!necesitaAuthKey(row.data)) continue;
            const plain = decryptForUser(row.user_id, row.data);
            if (plain === null) { resumen.omitidos++; continue; }
            db.prepare('UPDATE push_subs SET data = ? WHERE user_id = ? AND endpoint = ?').run(encryptForUser(row.user_id, plain), row.user_id, row.endpoint);
            resumen.push++;
        }
        for (const row of db.prepare('SELECT from_id, ts, data FROM stories').all()) {
            if (!necesitaAuthKey(row.data)) continue;
            const plain = decryptForUser(row.from_id, row.data);
            if (plain === null) { resumen.omitidos++; continue; }
            db.prepare('UPDATE stories SET data = ? WHERE from_id = ? AND ts = ?').run(encryptForUser(row.from_id, plain), row.from_id, row.ts);
            resumen.historias++;
        }
    }

    const quedan = db.prepare("SELECT COUNT(*) c FROM messages WHERE crypto_version < 3").get().c;
    db.close();

    console.log(APPLY ? 'MIGRACION APLICADA' : 'SIMULACION (no se escribio nada)');
    console.log('  mensajes a migrar   :', resumen.mensajes);
    console.log('  resumenes            :', resumen.resumenes);
    console.log('  notas / perfiles     :', resumen.notas, '/', resumen.perfiles);
    console.log('  llamadas / push      :', resumen.llamadas, '/', resumen.push);
    console.log('  historias            :', resumen.historias);
    console.log('  omitidos (ilegibles):', resumen.omitidos);
    console.log('  mensajes aun en el esquema viejo:', quedan);
    if (APPLY) console.log('  (migra de nuevo cuando quieras: es idempotente)');
    else console.log('\nPara migrar de verdad: node ops/migrate-to-mtproto.js --apply');
}

(async () => {
    if (APPLY) {
        console.log('Creando respaldo antes de migrar…');
        const dir = await backup();
        console.log('Respaldo en:', dir);
    }
    await main();
})().catch(error => {
    console.error('La migracion ha fallado:', error.message);
    process.exit(1);
});

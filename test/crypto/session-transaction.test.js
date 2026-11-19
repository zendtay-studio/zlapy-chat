// La poda RAM de auth_key forma parte del resultado transaccional: si SQLite
// revierte, la clave vigente conserva su sesión y la clave descartada se poda.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const mtproto = require('../../src/crypto/mtproto.js');
const { ctxSummary } = require('../../src/crypto/aad.js');
const { authKeys } = require('../../src/crypto/setup.js');
const { blobDb, db } = require('../../src/db/database.js');
const { Stmt } = require('../../src/db/statements.js');
const { tx } = require('../../src/db/transactions.js');
const { regenerateAuthKey } = require('../../src/users/store.js');
const { postAccountDelete } = require('../../src/profile/routes.js');
const { hashPassword } = require('../../src/auth/password-core.js');
const { cerrarWorker } = require('../../src/auth/password.js');
const { users, usernameIndex } = require('../../src/state.js');

test.after(() => cerrarWorker());

function insertUser(id, username, passwordHash = 'x') {
    Stmt.insertUser.run(id, username, passwordHash, '', 'request', 0, 0);
}

function responseDouble() {
    const headers = new Map();
    return {
        headersSent: false,
        setHeader(name, value) { headers.set(name, value); },
        getHeader(name) { return headers.get(name); },
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = String(body || ''); }
    };
}

test('un rollback de rotación conserva el contador viejo y poda el de la clave descartada', t => {
    const id = 'u-rollback-rotation';
    insertUser(id, 'rollbackrotation');
    insertUser('u-rollback-peer', 'rollbackpeer');
    const oldRec = authKeys.ensureAuthKey(id);
    authKeys.encryptForUser(id, 'resumen viejo', ctxSummary(id, 'u-rollback-peer'));
    Stmt.upsertSummary.run(id, 'u-rollback-peer', 0,
        authKeys.encryptForUser(id, 'resumen viejo', ctxSummary(id, 'u-rollback-peer')));
    const newKey = crypto.randomBytes(mtproto.AUTH_KEY_BYTES);
    const originalRun = Stmt.upsertSummary.run;
    const originalGenerate = mtproto.generateAuthKey;
    t.after(() => {
        Stmt.upsertSummary.run = originalRun;
        mtproto.generateAuthKey = originalGenerate;
        authKeys.authKeyCache.delete(id);
        db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(id, 'u-rollback-peer');
    });
    mtproto.generateAuthKey = () => newKey;
    Stmt.upsertSummary.run = () => { throw new Error('fallo inducido tras instalar la clave'); };

    assert.throws(() => regenerateAuthKey(id), /fallo inducido/);
    assert.equal(Stmt.getAuthKey.get(id).key_id, oldRec.keyId, 'SQLite restauró la auth_key anterior');

    const oldSurvives = mtproto.forgetSession(oldRec.key);
    const discardedIsAbsent = !mtproto.forgetSession(newKey);
    assert.equal(oldSurvives, true, 'la clave que sigue vigente no pierde su contador');
    assert.equal(discardedIsAbsent, true, 'la clave nunca confirmada no deja contador');
});

test('rotar sin fila previa inserta la auth_key y permite recargarla desde SQLite', t => {
    const id = 'u-rotation-without-row';
    insertUser(id, 'rotationwithoutrow');
    t.after(() => {
        authKeys.authKeyCache.delete(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    assert.equal(authKeys.authKeyRecord(id), null, 'la precondición es una fila ausente');

    const result = regenerateAuthKey(id);
    assert.equal(Stmt.getAuthKey.get(id).key_id, result.keyId, 'el upsert persistió la clave nueva');
    authKeys.authKeyCache.delete(id);
    const recargada = authKeys.authKeyRecord(id);
    assert.equal(recargada.keyId, result.keyId, 'recargar no depende de la caché');
    const escrito = authKeys.encryptForUser(id, 'contenido durable');
    assert.equal(authKeys.decryptForUser(id, escrito), 'contenido durable');
});

function simularPodaSqliteFallida(t) {
    t.after(() => {
        // Restaura el adaptador real de crypto/setup sin recargar módulos.
        blobDb.prepare('DELETE FROM mtproto_session_spill').run();
        const get = blobDb.prepare('SELECT next_seq FROM mtproto_session_spill WHERE auth_key_id = ?');
        const save = blobDb.prepare(`INSERT INTO mtproto_session_spill (auth_key_id, next_seq) VALUES (?, ?)
            ON CONFLICT(auth_key_id) DO UPDATE SET next_seq = excluded.next_seq`);
        const forget = blobDb.prepare('DELETE FROM mtproto_session_spill WHERE auth_key_id = ?');
        mtproto.configureSessionPersistence({
            load: id => get.get(id)?.next_seq || 0,
            save: (id, seq) => { save.run(id, seq); },
            forget: id => forget.run(id).changes > 0
        });
    });
    mtproto.configureSessionPersistence({
        load: () => 0,
        save: () => { },
        forget: () => { throw new Error('spill ocupado'); }
    });
}

test('un fallo de poda DESPUÉS del commit no restaura la clave anterior', t => {
    const id = 'u-postcommit-rotation';
    insertUser(id, 'postcommitrotation');
    const previous = authKeys.ensureAuthKey(id);
    authKeys.encryptForUser(id, 'contenido');
    t.after(() => {
        authKeys.authKeyCache.delete(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    simularPodaSqliteFallida(t);
    t.mock.method(console, 'warn', () => { });

    let result;
    assert.doesNotThrow(() => { result = regenerateAuthKey(id); });
    assert.equal(Stmt.getAuthKey.get(id).key_id, result.keyId, 'SQLite conserva la nueva');
    assert.equal(authKeys.authKeyRecord(id).keyId, result.keyId, 'RAM también conserva la nueva');
    assert.notEqual(result.keyId, previous.keyId);
});

test('un fallo de poda DESPUÉS de borrar no deja la cuenta autenticada en RAM', async t => {
    const id = 'u-postcommit-delete';
    const username = 'postcommitdelete';
    const passwordHash = await hashPassword('pruebachat1');
    insertUser(id, username, passwordHash);
    const account = { id, username, passwordHash, passwordSalt: '', sockets: new Set(), contacts: new Set() };
    users.set(id, account);
    usernameIndex.set(username, id);
    const rec = authKeys.ensureAuthKey(id);
    authKeys.encryptForUser(id, 'contenido');
    t.after(() => {
        users.delete(id);
        usernameIndex.delete(username);
        authKeys.authKeyCache.delete(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    simularPodaSqliteFallida(t);
    t.mock.method(console, 'warn', () => { });
    const res = responseDouble();

    await postAccountDelete({ authUser: account, headers: {}, socket: { encrypted: true } }, res,
        null, { password: 'pruebachat1' }, username);
    assert.equal(res.statusCode, 200);
    assert.equal(Stmt.getUserById.get(id), undefined, 'la fila sigue borrada');
    assert.equal(users.has(id), false, 'la cuenta no sobrevive en RAM aunque falle la poda');
    assert.equal(mtproto.authKeyId(rec.key).length, 16);
});

test('un fallo al borrar la cuenta no poda el contador de su auth_key vigente', async t => {
    const id = 'u-rollback-delete';
    const username = 'rollbackdelete';
    const passwordHash = await hashPassword('pruebachat1');
    insertUser(id, username, passwordHash);
    const account = {
        id, username, passwordHash, passwordSalt: '', sockets: new Set(), contacts: new Set()
    };
    users.set(id, account);
    usernameIndex.set(username, id);
    const oldRec = authKeys.ensureAuthKey(id);
    authKeys.encryptForUser(id, 'contenido');
    const originalDelete = tx.deleteAccount;
    t.after(() => {
        tx.deleteAccount = originalDelete;
        users.delete(id);
        usernameIndex.delete(username);
        authKeys.authKeyCache.delete(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    tx.deleteAccount = () => { throw new Error('borrado revertido'); };
    const req = { authUser: account, headers: {}, socket: { encrypted: true } };

    await assert.rejects(postAccountDelete(req, responseDouble(), null, { password: 'pruebachat1' }, username), /borrado revertido/);
    assert.ok(Stmt.getUserById.get(id), 'la cuenta sigue existiendo');
    assert.equal(mtproto.forgetSession(oldRec.key), true,
        'el contador solo se poda después de confirmar el borrado');
});

// Tests del esquema v3 de la base de datos:
//   · el esquema se aplica en bases nuevas (idempotente, sin migraciones),
//   · borrar una cuenta arrastra TODO en cascada (y libera el usuario),
//     sin purgar grupos cuyo gid contenga el uuid de la víctima,
//   · las restricciones (UNIQUE, CHECK, claves ajenas) hacen su trabajo.
const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
    SCHEMA_VERSION,
    ensureSchema,
    tableExists,
    tableColumns,
    deleteAccountRows
} = require('../src/db/schema.js');

const TABLES_V2 = [
    'users', 'user_profiles', 'user_keys', 'user_privacy', 'user_privacy_users',
    'user_chat_settings', 'user_muted_peers', 'user_notes', 'user_stickers',
    'user_group_seen', 'sessions', 'contacts', 'contact_requests', 'blocked',
    'summaries', 'messages', 'blob_access', 'stories', 'calls', 'push_subs',
    'groups', 'group_members', 'group_summaries', 'group_join_requests', 'meta'
];

const ids = {
    a: '11111111-1111-4111-8111-111111111111',
    b: '22222222-2222-4222-8222-222222222222',
    c: '33333333-3333-4333-8333-333333333333'
};

const newDb = () => new Database(':memory:');

/* Busca un valor en TODAS las columnas de TODAS las tablas. */
function findValueInDb(db, value) {
    const found = [];
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all();
    for (const table of tables) {
        for (const column of db.pragma(`table_info(${table})`)) {
            const count = db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE "${column.name}" = ?`).get(value).c;
            if (count) found.push(`${table}.${column.name}=${count}`);
        }
    }
    return found;
}

/* Inserta dos usuarios v2 mínimos y devuelve { db, idA, idB }. */
function seedUsers(db, idA = ids.a, idB = ids.b) {
    const insert = db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, add_policy, created_at, last_seen)
        VALUES (?, ?, 'hash', 'salt', 'request', ?, NULL)`);
    insert.run(idA, 'ana', 1000);
    insert.run(idB, 'beto', 2000);
    return { idA, idB };
}

test('el esquema v3 se aplica en una base nueva y registra la versión', () => {
    const db = newDb();
    ensureSchema(db);
    // Idempotente: aplicarlo de nuevo no rompe nada ni duplica nada.
    ensureSchema(db);

    for (const table of TABLES_V2) assert.ok(tableExists(db, table), `falta la tabla ${table}`);
    assert.ok(tableColumns(db, 'users').has('password_hash'));
    assert.ok(tableColumns(db, 'users').has('add_policy'));
    assert.ok(!tableColumns(db, 'users').has('data'), 'users ya no guarda un JSON con todo');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
    db.close();
});

test('borrar una cuenta elimina todo en cascada y libera el nombre de usuario', () => {
    const db = newDb();
    ensureSchema(db);
    const { idA, idB } = seedUsers(db);

    db.prepare("INSERT INTO user_profiles (user_id, display_name, avatar, bio) VALUES (?, 'Ana', '', 'hola')").run(idA);
    db.prepare('INSERT INTO user_privacy (user_id, feature, mode) VALUES (?, ?, ?)').run(idA, 'foto', 'contacts');
    db.prepare('INSERT INTO user_chat_settings (user_id) VALUES (?)').run(idA);
    db.prepare('INSERT INTO user_notes (user_id, data, ts) VALUES (?, ?, 1)').run(idA, '{"text":"x"}');
    db.prepare('INSERT INTO user_stickers (user_id, position, sticker) VALUES (?, 0, ?)').run(idA, 'https://giphy.com/x.gif');
    db.prepare('INSERT INTO contacts (owner, contact) VALUES (?, ?)').run(idA, idB);
    db.prepare('INSERT INTO contacts (owner, contact) VALUES (?, ?)').run(idB, idA);
    db.prepare('INSERT INTO blocked (owner, target) VALUES (?, ?)').run(idB, idA);
    db.prepare('INSERT INTO summaries (owner, peer) VALUES (?, ?)').run(idB, idA);
    db.prepare('INSERT INTO summaries (owner, peer) VALUES (?, ?)').run(idA, idB);
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run('h1', idA, Date.now() + 1000);
    db.prepare('INSERT INTO push_subs (user_id, endpoint, data) VALUES (?, ?, ?)').run(idA, 'https://push/1', '{}');
    db.prepare('INSERT INTO calls (id, owner, peer, ts) VALUES (?, ?, ?, 1)').run('callA', idA, 'beto');
    db.prepare('INSERT INTO calls (id, owner, peer, ts) VALUES (?, ?, ?, 2)').run('callB', idB, 'ana');

    // Conversación 1:1 (los dos sentidos) + grupo compartido
    const chat = 'chat:' + [idA, idB].sort().join('__');
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, to_id, kind, data, hash) VALUES ('dm1', ?, 1, ?, ?, 'text', 'x', 'hashA')").run(chat, idA, idB);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, to_id, kind, data, hash) VALUES ('dm2', ?, 2, ?, ?, 'text', 'y', 'hashB')").run(chat, idB, idA);
    db.prepare("INSERT INTO blob_access (hash, message_id, kind, chat_a, chat_b) VALUES ('hashA', 'dm1', 'chat', ?, ?)").run(idA, idB);
    db.prepare("INSERT INTO blob_access (hash, message_id, kind, chat_a, chat_b) VALUES ('hashB', 'dm2', 'chat', ?, ?)").run(idA, idB);
    db.prepare(`INSERT INTO groups (id, crypto_id, name, owner_id, visibility, join_policy, write_policy, add_policy,
        edit_policy, mention_all_policy, content_policy, invite_code, created_at)
        VALUES ('g1', 'crypto-g1', 'Grupo', ?, 'private', 'request', 'all', 'admins', 'admins', 'admins', '{}', 'inv', 1)`).run(idA);
    db.prepare("INSERT INTO group_members (gid, user_id, role) VALUES ('g1', ?, 'admin')").run(idA);
    db.prepare("INSERT INTO group_members (gid, user_id, role) VALUES ('g1', ?, 'member')").run(idB);
    db.prepare("INSERT INTO group_summaries (owner, gid, unread) VALUES (?, 'g1', 3)").run(idA);
    db.prepare("INSERT INTO group_summaries (owner, gid, unread) VALUES (?, 'g1', 1)").run(idB);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, kind, data, hash) VALUES ('gm1', 'group:g1', 3, ?, 'text', 'z', 'hashG1')").run(idA);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, kind, data) VALUES ('gm2', 'group:g1', 4, ?, 'text', 'w')").run(idB);
    db.prepare("INSERT INTO blob_access (hash, message_id, kind, gid) VALUES ('hashG1', 'gm1', 'group', 'g1')").run();
    db.prepare("INSERT INTO stories (from_id, ts, data, hash) VALUES (?, 9, 'cifrada', 'hashS')").run(idA);
    db.prepare("INSERT INTO blob_access (hash, message_id, kind, story_user) VALUES ('hashS', 'story:9', 'story', ?)").run(idA);
    db.prepare("INSERT INTO user_group_seen (user_id, gid, ts) VALUES (?, 'g1', 5)").run(idA);

    const removed = deleteAccountRows(db, idA, 'ana');

    // Sin rastro del id ni del nombre en ninguna tabla
    assert.deepEqual(findValueInDb(db, idA), []);
    assert.deepEqual(findValueInDb(db, 'ana'), []);
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    // La conversación privada se purga completa (también el mensaje de beto)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 1);
    assert.equal(db.prepare("SELECT id FROM messages").get().id, 'gm2');

    // Los adjuntos sin dueño se devuelven para poder purgarlos
    for (const hash of ['hashA', 'hashB', 'hashG1', 'hashS'])
        assert.ok(removed.hashes.includes(hash), `falta el hash ${hash}`);

    // El grupo sigue vivo: beto hereda administración y propiedad
    assert.deepEqual(
        db.prepare("SELECT user_id, role FROM group_members WHERE gid = 'g1'").all(),
        [{ user_id: idB, role: 'admin' }]
    );
    assert.equal(db.prepare("SELECT owner_id FROM groups WHERE id = 'g1'").get().owner_id, idB);
    assert.deepEqual(removed.groupsTouched, ['g1']);
    assert.deepEqual(removed.groupsRemoved, []);
    assert.deepEqual(db.prepare("SELECT owner, gid FROM group_summaries").all(), [{ owner: idB, gid: 'g1' }]);

    // Contabilidad del otro lado limpia
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM contacts').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM blocked').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM summaries').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM push_subs').get().c, 0);

    // El historial de llamadas donde era el otro extremo también se va:
    // no debe quedar rastro de la cuenta en ninguna parte.
    assert.deepEqual(db.prepare('SELECT id FROM calls').pluck().all(), []);

    // El nombre queda libre al instante: se puede registrar otra vez
    db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, add_policy, created_at)
        VALUES ('99999999-9999-4999-8999-999999999999', 'ana', 'h2', 's2', 'request', 9)`).run();
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'ana'").get().c, 1);
    db.close();
});

test('un grupo sin miembros se borra entero con sus mensajes y adjuntos', () => {
    const db = newDb();
    ensureSchema(db);
    const { idA } = seedUsers(db);
    db.prepare(`INSERT INTO groups (id, crypto_id, name, owner_id, visibility, join_policy, write_policy, add_policy,
        edit_policy, mention_all_policy, content_policy, invite_code, created_at)
        VALUES ('solo', 'crypto', 'Solitario', ?, 'private', 'request', 'all', 'admins', 'admins', 'admins', '{}', 'inv', 1)`).run(idA);
    db.prepare("INSERT INTO group_members (gid, user_id, role) VALUES ('solo', ?, 'admin')").run(idA);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, kind, data, hash) VALUES ('g1', 'group:solo', 1, ?, 'text', 'x', 'hG')").run(idA);
    db.prepare("INSERT INTO group_summaries (owner, gid, unread) VALUES (?, 'solo', 0)").run(idA);
    db.prepare("INSERT INTO blob_access (hash, message_id, kind, gid) VALUES ('hG', 'g1', 'group', 'solo')").run();

    const removed = deleteAccountRows(db, idA, 'ana');
    assert.deepEqual(removed.groupsRemoved, ['solo']);
    assert.ok(removed.hashes.includes('hG'));
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM groups').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_members').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_summaries').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM blob_access').get().c, 0);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
});

test('las restricciones del esquema frenan datos inválidos y nombres repetidos', () => {
    const db = newDb();
    ensureSchema(db);

    // CHECK en add_policy
    assert.throws(() => db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, add_policy)
        VALUES ('x', 'xuxa', 'h', 's', 'cualquiera')`).run(), /CHECK constraint failed/);

    // UNIQUE + COLLATE NOCASE: el mismo nombre con otra caja está ocupado
    db.prepare("INSERT INTO users (id, username, password_hash, password_salt) VALUES ('u1', 'ana', 'h', 's')").run();
    assert.throws(() => db.prepare("INSERT INTO users (id, username, password_hash, password_salt) VALUES ('u2', 'ANA', 'h', 's')").run(),
        /UNIQUE constraint failed/);

    // Clave ajena: no se puede meter un perfil de una cuenta que no existe
    assert.throws(() => db.prepare("INSERT INTO user_profiles (user_id) VALUES ('nadie')").run(),
        /FOREIGN KEY constraint failed/);

    // Borrar la cuenta borra su perfil
    db.prepare("INSERT INTO user_profiles (user_id, display_name) VALUES ('u1', 'Ana')").run();
    db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_profiles').get().c, 0);
    db.close();
});

test('la purga de DM es exacta: un grupo cuyo gid contiene el uuid de la víctima no se purga', () => {
    const db = newDb();
    ensureSchema(db);
    const { idA, idB } = seedUsers(db);

    // Grupo "malicioso" cuyo gid es exactamente el uuid de ana (público en /users)
    db.prepare(`INSERT INTO groups (id, crypto_id, name, owner_id, visibility, join_policy, write_policy, add_policy,
        edit_policy, mention_all_policy, content_policy, invite_code, created_at)
        VALUES (?, 'crypto', 'Grupo falso', NULL, 'public', 'open', 'all', 'all', 'all', 'all', '{}', 'inv', 1)`).run(idA);
    db.prepare("INSERT INTO group_members (gid, user_id, role) VALUES (?, ?, 'admin')").run(idA, idB);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, kind, data) VALUES ('gmsg', ?, 10, ?, 'text', 'secreto del grupo')")
        .run('group:' + idA, idB);

    // DM normal entre ana y beto (los dos sentidos)
    const chat = 'chat:' + [idA, idB].sort().join('__');
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, to_id, kind, data) VALUES ('dm1', ?, 5, ?, ?, 'text', 'hola')").run(chat, idA, idB);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, to_id, kind, data) VALUES ('dm2', ?, 6, ?, ?, 'text', 'respuesta')").run(chat, idB, idA);

    const removed = deleteAccountRows(db, idA, 'ana');

    // El mensaje del grupo SOBREVIVE (antes el instr() lo purgaba)
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE id = 'gmsg'").get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM groups').get().c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_members').get().c, 1);
    // La conversación privada sí se purga completa
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM messages WHERE id LIKE 'dm%'").get().c, 0);
    assert.deepEqual(removed.groupsTouched, []);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
});

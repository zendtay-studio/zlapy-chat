// Tests del esquema v10 de la base de datos:
//   · el esquema se aplica en bases nuevas (idempotente, sin migraciones),
//   · borrar una cuenta arrastra TODO en cascada (y libera el usuario),
//     sin purgar grupos cuyo gid contenga el uuid de la víctima,
//   · las restricciones (UNIQUE, CHECK, claves ajenas) hacen su trabajo,
//   · la migración v10 crea `user_rid` (rid + marcas de revocación) en las
//     instalaciones anteriores sin tocar las sesiones vivas de más,
//   · la migración v9 (privacidad 'online') sigue aplicándose donde falte.
const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
    SCHEMA_VERSION,
    SCHEMA_SQL,
    ensureSchema,
    backfillUserRids,
    tableExists,
    tableColumns,
    tableSql,
    deleteAccountRows
} = require('../src/db/schema.js');

const TABLES_V10 = [
    'users', 'user_profiles', 'user_keys', 'user_privacy', 'user_privacy_users', 'user_rid',
    'user_chat_settings', 'user_muted_peers', 'user_notes', 'user_stickers', 'user_sticker_blobs',
    'user_group_seen', 'contacts', 'contact_requests', 'blocked',
    'summaries', 'messages', 'message_reactions', 'blob_access', 'stories', 'calls', 'push_subs',
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

/* Inserta dos usuarios v10 mínimos y devuelve { db, idA, idB }. */
function seedUsers(db, idA = ids.a, idB = ids.b) {
    const insert = db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, add_policy, created_at, last_seen)
        VALUES (?, ?, 'hash', 'salt', 'request', ?, NULL)`);
    insert.run(idA, 'ana', 1000);
    insert.run(idB, 'beto', 2000);
    return { idA, idB };
}

test('el esquema v10 se aplica en una base nueva y registra la versión', () => {
    const db = newDb();
    ensureSchema(db);
    // Idempotente: aplicarlo de nuevo no rompe nada ni duplica nada.
    ensureSchema(db);

    for (const table of TABLES_V10) assert.ok(tableExists(db, table), `falta la tabla ${table}`);
    assert.ok(!tableExists(db, 'sessions'), 'ya no hay tabla de sesiones (tokens stateless)');
    assert.ok(tableExists(db, 'default_stickers'), 'falta el catálogo de stickers bbot predeterminados');
    assert.ok(tableColumns(db, 'users').has('password_hash'));
    assert.ok(tableColumns(db, 'users').has('add_policy'));
    assert.ok(!tableColumns(db, 'users').has('auth_version'), 'auth_version se retira: la revocación vive en user_rid (v10)');
    assert.ok(!tableColumns(db, 'users').has('data'), 'users ya no guarda un JSON con todo');
    assert.ok(tableColumns(db, 'user_rid').has('rid'), 'user_rid guarda el rid de cada cuenta');
    assert.match(tableSql(db, 'user_rid'), /ON DELETE CASCADE/, 'borrar la cuenta arrastra su rid');
    assert.match(tableSql(db, 'user_privacy'), /'online'/, 'la CHECK de user_privacy admite la función online');
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, String(SCHEMA_VERSION));
    db.close();
});

test('borrar una cuenta elimina todo en cascada y libera el nombre de usuario', () => {
    const db = newDb();
    ensureSchema(db);
    const { idA, idB } = seedUsers(db);

    db.prepare("INSERT INTO user_profiles (user_id, display_name, avatar_ref, bio) VALUES (?, 'Ana', '', 'hola')").run(idA);
    db.prepare('INSERT INTO user_privacy (user_id, feature, mode) VALUES (?, ?, ?)').run(idA, 'foto', 'contacts');
    db.prepare('INSERT INTO user_chat_settings (user_id) VALUES (?)').run(idA);
    db.prepare('INSERT INTO user_notes (user_id, data, ts) VALUES (?, ?, 1)').run(idA, '{"text":"x"}');
    db.prepare('INSERT INTO user_stickers (user_id, position, sticker) VALUES (?, 0, ?)').run(idA, 'https://giphy.com/x.gif');
    db.prepare('INSERT INTO contacts (owner, contact) VALUES (?, ?)').run(idA, idB);
    db.prepare('INSERT INTO contacts (owner, contact) VALUES (?, ?)').run(idB, idA);
    db.prepare('INSERT INTO blocked (owner, target) VALUES (?, ?)').run(idB, idA);
    db.prepare('INSERT INTO summaries (owner, peer) VALUES (?, ?)').run(idB, idA);
    db.prepare('INSERT INTO summaries (owner, peer) VALUES (?, ?)').run(idA, idB);
    db.prepare('INSERT INTO push_subs (user_id, endpoint, data) VALUES (?, ?, ?)').run(idA, 'https://push/1', '{}');
    db.prepare('INSERT INTO calls (id, owner, peer, ts) VALUES (?, ?, ?, 1)').run('callA', idA, 'beto');
    db.prepare('INSERT INTO calls (id, owner, peer, ts) VALUES (?, ?, ?, 2)').run('callB', idB, 'ana');

    // Conversación 1:1 (los dos sentidos) + grupo compartido
    const chat = 'chat:' + [idA, idB].sort().join('__');
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, to_id, kind, data, hash) VALUES ('dm1', ?, 1, ?, ?, 'text', 'x', 'hashA')").run(chat, idA, idB);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, to_id, kind, data, hash) VALUES ('dm2', ?, 2, ?, ?, 'text', 'y', 'hashB')").run(chat, idB, idA);
    db.prepare("INSERT INTO message_reactions (message_id, user_id, emoji, updated_at) VALUES ('dm1', ?, '❤️', 1)").run(idB);
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
    // Referencias por nombre (sin FK al contacto): preferencias de lista,
    // silenciados, marcas de chat borrado y listas de privacidad.
    db.prepare('INSERT INTO user_chat_prefs (user_id, peer_key, pinned_at, archived) VALUES (?, ?, 0, 1)').run(idB, 'dm:ana');
    db.prepare('INSERT INTO user_chat_prefs (user_id, peer_key, pinned_at, archived) VALUES (?, ?, 0, 1)').run(idA, 'dm:beto');
    db.prepare('INSERT INTO user_muted_peers (user_id, peer_id, peer_name) VALUES (?, ?, ?)').run(idB, idA, 'ana');
    // La misma cuenta con otra caja: la PK permite la fila y la purga debe
    // comparar sin distinguir mayúsculas.
    db.prepare('INSERT INTO user_muted_peers (user_id, peer_id, peer_name) VALUES (?, NULL, ?)').run(idB, 'ANA');
    db.prepare('INSERT INTO chat_deletions (chat, user_id, deleted_at) VALUES (?, ?, 1)').run(chat, idB);
    db.prepare('INSERT INTO chat_deletions (chat, user_id, deleted_at) VALUES (?, ?, 1)').run(chat, idA);
    db.prepare('INSERT INTO user_privacy (user_id, feature, mode) VALUES (?, ?, ?)').run(idB, 'foto', 'except');
    db.prepare('INSERT INTO user_privacy_users (user_id, feature, position, target_id, target_name) VALUES (?, ?, 0, ?, ?)').run(idB, 'foto', idA, 'ana');
    db.prepare('INSERT INTO user_privacy_users (user_id, feature, position, target_id, target_name) VALUES (?, ?, 1, NULL, ?)').run(idB, 'foto', 'ana');

    const removed = deleteAccountRows(db, idA, 'ana');

    // Sin rastro del id ni del nombre en ninguna tabla
    assert.deepEqual(findValueInDb(db, idA), []);
    assert.deepEqual(findValueInDb(db, 'ana'), []);
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    // La conversación privada se purga completa (también el mensaje de beto)
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 1);
    assert.equal(db.prepare("SELECT id FROM messages").get().id, 'gm2');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM message_reactions').get().c, 0);

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
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM push_subs').get().c, 0);

    // El historial de llamadas donde era el otro extremo también se va:
    // no debe quedar rastro de la cuenta en ninguna parte.
    assert.deepEqual(db.prepare('SELECT id FROM calls').pluck().all(), []);

    // Las referencias por nombre tampoco sobreviven: nada de chats archivados
    // fantasma, silencios huérfanos ni listas de privacidad que apunten a una
    // cuenta borrada.
    assert.deepEqual(db.prepare('SELECT peer_key FROM user_chat_prefs').pluck().all(), []);
    assert.deepEqual(db.prepare('SELECT peer_name FROM user_muted_peers').pluck().all(), []);
    assert.deepEqual(db.prepare('SELECT chat FROM chat_deletions').pluck().all(), []);
    assert.deepEqual(db.prepare('SELECT target_name FROM user_privacy_users').pluck().all(), []);

    // El nombre queda libre al instante: se puede registrar otra vez
    db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, add_policy, created_at)
        VALUES ('99999999-9999-4999-8999-999999999999', 'ana', 'h2', 's2', 'request', 9)`).run();
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'ana'").get().c, 1);
    db.close();
});

test('un grupo sin miembros se borra entero con sus mensajes y adjuntos', () => {
    const db = newDb();
    ensureSchema(db);
    const { idA, idB } = seedUsers(db);
    db.prepare(`INSERT INTO groups (id, crypto_id, name, owner_id, visibility, join_policy, write_policy, add_policy,
        edit_policy, mention_all_policy, content_policy, invite_code, created_at)
        VALUES ('solo', 'crypto', 'Solitario', ?, 'private', 'request', 'all', 'admins', 'admins', 'admins', '{}', 'inv', 1)`).run(idA);
    db.prepare("INSERT INTO group_members (gid, user_id, role) VALUES ('solo', ?, 'admin')").run(idA);
    db.prepare("INSERT INTO messages (id, chat, ts, from_id, kind, data, hash) VALUES ('g1', 'group:solo', 1, ?, 'text', 'x', 'hG')").run(idA);
    db.prepare("INSERT INTO group_summaries (owner, gid, unread) VALUES (?, 'solo', 0)").run(idA);
    db.prepare("INSERT INTO blob_access (hash, message_id, kind, gid) VALUES ('hG', 'g1', 'group', 'solo')").run();
    // Referencias de otra cuenta al grupo que va a desaparecer.
    db.prepare('INSERT INTO user_chat_prefs (user_id, peer_key, archived) VALUES (?, ?, 1)').run(idB, 'group:solo');
    db.prepare("INSERT INTO chat_deletions (chat, user_id, deleted_at) VALUES ('group:solo', ?, 1)").run(idB);
    db.prepare('INSERT INTO user_muted_peers (user_id, peer_id, peer_name) VALUES (?, NULL, ?)').run(idB, 'group:solo');

    const removed = deleteAccountRows(db, idA, 'ana');
    assert.deepEqual(removed.groupsRemoved, ['solo']);
    assert.ok(removed.hashes.includes('hG'));
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM groups').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_members').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_summaries').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM blob_access').get().c, 0);
    // El grupo borrado tampoco deja preferencias, marcas ni silencios sueltos.
    assert.deepEqual(db.prepare('SELECT peer_key FROM user_chat_prefs').pluck().all(), []);
    assert.deepEqual(db.prepare('SELECT chat FROM chat_deletions').pluck().all(), []);
    assert.deepEqual(db.prepare('SELECT peer_name FROM user_muted_peers').pluck().all(), []);
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

    // CHECK de user_privacy: solo funciones conocidas ('online' incluida)
    db.prepare(`INSERT INTO user_privacy (user_id, feature, mode) VALUES ('u1', 'online', 'nobody')`).run();
    assert.throws(() => db.prepare(`INSERT INTO user_privacy (user_id, feature, mode) VALUES ('u1', 'presencia', 'nobody')`).run(),
        /CHECK constraint failed/);

    // Clave ajena: no se puede meter un perfil de una cuenta que no existe
    assert.throws(() => db.prepare("INSERT INTO user_profiles (user_id) VALUES ('nadie')").run(),
        /FOREIGN KEY constraint failed/);

    // Borrar la cuenta borra su perfil
    db.prepare("INSERT INTO user_profiles (user_id, display_name) VALUES ('u1', 'Ana')").run();
    db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_profiles').get().c, 0);
    db.close();
});

test('la migración v10 crea user_rid, suelta sessions y respeta la privacidad v9', () => {
    const db = newDb();
    // Base "v9": misma DDL pero SIN la tabla user_rid, CON users.auth_version
    // (la columna que v10 retira), SIN 'online' en la CHECK de user_privacy
    // y CON la tabla sessions de entonces.
    const v9 = SCHEMA_SQL
        .replace("'compartir','online'", "'compartir'")
        .replace(/\/\* -+ 11\.[\s\S]*?logged_out_at\s+INTEGER NOT NULL DEFAULT 0\s*\);/, '')
        .replace("add_policy    TEXT NOT NULL DEFAULT 'request'",
            "auth_version  INTEGER NOT NULL DEFAULT 1,\n    add_policy    TEXT NOT NULL DEFAULT 'request'");
    db.exec(v9);
    assert.ok(!tableExists(db, 'user_rid'), 'la base simulada v9 no tiene user_rid');
    assert.ok(tableColumns(db, 'users').has('auth_version'), 'la base simulada v9 tiene auth_version');
    assert.ok(!/'online'/.test(tableSql(db, 'user_privacy')), 'la base simulada v9 no admite online');
    // La tabla sessions del esquema v9 (el SCHEMA_SQL actual ya no la crea).
    db.exec(`CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    )`);

    const idA = ids.a;
    db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, add_policy, auth_version, created_at)
        VALUES (?, 'ana', 'h', 's', 'request', 7, 1)`).run(idA);
    db.prepare('INSERT INTO user_privacy (user_id, feature, mode) VALUES (?, ?, ?)').run(idA, 'foto', 'contacts');
    db.prepare('INSERT INTO user_privacy_users (user_id, feature, position, target_id, target_name) VALUES (?, ?, 0, NULL, ?)')
        .run(idA, 'foto', 'caro');
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h1', ?, 9999999999999)").run(idA);

    ensureSchema(db);

    // La tabla de sesiones desaparece; user_rid se crea VACÍA (las filas las
    // escribe backfillUserRids con la llave maestra ya en RAM: applySchema
    // corre antes de que exista y no puede generar el rid).
    assert.ok(!tableExists(db, 'sessions'), 'la tabla sessions se suelta en la migración');
    assert.ok(tableExists(db, 'user_rid'), 'la migración crea user_rid (vacía: sin rid hasta el backfill)');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_rid').get().c, 0, 'applySchema no rellena filas');

    // El backfill (lo que hace server.js al arrancar) pone el rid a cada
    // cuenta que no lo tenga, y es idempotente.
    assert.equal(backfillUserRids(db), 1, 'se rellena una cuenta');
    assert.equal(backfillUserRids(db), 0, 'la segunda pasada no toca nada');
    const ridRow = db.prepare('SELECT rid, password_changed_at, logged_out_at FROM user_rid WHERE user_id = ?').get(idA);
    assert.ok(ridRow && typeof ridRow.rid === 'string' && ridRow.rid.length >= 20, 'cada cuenta recibe su rid');
    assert.equal(ridRow.password_changed_at, 0, 'sin datos previos, las marcas arrancan en 0 (no revolucionan tokens por tiempo)');
    // La columna auth_version de v9 se suelta: no queda ni como vestigio.
    assert.ok(!tableColumns(db, 'users').has('auth_version'), 'auth_version se suelta en instalaciones migradas');

    // La migración es idempotente: una segunda pasada NO rota el rid (o
    // cerraría las sesiones abiertas en cada reinicio).
    ensureSchema(db);
    assert.equal(db.prepare('SELECT rid FROM user_rid WHERE user_id = ?').get(idA).rid, ridRow.rid,
        'el rid no rota al reaplicar el esquema');

    // La CHECK nueva admite 'online' y las reglas previas sobreviven.
    db.prepare('INSERT INTO user_privacy (user_id, feature, mode) VALUES (?, ?, ?)').run(idA, 'online', 'only');
    assert.deepEqual(
        db.prepare('SELECT feature, mode FROM user_privacy WHERE user_id = ? ORDER BY feature').all(idA),
        [{ feature: 'foto', mode: 'contacts' }, { feature: 'online', mode: 'only' }]
    );

    // Las listas "solo/excepto" sobreviven al rebuild y la FK sigue viva:
    // borrar la cuenta las arrastra (junto con su fila de user_rid).
    assert.deepEqual(
        db.prepare('SELECT user_id, feature, position, target_name FROM user_privacy_users').all(),
        [{ user_id: idA, feature: 'foto', position: 0, target_name: 'caro' }]
    );
    db.prepare('DELETE FROM users WHERE id = ?').run(idA);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_privacy_users').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_privacy').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM user_rid').get().c, 0, 'el rid se borra con la cuenta');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();
});

test('el esquema es idempotente sobre una base ya migrada', () => {
    const db = newDb();
    ensureSchema(db);
    db.prepare(`INSERT INTO users (id, username, password_hash, password_salt, add_policy)
        VALUES (?, 'ana', 'h', 's', 'request')`).run(ids.a);
    db.prepare(`INSERT INTO user_rid (user_id, rid) VALUES (?, 'rid-original')`).run(ids.a);
    db.prepare(`INSERT INTO user_privacy (user_id, feature, mode) VALUES (?, 'online', 'nobody')`).run(ids.a);
    ensureSchema(db); // segunda pasada: no toca nada
    assert.equal(db.prepare('SELECT rid FROM user_rid WHERE user_id = ?').get(ids.a).rid, 'rid-original',
        'el rid no se rota por reaplicar el esquema');
    assert.equal(db.prepare('SELECT mode FROM user_privacy WHERE user_id = ? AND feature = ?').get(ids.a, 'online').mode, 'nobody');
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

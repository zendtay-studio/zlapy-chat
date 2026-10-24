/**
 * Esquema de la base de datos de Zlapy (v3).
 *
 * Tablas normalizadas con CHECK/UNIQUE y claves ajenas con ON DELETE CASCADE:
 * borrar una fila de `users` arrastra en cascada todo lo suyo, y borrar un
 * grupo lo arrastra con él.
 *
 * Es la única fuente de verdad del esquema: src/db/database.js lo aplica al
 * arrancar con `ensureSchema` (idempotente) y test/schema.test.js
 * lo verifica. No hay migraciones: una base en un formato anterior no es
 * compatible con este servidor.
 */
'use strict';

const SCHEMA_VERSION = 3;

// Esquema v3
// Orden de creación: primero las tablas padre (users, groups) para que las
// claves ajenas apunten a tablas que ya existen.
const SCHEMA_SQL = `
/* ---------------- 1. Cuentas ---------------- */
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    add_policy    TEXT NOT NULL DEFAULT 'request' CHECK (add_policy IN ('all','request','nobody')),
    created_at    INTEGER NOT NULL DEFAULT 0,
    last_seen     INTEGER
);

/* ---------------- 2. Perfil público ---------------- */
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL DEFAULT '',
    avatar       TEXT NOT NULL DEFAULT '',
    bio          TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    note_ts      INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT 0
);

/* ---------------- 3. Claves del dispositivo (cifradas en reposo) ---------------- */
CREATE TABLE IF NOT EXISTS user_keys (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_cipher TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
);

/* ---------------- 4. Privacidad por función ---------------- */
CREATE TABLE IF NOT EXISTS user_privacy (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature TEXT NOT NULL CHECK (feature IN ('foto','nota','descripcion','historias','llamadas','mensajes','compartir')),
    mode    TEXT NOT NULL CHECK (mode IN ('server','contacts','nobody','except','only')),
    PRIMARY KEY (user_id, feature)
);

/* Listas "excepto / solo" de cada función: por id cuando el usuario existe,
   con el nombre como etiqueta de reserva. */
CREATE TABLE IF NOT EXISTS user_privacy_users (
    user_id     TEXT NOT NULL,
    feature     TEXT NOT NULL,
    position    INTEGER NOT NULL,
    target_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
    target_name TEXT NOT NULL,
    PRIMARY KEY (user_id, feature, position),
    FOREIGN KEY (user_id, feature) REFERENCES user_privacy(user_id, feature) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_upu_target ON user_privacy_users(target_id) WHERE target_id IS NOT NULL;

/* ---------------- 5. Apariencia del chat ---------------- */
CREATE TABLE IF NOT EXISTS user_chat_settings (
    user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    wall          TEXT,
    opacity       REAL NOT NULL DEFAULT 30,
    blur          REAL NOT NULL DEFAULT 0,
    sender        TEXT,
    receiver      TEXT,
    sender_text   TEXT,
    receiver_text TEXT,
    font_size     REAL NOT NULL DEFAULT 15,
    auto_text     INTEGER NOT NULL DEFAULT 1 CHECK (auto_text IN (0,1)),
    wallpaper     TEXT NOT NULL DEFAULT '',
    updated_at    INTEGER NOT NULL DEFAULT 0
);

/* ---------------- 6. Chats silenciados ---------------- */
CREATE TABLE IF NOT EXISTS user_muted_peers (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
    peer_name TEXT NOT NULL,
    PRIMARY KEY (user_id, peer_name)
);
CREATE INDEX IF NOT EXISTS idx_ump_peer ON user_muted_peers(peer_id) WHERE peer_id IS NOT NULL;

/* ---------------- 6b. Preferencias de la lista de chats ----------------
   Chats fijados y marcados como "no leídos". El peer_key identifica la
   conversación: 'dm:<usuario>', 'group:<id>' o 'saved'. Vive en el servidor
   para que el estado sea el mismo en todos los dispositivos. */
CREATE TABLE IF NOT EXISTS user_chat_prefs (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_key   TEXT NOT NULL,
    pinned_at  INTEGER NOT NULL DEFAULT 0,
    unread     INTEGER NOT NULL DEFAULT 0 CHECK (unread IN (0,1)),
    archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, peer_key)
);

/* ---------------- 7. Nota personal (estado) ---------------- */
CREATE TABLE IF NOT EXISTS user_notes (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data    TEXT,
    ts      INTEGER NOT NULL DEFAULT 0
);

/* ---------------- 8. Stickers favoritos ---------------- */
CREATE TABLE IF NOT EXISTS user_stickers (
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    sticker  TEXT NOT NULL,
    PRIMARY KEY (user_id, position)
);

/* ---------------- 9. Grupos ---------------- */
CREATE TABLE IF NOT EXISTS groups (
    id                 TEXT PRIMARY KEY,
    crypto_id          TEXT NOT NULL,
    name               TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    avatar             TEXT NOT NULL DEFAULT '',
    owner_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
    visibility         TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
    join_policy        TEXT NOT NULL DEFAULT 'request' CHECK (join_policy IN ('open','request','closed')),
    write_policy       TEXT NOT NULL DEFAULT 'all' CHECK (write_policy IN ('all','admins')),
    add_policy         TEXT NOT NULL DEFAULT 'admins' CHECK (add_policy IN ('all','admins')),
    edit_policy        TEXT NOT NULL DEFAULT 'admins' CHECK (edit_policy IN ('all','admins')),
    mention_all_policy TEXT NOT NULL DEFAULT 'admins' CHECK (mention_all_policy IN ('all','admins')),
    content_policy     TEXT NOT NULL DEFAULT '{}',
    invite_code        TEXT NOT NULL,
    keys_cipher        TEXT,
    created_at         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_groups_visibility ON groups(visibility);
CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups(owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS group_members (
    gid       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    joined_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (gid, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS group_join_requests (
    gid      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    PRIMARY KEY (gid, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gjr_user ON group_join_requests(user_id);

/* ---------------- 10. Grupos vistos por usuario ---------------- */
CREATE TABLE IF NOT EXISTS user_group_seen (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gid     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    ts      INTEGER NOT NULL,
    PRIMARY KEY (user_id, gid)
);
CREATE INDEX IF NOT EXISTS idx_ugs_gid ON user_group_seen(gid);

/* ---------------- 11. Sesiones ---------------- */
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

/* ---------------- 12. Contactos ---------------- */
CREATE TABLE IF NOT EXISTS contacts (
    owner   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (owner, contact)
);
CREATE INDEX IF NOT EXISTS idx_contacts_contact ON contacts(contact);

CREATE TABLE IF NOT EXISTS contact_requests (
    from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts      INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_creq_to ON contact_requests(to_id);

CREATE TABLE IF NOT EXISTS blocked (
    owner  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (owner, target)
);
CREATE INDEX IF NOT EXISTS idx_blocked_target ON blocked(target);

/* ---------------- 13. Resúmenes de chat 1:1 ---------------- */
CREATE TABLE IF NOT EXISTS summaries (
    owner     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    unread    INTEGER NOT NULL DEFAULT 0,
    last_data TEXT,
    PRIMARY KEY (owner, peer)
);
CREATE INDEX IF NOT EXISTS idx_summaries_peer ON summaries(peer);

/* ---------------- 14. Mensajes ----------------
   'chat' codifica el destino:
     · DM     → 'chat:<idA>__<idB>' (ids ordenados)
     · grupo  → 'group:<gid>'
   No es una FK porque apunta a dos cosas distintas; el contenido sí está
   protegido: from_id/to_id borran el mensaje en cascada. */
CREATE TABLE IF NOT EXISTS messages (
    id                 TEXT PRIMARY KEY,
    chat               TEXT NOT NULL,
    ts                 INTEGER NOT NULL,
    from_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id              TEXT REFERENCES users(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL,
    data               TEXT NOT NULL,
    hash               TEXT,
    once               INTEGER NOT NULL DEFAULT 0 CHECK (once IN (0,1)),
    edited             INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0,1)),
    crypto_version     INTEGER NOT NULL DEFAULT 3,
    crypto_group_id    TEXT,
    signature          TEXT,
    signing_public_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id) WHERE to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id, ts DESC);

/* ---------------- 14b. Borrados con alcance por usuario ----------------
   Un mensaje o una conversación se guardan UNA vez para los dos
   interlocutores. Para que borrar "para mí" no destruya la copia del otro,
   aquí se anotan los borrados por usuario:
     · message_deletions: mensajes que un usuario ha ocultado para sí mismo
       (los borra el destinatario; el emisor conserva su mensaje).
     · chat_deletions: conversaciones que un usuario ha quitado de su lista.
   Ambas se limpian en cascada al borrarse el mensaje o el usuario. */
/* ---------------- 14c. auth_key por usuario ----------------
   Clave de cifrado de contenido de 2048 bits por usuario (independiente por
   persona), con su identificador (key_id, SHA-256 truncado). El servidor la
   conoce (por eso puede sincronizar el historial entre dispositivos) y la
   guarda CIFRADA con la llave maestra (PCE1): la maestra es la raiz de
   confianza completa y quien la obtenga puede descifrar el contenido de
   todos. Lo que aporta la auth_key es proteccion ante fuga de la base SIN
   fuga de la maestra. */
CREATE TABLE IF NOT EXISTS user_auth_keys (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auth_key    TEXT NOT NULL,
    key_id      TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_deletions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deleted_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mdel_user ON message_deletions(user_id);
CREATE TABLE IF NOT EXISTS chat_deletions (
    chat       TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deleted_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cdel_user ON chat_deletions(user_id);

/* ---------------- 15. Permisos de descarga de adjuntos ----------------
   'message_id' es el id del mensaje o 'story:<idUsuario>:<ts>' (por eso no es
   FK). chat_a/chat_b/gid/story_user sí lo son y limpian el permiso al borrar. */
CREATE TABLE IF NOT EXISTS blob_access (
    hash       TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('chat','group','story')),
    chat_a     TEXT REFERENCES users(id) ON DELETE CASCADE,
    chat_b     TEXT REFERENCES users(id) ON DELETE CASCADE,
    gid        TEXT REFERENCES groups(id) ON DELETE CASCADE,
    story_user TEXT REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (hash, message_id)
);
CREATE INDEX IF NOT EXISTS idx_ba_hash ON blob_access(hash);
CREATE INDEX IF NOT EXISTS idx_ba_message ON blob_access(message_id);
CREATE INDEX IF NOT EXISTS idx_ba_group ON blob_access(gid) WHERE gid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ba_story ON blob_access(story_user) WHERE story_user IS NOT NULL;

/* Miembros que podían ver un adjunto de grupo EN EL MOMENTO de publicarlo.
   Sin esta foto, el acceso se decidía por la pertenencia actual y quien entraba
   en un grupo público podía descargar todos los adjuntos anteriores. Las filas
   se borran con su mensaje (message_id), así que un miembro expulsado deja de
   tener acceso a lo que se publique después. */
CREATE TABLE IF NOT EXISTS blob_access_members (
    hash     TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bam_message ON blob_access_members(message_id);
CREATE INDEX IF NOT EXISTS idx_bam_user ON blob_access_members(user_id);
CREATE INDEX IF NOT EXISTS idx_ba_chat_a ON blob_access(chat_a) WHERE chat_a IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ba_chat_b ON blob_access(chat_b) WHERE chat_b IS NOT NULL;

/* ---------------- 16. Historias ---------------- */
CREATE TABLE IF NOT EXISTS stories (
    from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ts      INTEGER NOT NULL,
    data    TEXT NOT NULL,
    hash    TEXT,
    PRIMARY KEY (from_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_stories_ts ON stories(ts DESC);

/* ---------------- 17. Historial de llamadas ----------------
   'peer' guarda el nombre de usuario del otro extremo a propósito: el historial
   sobrevive a que esa cuenta cambie de nombre o se borre. */
CREATE TABLE IF NOT EXISTS calls (
    id    TEXT PRIMARY KEY,
    owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer  TEXT,
    ts    INTEGER NOT NULL,
    data  TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_owner_ts ON calls(owner, ts DESC);
CREATE INDEX IF NOT EXISTS idx_calls_peer ON calls(peer);

/* ---------------- 18. Notificaciones push ---------------- */
CREATE TABLE IF NOT EXISTS push_subs (
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    data     TEXT NOT NULL,
    PRIMARY KEY (user_id, endpoint)
);

/* ---------------- 19. Resúmenes de grupo ---------------- */
CREATE TABLE IF NOT EXISTS group_summaries (
    owner     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gid       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    unread    INTEGER NOT NULL DEFAULT 0,
    last_data TEXT,
    PRIMARY KEY (owner, gid)
);
CREATE INDEX IF NOT EXISTS idx_gs_gid ON group_summaries(gid);

/* ---------------- Índices redundantes ----------------
    idx_summaries_owner, idx_gs_owner e idx_creq_from duplican el prefijo de
    una PRIMARY KEY compuesta; idx_messages_hash no tiene ninguna consulta que
    lo use. Se sueltan aquí (idempotente) para que las bases antiguas se
    limpien al actualizarse. */
DROP INDEX IF EXISTS idx_summaries_owner;
DROP INDEX IF EXISTS idx_gs_owner;
DROP INDEX IF EXISTS idx_creq_from;
DROP INDEX IF EXISTS idx_messages_hash;

/* ---------------- 20. Metadatos ---------------- */
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

// Utilidades
const tableExists = (db, name) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const tableColumns = (db, name) =>
    new Set(db.pragma(`table_info(${name})`).map(column => column.name));

function applySchema(db) {
    db.exec(SCHEMA_SQL);
    // Altas de columna idempotentes: CREATE TABLE IF NOT EXISTS no añade
    // columnas a una tabla que ya existe, y esta tabla es nueva (no hay
    // migraciones generales, pero esta columna sí se puede añadir después).
    if (!tableColumns(db, 'user_chat_prefs').has('archived'))
        db.exec('ALTER TABLE user_chat_prefs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))');
}

/* Aplica el esquema si falta algo (idempotente) y registra la versión.
 * No hay migraciones: bases en formatos anteriores no son compatibles. */
function ensureSchema(db) {
    applySchema(db);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run('schema_version', String(SCHEMA_VERSION));
}

// Borrado en cascada
// El esquema declara claves ajenas ON DELETE CASCADE, así que borrar la fila
// de `users` arrastra solo: sesiones, contactos (en ambos sentidos), bloqueos,
// resúmenes, historias, llamadas, push, perfil, privacidad, colores, notas,
// stickers, pertenencia a grupos, resúmenes de grupo, solicitudes y permisos
// de descarga. Aquí se añade lo que la cascada no puede expresar con SQL:
// los mensajes (su destino va codificado en `chat`), los adjuntos y la
// herencia de administración de los grupos.

const blobHashesOfMessages = (db, where, ...params) => db.prepare(`SELECT DISTINCT hash FROM blob_access
    WHERE message_id IN (SELECT id FROM messages WHERE ${where})`).pluck().all(...params);

/* Borra los mensajes que cumplan la condición (y sus permisos de adjunto).
   Devuelve los hashes de los blobs que quedaron sin referencia. */
function deleteMessageRowsWhere(db, where, ...params) {
    const hashes = blobHashesOfMessages(db, where, ...params);
    const rows = db.prepare(`SELECT id FROM messages WHERE ${where}`).pluck().all(...params);
    if (rows.length) {
        const marks = rows.map(() => '?').join(',');
        db.prepare(`DELETE FROM blob_access WHERE message_id IN (${marks})`).run(...rows);
        db.prepare(`DELETE FROM blob_access_members WHERE message_id IN (${marks})`).run(...rows);
        db.prepare(`DELETE FROM messages WHERE id IN (${marks})`).run(...rows);
    }
    return hashes;
}

/* Borra un grupo entero: mensajes, adjuntos, miembros, resúmenes y solicitudes. */
function deleteGroupRows(db, gid) {
    const hashes = [
        ...db.prepare('SELECT DISTINCT hash FROM blob_access WHERE gid = ?').pluck().all(gid),
        ...blobHashesOfMessages(db, 'chat = ?', 'group:' + gid)
    ];
    db.prepare('DELETE FROM blob_access WHERE gid = ?').run(gid);
    deleteMessageRowsWhere(db, 'chat = ?', 'group:' + gid);
    db.prepare('DELETE FROM groups WHERE id = ?').run(gid); // cascada completa
    return hashes;
}

/* Borra una cuenta completa. Devuelve { hashes, groupsTouched, groupsRemoved }
   para que el servidor pueda limpiar los blobs y refrescar la RAM. */
function deleteAccountRows(db, userId, username) {
    const hashes = [];
    const groupsTouched = [];
    const groupsRemoved = [];

    // 1) Grupos: si era el último miembro, el grupo desaparece; si no, el grupo
    //    sigue vivo y la administración (y la propiedad) pasan a otro miembro.
    const gids = db.prepare('SELECT gid FROM group_members WHERE user_id = ?').pluck().all(userId);
    for (const gid of gids) {
        const others = db.prepare('SELECT user_id, role FROM group_members WHERE gid = ? AND user_id <> ?').all(gid, userId);
        if (!others.length) {
            hashes.push(...deleteGroupRows(db, gid));
            groupsRemoved.push(gid);
            continue;
        }
        const admins = others.filter(member => member.role === 'admin');
        const currentOwner = db.prepare('SELECT owner_id FROM groups WHERE id = ?').get(gid)?.owner_id || '';
        db.prepare('DELETE FROM group_members WHERE gid = ? AND user_id = ?').run(gid, userId);
        let heirId = admins.length ? admins[0].user_id : '';
        if (!heirId) {
            heirId = others[Math.floor(Math.random() * others.length)].user_id;
            db.prepare("UPDATE group_members SET role = 'admin' WHERE gid = ? AND user_id = ?").run(gid, heirId);
        }
        if (currentOwner === userId)
            db.prepare('UPDATE groups SET owner_id = ? WHERE id = ?').run(heirId, gid);
        groupsTouched.push(gid);
    }

    // 2) Mensajes directos: la conversación se purga completa (los dos
    //    sentidos). La clave de un chat 1:1 solo puede ser 'chat:<idA>__<idB>'
    //    y la de un grupo 'group:<gid>', así que el prefijo 'chat:' excluye a
    //    los grupos: un gid malicioso que contenga el uuid de la víctima no
    //    puede provocar la purga del historial de un grupo.
    hashes.push(...deleteMessageRowsWhere(db, "chat LIKE 'chat:%' AND instr(chat, ?) > 0", userId));
    // 3) Mensajes del usuario en cualquier chat (grupos incluidos).
    hashes.push(...deleteMessageRowsWhere(db, 'from_id = ?', userId));
    // 3b) La foto de miembros del momento en la que aún era miembro: bases
    //     creadas antes de que blob_access_members llevara FK no limpian
    //     estas filas solas al borrar la cuenta.
    db.prepare('DELETE FROM blob_access_members WHERE user_id = ?').run(userId);
    // 4) Historias del usuario.
    hashes.push(...db.prepare('SELECT DISTINCT hash FROM blob_access WHERE story_user = ?').pluck().all(userId));
    // 5) Historial de llamadas donde era el otro extremo.
    db.prepare('DELETE FROM calls WHERE peer = ?').run(username);
    // 6) El borrado de la cuenta: aquí caen TODAS las cascadas del esquema.
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    return { hashes, groupsTouched, groupsRemoved };
}

module.exports = {
    SCHEMA_VERSION,
    SCHEMA_SQL,
    applySchema,
    ensureSchema,
    tableExists,
    tableColumns,
    deleteAccountRows,
    deleteGroupRows,
    deleteMessageRowsWhere
};

/**
 * Esquema de la base de datos de Zlapy (v10).
 *
 * Tablas normalizadas con CHECK/UNIQUE y claves ajenas con ON DELETE CASCADE:
 * borrar una fila de `users` arrastra en cascada todo lo suyo, y borrar un
 * grupo lo arrastra con él.
 *
 * v4 (credencial derivada + nada en texto plano):
 *   · `user_profiles.avatar`      → `avatar_ref`  (hash del blob cifrado)
 *   · `user_chat_settings.wallpaper` → `wallpaper_ref` (hash del blob cifrado)
 *   · `groups.avatar`             → `avatar_ref`  (hash del blob cifrado)
 *   La foto de perfil, el fondo del chat y el avatar de grupo ya NO son
 *   data-URLs guardados en la fila: viven en `blob.db`, cifrados en reposo.
 *   En la base solo queda su hash, que no revela el contenido.
 * v5 registra qué cuentas guardan stickers locales, para controlar su acceso
 * y conservar los blobs mientras sigan en favoritos.
 * v6 añade una biblioteca pública de stickers con publicación voluntaria y
 * etiquetas para búsqueda. v7 incorpora el paquete local de stickers bbot.
 * v8 añade reacciones persistentes por usuario a los mensajes.
 * v9 hace configurable la privacidad de la presencia («en línea»): añade la
 *   función 'online' a `user_privacy` y quita la tabla `sessions` (los tokens
 *   ya no se guardan: son firmados y se validan en la petición).
 * v10 sustituye `users.auth_version` por la tabla `user_rid` (rid aleatorio
 *   por cuenta que rota para revocar TODOS sus tokens) y añade
 *   `password_changed_at` / `logged_out_at`, que sirven de segunda defensa
 *   frente a tokens emitidos antes de un cambio de contraseña o un logout.
 *   En las instalaciones migradas la columna `auth_version` queda sin uso.
 *
 * Es la única fuente de verdad del esquema: src/db/database.js lo aplica al
 * arrancar con `ensureSchema` (idempotente) y test/schema.test.js
 * lo verifica. No hay migraciones de formato completo, salvo las ALTER/
 * rebuild puntuales que listan las versiones (una base en un formato
 * anterior no es compatible con este servidor).
 */
'use strict';

const SCHEMA_VERSION = 12;

// Esquema v8
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
    avatar_ref   TEXT NOT NULL DEFAULT '',
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
    feature TEXT NOT NULL CHECK (feature IN ('foto','nota','descripcion','historias','llamadas','mensajes','compartir','online')),
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
    accent        TEXT,
    font_size     REAL NOT NULL DEFAULT 15,
    auto_text     INTEGER NOT NULL DEFAULT 1 CHECK (auto_text IN (0,1)),
    wallpaper_ref TEXT NOT NULL DEFAULT '',
    keep_archived INTEGER NOT NULL DEFAULT 0 CHECK (keep_archived IN (0,1)),
    always_push   INTEGER NOT NULL DEFAULT 0 CHECK (always_push IN (0,1)),
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
CREATE TABLE IF NOT EXISTS user_sticker_blobs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hash    TEXT NOT NULL,
    PRIMARY KEY (user_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_user_sticker_blobs_hash ON user_sticker_blobs(hash);
CREATE TABLE IF NOT EXISTS public_stickers (
    hash       TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_public_stickers_recent ON public_stickers(created_at DESC, hash);
CREATE TABLE IF NOT EXISTS public_sticker_tags (
    hash TEXT NOT NULL REFERENCES public_stickers(hash) ON DELETE CASCADE,
    tag  TEXT NOT NULL,
    PRIMARY KEY (hash, tag)
);
CREATE INDEX IF NOT EXISTS idx_public_sticker_tags_tag ON public_sticker_tags(tag, hash);
CREATE TABLE IF NOT EXISTS default_stickers (
    expression TEXT PRIMARY KEY,
    hash       TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL,
    tags       TEXT NOT NULL,
    sticker    TEXT NOT NULL,
    position   INTEGER NOT NULL
);

/* ---------------- 9. Grupos ---------------- */
CREATE TABLE IF NOT EXISTS groups (
    id                 TEXT PRIMARY KEY,
    crypto_id          TEXT NOT NULL,
    name               TEXT NOT NULL,
    description        TEXT NOT NULL DEFAULT '',
    avatar_ref         TEXT NOT NULL DEFAULT '',
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

/* ---------------- 11. Revocación de sesiones (rid) ----------------
   Sesiones stateless (v9): no hay tabla de sesiones. La validez de un token
   se decide comparando el checksum de su payload (firmado: SHA-256 sobre
   id | usuario | hash de contraseña | rid) con el estado vigente de la
   cuenta. ROTAR el rid invalida de golpe TODOS los tokens de la cuenta
   (cambio de contraseña, logout, cambio de cuenta), también los de otros
   dispositivos. password_changed_at y logged_out_at son la segunda defensa:
   un token emitido ANTES de esas marcas se rechaza aunque el checksum
   siguiera cuadrando (hueco de caché o escritura perdida). */
CREATE TABLE IF NOT EXISTS user_rid (
    user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rid               TEXT NOT NULL,
    password_changed_at INTEGER NOT NULL DEFAULT 0,
    logged_out_at     INTEGER NOT NULL DEFAULT 0
);

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
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL CHECK (length(emoji) > 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
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
    id        TEXT NOT NULL,
    owner     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer      TEXT,
    peer_hash TEXT,
    ts        INTEGER NOT NULL,
    data      TEXT,
    /* La llamada de CADA extremo es su propio registro: llamador y receptor
       comparten callId pero cada cuenta conserva la suya ('out' y 'in').
       Con PK(id) global, el INSERT OR REPLACE del segundo extremo machacaba
       la fila del primero: tras reiniciar, el historial de llamadas solo
       existía para quien recibió la llamada. */
    PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS idx_calls_owner_ts ON calls(owner, ts DESC);
/* Índice a ciegas del par (HMAC del nombre, src/crypto/peer-index.js): el
   texto va cifrado, así que el índice directo sobre "peer" jamás sirvió
   para buscar. Con el hash, purgar las llamadas de una cuenta borrada o
   renombrarla es O(log n) en vez de un barrido descifrando. */
CREATE INDEX IF NOT EXISTS idx_calls_peer_hash ON calls(peer_hash);

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

/* SQL original de una tabla (CHECK/UNIQUE incluidos) o '' si no existe. */
const tableSql = (db, name) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return row && row.sql ? String(row.sql) : '';
};

/* Migración v9: la CHECK de `user_privacy.feature` de las bases antiguas no
   admite 'online' (privacidad de la presencia). SQLite no puede ALTERar una
   CHECK, así que se reconstruyen las dos tablas (regla + listas) con el
   mismo esquema actualizado, copiando las filas. Idempotente: si el SQL de
   la tabla ya menciona 'online', no se toca nada. */
function migratePrivacyFeatures(db) {
    const sql = tableSql(db, 'user_privacy');
    if (!sql || /'online'/.test(sql)) return;
    if (!tableSql(db, 'user_privacy_users')) return; // base a medias: el CREATE IF NOT EXISTS la crea completa
    db.pragma('foreign_keys = OFF');
    try {
        db.exec(`
            BEGIN;
            CREATE TABLE user_privacy_v9 (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                feature TEXT NOT NULL CHECK (feature IN ('foto','nota','descripcion','historias','llamadas','mensajes','compartir','online')),
                mode    TEXT NOT NULL CHECK (mode IN ('server','contacts','nobody','except','only')),
                PRIMARY KEY (user_id, feature)
            );
            INSERT INTO user_privacy_v9 (user_id, feature, mode) SELECT user_id, feature, mode FROM user_privacy;
            CREATE TABLE user_privacy_users_v9 (
                user_id     TEXT NOT NULL,
                feature     TEXT NOT NULL,
                position    INTEGER NOT NULL,
                target_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
                target_name TEXT NOT NULL,
                PRIMARY KEY (user_id, feature, position),
                FOREIGN KEY (user_id, feature) REFERENCES user_privacy(user_id, feature) ON DELETE CASCADE
            );
            INSERT INTO user_privacy_users_v9 (user_id, feature, position, target_id, target_name)
                SELECT user_id, feature, position, target_id, target_name FROM user_privacy_users;
            DROP TABLE user_privacy_users;
            DROP TABLE user_privacy;
            ALTER TABLE user_privacy_v9 RENAME TO user_privacy;
            ALTER TABLE user_privacy_users_v9 RENAME TO user_privacy_users;
            CREATE INDEX IF NOT EXISTS idx_upu_target ON user_privacy_users(target_id) WHERE target_id IS NOT NULL;
            COMMIT;
        `);
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch { }
        throw error;
    } finally {
        db.pragma('foreign_keys = ON');
    }
}

function applySchema(db) {
    // v11: `calls.peer_hash` (índice a ciegas del par) se añade ANTES de
    // ejecutar el esquema: `idx_calls_peer_hash` referencia la columna, y
    // una instalación v10 aún no la tiene → ALTER primero, índice después.
    if (tableExists(db, 'calls') && !tableColumns(db, 'calls').has('peer_hash'))
        db.exec('ALTER TABLE calls ADD COLUMN peer_hash TEXT');
    // v12: la PK de `calls` era `id` GLOBAL; los dos extremos de una llamada
    // comparten callId, así que el segundo INSERT OR REPLACE machacaba la
    // fila del primero y al reiniciar solo un historial sobrevivía. La PK
    // correcta es (owner, id): una fila por extremo. SQLite no altera una
    // PK in situ → reconstrucción: nueva tabla, copia, suelta, renombra.
    // Antes de db.exec(SCHEMA_SQL) para que él recree los índices sobre la
    // tabla ya reconstruida (los índices de la vieja caen con ella).
    if (tableExists(db, 'calls') && !/PRIMARY KEY\s*\(owner,\s*id\)/i.test(tableSql(db, 'calls') || '')) {
        db.exec(`CREATE TABLE calls_v12 (
            id        TEXT NOT NULL,
            owner     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            peer      TEXT,
            peer_hash TEXT,
            ts        INTEGER NOT NULL,
            data      TEXT,
            PRIMARY KEY (owner, id)
        )`);
        // Filas de owners que ya no existan (no deberían: FK siempre activa)
        // se descartan: la FK nueva las rechazaría y tumbaría el arranque.
        db.exec(`INSERT INTO calls_v12 (id, owner, peer, peer_hash, ts, data)
            SELECT id, owner, peer, peer_hash, ts, data FROM calls
            WHERE owner IN (SELECT id FROM users)`);
        db.exec('DROP TABLE calls');
        db.exec('ALTER TABLE calls_v12 RENAME TO calls');
    }
    // v11: el índice antiguo de "peer" indexaba el TEXTO CIFRADO (nunca
    // pudo servir para buscar). Con peer_hash queda obsoleto: se suelta.
    try { db.exec('DROP INDEX IF EXISTS idx_calls_peer'); } catch { }
    db.exec(SCHEMA_SQL);
    // Altas de columna idempotentes para instalaciones con tablas existentes.
    if (!tableColumns(db, 'user_chat_prefs').has('archived'))
        db.exec('ALTER TABLE user_chat_prefs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))');
    if (!tableColumns(db, 'user_chat_settings').has('keep_archived'))
        db.exec('ALTER TABLE user_chat_settings ADD COLUMN keep_archived INTEGER NOT NULL DEFAULT 0 CHECK (keep_archived IN (0,1))');
    if (!tableColumns(db, 'user_chat_settings').has('always_push'))
        db.exec('ALTER TABLE user_chat_settings ADD COLUMN always_push INTEGER NOT NULL DEFAULT 0 CHECK (always_push IN (0,1))');
    if (!tableColumns(db, 'user_chat_settings').has('accent'))
        db.exec('ALTER TABLE user_chat_settings ADD COLUMN accent TEXT');
    // v9: la tabla de sesiones desaparece (tokens JWT stateless). Una base
    // antigua la conserva con filas de sesiones ya inservibles: se suelta.
    if (tableExists(db, 'sessions')) db.exec('DROP TABLE sessions');
    // v10: `users.auth_version` quedó sin uso al nacer `user_rid` (la
    // revocación es el rid + checksum). Si la instalación venía de v9, la
    // columna sigue ahí con su valor fijo: se suelta. No necesita la llave
    // maestra, así que puede hacerse aquí. Si el SQLite del sistema es
    // demasiado antiguo para DROP COLUMN, simplemente queda sin uso.
    if (tableColumns(db, 'users').has('auth_version')) {
        try { db.exec('ALTER TABLE users DROP COLUMN auth_version'); } catch { }
    }
    // v10: `user_rid` se crea con el resto del esquema (arriba). Las FILAS de
    // las cuentas existentes NO se rellenan aquí: generar el rid necesita la
    // llave maestra, y applySchema corre mientras la base se está abriendo
    // (antes de que exista). Lo hace backfillUserRids, ya con la llave en
    // RAM, desde el arranque del servidor (ver server.js).
    migratePrivacyFeatures(db);
}

/* Aplica el esquema si falta algo (idempotente) y registra la versión.
 * No hay migraciones de formato completo, salvo las ALTER/rebuild que
 * listan las versiones del encabezado: una base en un formato anterior no
 * es compatible con este servidor. */
function ensureSchema(db) {
    applySchema(db);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run('schema_version', String(SCHEMA_VERSION));
}

// Borrado en cascada
// El esquema declara claves ajenas ON DELETE CASCADE, así que borrar la fila
// de `users` arrastra solo: contactos (en ambos sentidos), bloqueos,
// resúmenes, historias, llamadas, push, perfil, privacidad, colores, notas,
// stickers, pertenencia a grupos, resúmenes de grupo, solicitudes y permisos
// de descarga, reacciones de mensajes. Aquí se añade lo que la cascada no puede expresar con SQL:
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

/* Valor en claro de una columna que puede ir cifrada en reposo. El esquema no
   conoce la llave maestra: quien borra (transactions.js) pasa el descifrador.
   Sin él se compara el texto tal cual, que es lo que usan los tests. */
const readableField = (options, column, value) =>
    typeof options.decryptField === 'function' ? options.decryptField(column, value) : value;

/* Borra filas de una tabla cuyo campo de nombre coincida con `matches`.
   Se usa para referencias que no tienen FK (o la tienen nula): silenciados y
   listas de privacidad guardan el nombre cifrado, no el id. */
function deleteRowsByFieldName(db, table, idColumn, fieldColumn, where, matches, options) {
    const filter = where ? ` WHERE ${where}` : '';
    for (const row of db.prepare(`SELECT ${idColumn} AS id, ${fieldColumn} AS value FROM ${table}${filter}`).all())
        if (matches(readableField(options, fieldColumn, row.value)))
            db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).run(row.id);
}

/* Borra un grupo entero: mensajes, adjuntos, miembros, resúmenes y solicitudes.
   También las referencias por texto que sobreviven a la cascada: preferencias
   de lista (fijado/archivado), marcas de chat oculto y silencios. */
function deleteGroupRows(db, gid, options = {}) {
    const peerKey = 'group:' + gid;
    const hashes = [
        ...db.prepare('SELECT DISTINCT hash FROM blob_access WHERE gid = ?').pluck().all(gid),
        ...blobHashesOfMessages(db, 'chat = ?', peerKey)
    ];
    db.prepare('DELETE FROM blob_access WHERE gid = ?').run(gid);
    deleteMessageRowsWhere(db, 'chat = ?', peerKey);
    db.prepare('DELETE FROM user_chat_prefs WHERE peer_key = ?').run(peerKey);
    db.prepare('DELETE FROM chat_deletions WHERE chat = ?').run(peerKey);
    deleteRowsByFieldName(db, 'user_muted_peers', 'rowid', 'peer_name',
        'peer_id IS NULL', value => value === peerKey, options);
    db.prepare('DELETE FROM groups WHERE id = ?').run(gid); // cascada completa
    return hashes;
}

/* Borra una cuenta completa. Devuelve { hashes, groupsTouched, groupsRemoved }
   para que el servidor pueda limpiar los blobs y refrescar la RAM.

   `options.decryptField(column, value)` descifra los campos en reposo
   (`calls.peer`, `user_muted_peers.peer_name`, `user_privacy_users.target_name`).
   Sin él (tests) se compara el texto tal cual. */
function deleteAccountRows(db, userId, username, options = {}) {
    const hashes = [];
    const groupsTouched = [];
    const groupsRemoved = [];
    const usernameKey = String(username || '').trim().toLowerCase();
    const sameUsername = value => typeof value === 'string' && value.trim().toLowerCase() === usernameKey;

    // 1) Grupos: si era el último miembro, el grupo desaparece; si no, el grupo
    //    sigue vivo y la administración (y la propiedad) pasan a otro miembro.
    const gids = db.prepare('SELECT gid FROM group_members WHERE user_id = ?').pluck().all(userId);
    for (const gid of gids) {
        const others = db.prepare('SELECT user_id, role FROM group_members WHERE gid = ? AND user_id <> ?').all(gid, userId);
        if (!others.length) {
            hashes.push(...deleteGroupRows(db, gid, options));
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
    // 4b) Stickers propios: al quitar la última referencia de la cuenta, el
    // blob se purga junto con sus conversaciones e imágenes.
    hashes.push(...db.prepare('SELECT hash FROM user_sticker_blobs WHERE user_id = ?').pluck().all(userId));
    hashes.push(...db.prepare('SELECT hash FROM public_stickers WHERE user_id = ?').pluck().all(userId));
    // 5) Referencias que viven en filas de OTRAS cuentas y que las claves
    //    ajenas no alcanzan porque guardan el nombre (o el par de ids) como
    //    texto. Sin esto quedaban chats archivados/fijados "fantasma" que al
    //    desarchivarse respondían «Chat no válido».
    //    - Preferencias de lista: 'dm:<usuario>'.
    db.prepare('DELETE FROM user_chat_prefs WHERE lower(peer_key) = ?').run('dm:' + usernameKey);
    //    - Marcadores de "chat borrado" de la conversación 1:1 (el id va
    //      dentro de 'chat:<idA>__<idB>'; el prefijo excluye grupos).
    db.prepare("DELETE FROM chat_deletions WHERE chat LIKE 'chat:%' AND instr(chat, ?) > 0").run(userId);
    //    - Silenciados guardados sin id resuelto (peer_id IS NULL). Los que
    //      tienen peer_id caen por la cascada al borrar `users`.
    deleteRowsByFieldName(db, 'user_muted_peers', 'rowid', 'peer_name',
        'peer_id IS NULL', sameUsername, options);
    //    - Listas "excepto / solo" de privacidad guardadas sin id resuelto.
    deleteRowsByFieldName(db, 'user_privacy_users', 'rowid', 'target_name',
        'target_id IS NULL', sameUsername, options);
    // 5b) Historial de llamadas donde era el otro extremo. El nombre del par
    //     va CIFRADO y se localiza por su blind index (peer_hash): un DELETE
    //     O(log n) en vez de recorrer y descifrar todo el historial. Sin
    //     llave para calcular el hash (o con filas cuyo nombre ya no se
    //     puede descifrar) se usa la comparación lenta de siempre, para no
    //     dejar nada atrás.
    try {
        const { peerHash } = require('../crypto/peer-index.js');
        const hashCuenta = peerHash(usernameKey);
        if (hashCuenta) db.prepare('DELETE FROM calls WHERE peer_hash = ?').run(hashCuenta);
        deleteRowsByFieldName(db, 'calls', 'id', 'peer', 'peer_hash IS NULL', sameUsername, options);
    } catch {
        deleteRowsByFieldName(db, 'calls', 'id', 'peer', '', sameUsername, options);
    }
    // 6) El borrado de la cuenta: aquí caen TODAS las cascadas del esquema.
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    return { hashes, groupsTouched, groupsRemoved };
}

/* Rellena `user_rid` para las cuentas que aún no tienen fila (migración v10
   de instalaciones anteriores, o una cuenta creada por una vía que no la
   escribió). Se llama con la llave maestra YA en RAM (server.js, tras cargar
   crypto/setup.js): generar el rid la necesita, y applySchema corre antes de
   que exista. Idempotente: no toca las filas que ya tienen rid. */
function backfillUserRids(db) {
    const faltan = db.prepare(`SELECT u.id FROM users u
        LEFT JOIN user_rid r ON r.user_id = u.id WHERE r.user_id IS NULL`).all();
    if (!faltan.length) return 0;
    const { generateRid } = require('../auth/rid.js');
    const insert = db.prepare('INSERT INTO user_rid (user_id, rid, password_changed_at, logged_out_at) VALUES (?, ?, 0, 0)');
    for (const row of faltan) insert.run(row.id, generateRid(row.id));
    return faltan.length;
}

/* Migración v11: calcula `calls.peer_hash` para las filas que aún no lo
   tienen. Necesita la llave maestra (descifrar el nombre y calcular su
   HMAC), así que corre desde server.js al arrancar, como backfillUserRids.
   Idempotente. Las filas cuyo nombre ya no se puede descifrar (daño en la
   base) quedan con hash NULL: la purga por cuenta las busca con la
   comparación lenta de siempre, así que no se pierden. */
function backfillCallPeerHashes(db) {
    const pendientes = db.prepare('SELECT id, peer FROM calls WHERE peer IS NOT NULL AND peer_hash IS NULL').all();
    if (!pendientes.length) return 0;
    const { peerHash } = require('../crypto/peer-index.js');
    const { decField } = require('../crypto/field-crypto.js');
    const update = db.prepare('UPDATE calls SET peer_hash = ? WHERE id = ?');
    let hechos = 0;
    for (const row of pendientes) {
        let nombre;
        try { nombre = decField('calls.peer', row.peer); } catch { nombre = null; }
        if (!nombre) continue;
        const hash = peerHash(nombre);
        if (hash) { update.run(hash, row.id); hechos++; }
    }
    return hechos;
}

module.exports = {
    SCHEMA_VERSION,
    SCHEMA_SQL,
    applySchema,
    ensureSchema,
    backfillUserRids,
    backfillCallPeerHashes,
    tableExists,
    tableColumns,
    tableSql,
    deleteAccountRows,
    deleteGroupRows,
    deleteMessageRowsWhere
};

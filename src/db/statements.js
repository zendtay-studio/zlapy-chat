/**
 * Sentencias preparadas.
 *
 * Compila una sola vez, al arrancar, todas las consultas que usa el servidor
 * (better-sqlite3 no cachea db.prepare entre llamadas) y las expone en el
 * objeto `Stmt`.
 */
'use strict';

const { blobDb, db } = require('./database.js');
const { stories, users } = require('../state.js');

const Stmt = {
    // Users (cuentas)
    getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare(`INSERT INTO users
        (id, username, password_hash, password_salt, add_policy, created_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
    updateUser: db.prepare(`UPDATE users SET username = ?, password_hash = ?, password_salt = ?,
        add_policy = ?, last_seen = ? WHERE id = ?`),
    touchUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    /* Revocación de sesiones sin almacén (v10): el `rid` de la cuenta rota
       y el checksum de todos sus tokens deja de cuadrar. Las marcas de
       tiempo son la segunda defensa (iat vs. cambio de contraseña/logout). */
    getRid: db.prepare('SELECT rid, password_changed_at, logged_out_at FROM user_rid WHERE user_id = ?'),
    upsertRid: db.prepare(`INSERT INTO user_rid (user_id, rid, password_changed_at, logged_out_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
        rid = excluded.rid, password_changed_at = excluded.password_changed_at,
        logged_out_at = excluded.logged_out_at`),
    groupExists: db.prepare('SELECT 1 FROM groups WHERE id = ?'),
    listOwnersByContact: db.prepare('SELECT owner FROM contacts WHERE contact = ?'),
    listGroupsOfUser: db.prepare('SELECT gid FROM group_members WHERE user_id = ?'),
    listAllUsers: db.prepare('SELECT * FROM users'),

    // Perfil público
    getProfile: db.prepare('SELECT display_name, avatar_ref, bio, note, note_ts FROM user_profiles WHERE user_id = ?'),
    upsertProfile: db.prepare(`INSERT INTO user_profiles (user_id, display_name, avatar_ref, bio, note, note_ts, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
        display_name = excluded.display_name, avatar_ref = excluded.avatar_ref, bio = excluded.bio,
        note = excluded.note, note_ts = excluded.note_ts, updated_at = excluded.updated_at`),

    // Claves del dispositivo (cifradas en reposo)
    getKey: db.prepare('SELECT key_cipher FROM user_keys WHERE user_id = ?'),
    // Clave de cifrado de contenido por usuario (auth_key, AES-256-GCM)
    getAuthKey: db.prepare('SELECT auth_key, key_id FROM user_auth_keys WHERE user_id = ?'),
    insertAuthKey: db.prepare('INSERT INTO user_auth_keys (user_id, auth_key, key_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    replaceAuthKey: db.prepare('UPDATE user_auth_keys SET auth_key = ?, key_id = ?, updated_at = ? WHERE user_id = ?'),
    upsertKey: db.prepare(`INSERT INTO user_keys (user_id, key_cipher, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET key_cipher = excluded.key_cipher, updated_at = excluded.updated_at`),

    // Privacidad por función
    listPrivacy: db.prepare('SELECT feature, mode FROM user_privacy WHERE user_id = ?'),
    upsertPrivacy: db.prepare('INSERT OR REPLACE INTO user_privacy (user_id, feature, mode) VALUES (?, ?, ?)'),
    deletePrivacy: db.prepare('DELETE FROM user_privacy WHERE user_id = ?'),
    listPrivacyUsers: db.prepare('SELECT feature, position, target_id, target_name FROM user_privacy_users WHERE user_id = ? ORDER BY feature, position'),
    upsertPrivacyUser: db.prepare(`INSERT OR REPLACE INTO user_privacy_users
        (user_id, feature, position, target_id, target_name) VALUES (?, ?, ?, ?, ?)`),
    deletePrivacyUsers: db.prepare('DELETE FROM user_privacy_users WHERE user_id = ?'),

    // Apariencia del chat
    getChatSettings: db.prepare('SELECT * FROM user_chat_settings WHERE user_id = ?'),
    upsertChatSettings: db.prepare(`INSERT OR REPLACE INTO user_chat_settings
        (user_id, wall, opacity, blur, sender, receiver, sender_text, receiver_text, accent,
         font_size, auto_text, wallpaper_ref, keep_archived, always_push, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

    // Chats silenciados
    listMutedPeers: db.prepare('SELECT rowid, peer_id, peer_name FROM user_muted_peers WHERE user_id = ?'),
    insertMutedPeer: db.prepare('INSERT OR REPLACE INTO user_muted_peers (user_id, peer_id, peer_name) VALUES (?, ?, ?)'),
    deleteMutedPeers: db.prepare('DELETE FROM user_muted_peers WHERE user_id = ?'),
    /* El nombre del par silenciado va cifrado: no se puede borrar por nombre
       con un WHERE, así que se borra por rowid tras descifrar y comparar. */
    deleteMutedPeerByRowid: db.prepare('DELETE FROM user_muted_peers WHERE rowid = ?'),

    // Preferencias de la lista de chats (fijado / no leído / archivado)
    listChatPrefs: db.prepare('SELECT peer_key, pinned_at, unread, archived FROM user_chat_prefs WHERE user_id = ?'),
    getChatPref: db.prepare('SELECT peer_key, pinned_at, unread, archived FROM user_chat_prefs WHERE user_id = ? AND peer_key = ?'),
    upsertChatPref: db.prepare(`INSERT INTO user_chat_prefs (user_id, peer_key, pinned_at, unread, archived, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, peer_key) DO UPDATE SET
            pinned_at = excluded.pinned_at,
            unread = excluded.unread,
            archived = excluded.archived,
            updated_at = excluded.updated_at`),
    deleteChatPref: db.prepare('DELETE FROM user_chat_prefs WHERE user_id = ? AND peer_key = ?'),

    // Nota personal (estado)
    getUserNote: db.prepare('SELECT data, ts FROM user_notes WHERE user_id = ?'),
    upsertUserNote: db.prepare('INSERT OR REPLACE INTO user_notes (user_id, data, ts) VALUES (?, ?, ?)'),
    deleteUserNote: db.prepare('DELETE FROM user_notes WHERE user_id = ?'),

    // Favoritos y blobs de stickers propios
    listStickers: db.prepare('SELECT sticker FROM user_stickers WHERE user_id = ? ORDER BY position'),
    insertSticker: db.prepare('INSERT OR REPLACE INTO user_stickers (user_id, position, sticker) VALUES (?, ?, ?)'),
    deleteStickers: db.prepare('DELETE FROM user_stickers WHERE user_id = ?'),
    insertUserStickerBlob: db.prepare('INSERT OR IGNORE INTO user_sticker_blobs (user_id, hash) VALUES (?, ?)'),

    // Grupos vistos
    listGroupSeen: db.prepare('SELECT gid, ts FROM user_group_seen WHERE user_id = ?'),
    upsertGroupSeen: db.prepare('INSERT OR REPLACE INTO user_group_seen (user_id, gid, ts) VALUES (?, ?, ?)'),
    deleteGroupSeenByUser: db.prepare('DELETE FROM user_group_seen WHERE user_id = ?'),
    // Borrado puntual: borrar un grupo no debe reescribir las tablas de cada
    // miembro con un saveUserToDb completo.
    deleteGroupSeen: db.prepare('DELETE FROM user_group_seen WHERE user_id = ? AND gid = ?'),

    // Messages
    insertMessage: db.prepare(`INSERT INTO messages
        (id, chat, ts, from_id, to_id, kind, data, hash, once, edited, crypto_version, crypto_group_id, signature, signing_public_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateMessage: db.prepare(`UPDATE messages SET kind = ?, data = ?, hash = ?, once = ?, edited = ?,
        crypto_version = ?, crypto_group_id = ?, signature = ?, signing_public_key = ? WHERE id = ?`),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
    getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getMessageReaction: db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?'),
    upsertMessageReaction: db.prepare(`INSERT INTO message_reactions (message_id, user_id, emoji, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(message_id, user_id) DO UPDATE SET
        emoji = excluded.emoji, updated_at = excluded.updated_at`),
    deleteMessageReaction: db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?'),
    listMessageReactions: db.prepare('SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id = ? ORDER BY updated_at ASC'),
    lastMessages: db.prepare('SELECT * FROM messages WHERE chat = ? ORDER BY ts DESC, id DESC LIMIT ?'),
    // Borrados con alcance por usuario
    insertMessageDeletion: db.prepare('INSERT OR REPLACE INTO message_deletions (message_id, user_id, deleted_at) VALUES (?, ?, ?)'),
    // Los borrados por usuario ya no se materializan por perfil (filterForViewer
    // consulta SOLO los ids de la página, en messages.js).
    insertChatDeletion: db.prepare('INSERT OR REPLACE INTO chat_deletions (chat, user_id, deleted_at) VALUES (?, ?, ?)'),
    chatDeletedFor: db.prepare('SELECT 1 FROM chat_deletions WHERE chat = ? AND user_id = ?'),
    deleteChatDeletion: db.prepare('DELETE FROM chat_deletions WHERE chat = ? AND user_id = ?'),
    prevMessages: db.prepare(`SELECT * FROM messages WHERE chat = ? AND (ts < ? OR (ts = ? AND id < ?))
        ORDER BY ts DESC, id DESC LIMIT ?`),
    lastMessage: db.prepare('SELECT * FROM messages WHERE chat = ? ORDER BY ts DESC, id DESC LIMIT 1'),

    // Blob access
    insertBlobAccessChat: db.prepare('INSERT OR REPLACE INTO blob_access (hash, message_id, kind, chat_a, chat_b) VALUES (?, ?, ?, ?, ?)'),
    insertBlobAccessGroup: db.prepare('INSERT OR REPLACE INTO blob_access (hash, message_id, kind, gid) VALUES (?, ?, ?, ?)'),
    insertBlobAccessStory: db.prepare('INSERT OR REPLACE INTO blob_access (hash, message_id, kind, story_user) VALUES (?, ?, ?, ?)'),
    getBlobHashesByMessage: db.prepare('SELECT DISTINCT hash FROM blob_access WHERE message_id = ?'),
    deleteBlobAccessByMessage: db.prepare('DELETE FROM blob_access WHERE message_id = ?'),
    getBlobAccessChat: db.prepare(`SELECT 1 FROM blob_access WHERE hash = ? AND kind = 'chat' AND (chat_a = ? OR chat_b = ?) LIMIT 1`),
    insertBlobAccessMember: db.prepare('INSERT OR IGNORE INTO blob_access_members (hash, message_id, user_id) VALUES (?, ?, ?)'),
    /* Acceso a un adjunto de grupo: los miembros fotografiados al publicarlo. */
    getBlobAccessGroup: db.prepare(`SELECT 1 FROM blob_access ba
        JOIN blob_access_members m ON m.hash = ba.hash
        WHERE ba.hash = ? AND ba.kind = 'group' AND m.user_id = ? LIMIT 1`),
    /* Adjuntos publicados antes de existir la foto: se responde con la
       pertenencia actual (compatibilidad hacia atrás). */
    getBlobAccessGroupByCurrentMembership: db.prepare(`SELECT 1 FROM blob_access ba
        JOIN group_members gm ON ba.gid = gm.gid
        WHERE ba.hash = ? AND ba.kind = 'group' AND gm.user_id = ? LIMIT 1`),
    blobAccessMemberCount: db.prepare('SELECT COUNT(*) AS c FROM blob_access_members WHERE hash = ?'),
    deleteBlobAccessMembersByMessage: db.prepare('DELETE FROM blob_access_members WHERE message_id = ?'),
    /* Purga de filas de acceso cuyo mensaje ya no existe (borrados masivos por
       SQL, como el vaciado de chats o de cuentas, no pueden avisar a ninguna
       statement JS). Las historias viven en la tabla `stories`, no en
       `messages`, así que en blob_access se conservan. */
    pruneOrphanBlobAccessMembers: db.prepare('DELETE FROM blob_access_members WHERE message_id NOT IN (SELECT id FROM messages)'),
    pruneOrphanBlobAccess: db.prepare("DELETE FROM blob_access WHERE kind <> 'story' AND message_id NOT IN (SELECT id FROM messages)"),
    getBlobAccessStory: db.prepare(`SELECT story_user FROM blob_access WHERE hash = ? AND kind = 'story' LIMIT 1`),
    getUserStickerBlob: db.prepare('SELECT 1 FROM user_sticker_blobs WHERE user_id = ? AND hash = ? LIMIT 1'),
    getPublicSticker: db.prepare('SELECT 1 FROM public_stickers WHERE hash = ? LIMIT 1'),
    listDefaultStickers: db.prepare(`SELECT hash, expression, label, tags, sticker, position
        FROM default_stickers ORDER BY position ASC`),
    getDefaultStickerByExpression: db.prepare('SELECT hash FROM default_stickers WHERE expression = ?'),
    isDefaultStickerHash: db.prepare('SELECT 1 FROM default_stickers WHERE hash = ? LIMIT 1'),
    upsertDefaultSticker: db.prepare(`INSERT INTO default_stickers
        (expression, hash, label, tags, sticker, position) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(expression) DO UPDATE SET hash = excluded.hash, label = excluded.label,
        tags = excluded.tags, sticker = excluded.sticker, position = excluded.position`),
    insertPublicSticker: db.prepare('INSERT OR IGNORE INTO public_stickers (hash, user_id, created_at) VALUES (?, ?, ?)'),
    insertPublicStickerTag: db.prepare('INSERT OR IGNORE INTO public_sticker_tags (hash, tag) VALUES (?, ?)'),
    listPublicStickers: db.prepare(`SELECT ps.hash, ps.created_at,
        GROUP_CONCAT(pst.tag, ',') AS tags
        FROM public_stickers ps
        LEFT JOIN public_sticker_tags pst ON pst.hash = ps.hash
        GROUP BY ps.hash
        ORDER BY ps.created_at DESC, ps.hash DESC
        LIMIT ? OFFSET ?`),
    searchPublicStickersByTags: db.prepare(`SELECT ps.hash, ps.created_at,
        GROUP_CONCAT(pst.tag, ',') AS tags
        FROM public_stickers ps
        JOIN public_sticker_tags pst ON pst.hash = ps.hash
        WHERE pst.tag IN (SELECT value FROM json_each(?))
        GROUP BY ps.hash
        HAVING COUNT(DISTINCT pst.tag) = ?
        ORDER BY ps.created_at DESC, ps.hash DESC
        LIMIT ? OFFSET ?`),
    searchPublicStickersByTagPrefix: db.prepare(`WITH requested_tags AS (
            SELECT value FROM json_each(?)
        )
        SELECT ps.hash, ps.created_at, GROUP_CONCAT(pst.tag, ',') AS tags
        FROM public_stickers ps
        JOIN public_sticker_tags pst ON pst.hash = ps.hash
        WHERE pst.tag IN (SELECT value FROM requested_tags)
            OR substr(pst.tag, 1, length(?)) = ?
        GROUP BY ps.hash
        HAVING COUNT(DISTINCT CASE WHEN pst.tag IN (SELECT value FROM requested_tags)
            THEN pst.tag END) = ?
            AND SUM(CASE WHEN substr(pst.tag, 1, length(?)) = ? THEN 1 ELSE 0 END) > 0
        ORDER BY ps.created_at DESC, ps.hash DESC
        LIMIT ? OFFSET ?`),
    searchPublicStickersByTagQuery: db.prepare(`WITH requested_terms AS (
            SELECT value FROM json_each(?)
        )
        SELECT ps.hash, ps.created_at,
        GROUP_CONCAT(pst.tag, ',') AS tags
        FROM public_stickers ps
        JOIN public_sticker_tags pst ON pst.hash = ps.hash
        JOIN requested_terms rt ON instr(pst.tag, rt.value) > 0
        GROUP BY ps.hash
        HAVING COUNT(DISTINCT rt.value) = ?
        ORDER BY ps.created_at DESC, ps.hash DESC
        LIMIT ? OFFSET ?`),
    countPublicStickers: db.prepare('SELECT COUNT(*) AS count FROM public_stickers'),
    countPublicStickersByTags: db.prepare(`SELECT COUNT(*) AS count FROM (
        SELECT ps.hash
        FROM public_stickers ps
        JOIN public_sticker_tags pst ON pst.hash = ps.hash
        WHERE pst.tag IN (SELECT value FROM json_each(?))
        GROUP BY ps.hash
        HAVING COUNT(DISTINCT pst.tag) = ?
    )`),
    countPublicStickersByTagPrefix: db.prepare(`WITH requested_tags AS (
            SELECT value FROM json_each(?)
        )
        SELECT COUNT(*) AS count FROM (
            SELECT ps.hash
            FROM public_stickers ps
            JOIN public_sticker_tags pst ON pst.hash = ps.hash
            WHERE pst.tag IN (SELECT value FROM requested_tags)
                OR substr(pst.tag, 1, length(?)) = ?
            GROUP BY ps.hash
            HAVING COUNT(DISTINCT CASE WHEN pst.tag IN (SELECT value FROM requested_tags)
                THEN pst.tag END) = ?
                AND SUM(CASE WHEN substr(pst.tag, 1, length(?)) = ? THEN 1 ELSE 0 END) > 0
        )`),
    countPublicStickersByTagQuery: db.prepare(`WITH requested_terms AS (
            SELECT value FROM json_each(?)
        )
        SELECT COUNT(*) AS count FROM (
            SELECT ps.hash
            FROM public_stickers ps
            JOIN public_sticker_tags pst ON pst.hash = ps.hash
            JOIN requested_terms rt ON instr(pst.tag, rt.value) > 0
            GROUP BY ps.hash
            HAVING COUNT(DISTINCT rt.value) = ?
        )`),

    // Blobs
    getBlob: blobDb.prepare('SELECT data FROM blobs WHERE hash = ?'),
    insertBlob: blobDb.prepare('INSERT OR IGNORE INTO blobs (hash, data) VALUES (?, ?)'),

    /* Cuota de almacenamiento. Las dos bases son conexiones separadas, así que
       no se puede cruzar `blobs` con `blob_access` en una sola consulta: se
       piden los hashes referenciados por una cuenta (base de datos) y se suman
       sus tamaños (base de adjuntos). */
    userBlobHashes: db.prepare(`
        SELECT hash FROM blob_access WHERE kind = 'chat' AND (chat_a = ? OR chat_b = ?)
        UNION SELECT ba.hash FROM blob_access ba JOIN group_members gm ON gm.gid = ba.gid
            WHERE ba.kind = 'group' AND gm.user_id = ?
        UNION SELECT hash FROM blob_access WHERE kind = 'story' AND story_user = ?
        UNION SELECT hash FROM user_sticker_blobs WHERE user_id = ?
        UNION SELECT hash FROM public_stickers WHERE user_id = ?
        UNION SELECT avatar_ref FROM user_profiles WHERE user_id = ? AND avatar_ref <> ''
        UNION SELECT wallpaper_ref FROM user_chat_settings WHERE user_id = ? AND wallpaper_ref <> ''`),
    allBlobHashes: blobDb.prepare('SELECT hash FROM blobs'),
    /* Referencias de TODOS los blobs: los adjuntos y también las imágenes de
       perfil, fondo y avatar de grupo (que no pasan por blob_access). */
    referencedBlobHashes: db.prepare(`SELECT DISTINCT hash FROM blob_access
        UNION SELECT hash FROM user_sticker_blobs
        UNION SELECT hash FROM public_stickers
        UNION SELECT hash FROM default_stickers
        UNION SELECT avatar_ref FROM user_profiles WHERE avatar_ref <> ''
        UNION SELECT wallpaper_ref FROM user_chat_settings WHERE wallpaper_ref <> ''
        UNION SELECT avatar_ref FROM groups WHERE avatar_ref <> ''
        UNION SELECT value FROM meta WHERE key = 'media_fallback_hash'`),
    blobSize: blobDb.prepare('SELECT LENGTH(data) AS bytes FROM blobs WHERE hash = ?'),
    blobBytesGlobal: blobDb.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM blobs'),
    deleteBlobByHash: blobDb.prepare('DELETE FROM blobs WHERE hash = ?'),

    hasBlob: blobDb.prepare('SELECT 1 FROM blobs WHERE hash = ? LIMIT 1'),

    // Summaries
    getSummary: db.prepare('SELECT unread, last_data FROM summaries WHERE owner = ? AND peer = ?'),
    upsertSummary: db.prepare('INSERT OR REPLACE INTO summaries (owner, peer, unread, last_data) VALUES (?, ?, ?, ?)'),
    listSummaries: db.prepare('SELECT peer, unread, last_data FROM summaries WHERE owner = ?'),
    deleteSummary: db.prepare('DELETE FROM summaries WHERE owner = ? AND peer = ?'),

    // Groups
    getGroup: db.prepare('SELECT * FROM groups WHERE id = ?'),
    insertGroup: db.prepare(`INSERT OR REPLACE INTO groups
        (id, crypto_id, name, description, avatar_ref, owner_id, visibility, join_policy, write_policy,
         add_policy, edit_policy, mention_all_policy, content_policy, invite_code, keys_cipher, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateGroup: db.prepare(`UPDATE groups SET crypto_id = ?, name = ?, description = ?, avatar_ref = ?,
        owner_id = ?, visibility = ?, join_policy = ?, write_policy = ?, add_policy = ?, edit_policy = ?,
        mention_all_policy = ?, content_policy = ?, invite_code = ?, keys_cipher = ?, created_at = ? WHERE id = ?`),
    listPublicGroups: db.prepare(`SELECT id FROM groups WHERE visibility = 'public'`),
    listPublicGroupsForDiscover: db.prepare(`SELECT id, name, description FROM groups g
        WHERE g.visibility = 'public'
          AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.gid = g.id AND gm.user_id = ?)
        ORDER BY (SELECT COUNT(*) FROM group_members gm WHERE gm.gid = g.id) DESC, g.created_at DESC, g.id ASC`),
    listRecommendedPublicGroups: db.prepare(`SELECT id FROM groups g
        WHERE g.visibility = 'public'
          AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.gid = g.id AND gm.user_id = ?)
        ORDER BY (SELECT COUNT(*) FROM group_members gm WHERE gm.gid = g.id) DESC, g.created_at DESC, g.id ASC
        LIMIT ? OFFSET ?`),
    publicGroupDiscoverDetails: db.prepare(`SELECT g.id, g.name, g.description, g.avatar_ref, g.join_policy,
        (SELECT COUNT(*) FROM group_members gm WHERE gm.gid = g.id) AS members,
        EXISTS (SELECT 1 FROM group_join_requests jr WHERE jr.gid = g.id AND jr.user_id = ?) AS requested
        FROM groups g
        WHERE g.id = ? AND g.visibility = 'public'
          AND NOT EXISTS (SELECT 1 FROM group_members gm WHERE gm.gid = g.id AND gm.user_id = ?)`),

    // Group members
    insertGroupMember: db.prepare(`INSERT INTO group_members (gid, user_id, role, joined_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(gid, user_id) DO UPDATE SET role = excluded.role`),
    deleteGroupMember: db.prepare('DELETE FROM group_members WHERE gid = ? AND user_id = ?'),
    listGroupMembers: db.prepare('SELECT user_id, role FROM group_members WHERE gid = ?'),
    listUserGroups: db.prepare('SELECT gid FROM group_members WHERE user_id = ?'),

    // Group summaries
    getGroupSummary: db.prepare('SELECT unread, last_data FROM group_summaries WHERE owner = ? AND gid = ?'),
    listGroupSummaries: db.prepare('SELECT gid, unread, last_data FROM group_summaries WHERE owner = ?'),
    upsertGroupSummary: db.prepare('INSERT OR REPLACE INTO group_summaries (owner, gid, unread, last_data) VALUES (?, ?, ?, ?)'),
    bumpGroupSummary: db.prepare(`INSERT INTO group_summaries (owner, gid, unread, last_data) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner, gid) DO UPDATE SET unread = unread + excluded.unread, last_data = excluded.last_data`),
    deleteGroupSummary: db.prepare('DELETE FROM group_summaries WHERE owner = ? AND gid = ?'),

    // Group join requests
    insertJoinRequest: db.prepare('INSERT OR REPLACE INTO group_join_requests (gid, user_id, username, ts) VALUES (?, ?, ?, ?)'),
    deleteJoinRequestsByGid: db.prepare('DELETE FROM group_join_requests WHERE gid = ?'),
    listJoinRequests: db.prepare('SELECT user_id, username, ts FROM group_join_requests WHERE gid = ?'),
    listUserJoinRequests: db.prepare('SELECT gid FROM group_join_requests WHERE user_id = ?'),

    // Contacts
    insertContact: db.prepare('INSERT OR IGNORE INTO contacts (owner, contact) VALUES (?, ?)'),
    deleteContact: db.prepare('DELETE FROM contacts WHERE owner = ? AND contact = ?'),
    listContacts: db.prepare('SELECT contact FROM contacts WHERE owner = ?'),

    // Contact requests
    insertContactRequest: db.prepare('INSERT OR REPLACE INTO contact_requests (from_id, to_id, ts) VALUES (?, ?, ?)'),
    deleteContactRequest: db.prepare('DELETE FROM contact_requests WHERE from_id = ? AND to_id = ?'),
    listContactRequestsTo: db.prepare('SELECT from_id, ts FROM contact_requests WHERE to_id = ?'),
    listContactRequestsFrom: db.prepare('SELECT to_id, ts FROM contact_requests WHERE from_id = ?'),

    // Blocked
    insertBlocked: db.prepare('INSERT OR IGNORE INTO blocked (owner, target) VALUES (?, ?)'),
    deleteBlocked: db.prepare('DELETE FROM blocked WHERE owner = ? AND target = ?'),
    listBlocked: db.prepare('SELECT target FROM blocked WHERE owner = ?'),

    // Stories
    insertStory: db.prepare('INSERT OR REPLACE INTO stories (from_id, ts, data, hash) VALUES (?, ?, ?, ?)'),
    updateStoryData: db.prepare('UPDATE stories SET data = ? WHERE from_id = ? AND ts = ?'),
    getStory: db.prepare('SELECT * FROM stories WHERE from_id = ? AND ts = ?'),
    deleteStory: db.prepare('DELETE FROM stories WHERE from_id = ? AND ts = ?'),
    listLiveStories: db.prepare('SELECT * FROM stories WHERE ts > ?'),
    deleteExpiredStories: db.prepare('DELETE FROM stories WHERE ts <= ?'),

    // Calls
    insertCall: db.prepare('INSERT OR REPLACE INTO calls (id, owner, peer, peer_hash, ts, data) VALUES (?, ?, ?, ?, ?, ?)'),
    updateCallData: db.prepare('UPDATE calls SET data = ? WHERE id = ? AND owner = ?'),
    /* El par de una llamada va cifrado y su localización por nombre va por el
       blind index `peer_hash` (src/crypto/peer-index.js): O(log n), sin
       descifrar nada. updateCallPeer recibe (cifrado, hash, owner, id) — con
       PK (owner, id) el mismo id vive en DOS filas (una por extremo), así
       que sin el owner el UPDATE pisaría el registro ajeno. */
    listCallsByPeerHash: db.prepare('SELECT id, owner, peer, data FROM calls WHERE peer_hash = ?'),
    deleteCallsByPeerHash: db.prepare('DELETE FROM calls WHERE peer_hash = ?'),
    updateCallPeer: db.prepare('UPDATE calls SET peer = ?, peer_hash = ? WHERE id = ? AND owner = ?'),
    listCalls: db.prepare('SELECT * FROM calls WHERE owner = ? ORDER BY ts DESC LIMIT ?'),
    trimCalls: db.prepare(`DELETE FROM calls WHERE owner = ? AND id NOT IN (
        SELECT id FROM calls WHERE owner = ? ORDER BY ts DESC LIMIT ?)`),

    /* Sin tabla de sesiones (v10): los tokens van firmados y su validez se
       decide con el checksum de `src/auth/rid.js` contra el rid de
       `user_rid` (getRid/upsertRid, más arriba). */

    // Push
    listPushSubs: db.prepare('SELECT user_id, endpoint, data FROM push_subs'),
    insertPushSub: db.prepare('INSERT OR REPLACE INTO push_subs (user_id, endpoint, data) VALUES (?, ?, ?)'),
    /* El endpoint (URL con el token del push) va cifrado: el borrado se hace
       por rowid tras descifrar y comparar. */
    listPushSubsByUser: db.prepare('SELECT rowid, endpoint, data FROM push_subs WHERE user_id = ?'),
    deletePushSubByRowid: db.prepare('DELETE FROM push_subs WHERE rowid = ?'),
    /* El recorte conserva las 5 más recientes por rowid: no se puede filtrar
       por `endpoint` porque el cifrado no es determinista (IV aleatorio). */
    trimPushSubs: db.prepare(`DELETE FROM push_subs WHERE user_id = ? AND rowid NOT IN (
        SELECT rowid FROM push_subs WHERE user_id = ? ORDER BY rowid DESC LIMIT 5)`),


    // Meta
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
}

/* Borra el resumen de un grupo para un miembro. Vive aquí (y no en el módulo
 * de grupos) para que las sentencias preparadas no dependan de él: los módulos
 * se necesitan entre sí y una dependencia cruzada los deja en un ciclo. */
function deleteGroupSummary(owner, gid) {
    Stmt.deleteGroupSummary.run(owner, gid);
}

module.exports = {
    Stmt,
    deleteGroupSummary
};

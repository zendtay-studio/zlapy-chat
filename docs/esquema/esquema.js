/* Esquema 2D de la base de datos de Zlapy (v3).
 *
 * Los datos están transcritos de src/db/schema.js (única fuente de verdad) y
 * los recuentos de filas son una instantánea de data/zlapy.db + data/blob.db
 * (tomada el 23 oct 2026, tras la tanda de seguridad).
 * Tras la ronda de remediación (23 oct 2026) el ESQUEMA SIGUE SIENDO v3: los
 * arreglos de la auditoría fueron de aplicación (límites, permisos, políticas
 * de grupo, anti-replay del canal), ninguno añadió tablas, columnas ni
 * índices. Las notas de algunas tablas mencionan topes que aplica el código
 * en tiempo de ejecución para que no se confundan con el DDL.
 * Las relaciones no declaradas como FK (chat codificado, nombres, hashes) se
 * dibujan aparte y se pueden ocultar con el interruptor "lógicas".
 */
'use strict';

/* ---------------- constantes de maquetación ---------------- */

const HEAD_H = 34;
const ROW_H = 22;
const PAD_B = 8;
const CARD_W = 320;
const TOP = 40;
const LEFT = 40;
const COL_GAP = 110;
const VGAP = 24;

const GROUPS = {
    identidad:  { label: 'Identidad y sesiones', color: '#4a9eff' },
    perfil:     { label: 'Perfil y preferencias', color: '#a78bfa' },
    social:     { label: 'Grafo social', color: '#34d399' },
    grupos:     { label: 'Grupos', color: '#f59e0b' },
    mensajeria: { label: 'Mensajería y adjuntos', color: '#f472b6' },
    infra:      { label: 'Infraestructura', color: '#94a3b8' }
};

const TYPE_SHORT = { TEXT: 'TEXT', INTEGER: 'INT', REAL: 'REAL', OBJECT: 'OBJ' };

/* ---------------- helpers de definición ---------------- */

// c(nombre, tipo, flags, nota). flags: p=PK, f=FK, n=NOT NULL, u=UNIQUE
const c = (n, t, f = '', note = '') => ({ n, t, f, note });
// r(columnas origen, tabla destino, columnas destino, ON DELETE)
const r = (cols, to, tcols, on = 'CASCADE') => ({ cols, to, tcols, on });

/* ---------------- tablas ---------------- */

const TABLES = [

    /* ============ A · perfil y preferencias ============ */

    {
        name: 'user_profiles', db: 'zlapy', group: 'perfil', rows: 17, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pf'),
            c('display_name', 'TEXT', 'n', "DEFAULT ''"),
            c('avatar', 'TEXT', 'n', "DEFAULT ''"),
            c('bio', 'TEXT', 'n', "DEFAULT ''"),
            c('note', 'TEXT', 'n', "DEFAULT ''"),
            c('note_ts', 'INTEGER', 'n', 'DEFAULT 0'),
            c('updated_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },
    {
        name: 'user_chat_settings', db: 'zlapy', group: 'perfil', rows: 10, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pf'),
            c('wall', 'TEXT'),
            c('opacity', 'REAL', 'n', 'DEFAULT 30'),
            c('blur', 'REAL', 'n', 'DEFAULT 0'),
            c('sender', 'TEXT'),
            c('receiver', 'TEXT'),
            c('sender_text', 'TEXT'),
            c('receiver_text', 'TEXT'),
            c('font_size', 'REAL', 'n', 'DEFAULT 15'),
            c('auto_text', 'INTEGER', 'n', 'DEFAULT 1 · CHECK 0|1'),
            c('wallpaper', 'TEXT', 'n', "DEFAULT ''"),
            c('updated_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },
    {
        name: 'user_privacy', db: 'zlapy', group: 'perfil', rows: 119, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pnf'),
            c('feature', 'TEXT', 'pn', "CHECK foto|nota|descripcion|historias|llamadas|mensajes|compartir"),
            c('mode', 'TEXT', 'n', 'CHECK server|contacts|nobody|except|only')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },
    {
        name: 'user_privacy_users', db: 'zlapy', group: 'perfil', rows: 0, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pnf'),
            c('feature', 'TEXT', 'pn'),
            c('position', 'INTEGER', 'pn'),
            c('target_id', 'TEXT', 'f', 'nullable · FK users'),
            c('target_name', 'TEXT', 'n', 'reserva si la cuenta ya no existe')
        ],
        refs: [
            r(['user_id', 'feature'], 'user_privacy', ['user_id', 'feature']),
            r(['target_id'], 'users', ['id'])
        ],
        idx: ['idx_upu_target']
    },
    {
        name: 'user_notes', db: 'zlapy', group: 'perfil', rows: 0, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pf'),
            c('data', 'TEXT'),
            c('ts', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },
    {
        name: 'user_stickers', db: 'zlapy', group: 'perfil', rows: 38, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pnf'),
            c('position', 'INTEGER', 'pn'),
            c('sticker', 'TEXT', 'n')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },
    {
        name: 'user_muted_peers', db: 'zlapy', group: 'perfil', rows: 1, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pnf'),
            c('peer_id', 'TEXT', 'f', 'nullable · FK users'),
            c('peer_name', 'TEXT', 'pn', 'nombre estable del chat silenciado')
        ],
        refs: [
            r(['user_id'], 'users', ['id']),
            r(['peer_id'], 'users', ['id'])
        ],
        idx: ['idx_ump_peer']
    },
    {
        name: 'user_chat_prefs', db: 'zlapy', group: 'perfil', rows: 1, col: 0,
        cols: [
            c('user_id', 'TEXT', 'pnf'),
            c('peer_key', 'TEXT', 'pn', "'dm:<usuario>' | 'group:<id>' | 'saved'"),
            c('pinned_at', 'INTEGER', 'n', 'DEFAULT 0'),
            c('unread', 'INTEGER', 'n', 'DEFAULT 0 · CHECK 0|1'),
            c('archived', 'INTEGER', 'n', 'DEFAULT 0 · CHECK 0|1'),
            c('updated_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },

    /* ============ B · identidad y grafo social ============ */

    {
        name: 'users', db: 'zlapy', group: 'identidad', rows: 17, col: 1,
        cols: [
            c('id', 'TEXT', 'p', 'UUID v4 en minúsculas'),
            c('username', 'TEXT', 'nu', 'UNIQUE · COLLATE NOCASE'),
            c('password_hash', 'TEXT', 'n', 'scrypt'),
            c('password_salt', 'TEXT', 'n'),
            c('add_policy', 'TEXT', 'n', "DEFAULT 'request' · CHECK all|request|nobody"),
            c('created_at', 'INTEGER', 'n', 'DEFAULT 0 · epoch ms'),
            c('last_seen', 'INTEGER')
        ],
        refs: [],
        idx: []
    },
    {
        name: 'sessions', db: 'zlapy', group: 'identidad', rows: 306, col: 1,
        cols: [
            c('token_hash', 'TEXT', 'p'),
            c('user_id', 'TEXT', 'nf'),
            c('expires_at', 'INTEGER', 'n', 'epoch ms')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: ['idx_sessions_user', 'idx_sessions_exp'],
        note: 'Tope de aplicación: 20 sesiones activas por cuenta (MAX_SESSIONS_PER_USER); al iniciar sesión las más antiguas se borran.'
    },
    {
        name: 'user_auth_keys', db: 'zlapy', group: 'identidad', rows: 12, col: 1,
        cols: [
            c('user_id', 'TEXT', 'pf'),
            c('auth_key', 'TEXT', 'n', '2048 bits · MTProto 2.0'),
            c('key_id', 'TEXT', 'n'),
            c('salt', 'INTEGER', 'n', 'DEFAULT 0 · rota cada 30 min'),
            c('session_id', 'INTEGER', 'n', 'DEFAULT 0'),
            c('last_msg_id', 'TEXT', 'n', "DEFAULT '0'"),
            c('created_at', 'INTEGER', 'n', 'DEFAULT 0'),
            c('updated_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },
    {
        name: 'user_keys', db: 'zlapy', group: 'identidad', rows: 0, col: 1,
        cols: [
            c('user_id', 'TEXT', 'pf'),
            c('key_cipher', 'TEXT', 'n', 'AES-256-GCM en reposo'),
            c('updated_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: []
    },
    {
        name: 'summaries', db: 'zlapy', group: 'social', rows: 18, col: 1,
        cols: [
            c('owner', 'TEXT', 'pnf'),
            c('peer', 'TEXT', 'pnf'),
            c('unread', 'INTEGER', 'n', 'DEFAULT 0'),
            c('last_data', 'TEXT', 'cifrado')
        ],
        refs: [
            r(['owner'], 'users', ['id']),
            r(['peer'], 'users', ['id'])
        ],
        idx: ['idx_summaries_peer'],
        note: 'Resumen de cada chat 1:1, uno por sentido.'
    },
    {
        name: 'contacts', db: 'zlapy', group: 'social', rows: 16, col: 1,
        cols: [
            c('owner', 'TEXT', 'pnf'),
            c('contact', 'TEXT', 'pnf')
        ],
        refs: [
            r(['owner'], 'users', ['id']),
            r(['contact'], 'users', ['id'])
        ],
        idx: ['idx_contacts_contact'],
        note: 'Relación dirigida: A tiene a B, no al revés.'
    },
    {
        name: 'contact_requests', db: 'zlapy', group: 'social', rows: 0, col: 1,
        cols: [
            c('from_id', 'TEXT', 'pnf'),
            c('to_id', 'TEXT', 'pnf'),
            c('ts', 'INTEGER', 'n')
        ],
        refs: [
            r(['from_id'], 'users', ['id']),
            r(['to_id'], 'users', ['id'])
        ],
        idx: ['idx_creq_to']
    },
    {
        name: 'blocked', db: 'zlapy', group: 'social', rows: 0, col: 1,
        cols: [
            c('owner', 'TEXT', 'pnf'),
            c('target', 'TEXT', 'pnf')
        ],
        refs: [
            r(['owner'], 'users', ['id']),
            r(['target'], 'users', ['id'])
        ],
        idx: ['idx_blocked_target']
    },

    /* ============ C · grupos ============ */

    {
        name: 'groups', db: 'zlapy', group: 'grupos', rows: 9, col: 2,
        cols: [
            c('id', 'TEXT', 'p'),
            c('crypto_id', 'TEXT', 'n', 'identificador E2E del grupo'),
            c('name', 'TEXT', 'n'),
            c('description', 'TEXT', 'n', "DEFAULT ''"),
            c('avatar', 'TEXT', 'n', "DEFAULT ''"),
            c('owner_id', 'TEXT', 'f', 'nullable · FK users · ON DELETE SET NULL'),
            c('visibility', 'TEXT', 'n', "DEFAULT 'private' · CHECK public|private"),
            c('join_policy', 'TEXT', 'n', "DEFAULT 'request' · CHECK open|request|closed"),
            c('write_policy', 'TEXT', 'n', "DEFAULT 'all' · CHECK all|admins"),
            c('add_policy', 'TEXT', 'n', "DEFAULT 'admins' · CHECK all|admins"),
            c('edit_policy', 'TEXT', 'n', "DEFAULT 'admins' · CHECK all|admins"),
            c('mention_all_policy', 'TEXT', 'n', "DEFAULT 'admins' · CHECK all|admins"),
            c('content_policy', 'TEXT', 'n', "DEFAULT '{}' · JSON"),
            c('invite_code', 'TEXT', 'n'),
            c('keys_cipher', 'TEXT', 'cifrado con la llave maestra'),
            c('created_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['owner_id'], 'users', ['id'], 'SET NULL')],
        idx: ['idx_groups_visibility', 'idx_groups_owner'],
        note: 'El propietario es ON DELETE SET NULL: el grupo sobrevive a la cuenta.'
    },
    {
        name: 'group_members', db: 'zlapy', group: 'grupos', rows: 15, col: 2,
        cols: [
            c('gid', 'TEXT', 'pnf'),
            c('user_id', 'TEXT', 'pnf'),
            c('role', 'TEXT', 'n', "DEFAULT 'member' · CHECK admin|member"),
            c('joined_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [
            r(['gid'], 'groups', ['id']),
            r(['user_id'], 'users', ['id'])
        ],
        idx: ['idx_gm_user']
    },
    {
        name: 'group_join_requests', db: 'zlapy', group: 'grupos', rows: 3, col: 2,
        cols: [
            c('gid', 'TEXT', 'pnf'),
            c('user_id', 'TEXT', 'pnf'),
            c('username', 'TEXT', 'n', 'desnormalizado para mostrar la solicitud'),
            c('ts', 'INTEGER', 'n')
        ],
        refs: [
            r(['gid'], 'groups', ['id']),
            r(['user_id'], 'users', ['id'])
        ],
        idx: ['idx_gjr_user']
    },
    {
        name: 'group_summaries', db: 'zlapy', group: 'grupos', rows: 15, col: 2,
        cols: [
            c('owner', 'TEXT', 'pnf'),
            c('gid', 'TEXT', 'pnf'),
            c('unread', 'INTEGER', 'n', 'DEFAULT 0'),
            c('last_data', 'TEXT', 'cifrado')
        ],
        refs: [
            r(['owner'], 'users', ['id']),
            r(['gid'], 'groups', ['id'])
        ],
        idx: ['idx_gs_gid']
    },
    {
        name: 'user_group_seen', db: 'zlapy', group: 'grupos', rows: 6, col: 2,
        cols: [
            c('user_id', 'TEXT', 'pnf'),
            c('gid', 'TEXT', 'pnf'),
            c('ts', 'INTEGER', 'n')
        ],
        refs: [
            r(['user_id'], 'users', ['id']),
            r(['gid'], 'groups', ['id'])
        ],
        idx: ['idx_ugs_gid']
    },

    /* ============ D · mensajería y adjuntos ============ */

    {
        name: 'messages', db: 'zlapy', group: 'mensajeria', rows: 430, col: 3,
        cols: [
            c('id', 'TEXT', 'p'),
            c('chat', 'TEXT', 'n', "'chat:<a>__<b>' | 'group:<gid>' · sin FK"),
            c('ts', 'INTEGER', 'n', 'epoch ms'),
            c('from_id', 'TEXT', 'nf'),
            c('to_id', 'TEXT', 'f', 'nullable · nulo en grupos'),
            c('kind', 'TEXT', 'n', 'text|image|audio|file|sticker|poll|seen|contact'),
            c('data', 'TEXT', 'n', 'cifrado'),
            c('hash', 'TEXT', 'hash del blob adjunto'),
            c('once', 'INTEGER', 'n', 'DEFAULT 0 · CHECK 0|1'),
            c('edited', 'INTEGER', 'n', 'DEFAULT 0 · CHECK 0|1'),
            c('crypto_version', 'INTEGER', 'n', 'DEFAULT 2'),
            c('crypto_group_id', 'TEXT', 'grupo E2E, si aplica'),
            c('signature', 'TEXT', 'Ed25519'),
            c('signing_public_key', 'TEXT')
        ],
        refs: [
            r(['from_id'], 'users', ['id']),
            r(['to_id'], 'users', ['id'])
        ],
        idx: ['idx_messages_chat_ts', 'idx_messages_to', 'idx_messages_from'],
        note: 'El destino va codificado en `chat`; por eso no puede ser una FK. Los medios enviados EN LÍNEA (sin hash) están limitados a 256 KiB por la aplicación; el flujo normal sube blob y guarda el hash, que no cuenta para esa cota.'
    },
    {
        name: 'message_deletions', db: 'zlapy', group: 'mensajeria', rows: 2, col: 3,
        cols: [
            c('message_id', 'TEXT', 'pnf'),
            c('user_id', 'TEXT', 'pnf'),
            c('deleted_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [
            r(['message_id'], 'messages', ['id']),
            r(['user_id'], 'users', ['id'])
        ],
        idx: ['idx_mdel_user'],
        note: 'Borrado "para mí": el otro interlocutor conserva su copia.'
    },
    {
        name: 'chat_deletions', db: 'zlapy', group: 'mensajeria', rows: 1, col: 3,
        cols: [
            c('chat', 'TEXT', 'pn'),
            c('user_id', 'TEXT', 'pnf'),
            c('deleted_at', 'INTEGER', 'n', 'DEFAULT 0')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: ['idx_cdel_user']
    },
    {
        name: 'blob_access', db: 'zlapy', group: 'mensajeria', rows: 47, col: 3,
        cols: [
            c('hash', 'TEXT', 'pn', 'apunta a blobs.hash'),
            c('message_id', 'TEXT', 'pn', "id de mensaje o 'story:<user>:<ts>'"),
            c('kind', 'TEXT', 'n', 'CHECK chat|group|story'),
            c('chat_a', 'TEXT', 'f', 'nullable · DM'),
            c('chat_b', 'TEXT', 'f', 'nullable · DM'),
            c('gid', 'TEXT', 'f', 'nullable · grupo'),
            c('story_user', 'TEXT', 'f', 'nullable · historia')
        ],
        refs: [
            r(['chat_a'], 'users', ['id']),
            r(['chat_b'], 'users', ['id']),
            r(['gid'], 'groups', ['id']),
            r(['story_user'], 'users', ['id'])
        ],
        idx: ['idx_ba_hash', 'idx_ba_message', 'idx_ba_group', 'idx_ba_story', 'idx_ba_chat_a', 'idx_ba_chat_b'],
        note: 'Permiso de descarga: dice quién puede pedir cada blob.'
    },
    {
        name: 'blob_access_members', db: 'zlapy', group: 'mensajeria', rows: 0, col: 3,
        cols: [
            c('hash', 'TEXT', 'pn', 'apunta a blobs.hash'),
            c('user_id', 'TEXT', 'pnf', 'miembro con acceso al publicarse'),
            c('message_id', 'TEXT', 'nf', 'mensaje de grupo')
        ],
        refs: [
            r(['user_id'], 'users', ['id']),
            r(['message_id'], 'messages', ['id'])
        ],
        idx: ['idx_bam_message', 'idx_bam_user'],
        note: "Foto de los miembros del MOMENTO de publicar: entrar en un grupo público después no da acceso a los adjuntos anteriores (V-04). En bases v3 nació sin FK; el barrido periódico limpia las filas que pierden su mensaje."
    },
    {
        name: 'stories', db: 'zlapy', group: 'mensajeria', rows: 3, col: 3,
        cols: [
            c('from_id', 'TEXT', 'pnf'),
            c('ts', 'INTEGER', 'pn'),
            c('data', 'TEXT', 'n', 'cifrado'),
            c('hash', 'TEXT', 'hash del blob')
        ],
        refs: [r(['from_id'], 'users', ['id'])],
        idx: ['idx_stories_ts'],
        note: 'Caducan por ts; deleteExpiredStories las purga. El medio publicado en línea (sin hash) tiene tope de 4 MB en la aplicación.'
    },
    {
        name: 'calls', db: 'zlapy', group: 'mensajeria', rows: 27, col: 3,
        cols: [
            c('id', 'TEXT', 'p'),
            c('owner', 'TEXT', 'nf'),
            c('peer', 'TEXT', 'nombre, no id: sobrevive al borrado'),
            c('ts', 'INTEGER', 'n'),
            c('data', 'TEXT')
        ],
        refs: [r(['owner'], 'users', ['id'])],
        idx: ['idx_calls_owner_ts', 'idx_calls_peer']
    },
    {
        name: 'push_subs', db: 'zlapy', group: 'mensajeria', rows: 2, col: 3,
        cols: [
            c('user_id', 'TEXT', 'pnf'),
            c('endpoint', 'TEXT', 'pn'),
            c('data', 'TEXT', 'n', 'suscripción Web Push cifrada')
        ],
        refs: [r(['user_id'], 'users', ['id'])],
        idx: [],
        note: 'Máximo 5 endpoints por usuario (trimPushSubs).'
    },

    /* ============ E · infraestructura ============ */

    {
        name: 'meta', db: 'zlapy', group: 'infra', rows: 4, col: 4,
        cols: [
            c('key', 'TEXT', 'p', 'crypto_version · migrated_at · schema_version · vapid'),
            c('value', 'TEXT')
        ],
        refs: [],
        idx: [],
        note: 'Metadatos del servidor y guarda de compatibilidad del cifrado.'
    },
    {
        name: 'blobs', db: 'blob', group: 'infra', rows: 41, col: 4,
        cols: [
            c('hash', 'TEXT', 'p', 'SHA-256 del contenido'),
            c('data', 'TEXT', 'n', 'AES-256-GCM')
        ],
        refs: [],
        idx: [],
        note: 'Vive en data/blob.db, una base SQLite separada.'
    },
    {
        name: 'vapid.json', db: 'file', group: 'infra', rows: 1, col: 4, file: true,
        cols: [
            c('publicKey', 'TEXT', 'clave pública VAPID (Base64URL)'),
            c('jwk', 'OBJECT', 'par EC P-256, incluye la clave privada')
        ],
        refs: [],
        idx: [],
        note: 'No es SQLite: es un archivo JSON en data/. No se muestran sus valores.'
    }
];

/* Relaciones que no son claves ajenas (el esquema las codifica en texto). */
const LOGICAL = [
    { from: 'messages', fromCol: 'chat', to: 'groups', toCol: 'id', label: "chat = 'group:<gid>'" },
    { from: 'messages', fromCol: 'chat', to: 'users', toCol: 'id', label: "chat = 'chat:<a>__<b>'" },
    { from: 'messages', fromCol: 'crypto_group_id', to: 'groups', toCol: 'crypto_id', label: 'grupo E2E' },
    { from: 'blob_access', fromCol: 'message_id', to: 'messages', toCol: 'id', label: 'message_id o story:<u>:<ts>' },
    { from: 'blob_access', fromCol: 'hash', to: 'blobs', toCol: 'hash', label: 'contenido del adjunto' },
    { from: 'blob_access_members', fromCol: 'hash', to: 'blobs', toCol: 'hash', label: 'contenido del adjunto' },
    { from: 'messages', fromCol: 'hash', to: 'blobs', toCol: 'hash', label: 'adjunto' },
    { from: 'stories', fromCol: 'hash', to: 'blobs', toCol: 'hash', label: 'adjunto' },
    { from: 'calls', fromCol: 'peer', to: 'users', toCol: 'username', label: 'por nombre' },
    { from: 'user_muted_peers', fromCol: 'peer_name', to: 'users', toCol: 'username', label: 'por nombre' },
    { from: 'group_join_requests', fromCol: 'username', to: 'users', toCol: 'username', label: 'desnormalizado' },
    { from: 'user_chat_prefs', fromCol: 'peer_key', to: 'users', toCol: 'id', label: "'dm:<usuario>'" }
];

/* ---------------- disposición en columnas ---------------- */

const COLUMNS = [
    ['user_profiles', 'user_chat_settings', 'user_privacy', 'user_privacy_users',
        'user_notes', 'user_stickers', 'user_muted_peers', 'user_chat_prefs'],
    ['users', 'sessions', 'user_auth_keys', 'user_keys', 'summaries',
        'contacts', 'contact_requests', 'blocked'],
    ['groups', 'group_members', 'group_join_requests', 'group_summaries', 'user_group_seen'],
    ['messages', 'message_deletions', 'chat_deletions', 'blob_access', 'blob_access_members', 'stories', 'calls', 'push_subs'],
    ['meta', 'blobs', 'vapid.json']
];

/* ---------------- estado ---------------- */

const state = {
    focus: null,
    query: '',
    logical: true,
    zoom: 1
};

const byName = Object.create(null);
let edgeList = [];
let canvasW = 0;
let canvasH = 0;

/* ---------------- utilidades ---------------- */

const $ = sel => document.querySelector(sel);

function esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function colIndex(table, name) {
    if (!table) return 0;
    const i = table.cols.findIndex(col => col.n === name);
    return i < 0 ? 0 : i;
}

function tableHeight(t) {
    return HEAD_H + t.cols.length * ROW_H + PAD_B;
}

/* ---------------- construcción de aristas ---------------- */

function buildEdges() {
    const edges = [];
    for (const t of TABLES) {
        for (const ref of (t.refs || [])) {
            edges.push({
                from: t.name,
                fromCol: ref.cols[0],
                to: ref.to,
                toCol: ref.tcols[0],
                on: ref.on,
                logical: false,
                label: `${ref.cols.join(', ')} → ${ref.to}.${ref.tcols.join(', ')}`
            });
        }
    }
    for (const l of LOGICAL) {
        edges.push({
            from: l.from,
            fromCol: l.fromCol,
            to: l.to,
            toCol: l.toCol,
            on: 'LOGICAL',
            logical: true,
            label: l.label
        });
    }
    return edges;
}

/* ---------------- maquetación ---------------- */

function layout() {
    for (const t of TABLES) byName[t.name] = t;

    COLUMNS.forEach((names, ci) => {
        let y = TOP;
        const x = LEFT + ci * (CARD_W + COL_GAP);
        for (const name of names) {
            const t = byName[name];
            if (!t) continue;
            t.x = x;
            t.y = y;
            t.h = tableHeight(t);
            y += t.h + VGAP;
        }
    });

    canvasW = LEFT + COLUMNS.length * (CARD_W + COL_GAP) - COL_GAP + LEFT;
    canvasH = Math.max(...TABLES.map(t => t.y + t.h)) + TOP;
}

/* ---------------- render ---------------- */

function rowHTML(t, col) {
    const f = col.f || '';
    const chips = [];
    if (f.includes('p')) chips.push('<i class="k pk">PK</i>');
    if (f.includes('f')) chips.push('<i class="k fk">FK</i>');
    if (f.includes('u')) chips.push('<i class="k uq">UQ</i>');

    const details = [
        `${t.name}.${col.n}`,
        col.t,
        f.includes('n') ? 'NOT NULL' : 'NULL',
        col.note
    ].filter(Boolean).join(' · ');

    return `<div class="row" data-col="${esc(col.n)}" title="${esc(details)}">` +
        `<span class="cn">${esc(col.n)}</span>` +
        `<span class="ct">${TYPE_SHORT[col.t] || esc(col.t)}</span>` +
        `<span class="ck">${chips.join('')}</span>` +
        `</div>`;
}

function renderCards() {
    const host = $('#cards');
    host.innerHTML = '';

    for (const t of TABLES) {
        const el = document.createElement('article');
        el.className = 'card';
        el.dataset.table = t.name;
        el.style.left = t.x + 'px';
        el.style.top = t.y + 'px';
        el.style.setProperty('--g', GROUPS[t.group].color);

        const idx = t.idx && t.idx.length ? `Índices: ${t.idx.join(', ')}` : 'Sin índices propios';
        const tip = [
            `${t.name} · ${t.rows} fila${t.rows === 1 ? '' : 's'}`,
            t.db === 'blob' ? 'data/blob.db' : t.db === 'file' ? 'data/vapid.json' : 'data/zlapy.db',
            idx,
            t.note || ''
        ].filter(Boolean).join('\n');

        el.title = tip;
        el.innerHTML =
            `<header>` +
            `<span class="dot"></span>` +
            `<h2>${esc(t.name)}</h2>` +
            `<span class="rows${t.rows === 0 ? ' zero' : ''}">${t.rows}</span>` +
            `</header>` +
            t.cols.map(col => rowHTML(t, col)).join('');

        el.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleFocus(t.name);
        });

        host.appendChild(el);
        t.el = el;
    }
}

function renderRegions() {
    const host = $('#regions');
    host.innerHTML = '';

    const blob = byName['blobs'];
    const vapid = byName['vapid.json'];

    if (blob) {
        const region = document.createElement('div');
        region.className = 'region';
        region.style.left = (blob.x - 14) + 'px';
        region.style.top = (blob.y - 28) + 'px';
        region.style.width = (CARD_W + 28) + 'px';
        region.style.height = (blob.h + 42) + 'px';
        region.innerHTML = '<span>data/blob.db · base separada</span>';
        host.appendChild(region);
    }

    if (vapid) {
        const region = document.createElement('div');
        region.className = 'region file';
        region.style.left = (vapid.x - 14) + 'px';
        region.style.top = (vapid.y - 28) + 'px';
        region.style.width = (CARD_W + 28) + 'px';
        region.style.height = (vapid.h + 42) + 'px';
        region.innerHTML = '<span>data/vapid.json · no sqlite</span>';
        host.appendChild(region);
    }
}

function anchor(t, colName, side) {
    const i = colIndex(t, colName);
    return {
        x: side === 'R' ? t.x + CARD_W : t.x,
        y: t.y + HEAD_H + i * ROW_H + ROW_H / 2
    };
}

function renderEdges() {
    const svg = $('#edges');
    svg.setAttribute('width', canvasW);
    svg.setAttribute('height', canvasH);
    svg.setAttribute('viewBox', `0 0 ${canvasW} ${canvasH}`);

    // Conserva <defs> y limpia solo los paths anteriores.
    svg.querySelectorAll('path.edge').forEach(p => p.remove());

    edgeList = [];

    for (const e of edgeListSource) {
        const a = byName[e.from];
        const b = byName[e.to];
        if (!a || !b) continue;

        const rightward = b.x >= a.x;
        const p1 = anchor(a, e.fromCol, rightward ? 'R' : 'L');
        const p2 = anchor(b, e.toCol, rightward ? 'L' : 'R');

        const dx = Math.max(46, Math.abs(p2.x - p1.x) * 0.42);
        const c1 = rightward ? p1.x + dx : p1.x - dx;
        const c2 = rightward ? p2.x - dx : p2.x + dx;
        const d = `M${p1.x},${p1.y} C${c1},${p1.y} ${c2},${p2.y} ${p2.x},${p2.y}`;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', 'edge ' + (e.logical ? 'logical' : e.on === 'SET NULL' ? 'setnull' : 'cascade'));
        path.setAttribute('marker-end', 'url(#ar-cascade)');
        path.dataset.from = e.from;
        path.dataset.to = e.to;
        path.dataset.logical = e.logical ? '1' : '0';
        path.dataset.fromCol = e.fromCol;
        path.dataset.toCol = e.toCol;

        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = `${e.from}.${e.fromCol} → ${e.to}.${e.toCol}` + (e.logical ? ' (lógica)' : '');
        path.appendChild(title);

        svg.appendChild(path);
        edgeList.push(path);
    }
}

/* ---------------- interacción ---------------- */

function toggleFocus(name) {
    state.focus = state.focus === name ? null : name;
    applyStates();
}

function applyStates() {
    const f = state.focus;
    const neighbors = new Set();

    if (f) {
        neighbors.add(f);
        for (const e of edgeListSource) {
            if (e.from === f) neighbors.add(e.to);
            if (e.to === f) neighbors.add(e.from);
        }
    }

    for (const t of TABLES) {
        const el = t.el;
        if (!el) continue;
        el.classList.toggle('focused', t.name === f);
        el.classList.toggle('neighbor', !!f && neighbors.has(t.name) && t.name !== f);
        el.classList.toggle('muted', !!f && !neighbors.has(t.name));
    }

    for (const p of edgeList) {
        const hot = !!f && (p.dataset.from === f || p.dataset.to === f);
        p.classList.toggle('hot', hot);
        p.classList.toggle('muted', !!f && !hot);
        p.classList.toggle('hidden', !state.logical && p.dataset.logical === '1');
    }

    // Resalta las filas concretas que participan en una arista del foco.
    for (const t of TABLES) {
        if (!t.el) continue;
        t.el.querySelectorAll('.row.hot').forEach(row => row.classList.remove('hot'));
    }

    if (f) {
        for (const p of edgeList) {
            if (!p.classList.contains('hot')) continue;
            const paint = (tableName, colName) => {
                const t = byName[tableName];
                if (!t || !t.el) return;
                const row = t.el.querySelector(`.row[data-col="${CSS.escape(colName)}"]`);
                if (row) row.classList.add('hot');
            };
            paint(p.dataset.from, p.dataset.fromCol);
            paint(p.dataset.to, p.dataset.toCol);
        }
    }
}

function applySearch() {
    const q = state.query.trim().toLowerCase();

    for (const t of TABLES) {
        if (!t.el) continue;
        const match = !q ||
            t.name.toLowerCase().includes(q) ||
            t.cols.some(col => col.n.toLowerCase().includes(q));
        t.el.classList.toggle('search-dim', !!q && !match);
        t.el.classList.toggle('hit', !!q && match);
    }

    for (const p of edgeList) {
        const a = byName[p.dataset.from];
        const b = byName[p.dataset.to];
        const hidden = !!q && (!a || !b ||
            a.el.classList.contains('search-dim') ||
            b.el.classList.contains('search-dim'));
        p.classList.toggle('hidden', hidden || (!state.logical && p.dataset.logical === '1'));
    }
}

function setZoom(scale) {
    state.zoom = Math.max(0.3, Math.min(1.6, scale));
    const canvas = $('#canvas');
    const sizer = $('#sizer');

    canvas.style.transform = `scale(${state.zoom})`;
    sizer.style.width = (canvasW * state.zoom) + 'px';
    sizer.style.height = (canvasH * state.zoom) + 'px';

    $('#zlabel').textContent = Math.round(state.zoom * 100) + '%';
}

function fit() {
    const vp = $('#viewport');
    const scale = Math.min(
        (vp.clientWidth - 40) / canvasW,
        (vp.clientHeight - 40) / canvasH,
        1
    );
    setZoom(scale);
    vp.scrollLeft = 0;
    vp.scrollTop = 0;
}

/* ---------------- estadísticas y leyenda ---------------- */

function renderStats() {
    const sqlite = TABLES.filter(t => t.db !== 'file');
    const columns = TABLES.reduce((n, t) => n + t.cols.length, 0);
    const fks = TABLES.reduce((n, t) => n + (t.refs ? t.refs.length : 0), 0);
    const indexes = TABLES.reduce((n, t) => n + (t.idx ? t.idx.length : 0), 0);
    const rows = TABLES.reduce((n, t) => n + (t.db === 'file' ? 0 : t.rows), 0);

    const item = (value, label) => `<span><b>${value}</b> ${label}</span>`;

    $('#stats').innerHTML = [
        item(sqlite.length, 'tablas'),
        item(columns, 'columnas'),
        item(fks, 'FK'),
        item(indexes, 'índices'),
        item(rows.toLocaleString('es-ES'), 'filas')
    ].join('<span class="sep"></span>');
}

function renderLegend() {
    const host = $('#legend');

    const groupItems = Object.values(GROUPS)
        .map(g => `<span class="item"><i class="chip" style="--c:${g.color}"></i>${esc(g.label)}</span>`)
        .join('');

    host.innerHTML =
        `<span class="item"><i class="swatch"></i>ON DELETE CASCADE</span>` +
        `<span class="item"><i class="swatch setnull"></i>ON DELETE SET NULL</span>` +
        `<span class="item"><i class="swatch logical"></i>relación lógica (no FK)</span>` +
        `<span class="grow"></span>` +
        groupItems;
}

/* ---------------- arranque ---------------- */

const edgeListSource = buildEdges();

function init() {
    layout();

    const canvas = $('#canvas');
    canvas.style.width = canvasW + 'px';
    canvas.style.height = canvasH + 'px';

    renderCards();
    renderRegions();
    renderEdges();
    renderStats();
    renderLegend();

    // Búsqueda
    $('#search').addEventListener('input', ev => {
        state.query = ev.target.value;
        applySearch();
    });

    // Relaciones lógicas
    $('#tgl-logical').addEventListener('change', ev => {
        state.logical = ev.target.checked;
        applyStates();
        applySearch();
    });

    // Zoom
    $('#zin').addEventListener('click', () => setZoom(state.zoom + 0.1));
    $('#zout').addEventListener('click', () => setZoom(state.zoom - 0.1));
    $('#zlabel').addEventListener('click', () => setZoom(1));
    $('#zfit').addEventListener('click', fit);

    // Clic en el fondo: limpia el foco
    $('#viewport').addEventListener('click', ev => {
        if (ev.target.closest('.card')) return;
        if (state.focus) {
            state.focus = null;
            applyStates();
        }
    });

    // Arrastrar para desplazarse
    const vp = $('#viewport');
    let drag = null;

    vp.addEventListener('mousedown', ev => {
        if (ev.button !== 0 || ev.target.closest('.card')) return;
        drag = { x: ev.clientX, y: ev.clientY, left: vp.scrollLeft, top: vp.scrollTop };
        vp.classList.add('panning');
    });

    window.addEventListener('mousemove', ev => {
        if (!drag) return;
        vp.scrollLeft = drag.left - (ev.clientX - drag.x);
        vp.scrollTop = drag.top - (ev.clientY - drag.y);
    });

    window.addEventListener('mouseup', () => {
        drag = null;
        vp.classList.remove('panning');
    });

    // Teclado
    window.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') {
            state.focus = null;
            state.query = '';
            $('#search').value = '';
            applyStates();
            applySearch();
        }
    });

    // Ctrl/Cmd + rueda: zoom
    vp.addEventListener('wheel', ev => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        setZoom(state.zoom + (ev.deltaY < 0 ? 0.08 : -0.08));
    }, { passive: false });

    window.addEventListener('resize', () => { /* el zoom se mantiene */ });

    fit();
}

init();

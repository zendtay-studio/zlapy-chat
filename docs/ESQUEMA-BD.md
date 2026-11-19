# Esquema de bases de datos de Zlapy (v12)

Referencia del estado actual. La fuente de verdad del esquema principal es
`src/db/schema.js`; `src/db/database.js` abre las bases, aplica los PRAGMA y
crea la tabla de adjuntos. No se documentan aquí formatos históricos ni
contadores que puedan quedar obsoletos.

## 1. Almacenamiento y convenciones

| Aspecto | Estado vigente |
| --- | --- |
| Base principal | `data/zlapy.db` por defecto; configurable con `DATA_DIR` y `DB_NAME`. |
| Base de adjuntos | `data/zlapy-blob.db` por defecto; configurable con `BLOB_DB_NAME`. Si no se fija nombre y solo existe el `blob.db` heredado, se conserva ese archivo. |
| Versión | `SCHEMA_VERSION = 12`; `ensureSchema` la registra en `meta.schema_version`. |
| Motor | SQLite mediante `better-sqlite3`; las dos conexiones usan WAL. |
| Durabilidad | `synchronous = FULL` en ambas bases: cada commit espera sincronización durable. |
| Concurrencia | `busy_timeout = 15000` por defecto, configurable con `SQLITE_BUSY_TIMEOUT_MS`; claves ajenas activadas con `foreign_keys = ON`. |
| Identificadores | TEXT; las cuentas usan UUID y los grupos/mensajes sus propios identificadores. |
| Tiempos | INTEGER en milisegundos desde epoch, salvo valores opcionales NULL. |
| Booleanos | INTEGER 0/1, con `CHECK` donde lo declara el esquema. |
| Cifrado | El contenido de usuario usa sobres PCE3/PCE3A con su `auth_key`; el material de infraestructura y los blobs se cifran con la llave maestra. Véase `CRIPTOGRAFIA.md`. |
| Imágenes | `avatar_ref` y `wallpaper_ref` contienen hashes de blobs, no data-URL. La excepción es la miniatura push, guardada en `push_avatars.data`. |

`ensureSchema` ejecuta `applySchema` y después fija la versión. La aplicación es
idempotente: crea tablas e índices ausentes y realiza los `ALTER` o rebuild de
compatibilidad necesarios para dejar el resultado descrito aquí. Los backfills
que necesitan la llave maestra (`user_rid` y `calls.peer_hash`) se completan en
el arranque, no durante la apertura inicial del esquema.

## 2. Cuentas, claves y sesiones

### `users`

| Columna | Definición y uso |
| --- | --- |
| `id` | TEXT PRIMARY KEY; identidad estable de la cuenta. |
| `username` | TEXT NOT NULL UNIQUE COLLATE NOCASE; nombre de login sin duplicados por capitalización. |
| `password_hash`, `password_salt` | TEXT NOT NULL. Las cuentas actuales usan bcrypt con la sal dentro del hash y `password_salt = ''`; la sal separada solo sirve al formato scrypt heredado. |
| `add_policy` | `all`, `request` o `nobody`; por defecto `request`. |
| `created_at` | INTEGER NOT NULL DEFAULT 0. |
| `last_seen` | INTEGER NULL; marca temporal de la última desconexión usada por la presencia. |

### Datos uno-a-uno de la cuenta

| Tabla | Clave y columnas esenciales | FK y contenido |
| --- | --- | --- |
| `user_profiles` | PK `user_id`; `display_name`, `avatar_ref`, `bio`, `note`, `note_ts`, `updated_at` | `user_id → users.id` CASCADE. El avatar es una referencia a blob. |
| `user_keys` | PK `user_id`; `key_cipher`, `updated_at` | CASCADE; claves del dispositivo cifradas en reposo. |
| `user_auth_keys` | PK `user_id`; `auth_key`, `key_id`, `created_at`, `updated_at` | CASCADE. `auth_key` tiene 2048 bits y se guarda cifrada con la llave maestra; `key_id` son los primeros 64 bits del resumen SHA-1 (`subarray(0, 8)`), en 16 caracteres hex. Las fechas son NOT NULL DEFAULT 0. |
| `user_rid` | PK `user_id`; `rid`, `password_changed_at`, `logged_out_at` | CASCADE. Estado de revocación de tokens; las dos marcas temporales son NOT NULL DEFAULT 0. |
| `user_notes` | PK `user_id`; `data`, `ts` | CASCADE; nota/estado personal serializado en `data`. |
| `user_chat_settings` | PK `user_id`; apariencia y opciones de chat | CASCADE; una fila por cuenta. |

`user_profiles.note` y `user_notes` son datos distintos: la primera es la nota
breve del perfil; la segunda guarda el estado personal serializado. Sus marcas
`note_ts` y `ts` permiten aplicar la caducidad correspondiente sin compartir
columna ni clave primaria.

No existe tabla `sessions`. Los JWT se guardan únicamente en cookies y se
validan con firma, caducidad, checksum del estado de la cuenta y `user_rid`.
El checksum incorpora id, username, hash de contraseña y rid; las marcas de
`password_changed_at` y `logged_out_at` rechazan además tokens anteriores.

Columnas de `user_chat_settings`:

- `wall`, `opacity`, `blur` y `wallpaper_ref`: fondo, opacidad, desenfoque y hash
  del fondo personalizado.
- `sender`, `receiver`, `sender_text`, `receiver_text`, `accent` y `font_size`:
  colores y tipografía.
- `auto_text`: cálculo automático de contraste, 0/1.
- `keep_archived`: conserva un chat archivado al llegar actividad, 0/1.
- `always_push`: preferencia de notificaciones, 0/1.
- `updated_at`: última escritura.

## 3. Privacidad y lista de chats

| Tabla | Clave y columnas esenciales | Relaciones y reglas |
| --- | --- | --- |
| `user_privacy` | PK `(user_id, feature)`; `mode` | `user_id → users.id` CASCADE. `feature`: `foto`, `nota`, `descripcion`, `historias`, `llamadas`, `mensajes`, `compartir`, `online`, `lecturas`, `usuario`. `mode`: `server`, `contacts`, `nobody`, `except`, `only`. |
| `user_privacy_users` | PK `(user_id, feature, position)`; `target_id`, `target_name` | FK compuesta `(user_id, feature) → user_privacy` CASCADE; `target_id → users.id` CASCADE y puede ser NULL. El nombre queda como respaldo cuando no hay id resuelto. |
| `user_muted_peers` | PK `(user_id, peer_name)`; `peer_id` | Ambas referencias a `users.id` son CASCADE; `peer_id` admite NULL y `peer_name` también puede identificar un grupo por su clave textual. |
| `user_chat_prefs` | PK `(user_id, peer_key)`; `pinned_at`, `unread`, `archived`, `updated_at` | `user_id` CASCADE. `peer_key` es `dm:<usuario>`, `group:<gid>` o `saved`; no es FK. `unread` y `archived` usan 0/1; `pinned_at` guarda la marca temporal de fijado (0 si no está fijado). |

## 4. Contactos y relaciones sociales

| Tabla | PK | Otras columnas | FK CASCADE |
| --- | --- | --- | --- |
| `contacts` | `(owner, contact)` | — | `owner` y `contact` a `users.id`. |
| `contact_requests` | `(from_id, to_id)` | `ts` | Ambos extremos a `users.id`. |
| `blocked` | `(owner, target)` | — | Ambos extremos a `users.id`. |
| `summaries` | `(owner, peer)` | `unread`, `last_data` | Ambos extremos a `users.id`; resumen individual de un DM. |
| `user_group_seen` | `(user_id, gid)` | `ts` | Usuario a `users.id`, grupo a `groups.id`. |
| `group_summaries` | `(owner, gid)` | `unread`, `last_data` | Propietario a `users.id`, grupo a `groups.id`. |

Las relaciones no guardan una copia por dispositivo. Los resúmenes sí son por
cuenta: contienen sus no leídos y el último payload presentable.

## 5. Grupos

### `groups`

| Grupo de columnas | Definición |
| --- | --- |
| Identidad | `id` TEXT PK; `crypto_id` TEXT NOT NULL; `custom_id` TEXT NOT NULL DEFAULT ''. |
| Presentación | `name`, `description`, `avatar_ref`; el avatar referencia un blob. |
| Propiedad | `owner_id → users.id` ON DELETE SET NULL; la rutina de baja transfiere la propiedad cuando hay miembros supervivientes. |
| Acceso | `visibility`: `public`/`private`; `join_policy`: `open`/`request`/`closed`; `invite_code` NOT NULL. |
| Permisos | `write_policy`, `add_policy`, `edit_policy`, `mention_all_policy`, todos restringidos a `all`/`admins`. |
| Contenido | `content_policy` TEXT NOT NULL DEFAULT '{}', con la política serializada. |
| Cifrado y alta | `keys_cipher` TEXT NULL; `created_at` INTEGER NOT NULL DEFAULT 0. |

`custom_id` admite enlaces cortos y tiene unicidad parcial solo cuando no está
vacío. `crypto_id` es el identificador criptográfico; los mensajes usan `id` en
la clave `group:<gid>`.

Los valores por defecto son `visibility = 'private'`, `join_policy = 'request'`
y `write_policy = 'all'`; las políticas de agregar, editar y mencionar a todos
empiezan en `admins`. `description`, `avatar_ref` y `custom_id` empiezan vacíos.

| Tabla | Clave y columnas | Relaciones |
| --- | --- | --- |
| `group_members` | PK `(gid, user_id)`; `role`, `joined_at` | Ambas FK CASCADE. `role` es `admin` o `member`. |
| `group_join_requests` | PK `(gid, user_id)`; `username`, `ts` | Ambas FK CASCADE; username es etiqueta de respaldo. |

## 6. Mensajes y borrados por alcance

### `messages`

| Columna | Definición y uso |
| --- | --- |
| `id` | TEXT PRIMARY KEY. |
| `chat` | TEXT NOT NULL; `chat:<idA>__<idB>` con ids ordenados para DM o `group:<gid>`. No es FK porque el destino es polimórfico. |
| `ts` | INTEGER NOT NULL; orden temporal del mensaje. |
| `from_id`, `to_id` | FK a `users.id` CASCADE. El autor es obligatorio; el destinatario puede ser NULL en grupos. |
| `kind`, `data` | TEXT NOT NULL; tipo y payload cifrado. |
| `hash` | TEXT NULL; hash del adjunto principal. |
| `once`, `edited` | INTEGER NOT NULL DEFAULT 0, CHECK 0/1. |
| `played_at` | INTEGER NULL; reproducción de una nota de voz, independiente de los acuses de lectura. |
| `crypto_version` | INTEGER NOT NULL DEFAULT 3; formato de cifrado por fila vigente. |
| `crypto_group_id` | TEXT NULL; contexto criptográfico de grupo. |
| `signature`, `signing_public_key` | TEXT NULL; firma y clave pública que permite verificar el mensaje conservado. |

No hay una columna `status`: el estado de entrega/lectura forma parte del
payload JSON cifrado en `data`. `played_at` sí es una columna independiente
para conservar la reproducción de voz sin reescribir ese estado.

### Borrado «para mí» y reacciones

| Tabla | Clave y columnas | Semántica |
| --- | --- | --- |
| `message_deletions` | PK `(message_id, user_id)`; `deleted_at` | Ambas FK CASCADE. Oculta un mensaje solo para esa cuenta. |
| `chat_deletions` | PK `(chat, user_id)`; `deleted_at` | `user_id` CASCADE. Oculta una conversación; `chat` es la clave textual, no una FK. |
| `message_reactions` | PK `(message_id, user_id)`; `emoji`, `updated_at` | Ambas FK CASCADE. Una reacción por usuario y mensaje; `emoji` no puede estar vacío. |

Si borra el autor, el mensaje desaparece físicamente. Si lo oculta el
destinatario, se crea su marca en `message_deletions`. Borrar un chat de la
lista usa `chat_deletions` y no destruye la vista del otro participante;
vaciar una conversación es una operación distinta y elimina sus mensajes.

## 7. Adjuntos y permisos de acceso

La base principal no contiene una FK directa a `blobs`: las bases son archivos
SQLite independientes. La autorización se representa en estas tablas:

| Tabla | Clave y columnas esenciales | Relaciones |
| --- | --- | --- |
| `blob_access` | PK `(hash, message_id)`; `kind`, `chat_a`, `chat_b`, `gid`, `story_user` | `kind`: `chat`, `group`, `story`. Las cuatro referencias opcionales son CASCADE a usuarios o grupos. `message_id` también puede ser `story:<id>:<ts>`, por eso no es FK. |
| `blob_access_members` | PK `(hash, user_id)`; `message_id` | `message_id → messages.id` CASCADE y `user_id → users.id` CASCADE. Conserva los miembros que podían ver un adjunto de grupo al publicarlo. |

Conocer un hash no concede acceso. En grupos con foto de miembros se comprueba
esa foto; los registros anteriores sin ella conservan la comprobación por
pertenencia actual. Los stickers públicos/locales y las imágenes de perfil
tienen sus propias referencias de conservación.

## 8. Historias, llamadas y push

| Tabla | Clave y columnas | Reglas |
| --- | --- | --- |
| `stories` | PK `(from_id, ts)`; `data`, `hash` | `from_id → users.id` CASCADE. Payload cifrado y adjunto opcional; caducidad de 24 h por defecto. |
| `calls` | PK `(owner, id)`; `peer`, `peer_hash`, `ts`, `data` | `owner → users.id` CASCADE. Una fila por extremo y llamada. `peer` está cifrado; `peer_hash` es el índice a ciegas HMAC para renombres y purgas. |
| `push_subs` | PK `(user_id, endpoint)`; `data` | `user_id` CASCADE. Endpoint y suscripción persistidos para Web Push. |
| `push_avatars` | PK `user_id`; `token` UNIQUE, `mime`, `data` BLOB, `updated_at` | `user_id` CASCADE. Miniatura en claro para el servicio push, servida mediante token no adivinable que rota al sustituirla. |

## 9. Stickers

| Tabla | Clave y columnas | Uso y FK |
| --- | --- | --- |
| `user_stickers` | PK `(user_id, position)`; `sticker` | Favoritos ordenados; `user_id` CASCADE. |
| `user_sticker_blobs` | PK `(user_id, hash)` | Referencias que conservan blobs de stickers; `user_id` CASCADE. |
| `public_stickers` | PK `hash`; `user_id`, `created_at` | Biblioteca publicada voluntariamente; autor CASCADE. |
| `public_sticker_tags` | PK `(hash, tag)` | `hash → public_stickers.hash` CASCADE; etiquetas de búsqueda. |
| `default_stickers` | PK `expression`; `hash` UNIQUE, `label`, `tags`, `sticker`, `position` | Catálogo local, sin FK a cuentas. |

## 10. Metadatos

`meta` tiene PK `key` y columna opcional `value`. Guarda, entre otros valores,
`schema_version`, la versión de cifrado de la base y el hash de la imagen de
respaldo de adjuntos (`media_fallback_hash`). Esta última referencia evita que
la limpieza de huérfanos elimine dicho recurso.

## 11. Base de adjuntos y cuotas

La base de adjuntos contiene `blobs` y una tabla técnica de sesiones, creadas
por `src/db/database.js`:

```sql
CREATE TABLE IF NOT EXISTS blobs (
    hash TEXT PRIMARY KEY,
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mtproto_session_spill (
    auth_key_id TEXT PRIMARY KEY,
    next_seq INTEGER NOT NULL
);
```

En `blobs`, `hash` es el SHA-256 del contenido original y `data` guarda la
data-URL cifrada con la llave maestra y asociada al hash como contexto. No hay
claves ajenas hacia la base principal.

`mtproto_session_spill` guarda solo el contador interno `seq` de una auth_key
cuando su entrada sale del LRU; el `seq_no` emitido se calcula como `seq * 2 + 1`.
No contiene mensajes ni claves, se vacía al abrir un proceso nuevo y la entrada
se elimina al rotar o borrar su clave.

Las cuotas se comprueban antes de escribir en los caminos de mensajes,
historias, imágenes y adjuntos:

| Límite | Valor vigente | Aplicación |
| --- | --- | --- |
| `BLOB_QUOTA_PER_USER_BYTES` | 512 MiB por cuenta | Hashes de `blob_access` asociados a sus DM, grupos e historias, sus referencias de stickers y su avatar/fondo, más historias en línea; los payloads nuevos también se cobran al validar el envío. |
| `BLOB_QUOTA_GLOBAL_BYTES` | 20 GiB | Suma persistida en `blobs.data` para toda la instancia. |

El cálculo por cuenta se cachea durante 15 segundos y se invalida al cambiar o
borrar contenido. El contador global se mantiene en RAM con las escrituras y
borrados reales. Estos límites son constantes de `src/chat/media.js`, no
columnas ni configuración del esquema.

## 12. Índices explícitos

Además de los índices automáticos de PK y UNIQUE, el esquema mantiene:

| Tabla | Índices y finalidad |
| --- | --- |
| `user_privacy_users` | `idx_upu_target(target_id)` parcial, para limpiar referencias resueltas. |
| `user_muted_peers` | `idx_ump_peer(peer_id)` parcial. |
| `user_sticker_blobs` | `idx_user_sticker_blobs_hash(hash)`. |
| `public_stickers` | `idx_public_stickers_recent(created_at DESC, hash)`. |
| `public_sticker_tags` | `idx_public_sticker_tags_tag(tag, hash)`. |
| `groups` | `idx_groups_visibility`; `idx_groups_owner` parcial; UNIQUE parcial `idx_groups_custom_id` cuando `custom_id != ''`. |
| `group_members`, solicitudes y vistos | `idx_gm_user`, `idx_gjr_user`, `idx_ugs_gid`. |
| Contactos | `idx_contacts_contact`, `idx_creq_to`, `idx_blocked_target`. |
| Resúmenes | `idx_summaries_peer`, `idx_gs_gid`. |
| `messages` | `idx_messages_chat_ts(chat, ts DESC, id DESC)` para paginar; `idx_messages_to(to_id)` parcial; `idx_messages_from(from_id, ts DESC)`. |
| Borrados y reacciones | `idx_mdel_user`, `idx_cdel_user`, `idx_message_reactions_message(message_id)`. |
| `blob_access` | `idx_ba_hash`, `idx_ba_message`; parciales `idx_ba_chat_a`, `idx_ba_chat_b`, `idx_ba_group` e `idx_ba_story`. |
| `blob_access_members` | `idx_bam_message`, `idx_bam_user`. |
| `stories` | `idx_stories_ts(ts DESC)`. |
| `calls` | `idx_calls_owner_ts(owner, ts DESC)`, `idx_calls_peer_hash(peer_hash)`. |

Las FK con `ON DELETE CASCADE` son la regla general. La excepción declarativa
principal es `groups.owner_id`, con `ON DELETE SET NULL`; las referencias
polimórficas o por texto se resuelven en las rutinas de aplicación.

## 13. Borrados y conservación de blobs

### Borrar un grupo

`deleteGroupRows`, dentro de la transacción de aplicación:

1. Recoge los hashes asociados al grupo y a sus mensajes.
2. Elimina mensajes y permisos de adjuntos del grupo.
3. Quita preferencias, marcas de conversación y silenciados textuales asociados
   a `group:<gid>`.
4. Borra `groups`; las FK eliminan miembros, solicitudes, vistos, resúmenes y
   permisos restantes.
5. Después, `pruneBlobHashes` elimina en la segunda base los hashes que ya no
   tengan ninguna referencia viva.

### Borrar una cuenta

`deleteAccountRows` complementa las cascadas:

1. En cada grupo, elimina el grupo si la cuenta era su último miembro. Si quedan
   miembros, garantiza un administrador y transfiere `owner_id` cuando procede.
2. Purga los DM completos en los que participa y todos los mensajes que ha
   escrito, incluidos los de grupos.
3. Recoge referencias de historias y stickers y elimina referencias textuales
   de preferencias, chats ocultos, silenciados y listas de privacidad.
4. Purga llamadas donde era el otro extremo usando `peer_hash`; si falta el
   índice o el nombre no puede descifrarse, aplica la comparación de respaldo.
5. Borra `users`, activando las cascadas de perfiles, claves, privacidad,
   contactos, grupos, mensajes, historias, llamadas, push y permisos restantes.
6. Devuelve hashes y grupos afectados para podar adjuntos y actualizar la RAM y
   los clientes después de la transacción principal.

### Poda de adjuntos

Las dos bases no comparten una transacción atómica. Por eso hay dos mecanismos
complementarios:

- `pruneBlobHashes` se ejecuta tras los borrados y solo elimina un hash si no
  aparece en `blob_access`, stickers, imágenes de perfil/fondo/grupo ni la
  referencia de respaldo.
- `sweepOrphanBlobs` limpia restos de operaciones incompletas cada 6 horas, en
  tandas de hasta 200 hashes, y también retira filas de acceso huérfanas.

La autorización depende de las referencias de la base principal; un blob sin
referencia deja de ser descargable aunque todavía no haya sido físicamente
podado.

## 14. Invariantes operativas

- `PRAGMA foreign_key_check` debe quedar vacío.
- Los usernames y los `custom_id` no vacíos son únicos según sus restricciones.
- Cada llamada conserva como máximo una fila por `(owner, id)`.
- Cada mensaje conserva como máximo una reacción por `(message_id, user_id)`.
- Un grupo superviviente a una baja conserva administración y propiedad válida.
- Sin una referencia/autorización válida no se sirve un adjunto por su hash.
- La base principal y `blobs` deben respaldarse junto con la credencial del
  propietario; una sola de esas piezas no basta para restaurar el servicio.

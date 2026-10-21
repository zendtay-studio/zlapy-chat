# Esquema de la base de datos de Zlapy (versión 3)

Esta es la referencia completa del almacenamiento de Zlapy. La base es
SQLite (`data/zlapy.db`) y el esquema vive en **`src/db/schema.js`**,
que es la única fuente de verdad: el servidor lo aplica al arrancar
(`migrateIfNeeded`) y los tests (`test/database-schema.test.js`) lo verifican.

> **Antes (v1):** la tabla `users` tenía solo `id`, `username` y `data`, un
> JSON gigante con la contraseña, las claves, el perfil, la privacidad, los
> colores, los stickers, los silenciados y las notas. No había ni una sola
> clave ajena: al borrar una cuenta quedaban filas huérfanas en todas las
> tablas (contactos, mensajes, historias, resúmenes…).
>
> **Ahora (v3):** cuentas con columnas reales, tablas normalizadas, claves
> ajenas en cascada e índices sobre las columnas hijas (v3, añadidos sin
> perder datos). Sobre esa base v2 se aplicó la actualización v3: mismos
> datos, índices nuevos y los redundantes retirados.
> ajenas `ON DELETE CASCADE` en todo lo que pertenece a una cuenta o a un
> grupo. Borrar una fila de `users` arrastra **absolutamente todo**.

---

## 1. Resumen visual

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ users                        │        │ groups                       │
│  id (PK)                     │        │  id (PK)                     │
│  username UNIQUE NOCASE      │        │  crypto_id  (E2E)            │
│  password_hash / salt        │        │  name / description / avatar │
│  add_policy / created_at     │◄──┐    │  owner_id ──► users (SET NULL)│
└──────────────┬───────────────┘   │    │  visibilidad / políticas     │
               │                   │    │  invite_code                 │
               │ ON DELETE CASCADE │    │  keys_cipher (cifrado)       │
               ▼                   │    └──────────────┬───────────────┘
┌──────────────────────────────┐   │                   │
│ user_profiles                │   │                   │ CASCADE
│ user_keys                    │   │                   ▼
│ user_privacy ──► users       │   │    ┌───────────────────────────┐
│ user_privacy_users           │   │    │ group_members (rol)       │
│ user_chat_settings           │   │    │ group_join_requests       │
│ user_muted_peers ──► users   │   │    │ group_summaries           │
│ user_notes                   │   │    │ user_group_seen ──► users │
│ user_stickers                │   │    └───────────────────────────┘
│ sessions                     │   │
│ contacts (2 sentidos)        │   │    ┌───────────────────────────┐
│ contact_requests             │   └────│ (todas: gid/user_id FK)   │
│ blocked                      │        └───────────────────────────┘
│ summaries (owner, peer) ─────┼──► users
│ messages (from_id/to_id) ────┼──► users           ┌───────────────┐
│ stories (from_id) ───────────┼──► users      ───► │ groups(destino│
│ calls (owner) ───────────────┼──► users           │ de grupo)     │
│ push_subs                    │   │                └───────────────┘
│ blob_access (chat_a/b, gid,  │   │
│   story_user)                │   │
└──────────────────────────────┘   │
                                   └── todas las flechas hacia `users`
                                       borran la fila en cascada.
```

---

## 2. Convenciones

| Tema | Regla |
| --- | --- |
| Identificadores de cuenta | UUID v4 en minúsculas (`crypto.randomUUID()`). |
| Nombres de usuario | Siempre en minúsculas, `UNIQUE COLLATE NOCASE` (comparación sin distinguir mayúsculas). |
| Fechas | Milisegundos desde epoch (`Date.now()`), enteros de 64 bits. |
| Booleans | `0` / `1` con `CHECK (col IN (0,1))`. |
| Cifrado en reposo | **Dos capas.** (1) *Capa de usuario (MTProto 2.0)*: cada cuenta tiene su `auth_key` de 2048 bits (`user_auth_keys`), de la que se derivan la clave de cada mensaje y la semilla de su firma Ed25519. Cubre mensajes, resúmenes, notas, perfil, llamadas, push e historias. (2) *Capa del servidor (llave maestra)*: material compartido que no pertenece a un usuario concreto — la `auth_key` almacenada, el material E2E de los grupos (`groups.keys_cipher`), el almacén de adjuntos (`blob.db`) y la clave VAPID (`meta`). Todo lo que sale a disco pasa por AES-256-GCM. El texto que ya estuviera en claro se sigue leyendo (sin migración) y se vuelve a cifrar al guardarse. |
| Claves ajenas | Activadas siempre (`PRAGMA foreign_keys = ON`) y `ON DELETE CASCADE` salvo `groups.owner_id` (SET NULL). |
| Fechas de creación | `created_at`/`updated_at` son informativos; no participan en la lógica. |

---

## 3. Tablas

### 3.1 `users` — cuentas

La tabla principal. Todo lo demás cuelga de aquí.

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUID de la cuenta. Nunca cambia. |
| `username` | TEXT | NOT NULL, UNIQUE COLLATE NOCASE | Nombre para iniciar sesión. Unicidad sin distinguir mayúsculas. |
| `password_hash` | TEXT | NOT NULL | Derivación de la contraseña (scrypt-like con sal). |
| `password_salt` | TEXT | NOT NULL | Sal aleatoria por cuenta (16 bytes en hex). |
| `add_policy` | TEXT | CHECK `all`/`request`/`nobody`, default `request` | Quién puede agregar como contacto. |
| `created_at` | INTEGER | NOT NULL, default 0 | Alta de la cuenta. |
| `last_seen` | INTEGER | NULL | Última desconexión. `NULL` = en línea. |

**Cascada:** borrar una fila de `users` arrastra (en este orden lógico):
`user_profiles`, `user_keys`, `user_privacy` (+ sus listas), `user_chat_settings`,
`user_muted_peers`, `user_notes`, `user_stickers`, `user_group_seen`, `sessions`,
`contacts` (ambos sentidos), `contact_requests`, `blocked`, `summaries`,
`messages` (como autor y como destinatario), `stories`, `calls`,
`push_subs`, `group_members`, `group_summaries`, `group_join_requests`,
`blob_access` (`chat_a`, `chat_b`, `story_user`) y `user_privacy_users.target_id`.

### 3.2 `user_profiles` — perfil público

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | PK, FK → `users.id` CASCADE | Dueño del perfil. |
| `display_name` | TEXT | NOT NULL default '' | Nombre visible. Si está vacío se usa `username`. |
| `avatar` | TEXT | NOT NULL default '' | Data-URL de la foto (máx. ~2 MB, validado por el servidor). |
| `bio` | TEXT | NOT NULL default '' | Descripción (límite del servidor: 140 caracteres). |
| `note` | TEXT | NOT NULL default '' | Nota de perfil (la que se edita desde el perfil). |
| `note_ts` | INTEGER | NOT NULL default 0 | Momento de la última nota; las notas caducan a las 24 h. |
| `updated_at` | INTEGER | NOT NULL default 0 | Última escritura (informativo). |

> Hay **dos** notas distintas y no se pisan entre sí:
> `user_profiles.note` es la nota del perfil y `user_notes` es la "nota
> personal" con fondo (la de los estados). En memoria viven en
> `profiles[usuario].note` y en `notesMap[usuario]` respectivamente.

### 3.3 `user_keys` — claves del dispositivo

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | PK, FK → `users.id` CASCADE | Cuenta dueña. |
| `key_cipher` | TEXT | NOT NULL | Par de claves públicas del dispositivo, **cifrado en reposo**. |
| `updated_at` | INTEGER | NOT NULL default 0 | Última rotación. |

### 3.4 `user_privacy` y `user_privacy_users` — privacidad por función

`user_privacy` guarda una fila por función configurada (si no hay fila, se
aplica el valor por defecto de esa función).

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Dueño. |
| `feature` | TEXT | CHECK: `foto`, `nota`, `descripcion`, `historias`, `llamadas`, `mensajes`, `compartir`, PK compuesta | Qué se está regulando. |
| `mode` | TEXT | CHECK: `server`, `contacts`, `nobody`, `except`, `only` | Regla. `server` = "todos" (histórico del nombre), `except` = todos menos la lista, `only` = solo la lista. |

`user_privacy_users` son las listas de `except`/`only`:

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | PK compuesta, FK compuesta → `user_privacy` CASCADE | Dueño. |
| `feature` | TEXT | PK compuesta, FK compuesta → `user_privacy` CASCADE | Función. |
| `position` | INTEGER | PK compuesta | Orden de la lista. |
| `target_id` | TEXT | FK → `users.id` CASCADE, NULL | Usuario afectado si existe (se borra en cascada). |
| `target_name` | TEXT | NOT NULL | Nombre como etiqueta de reserva si la cuenta no existe. |

### 3.5 `user_chat_settings` — apariencia del chat

Un registro por cuenta con el tema del chat (colores y fondo). Los 19 temas
preconfigurados del cliente terminan escribiendo aquí.

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | PK, FK → `users.id` CASCADE | Dueño. |
| `wall` | TEXT | NULL | Color de fondo del chat (`#rrggbb`). |
| `opacity` | REAL | NOT NULL default 30 | Opacidad del fondo (0–100). |
| `blur` | REAL | NOT NULL default 0 | Desenfoque del fondo (0–20). |
| `sender` | TEXT | NULL | Color de burbuja propia. |
| `receiver` | TEXT | NULL | Color de burbuja del otro. |
| `sender_text` | TEXT | NULL | Color del texto propio. |
| `receiver_text` | TEXT | NULL | Color del texto recibido. |
| `font_size` | REAL | NOT NULL default 15 | Tamaño de letra. |
| `auto_text` | INTEGER | CHECK 0/1, default 1 | Calcular automáticamente el color del texto según el contraste. |
| `wallpaper` | TEXT | NOT NULL default '' | Imagen de fondo (data-URL). |
| `updated_at` | INTEGER | NOT NULL default 0 | Última escritura. |

### 3.6 `user_muted_peers` — chats silenciados

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Quién silencia. |
| `peer_id` | TEXT | FK → `users.id` CASCADE, NULL | A quién silencia (si la cuenta existe). |
| `peer_name` | TEXT | NOT NULL, PK compuesta | Nombre del silenciado (etiqueta legible; la fila entera desaparece si esa cuenta se borra, porque `peer_id` es FK CASCADE). |

### 3.7 `user_notes` — nota personal (estado)

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | PK, FK → `users.id` CASCADE | Dueño. |
| `data` | TEXT | NULL | JSON con el contenido: `{ text, bg, ts, ...}`. |
| `ts` | INTEGER | NOT NULL default 0 | Cuándo se publicó (caduca a las 24 h). |

### 3.8 `user_stickers` — stickers favoritos

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Dueño. |
| `position` | INTEGER | PK compuesta | Orden (los últimos 30 se conservan). |
| `sticker` | TEXT | NOT NULL | URL del sticker. |

### 3.9 `groups` — grupos

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Id interno (`g_…`), es el que usan los mensajes (`group:<gid>`). |
| `crypto_id` | TEXT | NOT NULL | UUID usado por el cifrado extremo a extremo. |
| `name` | TEXT | NOT NULL | Nombre visible. |
| `description` | TEXT | NOT NULL default '' | Descripción. |
| `avatar` | TEXT | NOT NULL default '' | Foto (data-URL, máx. ~2 MB). |
| `owner_id` | TEXT | FK → `users.id` **ON DELETE SET NULL** | Creador. Al borrarse la cuenta pasa al nuevo administrador (lo hace la rutina de borrado). |
| `visibility` | TEXT | CHECK `public`/`private`, default `private` | Si aparece en "Descubrir grupos". |
| `join_policy` | TEXT | CHECK `open`/`request`/`closed`, default `request` | Cómo se entra. |
| `write_policy` | TEXT | CHECK `all`/`admins`, default `all` | Quién escribe. |
| `add_policy` | TEXT | CHECK `all`/`admins`, default `admins` | Quién agrega miembros. |
| `edit_policy` | TEXT | CHECK `all`/`admins`, default `admins` | Quién edita el grupo. |
| `mention_all_policy` | TEXT | CHECK `all`/`admins`, default `admins` | Quién puede mencionar a todos. |
| `content_policy` | TEXT | NOT NULL default '{}' | JSON por tipo de contenido (`text`, `image`, `video`, `audio`, `file`, `sticker`, `contact`, `poll`). |
| `invite_code` | TEXT | NOT NULL | Código del enlace de invitación. |
| `keys_cipher` | TEXT | NULL | Material E2E (cryptoId + keyboxes) **cifrado en reposo**. Las keyboxes siguen siendo por nombre de usuario. |
| `created_at` | INTEGER | NOT NULL default 0 | Alta del grupo. |

**Cascada:** borrar un grupo arrastra `group_members`, `group_summaries`,
`group_join_requests`, `user_group_seen` y `blob_access.gid`.

### 3.10 `group_members` — membresía y roles

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `gid` | TEXT | FK → `groups.id` CASCADE, PK compuesta | Grupo. |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Miembro. |
| `role` | TEXT | CHECK `admin`/`member`, default `member` | Administración. |
| `joined_at` | INTEGER | NOT NULL default 0 | Cuándo entró. Se conserva al reescribir el grupo: el upsert es `INSERT ... ON CONFLICT(gid,user_id) DO UPDATE SET role`, así el miembro viejo no pierde su fecha y el nuevo recibe "ahora". |

> Regla del servidor: **todo grupo vivo tiene al menos un administrador**.
> Si el último administrador borra su cuenta, la rutina de borrado promueve a
> otro miembro al azar (y le pasa la propiedad del grupo).

### 3.11 `group_join_requests` — solicitudes de entrada

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `gid` | TEXT | FK → `groups.id` CASCADE, PK compuesta | Grupo. |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Solicitante. |
| `username` | TEXT | NOT NULL | Su nombre (etiqueta de respaldo). |
| `ts` | INTEGER | NOT NULL | Cuándo lo pidió. |

### 3.12 `user_group_seen` — grupos vistos

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Quién. |
| `gid` | TEXT | FK → `groups.id` CASCADE, PK compuesta | Qué grupo. |
| `ts` | INTEGER | NOT NULL | Último mensaje visto (para el contador de no leídos). |

### 3.13 `sessions` — sesiones de inicio de sesión

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `token_hash` | TEXT | PK | SHA-256 del token de la cookie (el token nunca se guarda en claro). |
| `user_id` | TEXT | FK → `users.id` CASCADE | Cuenta. |
| `expires_at` | INTEGER | NOT NULL | Caducidad (30 días). Se purgan de la base al arrancar y cada 10 minutos; al usarlas solo se limpia la RAM. |

Las cookies por cuenta (`chatlocal_account_<id>`) permiten tener varias
cuentas abiertas en el mismo dispositivo; cada una guarda su propio token.

### 3.14 `contacts`, `contact_requests` y `blocked`

| Tabla | Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- | --- |
| `contacts` | `owner` | TEXT | FK → `users.id` CASCADE, PK compuesta | Dueño de la lista. |
| `contacts` | `contact` | TEXT | FK → `users.id` CASCADE, PK compuesta | Contacto. La relación se guarda en **los dos sentidos**. |
| `contact_requests` | `from_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Quién pide. |
| `contact_requests` | `to_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | A quién. |
| `contact_requests` | `ts` | INTEGER | NOT NULL | Cuándo. |
| `blocked` | `owner` | TEXT | FK → `users.id` CASCADE, PK compuesta | Quién bloquea. |
| `blocked` | `target` | TEXT | FK → `users.id` CASCADE, PK compuesta | Bloqueado. |

### 3.15 `summaries` — resumen de cada chat 1:1

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `owner` | TEXT | FK → `users.id` CASCADE, PK compuesta | Dueño del resumen. |
| `peer` | TEXT | FK → `users.id` CASCADE, PK compuesta | El otro extremo. |
| `unread` | INTEGER | NOT NULL default 0 | No leídos. |
| `last_data` | TEXT | NULL | JSON del último mensaje (para pintar la lista sin cargar el chat). |

### 3.16 `messages` — mensajes de chat

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUID del mensaje. |
| `chat` | TEXT | NOT NULL | **Destino**: `chat:<idA>__<idB>` (ids ordenados) o `group:<gid>`. No es FK porque apunta a dos cosas distintas. |
| `ts` | INTEGER | NOT NULL | Envío. |
| `from_id` | TEXT | FK → `users.id` CASCADE | Autor. Borrar la cuenta borra sus mensajes. |
| `to_id` | TEXT | FK → `users.id` CASCADE, NULL | Destinatario en 1:1 (`NULL` en grupos). |
| `kind` | TEXT | NOT NULL | `text`, `image`, `audio`, `video`, `file`, `sticker`, `contact`, `poll`, `seen`, `call`… |
| `data` | TEXT | NOT NULL | Payload (texto plano o el sobre cifrado; ver `crypto_version`). |
| `hash` | TEXT | NULL | Hash del adjunto principal. |
| `once` | INTEGER | CHECK 0/1, default 0 | Ver una vez. |
| `edited` | INTEGER | CHECK 0/1, default 0 | Editado. |
| `crypto_version` | INTEGER | NOT NULL default 2 | 2 = sobre cifrado con firma. |
| `crypto_group_id` | TEXT | NULL | Grupo criptográfico (para material E2E de grupos). |
| `signature` | TEXT | NULL | Firma del remitente. |
| `signing_public_key` | TEXT | NULL | Clave con la que se verificó. |

**Borrado:** los mensajes de un chat 1:1 se purgan **completos** (de los dos
lados) cuando una de las dos cuentas se borra; se localizan con
`chat LIKE 'chat:%' AND instr(chat, id) > 0`. El prefijo `'chat:'` excluye a los
grupos a propósito: como `gid` lo elige el cliente, un grupo cuyo id contenga
el uuid de la víctima NO provoca la purga de su historial (regresión cubierta
por tests).

### 3.17 `blob_access` — permisos de descarga de adjuntos

Sin fila aquí, `/blob/<hash>` responde 404 (o 403). Es la puerta de entrada a
la tabla `blobs` (base aparte, `data/blob.db`).

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `hash` | TEXT | PK compuesta | SHA-256 del adjunto. |
| `message_id` | TEXT | PK compuesta | Id del mensaje **o** `story:<idUsuario>:<ts>` (por eso no es FK). |
| `kind` | TEXT | CHECK `chat`/`group`/`story` | De dónde viene. |
| `chat_a`, `chat_b` | TEXT | FK → `users.id` CASCADE, NULL | Para `kind = 'chat'`, los dos extremos. |
| `gid` | TEXT | FK → `groups.id` CASCADE, NULL | Para `kind = 'group'`. |
| `story_user` | TEXT | FK → `users.id` CASCADE, NULL | Para `kind = 'story'`. |

### 3.18 `stories` — historias

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `from_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Autor. |
| `ts` | INTEGER | NOT NULL, PK compuesta | Publicación (clave junto al autor). |
| `data` | TEXT | NOT NULL | JSON de la historia, cifrado en reposo. |
| `hash` | TEXT | NULL | Adjunto principal. |

Las historias viven 24 h (el servidor las ignora y las borra después).

### 3.19 `calls` — historial de llamadas

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUID de la llamada. |
| `owner` | TEXT | FK → `users.id` CASCADE | A quién pertenece esta entrada del historial. |
| `peer` | TEXT | NULL | Nombre de usuario del otro extremo, a propósito: sobrevive a cambios de nombre. |
| `ts` | INTEGER | NOT NULL | Cuándo. |
| `data` | TEXT | NULL | JSON con la duración y el resultado. |

### 3.20 `push_subs` — notificaciones push

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Suscriptor. |
| `endpoint` | TEXT | NOT NULL, PK compuesta | URL del servicio push. |
| `data` | TEXT | NOT NULL | JSON con `keys`. |

### 3.21 `group_summaries` — resumen de grupo

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `owner` | TEXT | FK → `users.id` CASCADE, PK compuesta | Dueño del resumen. |
| `gid` | TEXT | FK → `groups.id` CASCADE, PK compuesta | Grupo. |
| `unread` | INTEGER | NOT NULL default 0 | No leídos. El servidor los mantiene con un upsert `INSERT … ON CONFLICT(owner,gid) DO UPDATE SET unread = unread + excluded.unread`: **el emisor nunca suma** (le pasa 0) y los demás acumulan 1 por mensaje. `writeGroupSummary` (INSERT OR REPLACE) solo se usa en rutas de "visto", que reinician el contador a 0. |
| `last_data` | TEXT | NULL | JSON del último mensaje. |

### 3.22 `meta` — metadatos

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `key` | TEXT | PK | Clave (`schema_version`, `crypto_version`, …). |
| `value` | TEXT | NULL | Valor. |

### 3.23 `user_auth_keys` — clave de cifrado por usuario (MTProto 2.0)

| Columna | Tipo | Qué guarda |
| --- | --- | --- |
| `user_id` | TEXT (PK, FK `users.id`, CASCADE) | Cuenta propietaria. |
| `auth_key` | TEXT | La clave de autorización de 2048 bits, **cifrada con la llave maestra** del servidor. |
| `key_id` | TEXT | `auth_key_id`: los 64 bits bajos del SHA-1 de la clave (identifica el sobre). |
| `salt` | INTEGER | Sal de 64 bits; se rota cada 30 minutos. |
| `session_id` | INTEGER | Identificador de sesión de 64 bits. |
| `last_msg_id` | TEXT | Último `msg_id` emitido (monótono, basado en el tiempo). |

Es el equivalente al modelo **en la nube** de MTProto 2.0: el servidor conoce la clave
(por eso puede sincronizar el historial entre dispositivos) pero **la llave maestra por
sí sola no descifra el contenido de nadie**. De ella se derivan, con las fórmulas de
MTProto 2.0, el `msg_key` (128 bits centrales del SHA-256 del mensaje con relleno),
el `aes_key` y el `aes_iv` de cada mensaje. El sobre es
`PCE3:<key_id>:<msg_key>:<iv>:<cifrado+tag>`; dentro va la cabecera interna
(sal, sesión, `msg_id`, `seq_no`, longitud). Se comprueba al recibir que el `msg_key`
recalculado coincide y que el `msg_id` está en la ventana anti-repetición.

### 3.24 `message_deletions` y `chat_deletions` — borrados con alcance por usuario

Un mensaje o una conversación se guardan **una sola vez** para los dos
interlocutores. Para que "borrar para mí" no destruya la copia del otro,
aquí se anota lo que cada usuario ha quitado:

| Tabla | Columnas | Qué guarda |
| --- | --- | --- |
| `message_deletions` | `message_id` (FK `messages.id`, CASCADE), `user_id` (FK `users.id`, CASCADE), `deleted_at` | Mensajes ocultos para un usuario concreto (los pidió el destinatario). |
| `chat_deletions` | `chat` (texto), `user_id` (FK `users.id`, CASCADE), `deleted_at` | Conversaciones quitadas de la lista de un usuario. |

Reglas:

- `/msg/delete`: si quien lo pide es el **autor**, el mensaje se borra de verdad
  (para los dos). Si es el **destinatario**, se anota en `message_deletions` y
  solo desaparece de su vista; el emisor no se entera.
- `/chat/delete`: siempre "borrar para mí" (se anota en `chat_deletions` y se
  borra el resumen de quien lo pidió). El otro interlocutor conserva su copia.
- Un mensaje nuevo en la conversación borra la anotación: el chat reaparece.
- El filtro se aplica al **servir** la página, no al leerla: la caché de
  páginas es compartida por los dos interlocutores de un DM.

### 3.25 Base de adjuntos (`data/blob.db`)

| Tabla | Columna | Significado |
| --- | --- | --- |
| `blobs` | `hash` (PK) | SHA-256 del contenido. |
| `blobs` | `data` | Contenido **cifrado en reposo**. |

Los blobs se borran cuando ninguna fila de `blob_access` los referencia
(`pruneBlobHashes`).

---

## 4. Borrado en cascada

La lógica vive en `src/db/schema.js` (`deleteAccountRows` y
`deleteGroupRows`) para poder probarla sin arrancar el servidor. Se ejecuta en
una sola transacción (todo o nada).

### 4.1 Borrar un grupo (`deleteGroupRows`)

1. Recoger los hashes de sus mensajes (`blob_access` con `gid` o cuyo
   `message_id` pertenece a `chat = 'group:<gid>'`).
2. Borrar los mensajes del grupo y sus permisos de adjunto.
3. `DELETE FROM groups WHERE id = ?` → la cascada se lleva `group_members`,
   `group_summaries`, `group_join_requests`, `user_group_seen` y los
   `blob_access` restantes.
4. El servidor poda los blobs huérfanos y avisa a los demás.

### 4.2 Borrar una cuenta (`deleteAccountRows`)

1. **Grupos.** Por cada grupo al que pertenecía:
   * Si era el último miembro → el grupo entero se borra (4.1).
   * Si no → se borra su fila de `group_members`; si era el último
     administrador, se promueve a otro miembro al azar; si además era el
     dueño, la propiedad (`groups.owner_id`) pasa al nuevo administrador.
2. **Mensajes 1:1.** Se purgan **completas** todas las conversaciones en las
   que participaba (también la copia del otro). Se localizan con
   `chat LIKE 'chat:%' AND instr(chat, <id>) > 0` (el prefijo `'chat:'`
   excluye los grupos).
3. **Mensajes en grupos.** `DELETE FROM messages WHERE from_id = ?` (sus
   mensajes desaparecen de todos los grupos).
4. **Historias.** Se recogen sus hashes; la cascada borra la historia y su
   `blob_access`.
5. **Llamadas.** Se borra el historial donde era el otro extremo
   (`calls.peer = <usuario>`), además de las suyas por cascada.
6. **La cuenta.** `DELETE FROM users WHERE id = ?`: aquí caen
   **todas** las cascadas del punto 3.1.
7. El servidor poda los blobs huérfanos, limpia la RAM (usuarios, perfiles,
   notas, bloqueos, sesiones, push, cachés), avisa a los contactos
   (`chatDelete`), refresca los grupos supervivientes y libera el nombre de
   usuario **al instante**.

Consecuencia práctica: se puede borrar una cuenta y **volver a registrarla
con el mismo nombre sin reiniciar el servidor**; el login viejo deja de
funcionar y las cookies de esa cuenta se limpian solas (`gone: true`).

---

## 5. El esquema al arrancar (sin migraciones)

Al arrancar, el servidor ejecuta `ensureSchema(db)`: aplica el esquema v3
completo con `CREATE TABLE / CREATE INDEX IF NOT EXISTS` (idempotente: si la
base ya está al día no toca nada) y escribe `meta.schema_version = 3`.

**No hay migraciones.** Una base en un formato anterior (por ejemplo, la v1
antigua con todo el usuario dentro de un JSON `data`) **no es compatible** con
este servidor: no se convierte ni se adapta. Para usarla hay dos caminos:

1. Restaurarla desde un respaldo guardado en `backups/` (ver «Copias de
   seguridad» en el README).
2. Empezar de cero: mueve la base actual a otra carpeta y deja que el servidor
   cree un esquema v3 limpio.

El cifrado en reposo se aplica de forma **compatible con lo que ya había**:
`decryptAtRest` devuelve el valor tal cual si no empieza por `PCE1:`, así que
un texto antiguo en claro se sigue leyendo y se vuelve a cifrar en el siguiente
guardado (no hace falta migrar la base).

**El servidor no migra al arrancar.** Lee los dos formatos de mensaje (el
heredado `PCE2` y el nuevo `PCE3`) y escribe siempre el nuevo, así que el
histórico se va re-cifrando solo a medida que se reescribe. Para convertirlo
todo de golpe existe `ops/migrate-to-mtproto.js` (manual, con respaldo
previo, idempotente y **eliminable**: el servidor no lo importa).

El esquema incluye índices para las columnas hijas de las claves ajenas
(`idx_messages_to`, `idx_summaries_peer`, `idx_ba_chat_a`, `idx_ba_chat_b`,
`idx_upu_target`, `idx_ump_peer`, `idx_groups_owner`, `idx_gs_gid`,
`idx_ugs_gid`, `idx_calls_peer`) para que las cascadas de borrado no hagan
full-scan, y retira los redundantes (`idx_summaries_owner`, `idx_gs_owner`,
`idx_creq_from`, `idx_messages_hash`).

---

## 6. Cómo inspeccionar la base

Con la CLI de SQLite:

```bash
sqlite3 data/zlapy.db
.mode box
.headers on
SELECT key, value FROM meta;

-- Cuentas
SELECT id, username, add_policy, datetime(created_at/1000, 'unixepoch') AS alta, last_seen
FROM users ORDER BY username;

-- Todo lo que cuelga de una cuenta
SELECT 'perfil'      AS parte, COUNT(*) FROM user_profiles      WHERE user_id = :id
UNION ALL SELECT 'privacidad',   COUNT(*) FROM user_privacy      WHERE user_id = :id
UNION ALL SELECT 'colores',      COUNT(*) FROM user_chat_settings WHERE user_id = :id
UNION ALL SELECT 'notas',        COUNT(*) FROM user_notes        WHERE user_id = :id
UNION ALL SELECT 'mensajes 1:1', COUNT(*) FROM messages          WHERE chat LIKE 'chat:%' AND instr(chat, :id) > 0
UNION ALL SELECT 'mensajes',     COUNT(*) FROM messages          WHERE from_id = :id;

-- ¿Hay algo roto?
PRAGMA foreign_key_check;
```

Desde Node (útil en scripts):

```js
const Database = require('better-sqlite3');
const db = new Database('data/zlapy.db', { readonly: true });
db.prepare('SELECT username FROM users WHERE username = ?').all('ano');
```

> Si el servidor está corriendo, la copia de solo el `.db` puede quedar
> desactualizada (WAL): copia también `zlapy.db-wal` y `zlapy.db-shm`, o usa
> `new Database('data/zlapy.db').backup('copia.db')`.

---

## 7. Invariantes

1. `foreign_key_check` siempre vacío (los tests lo comprueban).
2. Ningún nombre de usuario se puede repartir entre dos cuentas, ni cambiando
   mayúsculas y minúsculas.
3. Todo grupo vivo tiene al menos un administrador.
4. Ningún dato apunta a una cuenta o grupo inexistente: los borrados limpian
   en cascada: no queda nada apuntando a cuentas inexistentes.
5. Un adjunto sin fila en `blob_access` deja de servirse (404). Su bytes en
   `blob.db` se limpian en los caminos de borrado (`pruneBlobHashes`) y al
   al borrar el mensaje o la historia que lo usaba; no existe un barrido periódico automático.
6. La contraseña y las claves solo existen en columnas dedicadas y, en el caso
   de las claves, cifradas en reposo.
7. Datos sensibles (mensajes, historias, adjuntos, claves) nunca se escriben
   en claro: pasan por AES-256-GCM con la llave maestra `.zlapymasterkey`.

---

## 8. Archivos relacionados

| Archivo | Papel |
| --- | --- |
| `src/db/schema.js` | Esquema v3 y rutinas de borrado en cascada. |
| `test/schema.test.js` | Tests de esquema, cascadas y restricciones. |
| `src/crypto/message-crypto.js` | Cifrado en reposo (`encryptAtRest` / `decryptAtRest`) y firmas Ed25519. |
| `src/crypto/mtproto.js` | Cifrado en la nube (MTProto 2.0): `auth_key`, `msg_key`, `aes_key`/`aes_iv`, cabecera interna, relleno y ventana anti-repetición. |
| `src/crypto/user-auth-keys.js` | `auth_key` por usuario y cifrado por usuario (lo usan el servidor y el script de migración). |
| `ops/migrate-to-mtproto.js` | Migración **manual** al esquema de cifrado en la nube (no la hace el servidor al arrancar). |
| `test/security-regressions.test.js` | Tests de regresión de la auditoría de seguridad del 2026-10-19. |
| `src/shared/appearance.js` | Validación de la apariencia del chat (`user_chat_settings`). |

### Documentación relacionada

| Documento | Contenido |
| --- | --- |
| [`ARQUITECTURA.md`](ARQUITECTURA.md) | Cómo encaja la base con el resto: arranque, estado en memoria, caché y transacciones. |
| [`CRIPTOGRAFIA.md`](CRIPTOGRAFIA.md) | Qué se guarda cifrado y con qué llave (`user_auth_keys`, `meta.crypto_version`). |
| [`API.md`](API.md) | Las rutas que leen y escriben estas tablas. |
| [`FICHEROS.md`](FICHEROS.md) | Qué hace cada fichero del repositorio. |
| `data/zlapy.db` | Base de datos principal. |
| `data/blob.db` | Base de adjuntos cifrados. |

# Esquema de la base de datos de Zlapy (versión 12)

Esta es la referencia completa del almacenamiento de Zlapy. La base es
SQLite (`data/zlapy.db`) y el esquema vive en **`src/db/schema.js`**,
que es la única fuente de verdad: el servidor lo aplica al arrancar
(`ensureSchema` → `applySchema`) y los tests (`test/db/schema.test.js`) lo verifican.

> **Antes (v1):** la tabla `users` tenía solo `id`, `username` y `data`, un
> JSON gigante con la contraseña, las claves, el perfil, la privacidad, los
> colores, los stickers, los silenciados y las notas. No había ni una sola
> clave ajena: al borrar una cuenta quedaban filas huérfanas en todas las
> tablas (contactos, mensajes, historias, resúmenes…).
>
> **Entonces (v3):** cuentas con columnas reales, tablas normalizadas, claves
> ajenas en cascada e índices sobre las columnas hijas (v3, añadidos sin
> perder datos). Sobre aquella bases se sucedieron las versiones hasta la
> **v12** de hoy: 35 tablas, sin tabla de sesiones (JWT stateless), rid de
> revocación sin almacén, índice a ciegas de llamadas y solo cifrado PCE3.
> ajenas `ON DELETE CASCADE` en todo lo que pertenece a una cuenta o a un
> grupo. Borrar una fila de `users` arrastra **absolutamente todo**.

---

## 1. Resumen visual

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ users                        │        │ groups                       │
│  id (PK)                     │        │  id (PK)                     │
│  username UNIQUE NOCASE      │        │  crypto_id  (E2E)            │
│  password_hash / salt        │        │  name / description /        │
│  add_policy / created_at     │◄──┐    │    avatar_ref                │
└──────────────┬───────────────┘   │    │  owner_id ──► users (SET NULL)│
                │                   │    │  visibilidad / políticas     │
                │ ON DELETE CASCADE │    │  invite_code                 │
                ▼                   │    │  keys_cipher (cifrado)       │
┌──────────────────────────────┐   │    └──────────────┬───────────────┘
│ user_profiles                │   │                   │
│ user_keys                    │   │                   │ CASCADE
│ user_privacy ──► users       │   │                   ▼
│ user_privacy_users           │   │    ┌───────────────────────────┐
│ user_chat_settings           │   │    │ group_members (rol)       │
│ user_chat_prefs (fijados,    │   │    │ group_join_requests       │
│   no leídos, archivados)     │   │    │ group_summaries           │
│ user_muted_peers ──► users   │   │    │ user_group_seen ──► users │
│ user_notes                   │   │    └───────────────────────────┘
│ user_stickers                │   │    ┌───────────────────────────┐
│ user_sticker_blobs (refs)    │   │    │ blob_access_members       │
│ user_auth_keys (auth_key)    │   │    │ (foto de miembros que     │
│ user_rid (revocación)        │   │    │  podían ver un adjunto)   │
│ contacts (2 sentidos)        │   │    └───────────────────────────┘
│ contact_requests             │   │    ┌───────────────────────────┐
│ blocked                      │   │    │ default_stickers          │
│ summaries (owner, peer) ─────┼──► users│ (pack bbot local, sin FK)│
│ messages (from_id/to_id) ────┼──► users└───────────────────────────┘
│ message_deletions /          │   │              ┌───────────────┐
│   chat_deletions (para mí)   │   │       ───► │ groups(destino│
│ message_reactions            │   │              │ de grupo)     │
│ stories (from_id) ───────────┼──► users      └───────────────┘
│ calls (owner) ───────────────┼──► users
│ push_subs                    │   │
│ public_stickers ──► users    │   │
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
| Cifrado en reposo | **Dos capas.** (1) *Capa de usuario (MTProto 2.0)*: cada cuenta tiene su `auth_key` de 2048 bits (`user_auth_keys`), de la que se derivan la clave de cada mensaje y la semilla de su firma Ed25519. Cubre mensajes, resúmenes, notas, perfil, llamadas, push e historias. (2) *Capa del servidor (llave maestra)*: material compartido que no pertenece a un usuario concreto — la `auth_key` almacenada, el material E2E de los grupos (`groups.keys_cipher`), el almacén de adjuntos (`zlapy-blob.db`) y la clave VAPID (`meta`). Todo lo que sale a disco pasa por AES-256-GCM. El texto que ya estuviera en claro se sigue leyendo (sin migración) y se vuelve a cifrar al guardarse. |
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

La revocación de sesiones **no vive aquí**: la llevaba `users.auth_version`
(retirada en la v10) y ahora la decide `user_rid` (ver §3.13).

**Cascada:** borrar una fila de `users` arrastra (en este orden lógico):
`user_profiles`, `user_keys`, `user_privacy` (+ sus listas), `user_chat_settings`,
`user_chat_prefs`, `user_muted_peers`, `user_notes`, `user_stickers`,
`user_sticker_blobs`, `user_auth_keys`, `user_group_seen`, `user_rid`,
`contacts` (ambos sentidos), `contact_requests`, `blocked`, `summaries`,
`messages` (como autor y como destinatario), `message_deletions`,
`message_reactions`, `chat_deletions`, `stories`, `calls`,
`push_subs`, `public_stickers`, `group_members`, `group_summaries`, `group_join_requests`,
`blob_access` (`chat_a`, `chat_b`, `story_user`), `blob_access_members`
y `user_privacy_users.target_id`. (`default_stickers` es local y **no** tiene FK.)

### 3.2 `user_profiles` — perfil público

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | PK, FK → `users.id` CASCADE | Dueño del perfil. |
| `display_name` | TEXT | NOT NULL default '' | Nombre visible. Si está vacío se usa `username`. |
| `avatar_ref` | TEXT | NOT NULL default '' | Data-URL de la foto (máx. ~2 MB, validado por el servidor). |
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
| `feature` | TEXT | CHECK: `foto`, `nota`, `descripcion`, `online`, `historias`, `llamadas`, `mensajes`, `compartir`, PK compuesta | Qué se está regulando (`online` = quién ve «en línea» y última vez). |
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
| `accent` | TEXT | NULL | Color de acento de la interfaz (elegido aparte del color de las burbujas; se comparte entre todas las páginas). Se añadió por `ALTER TABLE`, por eso aparece al final en las bases migradas. |
| `keep_archived` | INTEGER | CHECK 0/1, default 0 | Si los mensajes nuevos de un chat archivado deben volver a mostrarlo. |
| `wallpaper_ref` | TEXT | NOT NULL default '' | Imagen de fondo (data-URL). |
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
| `avatar_ref` | TEXT | NOT NULL default '' | Foto (data-URL, máx. ~2 MB). |
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

### 3.13 `user_rid` — rid de revocación, y sesiones sin tabla (v10)

Las sesiones son **stateless**: el servidor genera el token (JWT HS256,
secreto derivado por HKDF-SHA256 de la llave maestra, dominio
`zlapy/session-token/v1`), lo firma y lo guarda **solo en la cookie HttpOnly
del navegador**. No hay filas que guardar, purgar ni migrar.

Para poder revocar sin almacén, cada cuenta tiene su rid en `user_rid`:

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | PK, FK → `users.id` CASCADE | Cuenta dueña. |
| `rid` | TEXT | NOT NULL | Identificador de sesión de la cuenta. Rota en registro, cambio de contraseña y cambio de cuenta (el logout es local al navegador y ya no rota). |
| `password_changed_at` | INTEGER | NOT NULL default 0 | Última vez que cambió la contraseña (segunda barrera de revocación). |
| `logged_out_at` | INTEGER | NOT NULL default 0 | Último logout (segunda barrera de revocación). |

El JWT lleva `{ sub, iss: 'zlapy-session', nbf, jti, checksum, exp }` y
**no se guarda ningún token**: cada petición recalcula la firma y compara el
`checksum` del token — SHA-256 canónico de `id | username | password_hash |
rid` de la cuenta— con el estado vigente (`src/auth/rid.js`). La comparación
usa `timingSafeEqual`. Todo token emitido antes de una rotación queda
descuadrado, de golpe y para todos los dispositivos.

La **segunda barrera** mira el tiempo: un token con `iat` anterior a
`password_changed_at` o a `logged_out_at` (comparando a granularidad de
segundo) se rechaza aunque el checksum no se haya recalado. Es la red para
bases migradas, donde el rid nuevo llega sin marcas fiables.

Las cookies por cuenta (`chatlocal_account_<id>`) permiten tener varias
cuentas abiertas en el mismo navegador; cada una lleva su propio token
(`jti` aleatorio: sin él, dos tokens emitidos en el mismo segundo serían
idénticos). La caducidad (`exp`, 30 días) es una red de seguridad, no el
mecanismo de revocación.

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
| `crypto_version` | INTEGER | NOT NULL default 3 | 3 = sobre PCE3 (cifrado con la `auth_key` del autor, con cabecera interna y **firma Ed25519**). Es el único formato que el servidor lee: si encuentra una fila con otra versión, **arranca abortando** (antes servía historiales silenciosamente descartados). |
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
la tabla `blobs` (base aparte, `data/zlapy-blob.db`).

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
| `id` | TEXT | NOT NULL, PK compuesta | UUID de la llamada. **Compartido por los dos extremos**: llamador y receptor tienen cada uno su fila. |
| `owner` | TEXT | NOT NULL, FK → `users.id` CASCADE, PK compuesta | A quién pertenece esta entrada del historial. |
| `peer` | TEXT | NULL | Nombre del otro extremo, **cifrado en reposo**. Se reescribe al renombrar la cuenta (columna y blob `data`). |
| `peer_hash` | TEXT | NULL | HMAC del nombre normalizado (**índice a ciegas**, `src/crypto/peer-index.js`). Columna de búsqueda: localizar renombrados y purgar es O(log n) sin descifrar. |
| `ts` | INTEGER | NOT NULL | Cuándo. |
| `data` | TEXT | NULL | JSON cifrado con la duración y el resultado. |

Dos arreglos que explican la forma actual:

* **v11 (índice a ciegas).** El nombre del par iba cifrado y las búsquedas por
  nombre (renombre, purga al borrar cuenta) recorrían y descifraban **todo**
  el historial: O(N) de toda la instalación. `peer_hash` (HMAC-SHA256 con
  subclave HKDF de la llave maestra) permite localizar por nombre sin
  revelarlo. El índice antiguo (`idx_calls_peer`) indexaba el texto cifrado:
  no servía para nada y se suelta.
* **v12 (PK `(owner, id)`).** La PK era el `id` global y los dos extremos
  comparten callId: el `INSERT OR REPLACE` del receptor machacaba la fila del
  llamador y, tras un reinicio, solo el historial de quien recibió la llamada
  volvía a cargar. Con la PK compuesta, cada cuenta conserva su registro
  (`dir: 'out'` / `dir: 'in'`).

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
| `created_at` | INTEGER | NULL | Alta de la clave. |
| `updated_at` | INTEGER | NULL | Última rotación. |

La sal, el `session_id` y el `msg_id` **no son columnas**: van dentro del sobre
cifrado (la sal rota cada 30 minutos y el `msg_id` es monótono por sesión).

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

### 3.25 Base de adjuntos (`data/zlapy-blob.db`)

| Tabla | Columna | Significado |
| --- | --- | --- |
| `blobs` | `hash` (PK) | SHA-256 del contenido. |
| `blobs` | `data` | Contenido **cifrado en reposo**. |

Es la **única tabla fuera de `src/db/schema.js`**: la crea `src/db/database.js`
al abrir (`CREATE TABLE IF NOT EXISTS`) y no tiene versión ni migraciones: si
existe, se usa; si no, se crea vacía. El nombre por defecto deriva de `DB_NAME`
(`zlapy` → `zlapy-blob.db`; las instalaciones antiguas conservan `blob.db`).

Los blobs se borran cuando ninguna fila de `blob_access` los referencia
(`pruneBlobHashes`).

### 3.26 Tablas de lista de chats y biblioteca de stickers

**`user_chat_prefs` — fijados, no leídos y archivados, sincronizados entre dispositivos.**

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Dueño. |
| `peer_key` | TEXT | NOT NULL, PK compuesta | Clave del chat: `dm:<idA>__<idB>`, `group:<gid>` o `saved` (mensajes guardados). |
| `pinned_at` | INTEGER | NULL | Fijado arriba (0/1 por convenio). |
| `unread` | INTEGER | NULL | No leídos que ve la lista. |
| `archived` | INTEGER | NULL | Archivado. |
| `updated_at` | INTEGER | NULL | Última escritura. |

**`user_sticker_blobs`** — qué blobs de sticker referencia cada cuenta (para conservarlos o purgarlos):

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Cuenta. |
| `hash` | TEXT | NOT NULL, PK compuesta | Blob referenciado. |

**`public_stickers`** y **`public_sticker_tags`** — biblioteca pública de stickers publicados voluntariamente (con sus etiquetas de búsqueda):

| Tabla | Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- | --- |
| `public_stickers` | `hash` | TEXT | PK | SHA-256 del WebP/GIF. |
| `public_stickers` | `user_id` | TEXT | FK → `users.id` CASCADE, NOT NULL | Quién lo publicó. |
| `public_stickers` | `created_at` | INTEGER | NOT NULL | Alta. |
| `public_sticker_tags` | `hash` | TEXT | FK → `public_stickers.hash` CASCADE, PK compuesta | Sticker etiquetado. |
| `public_sticker_tags` | `tag` | TEXT | NOT NULL, PK compuesta | Etiqueta (búsqueda sin acentos). |

**`default_stickers`** — catálogo del pack local bbot que el servidor siembra al arrancar (sin FK a `users`: es material local):

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `expression` | TEXT | PK | Clave de la expresión (`idle`, `happy`…). |
| `hash` | TEXT | NOT NULL UNIQUE | Hash del WebP. |
| `label` | TEXT | NOT NULL | Nombre visible. |
| `tags` | TEXT | NOT NULL | Etiquetas separadas. |
| `sticker` | TEXT | NOT NULL | Data-URL o ruta local. |
| `position` | INTEGER | NOT NULL | Orden. |

### 3.27 `message_reactions` — reacciones persistentes (v8)

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `message_id` | TEXT | FK → `messages.id` CASCADE, PK compuesta | Mensaje reaccionado. |
| `user_id` | TEXT | FK → `users.id` CASCADE, PK compuesta | Quién reacciona. |
| `emoji` | TEXT | NOT NULL, CHECK `length(emoji) > 0`, PK compuesta | Emoji elegido. |
| `updated_at` | INTEGER | NOT NULL | Última vez (permite cambiarla). |

Cambiar de emoji sobrescribe la fila: **una reacción por usuario y mensaje**.

### 3.28 `blob_access_members` — foto de miembros de un adjunto de grupo

| Columna | Tipo | Restricciones | Significado |
| --- | --- | --- | --- |
| `hash` | TEXT | NOT NULL, PK compuesta | SHA-256 del adjunto. |
| `message_id` | TEXT | NOT NULL, FK → `messages.id` CASCADE, PK compuesta | Mensaje que lo publicó. |
| `user_id` | TEXT | NOT NULL, FK → `users.id` CASCADE | Miembro que podía verlo entonces. |

Copia congelada de `group_members` en el momento de publicar: quien entró al
grupo después **no** gana acceso a los adjuntos anteriores.

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
   (`calls.peer_hash = <hash del nombre>`, O(log n)); el propio cae por
   cascada. Las filas cuyo nombre ya no se puede descifrar (sin hash) se
   purgen con la comparación lenta de siempre, para no dejar nada.
6. **La cuenta.** `DELETE FROM users WHERE id = ?`: aquí caen
   **todas** las cascadas del punto 3.1.
7. El servidor poda los blobs huérfanos, limpia la RAM (usuarios, perfiles,
   notas, bloqueos, sesiones, push, cachés), avisa a los contactos
   (`chatDelete`), refresca los grupos supervivientes y libera el nombre de
   usuario **al instante**.

Consecuencia práctica: se puede borrar una cuenta y **volver a registrarla
con el mismo nombre sin reiniciar el servidor**; el login viejo deja de
funcionar y las cookies de esa cuenta se limpian solas (`gone: true`, la
cuenta se quita de la lista de cuentas conectadas).

---

## 5. El esquema al arrancar (v12, con migraciones idempotentes)

Al arrancar, el servidor ejecuta `ensureSchema(db)` → `applySchema(db)`:
aplica el esquema vigente con `CREATE TABLE / CREATE INDEX IF NOT EXISTS`
(idempotente) y **migra lo que falte** de instalaciones anteriores, siempre
con pasadas idempotentes que no tocan lo que ya está al día:

| De | Qué hace |
| --- | --- |
| v9 | Suelta la tabla `sessions` (los tokens pasaron a JWT stateless). |
| v10 | Crea `user_rid` y retira `users.auth_version` (la revocación pasa al rid + checksum). |
| v11 | **Pre-`ALTER`**: si `calls` existe y no tiene `peer_hash`, lo añade (para que luego pueda crearse su índice). |
| v12 | Suelta `idx_calls_peer` (indexaba texto cifrado: inútil desde que existe `peer_hash`) y **reconstruye `calls`** con PK `(owner, id)` copiando solo las filas cuyo `owner` sigue en `users` (descarta huérfanas) — con PK global, el segundo extremo machacaba la fila del primero. |
| siempre | `ALTER` idempotentes que añaden columnas a bases ya creadas: `user_chat_prefs.archived`, `user_chat_settings.keep_archived`, `user_chat_settings.accent` (este último sin CHECK). |
| v9 (privacidad) | `migratePrivacyFeatures`: si el SQL de `user_privacy` no menciona `'online'`, reconstruye `user_privacy` y `user_privacy_users` dentro de una transacción con la CHECK ampliada. Idempotente: si ya admite `online`, no toca nada. No la llama `server.js` explícitamente: corre dentro de `applySchema`. |

Dos rellenos necesitan la **llave maestra** (derivar el rid y hashear los
nombres) y por eso NO van en `applySchema` —corre al abrir la base, antes de
que la llave exista— sino al arrancar el servidor, ya con ella en RAM
(`backfillUserRids`, `backfillCallPeerHashes` en `server.js`):

* **`backfillUserRids` es letal**: una cuenta sin rid no acepta ningún token,
  así que si el relleno falla el servidor sale con **exit 78** y no arranca.
* **`backfillCallPeerHashes` no es letal**: avisa y sigue. Las filas cuyo nombre
  ya no se puede descifrar se quedan sin `peer_hash` a propósito (las cubre la
  comparación lenta de siempre).

El número de versión vive en `meta.schema_version` (`SCHEMA_VERSION` en
`src/db/schema.js`).

**El servidor no migra el CIFRADO al arrancar.** Lee los dos formatos de
mensaje (el heredado `PCE2` y el nuevo `PCE3`) y escribe siempre el nuevo,
así que el histórico se va re-cifrando solo a medida que se reescribe. Para
convertirlo todo de golpe existe `ops/crypto/reencrypt-master.js` (manual, con
respaldo previo, idempotente y **eliminable**: el servidor no lo importa).

El esquema incluye índices para las columnas hijas de las claves ajenas y para
las búsquedas de servicio (`idx_messages_to`, `idx_messages_from`,
`idx_messages_chat_ts`, `idx_summaries_peer`, `idx_gs_gid`, `idx_ugs_gid`,
`idx_ba_hash`, `idx_ba_message`, `idx_ba_group`, `idx_ba_story`,
`idx_ba_chat_a`, `idx_ba_chat_b`, `idx_bam_message`, `idx_bam_user`,
`idx_upu_target`, `idx_ump_peer`, `idx_groups_owner`, `idx_groups_visibility`,
`idx_public_stickers_recent`, `idx_public_sticker_tags_tag`,
`idx_user_sticker_blobs_hash`, `idx_mdel_user`, `idx_cdel_user`,
`idx_message_reactions_message`, `idx_stories_ts`, `idx_calls_owner_ts`,
`idx_calls_peer_hash`) para que las cascadas de borrado y el listado no hagan
full-scan, y retira los redundantes
(`idx_summaries_owner`, `idx_gs_owner`, `idx_creq_from`,
`idx_messages_hash`, `idx_calls_peer`).

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

-- Revocación y llamadas
SELECT u.username, r.rid, r.password_changed_at, r.logged_out_at
FROM user_rid r JOIN users u ON u.id = r.user_id ORDER BY u.username;

SELECT c.id, u.username AS dueño, c.peer_hash IS NOT NULL AS con_hash
FROM calls c JOIN users u ON u.id = c.owner ORDER BY c.ts DESC LIMIT 20;
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
   `zlapy-blob.db` se limpian en los caminos de borrado (`pruneBlobHashes`) y al
   al borrar el mensaje o la historia que lo usaba; no existe un barrido periódico automático.
6. La contraseña y las claves solo existen en columnas dedicadas y, en el caso
   de las claves, cifradas en reposo.
7. Datos sensibles (mensajes, historias, adjuntos, claves) nunca se escriben
   en claro: pasan por AES-256-GCM con la llave maestra (derivada de la
   credencial del propietario: `DB_USER` + `DB_PASSWORD` del `.env`).
8. Toda cuenta tiene exactamente una fila en `user_rid`; sin rid, ningún
   token de la cuenta valida (sesión cerrada de forma segura).
9. De cada llamada hay como máximo una fila por `(owner, id)`: los dos
   extremos conviven y ninguno pisa al otro.

---

## 8. Archivos relacionados

| Archivo | Papel |
| --- | --- |
| `src/db/schema.js` | Esquema v12, migraciones idempotentes (v9→v12) y rutinas de borrado en cascada. |
| `src/auth/rid.js` | Rid de cuenta, checksum canónico del token y generación del rid aleatorio. |
| `src/crypto/peer-index.js` | Índice a ciegas de nombres de par (HMAC) para `calls.peer_hash`. |
| `test/db/schema.test.js` | Tests de esquema, cascadas y restricciones. |
| `src/crypto/message-crypto.js` | Cifrado en reposo (`encryptAtRest` / `decryptAtRest`) y firmas Ed25519. |
| `src/crypto/mtproto.js` | Cifrado en la nube (MTProto 2.0): `auth_key`, `msg_key`, `aes_key`/`aes_iv`, cabecera interna, relleno y ventana anti-repetición. |
| `src/crypto/user-auth-keys.js` | `auth_key` por usuario y cifrado por usuario (lo usan el servidor y el script de migración). |
| `ops/crypto/reencrypt-master.js` | Migración **manual** al esquema de cifrado en la nube (no la hace el servidor al arrancar). |
| `test/http/security-regressions.test.js` | Tests de regresión de la auditoría de seguridad del 2026-10-19. |
| `src/shared/appearance.js` | Validación de la apariencia del chat (`user_chat_settings`). |

### Documentación relacionada

| Documento | Contenido |
| --- | --- |
| [`ARQUITECTURA.md`](ARQUITECTURA.md) | Cómo encaja la base con el resto: arranque, estado en memoria, caché y transacciones. |
| [`CRIPTOGRAFIA.md`](CRIPTOGRAFIA.md) | Qué se guarda cifrado y con qué llave (`user_auth_keys`, `meta.crypto_version`). |
| [`API.md`](API.md) | Las rutas que leen y escriben estas tablas. |
| [`FICHEROS.md`](FICHEROS.md) | Qué hace cada fichero del repositorio. |
| `data/zlapy.db` | Base de datos principal. |
| `data/zlapy-blob.db` | Base de adjuntos cifrados. |

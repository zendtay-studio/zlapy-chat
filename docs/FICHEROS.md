# Mapa de ficheros de Zlapy

Inventario de todos los ficheros del repositorio: qué hace cada uno, qué exporta y quién lo consume.

- **Alcance**: todo lo versionado más `server.js`, `src/`, `ops/`, `public/`, `test/`, `docs/` y `.github/`.
- **Líneas**: `wc -l` sobre el fichero tal cual está en disco (los binarios no tienen líneas).
- **No se documenta el contenido** de `data/` ni de `backups/`: son persistencia, no código.

Complementa a:
- `README.md` — instalación, uso y operación.
- `docs/API.md` — el contrato HTTP/WebSocket.
- `docs/ESQUEMA-BD.md` — el detalle de las tablas y sus columnas.

---

## 1. Árbol del repositorio

```
/                         raíz del proyecto
├── server.js             punto de entrada del proceso
├── package.json          dependencias y scripts npm
├── package-lock.json     versiones exactas (se versiona: reproducibilidad)
├── .env.example          plantilla de configuración (la real NO se versiona)
├── .gitignore            lista de lo que queda fuera
├── zty.yml.example       plantilla de cloudflared (la real NO se versiona)
├── README.md             documentación de uso
├── .github/workflows/    CI
├── src/                  backend, partido por dominio
│   ├── config.js  state.js
│   ├── auth/  calls/  chat/  contacts/  crypto/  db/
│   ├── groups/  http/  meta/  profile/  push/
│   ├── realtime/  shared/  stickers/  stories/  users/
├── ops/                  scripts de operación (supervisor, túnel, respaldos, llave, migración)
├── public/               cliente web (HTML/CSS/JS) y service worker
├── test/                 suite de pruebas (node --test)
└── docs/                 documentación técnica
```

**Capas y dirección de las dependencias** (de arriba abajo; el `crypto/setup.js` es el único que se salta a la capa de base de datos, y los *imports perezosos* son la única forma de volver hacia arriba):

```
server.js
  └── src/http/servers.js ─────────► src/http/router.js ──► src/<dominio>/routes.js
        │                                    │                       │
        │                                    │                       ▼
        │                                    │                 src/<dominio>/store.js
        │                                    │                       │
        ▼                                    ▼                       ▼
   src/realtime/websocket.js  ──────►  src/db/statements.js  ◄──────┘
                                             │
                                             ▼
                                      src/db/database.js ──► src/db/schema.js
                                             │                     (SQL puro)
                                             ▼
                                     src/crypto/setup.js ──► master-key.js
                                                           ├─► message-crypto.js
                                                           ├─► user-auth-keys.js ──► mtproto.js
                                                           └─► transport.js
```

`src/state.js` (caché en RAM) y `src/shared/*` (utilidades puras) cuelgan de todos los dominios, pero no dependen de ellos.

---

## 2. Ficheros de la raíz

| Fichero | Líneas | Qué hace | Exporta / notes |
|---|---:|---|---|
| `server.js` | 74 | Arranque. Antes de abrir las bases ajusta permisos de disco al mínimo que exige la operación (directorios `data/`, `data2/` y `backups/` a 0700, bases y `.env` a 0600, best-effort y solo si hace falta), comprueba que `meta.crypto_version` de la base sea `2` (si no, aborta con mensaje explícito), carga cuentas/grupos/historias en RAM con `loadFromDb()` y lanza `src/http/servers.js`. | No exporta nada: es un script de efecto. El mapa de módulos está documentado en su cabecera. |
| `package.json` | 44 | Metadatos y scripts npm: `start` → `ops/supervisor.js`, `tunnel`, `key`, `backup`, `migrate:mtproto`, `test` → `node --test test/*.test.js`, `postinstall` (verifica el binario nativo de `better-sqlite3`). Deps: `better-sqlite3`, `dotenv`. `engines.node >= 22`. | — |
| `package-lock.json` | 58 | Versiones exactas. **Sí se versiona** a propósito (`npm ci` en CI, auditoría de terceros). | — |
| `.env.example` | 106 | Plantilla comentada de toda la configuración: `PORT`, `DATA_DIR`, `CHAT_MASTER_KEY`, límites de mensajes, `SQLITE_*`, TTL de notas/historias/sesiones, `CLOUDFLARE_TUNNEL_TOKEN`, `GIPHY_API_KEY` y el bloque `SUPERVISOR_*`. | — |
| `.gitignore` | 62 | Excluye secretos y datos: `.env`, claves TLS (`*.pem`/`*.key`/`*.crt`…), `*.db`, `data/`, `data2/`, `backups/`, `*.bak`, `zty.yml`, `node_modules/`, `.zlapy.pid`. | — |
| `zty.yml.example` | 33 | Plantilla de `cloudflared`: `tunnel`, `protocol: http2`, `edge-ip-version: "4"`, `ingress` con una regla de host y un *catch-all* `http_status:404`. | — |
| `README.md` | 742 | Guía de instalación, uso, cifrado en nube, base de datos, respaldos, operación y estructura. | Fichero volátil: lo edita a menudo y crece con cada sección nueva. |

---

## 3. `src/` — núcleo

| Fichero | Líneas | Qué hace | Exporta |
|---|---:|---|---|
| `src/config.js` | 179 | Resuelve la configuración desde `process.env` con valores por defecto, valida rangos y expone las rutas (`ROOT`, `PUBLIC`, `DATA`, `DB_PATH`, `BLOB_DB_PATH`). Carga el `.env` de la raíz con `dotenv` (las variables ya presentes en el entorno mandan). Cotas de la ronda SECOA: `MAX_INLINE_MEDIA_CHARS`, `STORY_INLINE_CHAR_LIMIT`, `MAX_GROUP_MEMBERS`, `CHAT_PAGE_CACHE_MAX_BYTES`, `MAX_SESSIONS_PER_USER`. Expone `tlsState` (estado del arranque TLS, incluido el **degradado sin certificado**) y las rutas de los certificados. | `DEFAULTS`, `loadConfig(env)`, `ROOT`, `CONFIG`, `tlsState`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `GIPHY_API_KEY`, `PORT`, `PUBLIC`, `DATA`, `DB_PATH`, `BLOB_DB_PATH` |
| `src/state.js` | 57 | Capa de caché en RAM: cuentas, índices, perfiles, grupos, bloqueos, sesiones, suscripciones push, notas, llamadas, historias, ofertas pendientes y caché de páginas de chat. La base sigue siendo la fuente de verdad. | `setStories`, `setNotesMap`, `setCallFiles` (seters) + `users`, `usernameIndex`, `profiles`, `groupCache`, `groupPubCache`, `blockedSet`, `sessionCache`, `pushSubs`, `notesMap`, `callFiles`, `stories`, `pendingOffers`, `chatPageCache`, `CHAT_PAGE_TTL`, `CHAT_PAGE_MAX`, `AUTH_SESSION_TTL` |

---

## 4. `src/db/` — persistencia

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/db/database.js` | 80 | Abre las dos bases SQLite (`zlapy.db` y `blob.db`) con WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout` y `cache_size` configurables. Comprueba el `crypto_version` guardado en `meta` y aborta si no es `2`. Aplica el esquema y verifica que `messages` tenga las columnas `crypto_version`, `crypto_group_id`, `signature`, `signing_public_key`. | `db`, `blobDb`, `messageSchema` | todo `src/` |
| `src/db/schema.js` | 460 | **Única fuente de verdad del esquema (v3).** 20 bloques de tablas normalizadas con `CHECK`/`UNIQUE` y claves ajenas `ON DELETE CASCADE`. Sin migraciones: `ensureSchema` es idempotente y registra `schema_version`. Además implementa en SQL+JS lo que la cascada no expresa: `deleteAccountRows` (purga DMs, mensajes, historias, llamadas y hereda la administración de grupos), `deleteGroupRows`, `deleteMessageRowsWhere`. | `SCHEMA_VERSION`, `SCHEMA_SQL`, `applySchema`, `ensureSchema`, `tableExists`, `tableColumns`, `deleteAccountRows`, `deleteGroupRows`, `deleteMessageRowsWhere` | `database.js`, `transactions.js`, `server.js`, `ops/migrate-to-mtproto.js`, `test/schema.test.js` |
| `src/db/statements.js` | 272 | Compila **una sola vez** todas las consultas del servidor (better-sqlite3 no cachea `db.prepare`). Agrupa 127 sentencias en el objeto `Stmt`, con comentarios por dominio. `listSessionHashesByUser` (orden por expiración descendente) sostiene el tope de sesiones por cuenta. `deleteGroupSummary` vive aquí para no crear un ciclo con `src/groups/store.js`. | `Stmt` (objeto gigante), `deleteGroupSummary(owner, gid)`, `listSessionHashesByUser` | prácticamente todos los módulos de dominio |
| `src/db/transactions.js` | 89 | Envuelve en transacciones las escrituras atómicas (`sendMessage`, `deleteMessage`, `markSeenMessage`, `deleteGroup`, `deleteAccount`, `saveUser`) y purga los blobs que quedan sin referencia en `blob_access`. Cachea las sentencias de `removeBlobAccess` por variante de `where`. | `stmtBlobHasReference`, `stmtBlobRemove`, `pruneBlobHashes`, `blobAccessWhereCache`, `removeBlobAccess`, `tx` | `router.js`, `chat/routes.js`, `stories/routes.js`, `profile/routes.js`, `realtime/websocket.js`, `chat/messages.js`, `users/store.js` |

---

## 5. `src/crypto/` — cifrado

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/crypto/master-key.js` | ~125 | Obtiene la llave maestra de 32 bytes `CHAT_MASTER_KEY` del `.env` (base64). Si falta y la base ya tiene datos, **aborta** (una llave nueva haría ilegibles los datos). Genera la llave (CSPRNG) y la escribe en el `.env` con escritura atómica si la instalación es nueva. | `getMasterKeyBytes`, `baseDeDatosConDatos`, `readKeyFromEnvFile` | `crypto/setup.js` |
| `src/crypto/message-crypto.js` | 213 | Fábrica del cifrado: `encryptAtRest`/`decryptAtRest` (AES-256-GCM, prefijo `PCE1:`), `encryptMessage`/`decryptMessage` (AES-256-GCM con AAD ligado al contexto del mensaje, prefijo `PCE2:`) y firma **Ed25519** de cada mensaje (`signMessage`/`verifyMessage`) con clave derivada por HKDF de la `auth_key` del autor (o de la llave maestra como respaldo). Cachea los pares de claves (máx. 500). | `createMessageCrypto(masterKey, options)` → `{ encryptAtRest, decryptAtRest, encryptMessage, decryptMessage, signMessage, verifyMessage, getSigningPublicKey, forgetSigningKey }` | `crypto/setup.js`, `ops/migrate-to-mtproto.js` |
| `src/crypto/mtproto.js` | 233 | Réplica de la **estructura** de MTProto 2.0 (cifrado "en la nube"): `auth_key` de 2048 bits, `server_salt` rotado, `session_id`, `msg_id` monotónico, `msg_key` = 128 bits centrales del SHA-256, derivación exacta de `aes_key`/`aes_iv`, cabecera interna cifrada (salt/session/msg_id/seq_no/len) y relleno 12..27 bytes. Desviación documentada: **AES-256-GCM en vez de IGE** (IGE no está autenticado). Sobre `PCE3:`. | `AUTH_KEY_BYTES`, `PADDING_MIN`, `PADDING_MAX`, `INTERNAL_HEADER_BYTES`, `DOMAIN`, `authKeyId`, `generateAuthKey`, `deriveKeys`, `computeMsgKey`, `buildPadding`, `buildInternalHeader`, `readInternalHeader`, `encrypt`, `decrypt`, `keyFingerprint`, `nextMsgId`, `msgIdAcceptable` | `crypto/setup.js`, `crypto/user-auth-keys.js`, `chat/messages.js`, `users/store.js`, `ops/migrate-to-mtproto.js` |
| `src/crypto/user-auth-keys.js` | 117 | Gestión de la `auth_key` **por usuario** (tabla `user_auth_keys`): carga/crea/cachea la clave (cifrada en reposo con la llave maestra), rota la sal cada 30 min y expone `encryptForUser`/`decryptForUser` (PCE3 con la `auth_key`, PCE1 heredado con la maestra) más `messageContextBytes` (contexto ligado al cifrado). Vive aparte para que el servidor y el script de migración usen **exactamente** la misma implementación. | `createUserAuthKeys({db, Stmt, encryptAtRest, decryptAtRest})` → `{ authKeyRecord, ensureAuthKey, rotateSaltIfNeeded, encryptForUser, decryptForUser, messageContextBytes, randomUint64, authKeyCache, SALT_ROTATION_MS }`; además `AUTH_KEY_CACHE_MAX`, `SALT_ROTATION_MS` | `crypto/setup.js`, `ops/migrate-to-mtproto.js` |
| `src/crypto/setup.js` | 55 | Punto único de instanciación: crea la llave maestra y el `messageCrypto` (con la `auth_key` del autor como semilla de firma), y expone la API de cifrado que consume el resto del servidor. | `masterKey`, `messageCrypto`, `encryptAtRest`, `decryptAtRest`, `authKeys`, `authKeyRecord`, `ensureAuthKey`, `rotateSaltIfNeeded`, `encryptForUser`, `decryptForUser`, `messageContextBytes` | casi todos los módulos (`users/`, `chat/`, `groups/`, `stories/`, `calls/`, `push/`, `profile/`) |
| `src/crypto/transport.js` | 212 | Claves y sobre del **canal**: deriva el par X25519 de la llave maestra (HKDF-SHA256 + *clamping*), publica la clave pública y cifra/descifra sobres con ChaCha20 y HMAC-SHA256 (cifrar-y-luego-autenticar), atados a método, ruta, tiempo y estado. El mismo módulo sirve al HTTP y al WebSocket (con otro dominio de HKDF). | `TRANSPORT_ALGO`, `MAX_CLOCK_SKEW_MS`, `transportPublicKey`, `sessionFromEphemeral`, `decryptEnvelope`, `encryptEnvelope`, `requestAad`, `responseAad`, `deriveSessionKey`, `seal`, `open` | `http/transport.js`, `realtime/encrypted.js`, `meta/routes.js`, `test/transport.test.js` |

---

## 6. `src/shared/` — utilidades puras (sin estado)

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/shared/validation.js` | 98 | Validación de entrada: nombre de usuario (`USERNAME_RE` + reservados `__proto__`/`constructor`/`prototype`), avatares y medios (solo data-URLs de imagen/video/audio o el SVG propio), stickers (allowlist de CDN de GIPHY → anti-fuga de IP/UA), MIME, id de mensaje, allowlist de endpoints push (**anti-SSRF**) y `clientIp` (solo confía en `CF-Connecting-IP` si viene por loopback). | `USERNAME_RE`, `RESERVED_USERNAMES`, `validUsername`, `DATA_URL_IMAGE_RE`, `DATA_URL_MEDIA_RE`, `validAvatar`, `validStoryMedia`, `STICKER_ALLOWED_HOSTS`, `validStickerData`, `MIME_RE`, `validMime`, `validMessageId`, `clampStr`, `PUSH_ALLOWED_HOSTS`, `validPushEndpoint`, `clientIp`, `NOTE_TTL` | `auth/routes.js`, `router.js`, `chat/routes.js`, `stories/routes.js`, `stickers/routes.js`, `push/routes.js`, `profile/routes.js`, `groups/routes.js`, `realtime/websocket.js` |
| `src/shared/limits.js` | 71 | Topes de tamaño del contenido (directo/grupo/historia/descripción) y el limitador de frecuencia de ventana deslizante por cuenta. `characterCount` cuenta puntos de código y corta pronto (`stopAt`) para no reservar 200 MB de heap. | `MESSAGE_LIMITS`, `characterCount`, `createMessageRateLimiter(limit, windowMs, now)` | `http/helpers.js`, `http/rate-limit.js`, `router.js`, `chat/routes.js`, `stories/routes.js`, `profile/routes.js`, `meta/routes.js` |
| `src/shared/types.js` | 63 | Normaliza el contenido estructurado que viaja dentro de un mensaje: encuestas (`normalizePollData` descarta los votos que envía el cliente) y tarjetas de contacto (`normalizeContactData` exige que el contacto exista). `togglePollVote` calcula el cambio de votos. | `normalizePollData`, `normalizeContactData`, `togglePollVote` | `router.js`, `chat/routes.js` |
| `src/shared/gallery.js` | 41 | Valida galerías: ≥2 elementos, hash SHA-256 válido, MIME de imagen, dimensiones acotadas, tope de elementos y de tamaño codificado. Guarda en el almacén de blobs los adjuntos que llegan con contenido. | `validateGallery(user, input, blobAvailableTo, storeBlob)` | `router.js`, `chat/routes.js` |
| `src/shared/message-data.js` | 25 | Desencripta los campos de texto de un mensaje guardados en el formato heredado (`PCE1:`) para que el resto del servidor los lea en claro. | `decryptLegacyMessageFields(message, decryptAtRest)` | `chat/messages.js` |
| `src/shared/appearance.js` | 46 | Normaliza la apariencia del chat que envía el cliente (colores hex, opacidad 0-80, blur 0-20, tamaño 12-22, fondo de pantalla como data-URL) y conserva del envío anterior lo no especificado. | `normalizeChatAppearanceSettings(settings, previous)` | `profile/routes.js` |
| `src/shared/avatar.js` | 34 | Genera un SVG identicon determinista a partir del UUID de la cuenta (SHA-256 → matiz y patrón de píxeles espejado). | `createDefaultAvatarSvg(accountId)` | `http/router.js` (`GET /avatar/:id.svg`) |
| `src/shared/static-path.js` | 70 | Resolución segura de ficheros estáticos: decodifica hasta 5 veces, rechaza traversal, barras invertidas, nombres reservados de Windows y segmentos ocultos; comprueba allowlist de extensiones y que el fichero real esté dentro de `public/` (con `realpath`, para neutralizar symlinks). | `decodeRequestPath(rawUrl)`, `resolvePublicFile(publicRoot, rawUrl)` | `http/router.js` |

---

## 7. `src/users/` — cuentas, perfil y privacidad

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/users/store.js` | 504 | Almacén de cuentas. Hidrata cada cuenta desde SQLite (perfil, contactos, stickers, grupos vistos, clave del dispositivo, nota, privacidad, apariencia, silencios, bloqueos), carga el estado global al arrancar (`loadFromDb`) y persiste (`writeUserRows` reescribe las ~8 tablas de la cuenta; `saveStickers`/`saveMutedPeers`/`saveChatSettings` son guardados quirúrgicos). También `regenerateAuthKey`: genera una `auth_key` nueva y **re-cifra** todo el contenido del usuario para no perder el historial. | `hydrateUserFromDb`, `loadFromDb`, `regenerateAuthKey`, `userFromRow`, `loadUserFromRow`, `accountByName`, `purgeUserFromMemory`, `writeUserRows`, `saveStickers`, `saveMutedPeers`, `saveChatSettings`, `saveUserToDb` | `server.js`, `auth/routes.js`, `auth/sessions.js`, `chat/routes.js`, `contacts/routes.js`, `profile/routes.js`, `groups/store.js`, `stickers/routes.js`, `realtime/websocket.js`, `db/transactions.js` |
| `src/users/helpers.js` | 67 | Utilidades de cuenta: `byId`/`byName` sobre la RAM, `parseJsonSafe` (JSON tolerante a datos corruptos), `usernameTakenInDb`, `accountId` (id estable aunque la cuenta no exista), `pairKeyFromIds` (clave de DM ordenada), `freshNote` (nota con caducidad) y silencios. | `uniq`, `parseJsonSafe`, `byId`, `byName`, `usernameTakenInDb`, `accountId`, `pairKeyFromIds`, `freshNote`, `mutedChatPeers`, `isChatMuted` | prácticamente todos los módulos de dominio |
| `src/users/privacy.js` | 86 | Privacidad **por función** (`foto`, `nota`, `descripcion`, `historias`, `llamadas`, `mensajes`, `compartir`): modos `server`/`contacts`/`nobody`/`except`/`only` con listas de usuarios. El bloqueo entre dos cuentas siempre gana a la regla de privacidad. | `PRIV_KEYS`, `PRIV_DEF`, `normPriv`, `isContact`, `accountsBlocked`, `privacyFor`, `permite`, `permiteDescripcion`, `isBlockedBy` | `router.js`, `chat/routes.js`, `contacts/routes.js`, `profile/routes.js`, `stories/routes.js`, `chat/media.js`, `realtime/notify.js`, `realtime/websocket.js` |

---

## 8. `src/chat/` — mensajes

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/chat/messages.js` | 315 | Núcleo del mensaje. `prepareStoredMessage` firma (Ed25519) y cifra el cuerpo con la `auth_key` del autor (PCE3) ligando el contexto del mensaje; `rowToMessage` hace el camino inverso y valida versión, descifrado y firma (devuelve `null` si algo falla). `resolveReply` resuelve la cita contra el mensaje real (nunca confía en el id ni en el autor que envía el cliente). `readMessagePage` pagina, `filterForViewer` aplica los borrados por usuario **al servir** (no al cachear), `getChatPage` cachea páginas de DM con **cota global de bytes** (`CHAT_PAGE_CACHE_MAX_BYTES`, 64 MiB) además del tope de entradas. `replyPreviewText`/`enrichReplies` preparan las citas para el cliente. | `messageBody`, `prepareStoredMessage`, `updateStoredMessage`, `rowToMessage`, `findMessage`, `findMessageRow`, `REPLY_ID_RE`, `resolveReply`, `replyPreviewText`, `enrichReplies`, `readMessagePage`, `filterForViewer`, `getChatPage`, `invalidateChatPage`, `deleteMessageById` | `http/router.js`, `chat/routes.js`, `groups/store.js`, `db/transactions.js`, `users/store.js` |
| `src/chat/routes.js` | 606 | Rutas HTTP del chat 1:1: envío (`/send`), lectura paginada (`/messages`), acuses (`/receipt`, con `receiptLimiter` 120/min), "ver una vez" (`/seen`), edición (`/msg/edit`), borrado (`/msg/delete`, `/chat/delete`), preferencias de silencio (`chatPrefsLimiter`), voto en encuestas, descarga de adjuntos (`/blob/:hash`) y resumen de conversaciones (`/chats/summary`). Aplica las mismas reglas de contenido y cuota que los grupos: medio sin hash limitado a `maxInlineMediaChars` (413 si pasa) y `bytesNuevos` cuenta **siempre** el `data` del mensaje para la cuota de blobs (SECOA-I-001). | `getRoute2197`, `getHave`, `getChatsSummary`, `getChatPreferences`, `postChatPreferences`, `postPollVote`, `postSend`, `postSeen`, `postReceipt`, `postMsgDelete`, `postMsgEdit`, `postChatDelete`, `postMessages` | `http/router.js` |
| `src/chat/summaries.js` | 123 | Resúmenes de conversación 1:1 (el último mensaje de cada chat). Se cifran con la clave del **dueño** del resumen; resuelve los nombres desde la RAM. Mantiene la cadena `prevId` para poder rehacer el resumen si se borra el último mensaje. | `resolveName`, `decorateForClient`, `readSummaryEntry`, `writeSummaryEntry`, `lastEntryFromMsg`, `onMessageSentSummary`, `onReadSummary`, `onMessageDeletedSummary`, `onChatDeletedSummary`, `renamePeerInSummaries` | `chat/routes.js`, `router.js`, `groups/store.js`, `chat/mentions.js` |
| `src/chat/media.js` | 54 | Adjuntos (blobs). `storeBlob` exige un data-URL y verifica que el SHA-256 del contenido coincida con el hash declarado; `blobAvailableTo` decide el acceso por conversación, grupo o historia (**conocer el hash no da acceso al fichero**). | `blobHashOk`, `storeBlob`, `readBlob`, `blobAvailableTo` | `router.js`, `chat/routes.js`, `shared/gallery.js`, `stories/routes.js` |
| `src/chat/mentions.js` | 89 | `withMentions` resuelve los usuarios mencionados en un mensaje. `propagateUsernameChange` reescribe el nombre en todo el estado (perfiles, bloqueos, notas, historias, grupos, resúmenes, llamadas) cuando una cuenta cambia de nombre. | `withMentions`, `propagateUsernameChange` | `router.js`, `profile/routes.js` |

---

## 9. `src/groups/` — grupos

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/groups/store.js` | 270 | Estado de los grupos: `readGroup` normaliza y cachea en RAM; `writeGroupMeta` persiste grupo, miembros, roles y solicitudes (el material E2E —`cryptoId` y *keyboxes*— viaja cifrado en una sola columna); `pub` decide qué ve cada usuario (el `inviteCode` solo se entrega a admins); resúmenes de grupo con contador de no leídos. | `groupPolicies`, `normalizeGroup`, `readGroup`, `decryptGroupKeys`, `writeGroupMeta`, `invalidateGroupPubCache`, `pub`, `lastGroupMessage`, `groupBrief`, `groupLastEntry`, `readGroupSummary`, `writeGroupSummary`, `deleteGroupSummary`, `groupSummaryFor`, `updateGroupMessageSummaries`, `initializeGroupSummary` | `http/router.js`, `groups/routes.js`, `chat/routes.js`, `profile/routes.js`, `chat/mentions.js`, `realtime/websocket.js` |
| `src/groups/routes.js` | 117 | Rutas HTTP de grupos: listar los grupos de la cuenta, descubrir los públicos, ver las solicitudes de entrada y crear un grupo nuevo (idempotente por `id` solicitado, **rechaza con 400 cualquier creación que supere `CONFIG.maxGroupMembers` miembros iniciales**). | `getGroupsRequests`, `getGroups`, `getGroupsDiscover`, `postGroups` | `http/router.js` |

---

## 10. Resto de dominios

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/auth/routes.js` | 266 | Registro, login, alta/baja de cuentas vinculadas, cambio de cuenta y logout. Frenos de fuerza bruta **por cuenta y por IP** (umbrales 8 y 30) y de registro por IP (15/h). El cambio de contraseña o de nombre exige la contraseña actual. | `getAuthSession`, `getKey`, `postKey`, `postAuthRegister`, `postAuthLogin`, `postAuthAddAccount`, `postAuthSwitch`, `postAuthAccountRemove`, `postAuthLogout` | `http/router.js` |
| `src/auth/sessions.js` | 206 | Sesiones y cookies. Token opaco de 32 bytes en cookie `HttpOnly` + `SameSite=Lax`; hash SHA-256 en la base y caché en RAM. Cookie de cuenta (`chatlocal_account_<id>`) para varias cuentas en el mismo navegador. `originAllowed` es la primera barrera contra CSRF. **Tope de sesiones activas por cuenta** (`MAX_SESSIONS_PER_USER`, 20): `pruneSessionsForUser` borra las más antiguas (por `expires_at`) al crear una sesión nueva. `requestEncrypted`/`cookieSecure`/`isLoopbackPeer` deciden si la conexión es segura (TLS real o proxy de confianza) y si el cliente es el propio equipo: sobre ellas se apoyan la cookie `Secure` y el portillo del modo degradado. `passwordDigest` usa scrypt (N=16384, r=8, p=1) y `safeEqualHex` compara en tiempo constante. | `hashSessionToken`, `cookieValue`, `sessionCookie`, `accountCookieName`, `accountCookies`, `appendCookie`, `getSessionFromCache`, `sessionUser`, `setSessionCookie`, `setAccountSessionCookie`, `clearCookie`, `clearSessionCookie`, `createSession`, `createLinkedAccountSession`, `originAllowed`, `isLoopbackPeer`, `requestEncrypted`, `cookieSecure`, `passwordDigest`, `safeEqualHex` | `auth/routes.js`, `http/router.js`, `realtime/websocket.js`, `stickers/routes.js` |
| `src/profile/routes.js` | 341 | Perfil y cuenta: `GET /profile` con la privacidad aplicada, edición de perfil, ajustes de apariencia, notas, regeneración de la clave de cifrado (`/account/regenerate-key`) y **borrado irreversible de la cuenta** (exige contraseña). Incluye *rollback* manual si el renombrado falla a medias. | `getAccountChatSettings`, `getProfile`, `getNotes`, `postAccountProfile`, `postAccountChatSettings`, `postAccountRegenerateKey`, `postAccountDelete`, `postProfile`, `postNotes` | `http/router.js` |
| `src/contacts/routes.js` | 160 | Solicitudes de contacto (enviar, aceptar, rechazar, cancelar), lista de contactos y bloqueo entre cuentas. Al bloquear se rompe el contacto, se cancelan las solicitudes pendientes y se descartan las ofertas de llamada en curso. | `getContactsRequests`, `getContactsRequestsSent`, `postContacts`, `postContactsRemove`, `postContactsCancel`, `postContactsRespond`, `postBlock` | `http/router.js` |
| `src/stories/routes.js` | 175 | Historias: publicar, listar, ver, dar like, editar y borrar. Cada historia se guarda cifrada con la clave de su autor; el fan-out respeta la privacidad (`permite(..., 'historias', ...)`). El medio que se publica **sin hash** se limita a `CONFIG.storyInlineCharLimit` (4 000 000 caracteres → 413; SECOA-A-001); el flujo normal sube blob + hash. `like`/`view` responden con `200 {ok:false}` en lugar de 404 para no servir de oráculo de existencia. | `getStories`, `postStory`, `postStoryLike` | `http/router.js` |
| `src/stickers/routes.js` | 66 | Proxy de búsqueda de GIPHY (la clave del operador **no** sale del servidor; exige sesión y tiene límite por cuenta) y gestión de stickers favoritos (validados antes de guardarse, máx. 30). | `getGiphySearch`, `getStickers`, `postStickers` | `http/router.js` |
| `src/calls/routes.js` | 31 | Historial de llamadas de la cuenta (filtrando los interlocutores bloqueados) y registro del cierre de una llamada. | `getCalls`, `postCallLog` | `http/router.js` |
| `src/calls/store.js` | 70 | Registro de llamadas por cuenta (en RAM y cifrado en la base) y estado de cada llamada. `endUserCalls` cierra las llamadas vivas cuando se cae la última conexión, para no dejar la contraparte colgada. | `addCall`, `updateCall`, `hasCall`, `CALL_TERMINAL_STATES`, `endUserCalls` | `realtime/websocket.js`, `calls/routes.js` |
| `src/push/routes.js` | 53 | Alta y baja de suscripciones de dispositivos (las claves se guardan cifradas en reposo) y envío de una notificación de prueba. | `postPushSubscribe`, `postPushUnsubscribe`, `postPushTest` | `http/router.js` |
| `src/push/vapid.js` | 118 | Genera y guarda la clave VAPID (cifrada en reposo en `meta`), firma el JWT de autorización (ES256) y cifra cada notificación con WebPush (aes128gcm). `notifyUser` limpia las suscripciones caducadas (404/410) y avisa por log de los fallos. | `b64u`, `b64uDec`, `vapidRecord`, `VAPID`, `hkdfExtract`, `hkdfExpand`, `vapidAuth`, `pushTo`, `notifyUser`, `pushNameOf` | `http/router.js`, `chat/routes.js`, `contacts/routes.js`, `realtime/websocket.js`, `auth/routes.js` |
| `src/meta/routes.js` | 39 | Metadatos y salud: `GET /healthz` (comprueba que **ambas** bases respondan) y el volcado de límites que consume el cliente. | `getConfig`, `getHealthz` | `http/router.js` (solo `getHealthz`) |

---

## 11. `src/realtime/` — WebSocket

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/realtime/websocket.js` | 343 | Servidor WebSocket: upgrade (valida el *handshake* RFC 6455, exige sesión y origen válido), tope de 8 conexiones por cuenta, *token bucket* por conexión (200 frames/s, ráfaga 600), tope de buffer entrante (768 KB) y *heartbeat* que cierra conexiones colgadas. Acepta el saludo cifrado (`{type:"enc", ephemeral}`), descifra los frames `z1:` y deja el resto del manejo igual. Gestiona los frames de llamada, `typing`/`recording`, y el frame `privacy` (fusión de la matriz de privacidad + nota). Al final, tareas periódicas de limpieza: historias caducadas, sesiones caducadas y notas caducadas. | `rejectUpgrade`, `wsUpgradeInner`, `wsUpgrade` | `http/servers.js` |
| `src/realtime/notify.js` | 157 | Escritura de frames a los clientes y difusión. `wsSend`/`pushRawName` construyen la cabecera de frame, cifran el texto si el socket tiene sesión (`z1:`) y respetan el *backpressure* (1 MB pendiente → se corta el socket). `push`/`pushName` entregan a **todas** las conexiones de la cuenta. Además `userList`, `broadcastUsersAround`, `broadcastUsers`, `connectContacts`, `removeContacts` y el reparto de historias según privacidad. | `WS_MAX_PER_USER`, `WS_FRAME_RATE`, `WS_FRAME_BURST`, `WS_MAX_BACKLOG_BYTES`, `textFrameHead`, `wsSend`, `pushRawName`, `push`, `pushName`, `userList`, `broadcastUsersAround`, `broadcastUsers`, `updateContactRequests`, `connectContacts`, `removeContacts`, `liveStories`, `storyForViewer`, `pushStories` | prácticamente todos los módulos de dominio |
| `src/realtime/encrypted.js` | 77 | Sesión cifrada del WebSocket: procesa el saludo `enc` (32 bytes de clave efímera), deriva la clave en el dominio `zlapy-transport-v1/ws`, lleva contadores de nonce por sentido con las etiquetas `zlapyC2S`/`zlapyS2C` y sella/abre los frames `z1:`. Un frame inválido se descarta sin cerrar la conexión; sin saludo, todo sigue en claro. | `WS_PREFIX`, `WS_INFO`, `acceptHandshake`, `openFrame`, `sealFrame`, `wsNonce`, `wsAad` | `realtime/websocket.js`, `realtime/notify.js`, `test/transport.test.js` |
| `src/realtime/frames.js` | 118 | Framing WebSocket (RFC 6455) del subconjunto usado: exige frames enmascarados, acota longitud (256 KB/frame) y buffer (768 KB) con close 1009, rechaza frames de control fragmentados o >125 B (close 1002), contesta ping, ensambla fragmentación con tope de 4096 trozos y rechaza opcodes binarios (close 1003). | `parseFrames(socket, buf, onText)`, `closeFrame(code, reason)`, `MAX_FRAME_BYTES`, `MAX_BUFFER_BYTES`, `MAX_FRAGMENTS` | `realtime/websocket.js` |

---

## 12. `src/http/` — servidor HTTP

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/http/router.js` | 730 | **El enrutador.** Mantiene el orden de comprobaciones: forzado de TLS (301 a HTTPS) → rutas públicas (`/config`, `/healthz`, `/avatar/:id.svg`, páginas estáticas) → sesión → **portillo del modo degradado: `publicAuthPost` desde fuera de loopback → 503** → método → origen válido (CSRF) → cuerpo JSON con tope por ruta (8 KiB en las de auth, `MAX_HTTP_BODY_BYTES` en el resto). Si el `POST` trae `X-Zlapy-Enc`, descifra el cuerpo antes de interpretarlo y envuelve la respuesta. Contiene las acciones de grupo en línea (`join`, `leave`, `addMember`, `removeMember`, `approveAdmin`, políticas, *keyboxes*, envío de mensajes de grupo) con estas reglas de la ronda SECOA: **tope de `maxGroupMembers`** al crear/entrar/añadir, **el propietario no se puede expulsar** (403) y **cinco políticas de grupo son solo-admins** (`visibility`, `join_policy`, `add_policy`, `edit_policy`, `mention_all_policy`; 403 para el resto). | `handleRequest`, `handler` | `http/servers.js` |
| `src/http/transport.js` | 154 | Sobre cifrado en el ciclo HTTP: `isEncrypted` detecta la cabecera, `openRequest` valida versión/tiempo/clave/nonce/HMAC y devuelve el JSON descifrado más la sesión, y `sealResponse` intercepta `writeHead`/`end` para quitar `Content-Length`, anunciar `X-Zlapy-Enc`/`X-Zlapy-Resp-Nonce` y cifrar el cuerpo. **Anti-replay**: memoria de nonces (`nonceUsado`, `NONCE_MEMORY_MS`, tope 8192 entradas) que se registra **solo tras validar el MAC** — y rechaza nonce vacío o de más de 32 bytes (sin eso, un sobre sin nonce eludía el registro). | `isEncrypted`, `openRequest`, `sealResponse`, `nonceUsado`, `NONCE_MEMORY_MS` | `http/router.js`, `test/transport.test.js` |
| `src/http/servers.js` | 150 | Arranque y cierre ordenado. Crea el servidor HTTP y, si existen `cert.pem`/`key.pem`, el HTTPS; un `dispatcher` TCP decide por el primer byte si la conexión es TLS (0x16) y enruta el *upgrade* WebSocket por el mismo puerto. `SO_REUSEADDR` para reenganchar el puerto tras un reinicio. Con `FORCE_TLS` activo y sin certificados **no aborta**: marca `tlsState.degradedNoCert` (HTTP total, pero el router cierra la autenticación pública desde fuera de loopback). En `SIGTERM`/`SIGINT` cierra sockets, hace `wal_checkpoint(TRUNCATE)` y cierra las bases. | `httpSrv`, `httpsSrv`, `dispatcher`, `orderlyShutdown` | `server.js` |
| `src/http/responses.js` | 49 | Cabeceras de seguridad para **toda** respuesta (`nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP) y la CSP por petición (el host se valida con `CSP_HOST_RE` antes de meterse en la cabecera). `json()` es el envoltorio con `Cache-Control: no-store`. | `securityHeaders`, `CSP_HOST_RE`, `cspFor(host)`, `json(res, code, obj)` | todos los módulos de rutas |
| `src/http/rate-limit.js` | 82 | Contadores de fuerza bruta y **once limitadores por cuenta** (ventana deslizante de 60 s): mensajería (30), GIPHY (30), perfil (10), historias (15), vistas de historias (60), contactos (20), creación de grupos (10), ofertas de llamada (5), preferencias de chat (20), verificación de contraseña (5) y acuses de lectura (120, `receiptLimiter`, añadido en la ronda SECOA: cada uno recorre hasta 500 ids y descifra cada fila). Contadores de login/registro en Map en RAM con purga perezosa; todo podado con `unref()`. También cuenta el barrido periódico de blobs huérfanos. | `loginAttempts`, `registerAttempts`, `messageRateLimiter`, `giphyLimiter`, `profileLimiter`, `storyLimiter`, `storyViewLimiter`, `contactLimiter`, `groupCreateLimiter`, `callOfferLimiter`, `chatPrefsLimiter`, `passwordCheckLimiter`, `receiptLimiter` | `auth/routes.js`, `http/helpers.js`, `stickers/routes.js`, `profile/routes.js`, `stories/routes.js`, `users/store.js`, `chat/routes.js`, `http/router.js`, `realtime/websocket.js` |
| `src/http/helpers.js` | 51 | Utilidades de respuesta: mapa de tipos MIME de los estáticos, `rejectRateLimitedMessage` (429 con `Retry-After`), `rejectRateLimited` genérico y `safeDecodeSegment` (decodifica un segmento de ruta sin lanzar). | `mimeMap`, `rejectRateLimitedMessage`, `rejectRateLimited`, `safeDecodeSegment` | `http/router.js`, `chat/routes.js`, `profile/routes.js`, `stories/routes.js`, `stickers/routes.js` |

---

## 13. `ops/` — scripts de operación

| Fichero | Líneas | Qué hace | Notas |
|---|---:|---|---|
| `ops/supervisor.js` | 503 | `npm start`. Vigila `node server.js` y lo relanza: backoff exponencial (1 s → 30 s), distingue **fallo de arranque** (cortacircuito, salida con código 70) de **caída en caliente** (el servicio nunca se deja apagado), y ejecuta un *watchdog* de salud contra `/healthz` (solo un 2xx cuenta como sano). Captura el puerto real del banner del hijo. Escribe el PID en `.zlapy.pid` **con permisos 0600** (antes quedaba 0644: cualquier usuario local podía leer el PID del servidor). | Exporta `checkHealth`, `killUnhealthy`, `getState` (para testearlo); solo arranca si es el módulo principal. |
| `ops/tunnel.js` | 165 | `npm run tunnel`. Levanta `cloudflared` con la configuración de `zty.yml` y el token de `CLOUDFLARE_TUNNEL_TOKEN`. El token **no viaja en argv**: se entrega por `--token-file` (fichero temporal 0600 en directorio 0700, borrado al salir) o, si la versión no lo soporta, por la variable de entorno `TUNNEL_TOKEN`. La salida del proceso se filtra para redactar el token. | Sin exports. |
| `ops/backup.js` | ~95 | `npm run backup`. Copia `zlapy.db` y `blob.db` con la API de backup de SQLite (seguro con el servidor en marcha). La llave maestra vive en el `.env` (`CHAT_MASTER_KEY`): recomienda copiar ese fichero aparte. Fija permisos 0700/0600 de forma incondicional. | Sin exports. |
| `ops/generate-master-key.js` | ~135 | `npm run key`. Escribe `CHAT_MASTER_KEY` (32 bytes en base64) en el `.env`, o la vacía. Con `--force` y la base CON datos, gira la llave y re-cifra todo el material dependiente (motor de `ops/reencrypt-master.js`). No muestra la clave por pantalla. | Exporta `generateMasterKey(envPath, { force, clear })` y re-exporta `ensureEnvFile`, `setEnvValue`, `writeSecretFile` (de `env-writer.js`). |
| `ops/env-writer.js` | ~90 | Escritura atómica de secretos (`writeSecretFile`: temporal 0600 + fsync + rename), `setEnvValue` y lectura directa de variables (`readEnvValue`, misma mecánica de regex que `src/crypto/master-key.js`). Módulo diminuto sin dependencias: lo comparten el generador de llave y el motor de re-cifrado sin círculos de require. | `writeSecretFile`, `setEnvValue`, `readEnvValue` |
| `ops/reencrypt-master.js` | ~230 | Motor de ROTACIÓN de la llave maestra con re-cifrado completo (verifica todos los sobres con la llave vieja, copia el `.env` a `.env.master-bak`, entra la llave nueva y re-cifra `user_auth_keys`, `groups.keys_cipher`, `meta` VAPID y `blobs.data` en transacciones; reversión compensada ante fallo). | `rotateMasterKey(options)`, `hasMasterDataAtRest(dbPath, blobPath)`, `isMasterEnvelope(value)` |
| `ops/migrate-to-mtproto.js` | 227 | `npm run migrate:mtproto`. Convierte el histórico PCE2 → PCE3 y re-cifra resúmenes, notas, perfil, llamadas, push e historias con la `auth_key` del usuario. Sin `--apply` solo simula; con `--apply` hace un respaldo previo en `backups/`. Verifica cada registro de ida y vuelta antes de escribirlo. Idempotente. | Sin exports. Importa de `src/` con la **misma** implementación que el servidor. |

---

## 14. `public/` — cliente web

Desde la reordenación del cliente, los ficheros compartidos viven en `public/js/`
y `public/css/`; en la raíz de `public/` solo quedan las páginas y **dos
`shims` de compatibilidad** (ver al final de la tabla).

| Fichero | Líneas | Qué hace | Notas |
|---|---:|---|---|
| `public/index.html` | 17757 | La SPA principal en un único fichero: HTML + CSS + JS inline (chat, grupos, historias, llamadas WebRTC, ajustes, notas, encuestas, menciones, adjuntos, stickers). | Rutas de API: `/auth/*`, `/account/*`, `/send`, `/messages`, `/receipt`, `/seen`, `/msg/*`, `/chat/*`, `/contacts/*`, `/groups/*`, `/stories`, `/story/*`, `/profile`, `/block`, `/poll/vote`, `/stickers`, `/push/*`, `/blob/*`, `/avatar/*`, `/call/log`, `/config`. Carga `/css/theme.css`, `avatar-editor.css`, `popmenu.css` y `/js/{transport-crypto.js, transport.js, avatar-editor.js, popmenu.js, autogrow.js}`. Registra el service worker en `/sw.js?v=39`. |
| `public/login.html` | 202 | Pantalla de acceso (login y registro), separada de la SPA: si no hay sesión, `index.html` redirige aquí. | Carga `/css/theme.css`, `/css/login.css`, `/js/transport-crypto.js` y `/js/transport.js`; hace `POST /auth/login` o `POST /auth/register`. |
| `public/group-create.html` | 242 | Formulario de creación de grupo: nombre, descripción, miembros elegibles y avatar. | Carga `/css/{theme,group-create,avatar-editor}.css` y `/js/{autogrow,avatar-editor,group-create,transport-crypto,transport}.js`. |
| `public/group-details.html` | 337 | Ficha del grupo: ajustes y políticas según el rol, integrantes y solicitudes de entrada. | Carga `/css/{theme,group-create,group-details,popmenu,avatar-editor}.css` y `/js/{autogrow,avatar-editor,group-details,popmenu,transport-crypto,transport}.js`. |
| `public/profile.html` | 409 | Pantalla de "Mi perfil": datos de la cuenta, cambio de nombre y contraseña, preferencias de privacidad y ajustes de apariencia. | Carga `/css/{theme,avatar-editor}.css` y `/js/{appearance,autogrow,avatar-editor,transport-crypto,transport}.js`. |
| `public/view.html` | 380 | Visor de perfil de un contacto (sin sidebar). Se usa en `iframe` dentro de `index.html`. | Carga `/css/theme.css` y `/js/{appearance,transport-crypto,transport}.js`. |
| `public/stories.html` | 2391 | Visor de historias a pantalla completa (con visualizaciones, likes, editor de publicación y hoja de stickers). | Carga `/css/{theme,popmenu}.css` y `/js/{popmenu,appearance,transport-crypto,transport}.js`. |
| `public/privacy.html` | 615 | Política de privacidad estática. | Carga `/css/theme.css` y `/js/{appearance,transport-crypto,transport}.js`. |
| `public/css/theme.css` | 639 | Hoja de estilos común: tokens CSS, tema oscuro, formularios y controles. La cargan todas las páginas. | — |
| `public/css/login.css` | 332 | Estilos propios de la pantalla de acceso. | — |
| `public/css/popmenu.css` | 93 | Estilo del pop-menu compartido (filas con icono, separaciones, cierre al tocar fuera). | — |
| `public/css/avatar-editor.css` | 232 | Estilos del editor de foto (recorte, zoom, encuadre). | — |
| `public/css/group-create.css` | 1368 | Estilos compartidos de creación y ficha de grupo. | — |
| `public/css/group-details.css` | 1349 | Estilos propios de la ficha de grupo (integrantes, políticas, solicitudes). | — |
| `public/js/transport-crypto.js` | 424 | Primitivas criptográficas en JavaScript puro para el canal: SHA-256, HMAC-SHA256, HKDF, X25519, ChaCha20, `aeadSeal`/`aeadOpen`, construcción/descifrado del sobre HTTP y de los frames WebSocket. Se implementa a mano porque `crypto.subtle` no existe en contextos no seguros (`http://` en la LAN); solo usa `crypto.getRandomValues`. Expone `window.ZlapyTransport`. | `ALGO`, `sha256`, `hmacSha256`, `hkdf`, `x25519`, `publicFromPrivate`, `aeadSeal`, `aeadOpen`, `chacha20`, `encrypt`, `decryptResponse`, `deriveSessionKey`, `requestAad`, `responseAad`, `wsKey`, `wsSeal`, `wsOpen`, `toBase64`, `fromBase64`, `randomBytes`, `BASE_POINT` |
| `public/js/transport.js` | 218 | Integración del canal con la app: envuelve `fetch` (solo `POST` del mismo origen con cuerpo JSON: cifra la petición y descifra la respuesta), cachea la clave pública de `/config` y expone `ZlapyTransportReady()`. Extiende `WebSocket` para enviar el saludo `enc`, encolar los envíos hasta tener sesión y descifrar los frames `z1:` en `onmessage`/`addEventListener`. Si no hay clave, todo sigue en claro. | IIFE; expone `window.ZlapyTransportReady` y reemplaza `window.fetch`/`window.WebSocket`. |
| `public/js/appearance.js` | 68 | Aplica el acento configurado por el usuario como variables CSS (`--accent`, `--accent-ink`, …) leyendo `localStorage` y luego `GET /account/chat-settings`. | IIFE con `'use strict'`. Lo cargan profile, view, stories y privacy (`index.html` lo tiene inline). |
| `public/js/popmenu.js` | 154 | Pop-menu compartido: `ZlapyPopMenu.open({anchor, items, onSelect})`. Se usa en el chat, la lista de contactos, las historias y los integrantes del grupo. | `window.ZlapyPopMenu` (`open`, `close`, `isOpen`, `icons`) |
| `public/js/autogrow.js` | 37 | Textarea que crece con su contenido (también al cargar). | `window.ZlapyAutoGrow` (`grow`, `attach`) |
| `public/js/avatar-editor.js` | 321 | Editor de foto (perfil y grupo): recorte 512×512 con arrastre, zoom y punto de encuadre. | `window.ZlapyAvatarEditor.open({file, onSave})` |
| `public/js/group-create.js` | 565 | Lógica del formulario de creación de grupo: selección de miembros y subida del avatar. | IIFE de página. |
| `public/js/group-details.js` | 1301 | Lógica de la ficha de grupo: políticas según rol, integrantes, solicitudes de entrada y subida de *keyboxes*. | IIFE de página. |
| `public/js/sw.js` | 73 | Service worker: cachea el *shell* (`chatlocal-v65`), sirve offline solo las navegaciones del shell (el resto falla de forma explícita, sin inventar un 504 vacío) y gestiona las notificaciones push y su clic. | — |
| `public/sw.js` | 1 | **Shim** de compatibilidad: `importScripts('/js/sw.js')`. Los navegadores que ya registraron `/sw.js` siguen recibiendo actualizaciones a través de él. | Sin lógica propia. |
| `public/transport-crypto.js` | 4 | **Shim** de compatibilidad: comenta que la ruta histórica sigue existiendo y hace `require('./js/transport-crypto.js')` para la suite de Node. | Se borrará cuando ningún test cargue la ruta antigua. |
| `public/manifest.webmanifest` | 14 | Manifiesto PWA: nombre, `display: standalone`, colores e iconos. | — |
| `public/icon-192.png` | binario | Icono 192×192. | — |
| `public/icon-512.png` | binario | Icono 512×512 (también `maskable`). | — |

---

## 15. `test/` — suite de pruebas

Se ejecuta con `npm test` → `node --test test/*.test.js`.

| Fichero | Líneas | Qué cubre |
|---|---:|---|
| `test/helpers.js` | 246 | Utilidad (no es un test): arranca `server.js` como proceso hijo con `DATA_DIR` temporal y puerto libre, y provee `api()`, `register()`, `rawRequest()` y un cliente WebSocket mínimo (`WsClient`) con framing propio, acceso a los textos crudos y envío de texto. |
| `test/appearance.test.js` | 49 | Normalización de la apariencia del chat y persistencia del fondo. |
| `test/avatar.test.js` | 46 | Identicon SVG estable y determinista. |
| `test/config.test.js` | 31 | `.env.example` válido, valores por defecto y overrides de `loadConfig`. |
| `test/frames.test.js` | 135 | Framing RFC 6455: máscaras, longitudes, fragmentación, códigos de cierre. |
| `test/gallery.test.js` | 63 | Validación de galerías y acotado de metadatos. |
| `test/generate-master-key.test.js` | 61 | Generación y vaciado de `CHAT_MASTER_KEY` preservando el resto del `.env`. |
| `test/limits.test.js` | 34 | Límites por tipo y limitador de frecuencia (ventana deslizante). |
| `test/message-crypto.test.js` | 57 | Cifrado de mensajes con AAD ligado al contexto y firma. |
| `test/message-data.test.js` | 29 | Desencriptado de los campos heredados (`PCE1:`). |
| `test/migrate-to-mtproto.test.js` | 156 | El script de migración: simula, migra, conserva el contenido y el servidor funciona sin él. |
| `test/mtproto-server.test.js` | 129 | Integración del cifrado en nube: `auth_key` por usuario, aislamiento entre cuentas, huella publicada y regeneración sin perder historial. |
| `test/mtproto.test.js` | 122 | Primitivas MTProto: ida y vuelta, derivación de claves, cabecera interna, relleno y ventanas de `msg_id`. |
| `test/schema.test.js` | 230 | Esquema v3: idempotencia, cascadas del borrado de cuenta (y que no purga grupos cuyo `gid` contenga el uuid de la víctima), `UNIQUE`/`CHECK`/FK. |
| `test/security-regressions.test.js` | 270 | Regresiones de la auditoría de seguridad del 2026-10-19 (una cuenta no puede leer lo de otra, enumeración de cuentas, CSRF, etc.). |
| `test/server-http.test.js` | 121 | Integración HTTP contra `server.js` real: request-targets malformados, auth, borrado de cuenta y reinicio. |
| `test/server-ws.test.js` | 130 | Integración WebSocket: handshake, multi-dispositivo, límites de frame/buffer, *rate limit* y cierre de llamadas al desconectar. |
| `test/static-path.test.js` | 51 | Traversal y trucos de ruta en los estáticos. |
| `test/supervisor.test.js` | 90 | Humo del supervisor: arranca, `/healthz` responde, mata al hijo y lo reinicia (puerto y `DATA_DIR` temporales). |
| `test/transport.test.js` | 277 | Sobre del canal HTTP y WebSocket: primitivas del cliente contra Node (incluido un vector RFC 8439), ida y vuelta de 2 MB, rechazo de sobres manipulados/otra ruta/otro tiempo, publicación de la clave en `/config` y `/healthz`, registro y mensajes cifrados, `400` con sobre roto, compatibilidad en claro y handshake `enc` con frames `z1:`. |
| `test/types.test.js` | 55 | Encuestas y tarjetas de contacto. |

---

## 16. `docs/` y `.github/`

| Fichero | Líneas | Qué es |
|---|---:|---|
| `docs/FICHEROS.md` | este | Este documento: mapa de ficheros, glosario de símbolos, dónde tocar y convenciones. |
| `docs/API.md` | 764 | Contrato HTTP + WebSocket: rutas, cuerpos, cabeceras y códigos de error. |
| `docs/ESQUEMA-BD.md` | 577 | Tablas, columnas, índices y reglas de borrado en cascada. |
| `docs/ARQUITECTURA.md` | 1495 | Arquitectura del backend: arranque, ciclo HTTP, algoritmos y reglas de negocio. |
| `docs/CRIPTOGRAFIA.md` | 1769 | El sistema criptográfico completo: llave maestra, PCE1/PCE2/PCE3, firmas y canal de transporte. |
| `docs/INSTALACION.md` | 1072 | Instalación por plataforma, configuración inicial, permisos y operación. |
| `docs/decisiones-auditoria.md` | 191 | Decisiones de diseño tomadas tras las auditorías (V-12, V-18, CSP, SECOA…): qué se decidió no cambiar y por qué. |
| `docs/esquema/esquema.js` | 985 | Datos del visor 2D del esquema de la base (transcritos de `src/db/schema.js`). |
| `docs/esquema/index.html` | 64 | Página del visor del esquema. |
| `docs/esquema/esquema.css` | 510 | Estilos del visor del esquema. |
| `.github/workflows/ci.yml` | 37 | CI: `npm ci` (con la caché de npm alimentada por `package-lock.json`) + `npm test` en Node 22. Sin secretos; `permissions: contents: read`. |

---

## 17. Glosario de símbolos exportados

Referencia rápida: **qué** exporta cada módulo y **quién** lo consume. "—" significa que no hay consumidor fuera del propio fichero.

### 17.1 `src/` (núcleo)

| Módulo | Exporta | Consumido por |
|---|---|---|
| `config.js` | `DEFAULTS`, `loadConfig`, `ROOT`, `CONFIG`, `tlsState`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `GIPHY_API_KEY`, `PORT`, `PUBLIC`, `DATA`, `DB_PATH`, `BLOB_DB_PATH` | `config.test.js`, `shared/limits.js`, `shared/gallery.js`, `db/database.js`, `http/router.js`, `http/servers.js`, `crypto/master-key.js`, `auth/sessions.js`, `users/store.js`, `chat/routes.js`, `chat/messages.js`, `stories/routes.js`, `profile/routes.js`, `meta/routes.js`, `realtime/websocket.js`, `realtime/notify.js`, `push/vapid.js`, `stickers/routes.js`, `groups/routes.js`, `ops/backup.js`, `ops/migrate-to-mtproto.js` |
| `state.js` | `setStories`, `setNotesMap`, `setCallFiles` + 13 estructuras de estado + `CHAT_PAGE_TTL`, `CHAT_PAGE_MAX`, `AUTH_SESSION_TTL` | todos los módulos de dominio (y `state.js` es la única fuente de los mapas mutables) |

### 17.2 `src/db/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `database.js` | `db`, `blobDb`, `messageSchema` | `db`/`blobDb`: `statements.js`, `transactions.js`, `schema.js`, `http/servers.js`, `users/store.js`, `chat/mentions.js`, `stories/routes.js`, `realtime/websocket.js`, `meta/routes.js`, `push/routes.js`, `crypto/setup.js`. `messageSchema`: — (solo interno) |
| `schema.js` | `SCHEMA_VERSION`, `SCHEMA_SQL`, `applySchema`, `ensureSchema`, `tableExists`, `tableColumns`, `deleteAccountRows`, `deleteGroupRows`, `deleteMessageRowsWhere` | `ensureSchema`: `database.js`, `ops/migrate-to-mtproto.js`. `deleteAccountRows`/`deleteGroupRows`: `transactions.js`. `SCHEMA_VERSION`: `server.js`, `users/store.js`, `meta/routes.js`. `tableExists`/`tableColumns`/`applySchema`/`SCHEMA_SQL`: `test/schema.test.js` |
| `statements.js` | `Stmt` (127 sentencias preparadas) + `deleteGroupSummary` + `listSessionHashesByUser` | `Stmt`: prácticamente todos los dominios. `deleteGroupSummary`: `http/router.js`, `groups/store.js`. `listSessionHashesByUser`: `auth/sessions.js` (tope de sesiones por cuenta) |
| `transactions.js` | `stmtBlobHasReference`, `stmtBlobRemove`, `pruneBlobHashes`, `blobAccessWhereCache`, `removeBlobAccess`, `tx` | `pruneBlobHashes`/`removeBlobAccess`/`tx`: `http/router.js`, `chat/routes.js`, `chat/messages.js`, `stories/routes.js`, `profile/routes.js`, `realtime/websocket.js`, `users/store.js` |

### 17.3 `src/crypto/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `master-key.js` | `getMasterKeyBytes` | `crypto/setup.js` |
| `message-crypto.js` | `createMessageCrypto` | `crypto/setup.js`, `ops/migrate-to-mtproto.js`, `test/message-crypto.test.js` |
| `mtproto.js` | `AUTH_KEY_BYTES`, `PADDING_MIN`, `PADDING_MAX`, `INTERNAL_HEADER_BYTES`, `DOMAIN`, `authKeyId`, `generateAuthKey`, `deriveKeys`, `computeMsgKey`, `buildPadding`, `buildInternalHeader`, `readInternalHeader`, `encrypt`, `decrypt`, `keyFingerprint`, `nextMsgId`, `msgIdAcceptable` | `crypto/setup.js`, `crypto/user-auth-keys.js`, `chat/messages.js`, `users/store.js`, `ops/migrate-to-mtproto.js`, `test/mtproto.test.js` |
| `user-auth-keys.js` | `createUserAuthKeys`, `AUTH_KEY_CACHE_MAX`, `SALT_ROTATION_MS` | `crypto/setup.js`, `ops/migrate-to-mtproto.js` |
| `setup.js` | `masterKey`, `messageCrypto`, `encryptAtRest`, `decryptAtRest`, `authKeys`, `authKeyRecord`, `ensureAuthKey`, `rotateSaltIfNeeded`, `encryptForUser`, `decryptForUser`, `messageContextBytes` | `chat/messages.js`, `chat/media.js`, `chat/summaries.js`, `groups/store.js`, `stories/routes.js`, `calls/store.js`, `push/routes.js`, `push/vapid.js`, `profile/routes.js`, `users/store.js` |
| `transport.js` | `TRANSPORT_ALGO`, `MAX_CLOCK_SKEW_MS`, `transportPublicKey`, `sessionFromEphemeral`, `decryptEnvelope`, `encryptEnvelope`, `requestAad`, `responseAad`, `deriveSessionKey`, `seal`, `open` | `http/transport.js`, `realtime/encrypted.js`, `meta/routes.js`, `test/transport.test.js` |

### 17.4 `src/shared/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `validation.js` | `USERNAME_RE`, `RESERVED_USERNAMES`, `validUsername`, `DATA_URL_IMAGE_RE`, `DATA_URL_MEDIA_RE`, `validAvatar`, `validStoryMedia`, `STICKER_ALLOWED_HOSTS`, `validStickerData`, `MIME_RE`, `validMime`, `validMessageId`, `clampStr`, `PUSH_ALLOWED_HOSTS`, `validPushEndpoint`, `clientIp`, `NOTE_TTL` | `auth/routes.js`, `http/router.js`, `chat/routes.js`, `stories/routes.js`, `stickers/routes.js`, `push/routes.js`, `push/vapid.js`, `profile/routes.js`, `groups/routes.js`, `realtime/websocket.js`, `users/helpers.js` |
| `limits.js` | `MESSAGE_LIMITS`, `characterCount`, `createMessageRateLimiter` | `http/helpers.js`, `http/rate-limit.js`, `http/router.js`, `chat/routes.js`, `stories/routes.js`, `profile/routes.js`, `meta/routes.js` |
| `types.js` | `normalizePollData`, `normalizeContactData`, `togglePollVote` | `http/router.js`, `chat/routes.js` |
| `gallery.js` | `validateGallery` | `http/router.js`, `chat/routes.js` |
| `message-data.js` | `decryptLegacyMessageFields` | `chat/messages.js` |
| `appearance.js` | `normalizeChatAppearanceSettings` | `profile/routes.js` |
| `avatar.js` | `createDefaultAvatarSvg` | `http/router.js` |
| `static-path.js` | `decodeRequestPath`, `resolvePublicFile` | `http/router.js` |

### 17.5 `src/users/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `store.js` | `hydrateUserFromDb`, `loadFromDb`, `regenerateAuthKey`, `userFromRow`, `loadUserFromRow`, `accountByName`, `purgeUserFromMemory`, `writeUserRows`, `saveStickers`, `saveMutedPeers`, `saveChatSettings`, `saveUserToDb` | `server.js`, `auth/routes.js`, `auth/sessions.js`, `chat/routes.js`, `contacts/routes.js`, `profile/routes.js`, `groups/store.js`, `stickers/routes.js`, `realtime/websocket.js`, `realtime/notify.js`, `chat/mentions.js`, `db/transactions.js` |
| `helpers.js` | `uniq`, `parseJsonSafe`, `byId`, `byName`, `usernameTakenInDb`, `accountId`, `pairKeyFromIds`, `freshNote`, `mutedChatPeers`, `isChatMuted` | `http/router.js`, `auth/routes.js`, `chat/routes.js`, `contacts/routes.js`, `profile/routes.js`, `groups/routes.js`, `groups/store.js`, `stories/routes.js`, `push/vapid.js`, `realtime/notify.js`, `realtime/websocket.js`, `users/privacy.js`, `users/store.js`, `stickers/routes.js` |
| `privacy.js` | `PRIV_KEYS`, `PRIV_DEF`, `normPriv`, `isContact`, `accountsBlocked`, `privacyFor`, `permite`, `permiteDescripcion`, `isBlockedBy` | `http/router.js`, `chat/routes.js`, `contacts/routes.js`, `profile/routes.js`, `stories/routes.js`, `chat/media.js`, `groups/routes.js`, `realtime/notify.js`, `realtime/websocket.js`, `auth/routes.js` |

### 17.6 `src/chat/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `messages.js` | `messageBody`, `prepareStoredMessage`, `updateStoredMessage`, `rowToMessage`, `findMessage`, `findMessageRow`, `REPLY_ID_RE`, `resolveReply`, `replyPreviewText`, `enrichReplies`, `readMessagePage`, `filterForViewer`, `getChatPage`, `invalidateChatPage`, `deleteMessageById` | `http/router.js`, `chat/routes.js`, `chat/summaries.js`, `groups/store.js`, `db/transactions.js`, `users/store.js` |
| `routes.js` | `getRoute2197`, `getHave`, `getChatsSummary`, `getChatPreferences`, `postChatPreferences`, `postPollVote`, `postSend`, `postSeen`, `postReceipt`, `postMsgDelete`, `postMsgEdit`, `postChatDelete`, `postMessages` | `http/router.js` |
| `summaries.js` | `resolveName`, `decorateForClient`, `readSummaryEntry`, `writeSummaryEntry`, `lastEntryFromMsg`, `onMessageSentSummary`, `onReadSummary`, `onMessageDeletedSummary`, `onChatDeletedSummary`, `renamePeerInSummaries` | `chat/routes.js`, `http/router.js`, `groups/store.js`, `chat/mentions.js` |
| `media.js` | `blobHashOk`, `storeBlob`, `readBlob`, `blobAvailableTo` | `http/router.js`, `chat/routes.js`, `shared/gallery.js`, `stories/routes.js` |
| `mentions.js` | `withMentions`, `propagateUsernameChange` | `http/router.js`, `profile/routes.js` |

### 17.7 `src/groups/`, `src/stories/`, `src/stickers/`, `src/calls/`, `src/push/`, `src/contacts/`, `src/profile/`, `src/auth/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `groups/store.js` | `groupPolicies`, `normalizeGroup`, `readGroup`, `decryptGroupKeys`, `writeGroupMeta`, `invalidateGroupPubCache`, `pub`, `lastGroupMessage`, `groupBrief`, `groupLastEntry`, `readGroupSummary`, `writeGroupSummary`, `deleteGroupSummary`, `groupSummaryFor`, `updateGroupMessageSummaries`, `initializeGroupSummary` | `http/router.js`, `groups/routes.js`, `chat/routes.js`, `profile/routes.js`, `chat/mentions.js`, `realtime/websocket.js` |
| `groups/routes.js` | `getGroupsRequests`, `getGroups`, `getGroupsDiscover`, `postGroups` | `http/router.js` |
| `stories/routes.js` | `getStories`, `postStory`, `postStoryLike` | `http/router.js` |
| `stickers/routes.js` | `getGiphySearch`, `getStickers`, `postStickers` | `http/router.js` (`getGiphySearch`, `postStickers`) |
| `calls/routes.js` | `getCalls`, `postCallLog` | `http/router.js` |
| `calls/store.js` | `addCall`, `updateCall`, `hasCall`, `CALL_TERMINAL_STATES`, `endUserCalls` | `realtime/websocket.js`, `calls/routes.js` |
| `push/routes.js` | `postPushSubscribe`, `postPushUnsubscribe`, `postPushTest` | `http/router.js` |
| `push/vapid.js` | `b64u`, `b64uDec`, `vapidRecord`, `VAPID`, `hkdfExtract`, `hkdfExpand`, `vapidAuth`, `pushTo`, `notifyUser`, `pushNameOf` | `http/router.js`, `chat/routes.js`, `contacts/routes.js`, `realtime/websocket.js`, `auth/routes.js` |
| `contacts/routes.js` | `getContactsRequests`, `getContactsRequestsSent`, `postContacts`, `postContactsRemove`, `postContactsCancel`, `postContactsRespond`, `postBlock` | `http/router.js` |
| `profile/routes.js` | `getAccountChatSettings`, `getProfile`, `getNotes`, `postAccountProfile`, `postAccountChatSettings`, `postAccountRegenerateKey`, `postAccountDelete`, `postProfile`, `postNotes` | `http/router.js` |
| `auth/routes.js` | `getAuthSession`, `getKey`, `postKey`, `postAuthRegister`, `postAuthLogin`, `postAuthAddAccount`, `postAuthSwitch`, `postAuthAccountRemove`, `postAuthLogout` | `http/router.js` |
| `auth/sessions.js` | `hashSessionToken`, `cookieValue`, `sessionCookie`, `accountCookieName`, `accountCookies`, `appendCookie`, `getSessionFromCache`, `sessionUser`, `setSessionCookie`, `setAccountSessionCookie`, `clearCookie`, `clearSessionCookie`, `createSession`, `createLinkedAccountSession`, `originAllowed`, `isLoopbackPeer`, `requestEncrypted`, `cookieSecure`, `passwordDigest`, `safeEqualHex` | `auth/routes.js`, `profile/routes.js`, `http/router.js`, `realtime/websocket.js`, `stickers/routes.js` |

### 17.8 `src/realtime/` y `src/http/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `realtime/websocket.js` | `rejectUpgrade`, `wsUpgradeInner`, `wsUpgrade` | `http/servers.js` |
| `realtime/notify.js` | `WS_MAX_PER_USER`, `WS_FRAME_RATE`, `WS_FRAME_BURST`, `WS_MAX_BACKLOG_BYTES`, `textFrameHead`, `wsSend`, `pushRawName`, `push`, `pushName`, `userList`, `broadcastUsersAround`, `broadcastUsers`, `updateContactRequests`, `connectContacts`, `removeContacts`, `liveStories`, `storyForViewer`, `pushStories` | `http/router.js`, `chat/routes.js`, `groups/routes.js`, `contacts/routes.js`, `profile/routes.js`, `stories/routes.js`, `calls/store.js`, `push/vapid.js`, `realtime/websocket.js`, `auth/sessions.js`, `auth/routes.js`, `chat/mentions.js`, `users/store.js`, `groups/store.js` |
| `realtime/frames.js` | `parseFrames`, `closeFrame`, `MAX_FRAME_BYTES`, `MAX_BUFFER_BYTES`, `MAX_FRAGMENTS` | `realtime/websocket.js` |
| `realtime/encrypted.js` | `WS_PREFIX`, `WS_INFO`, `acceptHandshake`, `openFrame`, `sealFrame`, `wsNonce`, `wsAad` | `realtime/websocket.js`, `realtime/notify.js`, `test/transport.test.js` |
| `http/router.js` | `handleRequest`, `handler` | `http/servers.js` |
| `http/transport.js` | `isEncrypted`, `openRequest`, `sealResponse`, `nonceUsado`, `NONCE_MEMORY_MS` | `http/router.js`, `test/transport.test.js` |
| `http/servers.js` | `httpSrv`, `httpsSrv`, `dispatcher`, `orderlyShutdown` | `server.js` |
| `http/responses.js` | `securityHeaders`, `CSP_HOST_RE`, `cspFor`, `json` | todos los módulos de rutas + `http/router.js` |
| `http/rate-limit.js` | `loginAttempts`, `registerAttempts`, `messageRateLimiter`, `giphyLimiter`, `profileLimiter`, `storyLimiter`, `storyViewLimiter`, `contactLimiter`, `groupCreateLimiter`, `callOfferLimiter`, `chatPrefsLimiter`, `passwordCheckLimiter`, `receiptLimiter` | `auth/routes.js`, `http/helpers.js`, `stickers/routes.js`, `profile/routes.js`, `stories/routes.js`, `users/store.js`, `realtime/websocket.js`, `chat/routes.js`, `http/router.js` |
| `http/helpers.js` | `mimeMap`, `rejectRateLimitedMessage`, `rejectRateLimited`, `safeDecodeSegment` | `http/router.js`, `chat/routes.js`, `profile/routes.js`, `stories/routes.js`, `stickers/routes.js` |
| `meta/routes.js` | `getConfig`, `getHealthz` | `http/router.js` (solo `getHealthz`) |

---

## 18. Dónde tocar para cada tarea

| Tarea | Ficheros a tocar |
|---|---|
| **Cambiar el formato de un mensaje** (campos del cuerpo, versión del sobre) | `src/chat/messages.js` (`messageBody`, `prepareStoredMessage`, `rowToMessage`) + `src/crypto/mtproto.js` (derivación de claves) + `src/shared/message-data.js` (lectura del formato heredado) |
| **Añadir un tipo de mensaje** (p. ej. `location`) | `src/groups/store.js` (`groupPolicies`) → `src/http/router.js` (envío de grupo) → `src/chat/routes.js` (envío de DM) → `src/shared/types.js` si es contenido estructurado → `public/index.html` (render) → `src/chat/messages.js` (firma: `messageSignaturePayload` en `src/crypto/message-crypto.js`) |
| **Añadir una ruta HTTP** | `src/http/router.js` (registro + controles de sesión/origen) + el módulo del dominio (`src/<dominio>/routes.js`) + `src/http/responses.js` (`json`) + `docs/API.md` |
| **Añadir una ruta WebSocket** | `src/realtime/websocket.js` (rama del `switch` sobre `m.type`) + `src/realtime/notify.js` (`push`/`pushName`) + `public/index.html` (recepción) |
| **Cambiar el esquema de la base** | `src/db/schema.js` (`SCHEMA_SQL`) + `src/db/statements.js` (`Stmt`) + `src/db/schema.js` (cascadas en JS: `deleteAccountRows`/`deleteGroupRows`) + `test/schema.test.js` + `docs/ESQUEMA-BD.md`. Ojo: `SCHEMA_VERSION` y `meta.crypto_version` son dos cosas distintas (esquema vs formato de cifrado) y `server.js` aborta si la segunda no es `2`. |
| **Cambiar el cifrado** | `src/crypto/*` — `master-key.js` (llave maestra), `message-crypto.js` (AES-GCM + Ed25519), `mtproto.js` (estructura MTProto 2.0), `user-auth-keys.js` (clave por usuario), `setup.js` (instanciación). Si cambia el *formato del sobre*, hay que tocar también `src/chat/messages.js` (lectura/escritura) y `ops/migrate-to-mtproto.js`. |
| **Cambiar la clave de cifrado de una cuenta** | `src/users/store.js` (`regenerateAuthKey`) + `src/profile/routes.js` (`postAccountRegenerateKey`) |
| **Cambiar un límite** (longitud de mensaje, cuota, tamaño de cuerpo, TTL) | `src/config.js` (`DEFAULTS` + validación) + `.env.example` + `src/shared/limits.js` (lo que se consume) |
| **Cambiar la privacidad por función** | `src/users/privacy.js` (`PRIV_KEYS`, `PRIV_DEF`, `permite`) + `src/db/schema.js` (`user_privacy`) + `src/profile/routes.js` (lectura/escritura) |
| **Cambiar las reglas de un grupo** (políticas por tipo) | `src/groups/store.js` (`groupPolicies`, `normalizeGroup`) + `src/http/router.js` (validación de envío) + `src/chat/routes.js` (DM: reutiliza `groupPolicies`) + `src/db/schema.js` (`groups.content_policy`) |
| **Cambiar el enrutado / la seguridad HTTP** | `src/http/router.js` (orden de comprobaciones), `src/http/responses.js` (cabeceras y CSP), `src/http/servers.js` (TLS, apagado), `src/shared/static-path.js` (estáticos) |
| **Tocar el cliente web** | `public/index.html` (SPA principal), `public/login.html` (acceso), `public/profile.html`, `public/view.html`, `public/stories.html`, `public/privacy.html`, `public/theme.css`, `public/appearance.js`, `public/sw.js`, `public/manifest.webmanifest` |
| **Añadir un test** | `test/<dominio>.test.js` (unitario: `require('../src/<dominio>/<fichero>')`) o `test/server-http.test.js` / `test/server-ws.test.js` (integración, con `test/helpers.js`). Se ejecutan con `npm test` → `node --test test/*.test.js` |
| **Cambiar el proceso de arranque / el apagado** | `server.js` + `src/http/servers.js` + `ops/supervisor.js` |
| **Cambiar los respaldos** | `ops/backup.js` (copia) + `ops/migrate-to-mtproto.js` (respaldo previo) + `docs/ESQUEMA-BD.md` |
| **Cambiar el túnel / el despliegue público** | `ops/tunnel.js` + `zty.yml.example` + `.env.example` (`CLOUDFLARE_TUNNEL_TOKEN`) |

---

## 19. Ficheros que NO se versionan

| Ruta | Qué es | Por qué no se versiona |
|---|---|---|
| `.env` | Configuración real: `CHAT_MASTER_KEY`, `CLOUDFLARE_TUNNEL_TOKEN`, `GIPHY_API_KEY`, `PORT`, `DATA_DIR`, `SUPERVISOR_*` | Contiene secretos. El token del túnel permite secuestrar el túnel; la llave maestra descifra todo. Se versiona solo `.env.example`. |
| `cert.pem`, `key.pem` | Certificado y clave privada TLS (autofirmados) | Clave privada. El servidor arranca sin HTTPS si no existen (`src/http/servers.js`). |
| `data/` | `zlapy.db` y `blob.db` (con sus WAL y shm) | Persistencia mutable: cambia con cada escritura, no es código. Es lo que protege la llave maestra. |
| `backups/` | Copias fechadas de las bases + llave maestra | Contienen datos de cuentas (hashes de contraseña, sesiones, mensajes cifrados). `ops/backup.js` los deja en `0700/0600`. |
| `zty.yml` | Configuración real de `cloudflared` (UUID del túnel, hostname, ingress) | Copia local de `zty.yml.example`; puede contener nombres de host internos. |
| `.zlapy.pid` | PID del proceso servidor, escrito por `ops/supervisor.js` | Estado de ejecución; cambia en cada arranque. En `.gitignore` aunque el comentario que lo acompaña esté bajo "Dependencias" (descolocado). |
| `node_modules/` | Dependencias instaladas | Se reinstalan con `npm ci` a partir de `package-lock.json`, que **sí** se versiona. |

Regla general: **lo que es secreto o datos de usuario no entra en el repositorio**; lo que es reproducible (código, plantillas, lockfile) sí.

---

## 20. Convenciones del código

### 20.1 Módulos CommonJS, sin transpilación

- Todo el backend usa **CommonJS** (`require` / `module.exports`). No hay Babel, ni ESM, ni bundler.
- El cliente web es JS plano en el navegador (`public/appearance.js` y `public/sw.js`); `public/index.html` lleva su JS inline en un `<script>` dentro del `<body>`.

### 20.2 `require` relativo con `.js` explícito

- Regla mayoritaria: el path relativo **lleva la extensión `.js`** (`require('../db/statements.js')`, `require('./helpers.js')`).
- **Excepciones reales en el repositorio** (conviven sin normalizar):
  - `src/shared/limits.js:9` y `src/shared/gallery.js:9` → `require('../config')`.
  - `src/crypto/user-auth-keys.js:13` → `require('./mtproto')`.
  - `server.js:33-35,52` → `require('./src/db/statements')`, `'./src/db/database'`, `'./src/users/store'`, `'./src/http/servers'`.
  - `ops/migrate-to-mtproto.js:33-37` → `require('../src/config')` y compañía.
  - Todos los ficheros de `test/` → `require('../src/...')` sin extensión.
- Recomendación al añadir código nuevo: **usar siempre la extensión `.js`**.

### 20.3 `'use strict'`

- En `src/`, `ops/` y `server.js` (54 ficheros), **44** llevan `'use strict';` **inmediatamente después del comentario de cabecera**.
- Los 10 que **no** lo llevan son precisamente los módulos más "puros": `src/config.js`, `src/crypto/message-crypto.js`, los 7 módulos de `src/shared/` (`appearance.js`, `avatar.js`, `gallery.js`, `limits.js`, `message-data.js`, `static-path.js`, `types.js`) y `ops/generate-master-key.js`.
- En `test/`, solo 2 de 20 lo llevan (`test/helpers.js` y `test/supervisor.test.js`).

### 20.4 `module.exports` al final

- El bloque `module.exports = { ... }` es **siempre la última pieza** del fichero (con una o dos líneas en blanco de separación). Exporta un **objeto literal** con nombres explícitos, nunca `exports.x = ...` suelto.
- Los módulos de un solo símbolo usan la forma abreviada (`module.exports = { createMessageCrypto };`) o la forma larga con varias líneas, según el número de exports.

### 20.5 Comentarios

- Comentarios de línea con `//`; comentarios de bloque con `/** ... */` para la cabecera del fichero.
- La cabecera de cada módulo es un bloque `/** ... */` con: qué hace el módulo, el motivo de las decisiones de diseño y (si aplica) qué **no** hace.
- Los comentarios explican el **porqué**, no el qué: hay ejemplos de "por qué" de seguridad («*Conocer el hash no da acceso al archivo*») y de rendimiento («*better-sqlite3 no cachea db.prepare*»).
- Separadores de sección con el estilo `/* =========================================================\n *  Título\n * ========================================================= */`.
- Idioma: **español** en todos los comentarios y mensajes de error de `src/` y `ops/`.

### 20.6 Import perezoso con `require()` dentro de la función

Es la convención para romper **ciclos de dependencias** entre módulos: el `require` se hace *dentro* del cuerpo de la función, en el momento en que se necesita, no arriba del fichero.

**`src/realtime/notify.js:89-91`** — `realtime/notify.js` importa `users/store.js` arriba del fichero, y `users/store.js` importa `realtime/notify.js` (`src/users/store.js:21`). El ciclo se rompe con un require perezoso:

```js
function connectContacts(a, b) {
    // Require perezoso: evita un ciclo entre modulos.
    const { saveUserToDb } = require('../users/store.js');
    Stmt.insertContact.run(a.id, b.id);
    ...
}
```

El mismo patrón aparece en `removeContacts` (`src/realtime/notify.js:103-104`).

**`src/users/store.js:133-135`** — `users/store.js` ↔ `groups/store.js` (el segundo importa al primero en `src/groups/store.js:244`):

```js
function loadFromDb() {
    // Require perezoso: evita un ciclo entre modulos.
    const { readGroup } = require('../groups/store.js');
    ...
}
```

Otros casos del mismo patrón, todos con el comentario `// Require perezoso: evita un ciclo entre modulos.`:

| Fichero | Línea | Módulo cargado perezosamente | Ciclo que rompe |
|---|---:|---|---|
| `src/realtime/notify.js` | 91 | `../users/store.js` | `notify.js` ↔ `users/store.js` |
| `src/realtime/notify.js` | 104 | `../users/store.js` | ídem |
| `src/users/store.js` | 135 | `../groups/store.js` | `users/store.js` ↔ `groups/store.js` |
| `src/groups/store.js` | 244 | `../users/store.js` | ídem |
| `src/db/transactions.js` | 49 | `../chat/messages.js` | `transactions.js` ↔ `chat/messages.js` |
| `src/db/transactions.js` | 82 | `../users/store.js` | `transactions.js` ↔ `users/store.js` |
| `src/chat/messages.js` | 208 | `../db/transactions.js` | ídem |

### 20.7 Otras convenciones observables

- **Rutas y nombres**: siempre en minúsculas y con `_` en los nombres de fichero (`message-crypto.js`, `user-auth-keys.js`); los identificadores de base de datos usan `snake_case` y los de JS `camelCase`.
- **Transacciones**: toda escritura que deba ser atómica va en `src/db/transactions.js` (`tx.*`), nunca en `db.prepare(...).run()` sueltas cuando importa la integridad.
- **Sentencias preparadas**: se añaden a `Stmt` (`src/db/statements.js`), nunca se compila en caliente dentro de un bucle.
- **Privacidad y autorización**: el servidor nunca confía en el cliente — el id y el autor de una cita se resuelven contra el mensaje real (`resolveReply`), el `from` de un envío lo sobrescribe el router, y los identificadores que llegan del cliente se validan por tipo antes de tocar la base.
- **Errores**: se capturan y se registran con contexto (`console.error('[dominio] ...')`); un error nunca tumba el proceso (hay `try/catch` en el handler HTTP, en el handler de frames WebSocket y en `uncaughtException`).

---

## 21. Anomalías detectadas al inventariar

**Corregidas durante la redacción de este documento:**

1. ~~**Exports huérfanos**~~ — `getConfig` (`src/meta/routes.js`), `getChatPreferences`
   (`src/chat/routes.js`) y `getStickers` (`src/stickers/routes.js`) estaban
   duplicados en línea dentro del router, que nunca llamaba a los módulos. Ahora
   el router los invoca y el payload de `/config` vive en un solo sitio.
2. ~~**Comentarios con rutas obsoletas**~~ — `src/db/database.js` y
   `src/db/schema.js` apuntaban a `test/database-schema.test.js`; el fichero se
   llama `test/schema.test.js`.
3. ~~**configuración cargada dos veces**~~ — `src/shared/limits.js` y
   `src/shared/gallery.js` llamaban a `loadConfig(process.env)` por su cuenta;
   ahora usan el `CONFIG` ya congelado de `src/config.js`.
4. ~~**extensiones de `require` inconsistentes**~~ — se añadieron las
   extensiones `.js` en `server.js`, `src/shared/*` y en los tests.
5. ~~**indentación inconsistente**~~ — el router y los módulos de rutas
   homogeneizados: el cuerpo de cada manejador va a 4 espacios.

**Pendientes (no son bugs, pero conviene atenderlos):**

5. **Indentación inconsistente**: el router y los módulos de rutas mezclaban
   bloques a 4 y a 12/16 espacios (herencia del monolito). Homogeneizado: el
   cuerpo de cada manejador va a 4 espacios.
6. **`'use strict'` ausente** en 10 ficheros de `src/`/`ops/` (ver §20.3): los 7
   módulos puros de `src/shared/`, `src/crypto/message-crypto.js`,
   `src/config.js` y `ops/generate-master-key.js`. No es un problema funcional
   (Node no es sloppy por defecto en CommonJS), pero rompe la homogeneidad.
7. **Exports que nadie consume**: `findMessageRow`
   (`src/chat/messages.js`) y `messageSchema` (`src/db/database.js`), que solo
   se usa dentro del propio fichero.
8. **Ficheros de ejemplo sin equivalente versionado**: `zty.yml.example` existe
   y `zty.yml` está en `.gitignore` (correcto), pero el `.gitignore` situaba
   `.zlapy.pid` bajo el comentario "Dependencias", que no es donde corresponde.
9. **`public/index.html` tiene 17757 líneas** en un único fichero (HTML + CSS + JS). Sigue siendo el mayor fichero del repositorio y el punto de fragilidad del cliente; cualquier separación exigiría cambiar la CSP (`unsafe-inline`). El grueso del cliente compartido ya vive fuera (en `public/js/` y `public/css/`); lo que queda dentro es solo la SPA.

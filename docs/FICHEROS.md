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
├── ops/                  scripts de operación, partidos por dominio
│   ├── install/          dependencias y binario nativo (ensure-deps, check-native, build-sqlite)
│   ├── runtime/          supervisor (vigila y relanza el servidor)
│   ├── db/               db-viewer, sqliteview
│   ├── backup/           respaldos
│   ├── crypto/           re-cifrado maestro y reparaciones
│   ├── auth/             credencial del propietario
│   ├── net/              túnel de Cloudflare
│   ├── config/           escritura del .env
│   └── data/             generadores de datos (emojis, paquete bbot)
├── public/               cliente web (HTML/CSS/JS) y service worker
├── test/                 suite (node --test), partida por dominio
│   ├── bootstrap.js  helpers.js  (arnés común)
│   ├── auth/  calls/  chat/  client/  crypto/  db/
│   ├── groups/  http/  profile/  push/  runtime/
│   └── shared/  stickers/
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
| `server.js` | 74 | Arranque. **Preflight de dependencias primero** (`ops/install/ensure-deps.js`): si falta una librería sale con código 79 antes de cargar nada (el supervisor la instala y relanza una sola vez). Instala las **guardas de proceso** (`src/process-guards.js`) y arranca el **latido** IPC tras `src/http/servers.js`. Después, lo de siempre: ajusta permisos de disco al mínimo que exige la operación (directorios `data/`, `data2/` y `backups/` a 0700, bases y `.env` a 0600, best-effort), comprueba `meta.crypto_version`, migra rid/hash en caliente, carga cuentas/grupos/historias en RAM (`loadFromDb()`) y vigila el `.env` (cambio de credencial → exit 75). | No exporta nada: es un script de efecto. El mapa de módulos está documentado en su cabecera. |
| `package.json` | 46 | Metadatos y scripts npm: `start` → **`node ops/install/ensure-deps.js && node ops/runtime/supervisor.js`** (el preflight de dependencias corre antes del supervisor), `deps` → `ops/install/ensure-deps.js`, `tunnel`, `owner`, `test` → `node --test --require ./test/bootstrap.js test/*.test.js`, `postinstall` (verifica el binario nativo de `better-sqlite3`). Deps: `better-sqlite3`, `dotenv`, `@noble/hashes`, `@resvg/resvg-wasm`, `bcryptjs`, `jsonwebtoken`, `lru`, `webp-wasm`. `engines.node >= 22`. | — |
| `package-lock.json` | 58 | Versiones exactas. **Sí se versiona** a propósito (`npm ci` en CI, auditoría de terceros). | — |
| `.env.example` | ~185 | Plantilla comentada de toda la configuración: `PORT`, `DATA_DIR`, la credencial del propietario (`DB_USER`, `DB_PASSWORD`, `DB_PASSWORD_FILE`), `DB_NAME`/`BLOB_DB_NAME`, límites de mensajes, `SQLITE_*`, TTL de notas/historias/sesiones, `CLOUDFLARE_TUNNEL_TOKEN`, `GIPHY_API_KEY` y el bloque `SUPERVISOR_*`. | — |
| `.gitignore` | 62 | Excluye secretos y datos: `.env`, claves TLS (`*.pem`/`*.key`/`*.crt`…), `*.db`, `data/`, `data2/`, `backups/`, `*.bak`, `zty.yml`, `node_modules/`, `.zlapy.pid`. | — |
| `zty.yml.example` | 33 | Plantilla de `cloudflared`: `tunnel`, `protocol: http2`, `edge-ip-version: "4"`, `ingress` con una regla de host y un *catch-all* `http_status:404`. | — |
| `README.md` | 742 | Guía de instalación, uso, cifrado en nube, base de datos, respaldos, operación y estructura. | Fichero volátil: lo edita a menudo y crece con cada sección nueva. |

---

## 3. `src/` — núcleo

| Fichero | Líneas | Qué hace | Exporta |
|---|---:|---|---|
| `src/config.js` | 220 | Resuelve la configuración desde `process.env` con valores por defecto, valida rangos y expone las rutas (`ROOT`, `PUBLIC`, `DATA`, `DB_PATH`, `BLOB_DB_PATH`). Carga el `.env` de la raíz con `dotenv` (las variables ya presentes en el entorno mandan). Cotas de la ronda SECOA: `MAX_INLINE_MEDIA_CHARS`, `STORY_INLINE_CHAR_LIMIT`, `MAX_GROUP_MEMBERS`, `CHAT_PAGE_CACHE_MAX_BYTES`. Expone `tlsState` (estado del arranque TLS, incluido el **degradado sin certificado**) y las rutas de los certificados. | `DEFAULTS`, `loadConfig(env)`, `ROOT`, `CONFIG`, `tlsState`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `GIPHY_API_KEY`, `PORT`, `PUBLIC`, `DATA`, `DB_PATH`, `BLOB_DB_PATH` |
| `src/process-guards.js` | ~130 | Guardas de proceso: `uncaughtException`/`unhandledRejection` se registran SIEMPRE en consola y `data/log/errors.log` (acotado a 2 MB conservando el final); los errores **fatales** (SQLITE corrupta, `ENOSPC`, `EACCES`…) cierran la base vía `setFatalHook` y salen con código 1 (el supervisor levanta limpio), el resto **no tumba el servidor**. `startHeartbeat` emite latidos al supervisor por el canal IPC (no-op sin canal). Sustituye a los manejadores que antes vivían en `src/http/servers.js`. | `installProcessGuards`, `setFatalHook`, `startHeartbeat`, `isFatal`, `writeLog` | `server.js`, `src/http/servers.js`, `test/runtime/process-guards.test.js` |
| `src/state.js` | 71 | Capa de caché en RAM: cuentas, índices, perfiles, grupos, bloqueos, suscripciones push, notas, llamadas, historias, ofertas pendientes y caché de páginas de chat. La base sigue siendo la fuente de verdad. (Las sesiones salieron en v9: son tokens JWT sin almacén.) | `setStories`, `setNotesMap`, `setCallFiles` (seters) + `users`, `usernameIndex`, `profiles`, `groupCache`, `groupPubCache`, `blockedSet`, `pushSubs`, `notesMap`, `callFiles`, `stories`, `pendingOffers`, `chatPageCache`, `CHAT_PAGE_TTL`, `CHAT_PAGE_MAX`, `AUTH_SESSION_TTL` |

---

## 4. `src/db/` — persistencia

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/db/database.js` | 80 | Abre las dos bases SQLite (`zlapy.db` y `blob.db`) con WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout` y `cache_size` configurables. Comprueba el `crypto_version` guardado en `meta` y aborta si no es `2`. Aplica el esquema y verifica que `messages` tenga las columnas `crypto_version`, `crypto_group_id`, `signature`, `signing_public_key`. | `db`, `blobDb`, `messageSchema` | todo `src/` |
| `src/db/schema.js` | 780 | **Única fuente de verdad del esquema (v12).** 20 bloques de tablas normalizadas con `CHECK`/`UNIQUE` y claves ajenas `ON DELETE CASCADE`. `applySchema` migra instalaciones antiguas de forma idempotente (v9: suelta `sessions`; v10: crea `user_rid`, retira `users.auth_version`; v11: añade `calls.peer_hash` + índice, suelta `idx_calls_peer`; v12: reconstruye `calls` con PK `(owner, id)`); dos rellenos que necesitan la llave maestra (`backfillUserRids`, `backfillCallPeerHashes`) los llama `server.js` al arrancar. `migratePrivacyFeatures` reajusta `user_privacy` cuando la CHECK no admite `online`. Además implementa en SQL+JS lo que la cascada no expresa: `deleteAccountRows` (purga DMs, mensajes, historias y llamadas —estas por su índice a ciegas— y hereda la administración de grupos), `deleteGroupRows`, `deleteMessageRowsWhere`. | `SCHEMA_VERSION`, `SCHEMA_SQL`, `applySchema`, `ensureSchema`, `tableExists`, `tableColumns`, `tableSql`, `backfillUserRids`, `backfillCallPeerHashes`, `deleteAccountRows`, `deleteGroupRows`, `deleteMessageRowsWhere` | `database.js`, `transactions.js`, `server.js`, `ops/crypto/reencrypt-master.js`, `test/db/schema.test.js` |
| `src/db/statements.js` | 406 | Compila **una sola vez** todas las consultas del servidor (better-sqlite3 no cachea `db.prepare`). Agrupa ~126 sentencias en el objeto `Stmt`, con comentarios por dominio. `deleteGroupSummary` vive aquí para no crear un ciclo con `src/groups/store.js`. Revocación y llamadas (v10-v11/v12): `getRid`/`upsertRid` leen y rotan el rid de `user_rid` (la revocación sin almacén), `insertCall` escribe el par cifrado y su `peer_hash` (índice a ciegas), `listCallsByPeerHash`/`deleteCallsByPeerHash` localizan y purgan llamadas por nombre sin descifrar, y `updateCallPeer` va acotado a `id + owner` (con PK compuesta el mismo callId vive en dos filas). | `Stmt` (objeto gigante), `deleteGroupSummary(owner, gid)`, `getRid`, `upsertRid`, `listCallsByPeerHash`, `deleteCallsByPeerHash` | prácticamente todos los módulos de dominio |
| `src/db/transactions.js` | 89 | Envuelve en transacciones las escrituras atómicas (`sendMessage`, `deleteMessage`, `markSeenMessage`, `deleteGroup`, `deleteAccount`, `saveUser`) y purga los blobs que quedan sin referencia en `blob_access`. Cachea las sentencias de `removeBlobAccess` por variante de `where`. | `stmtBlobHasReference`, `stmtBlobRemove`, `pruneBlobHashes`, `blobAccessWhereCache`, `removeBlobAccess`, `tx` | `router.js`, `chat/routes.js`, `stories/routes.js`, `profile/routes.js`, `realtime/websocket.js`, `chat/messages.js`, `users/store.js` |

---

## 5. `src/crypto/` — cifrado

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/crypto/master-key.js` | ~160 | Conexión de la credencial con el arranque: `getMasterKeyBytes()` deriva la llave de la credencial (`owner-key.js`) e inicializa las bases nuevas. Vigila el `.env`: si la credencial cambia con el servidor vivo, sale con código 75 para que el supervisor reinicie. | `getMasterKeyBytes`, `baseDeDatosConDatos`, `readCredential`, `readCredentialFromEnvFile`, `watchCredentialFile` | `crypto/setup.js`, `server.js` |
| `src/crypto/kdf.js` | ~165 | Derivación de llaves: scrypt de `@noble/hashes` (credencial → llave maestra) y bcryptjs (contraseñas de cuenta, con pre-hash SHA-256 para evitar el truncado a 72 bytes). Estimación de entropía y detección de contraseñas triviales. | `deriveKey`, `deriveMasterKey`, `hashPassword`, `verifyPassword`, `bcryptInput`, `assessPassword` | `crypto/owner-key.js`, `auth/password-core.js` |
| `src/crypto/owner-key.js` | ~380 | Credencial del propietario: lee `DB_USER`+`DB_PASSWORD` (o `DB_PASSWORD_FILE`), deriva la llave con la sal de `meta.kdf_salt` y la comprueba contra `meta.keycheck`. Escribe los metadatos (`kdf_params`, `key_id`, `integrity_manifest`). En bases nuevas inicializa la credencial; en bases con datos sin credencial se niega. | `unlockMasterKey`, `ensureOwnerCredential`, `writeKeyMaterial`, `keyId`, `writeIntegrityManifest`, `checkIntegrityManifest` | `crypto/master-key.js`, `ops/auth/owner-credentials.js` |
| `src/crypto/field-crypto.js` | ~110 | Cifrado en reposo de campos sueltos con AAD propio de la columna (`field:<tabla>.<columna>`): un sobre no se puede mover de columna. `FIELD_TABLES` es el mapa del dominio de la llave maestra que recorre el motor de re-cifrado. | `encField`, `decField`, `decFieldOrNull`, `isFieldEnvelope`, `aadOf`, `FIELD_TABLES` | stores de usuarios/grupos/llamadas/push, `ops/crypto/reencrypt-master.js` |
| `src/crypto/message-crypto.js` | 213 | Fábrica del cifrado: `encryptAtRest`/`decryptAtRest` (AES-256-GCM, prefijo `PCE1:`), `encryptMessage`/`decryptMessage` (AES-256-GCM con AAD ligado al contexto del mensaje, prefijo `PCE2:`) y firma **Ed25519** de cada mensaje (`signMessage`/`verifyMessage`) con clave derivada por HKDF de la `auth_key` del autor (o de la llave maestra como respaldo). Cachea los pares de claves (máx. 500). | `createMessageCrypto(masterKey, options)` → `{ encryptAtRest, decryptAtRest, encryptMessage, decryptMessage, signMessage, verifyMessage, getSigningPublicKey, forgetSigningKey }` | `crypto/setup.js`, `ops/crypto/reencrypt-master.js` |
| `src/crypto/mtproto.js` | 233 | Réplica de la **estructura** de MTProto 2.0 (cifrado "en la nube"): `auth_key` de 2048 bits, `server_salt` rotado, `session_id`, `msg_id` monotónico, `msg_key` = 128 bits centrales del SHA-256, derivación exacta de `aes_key`/`aes_iv`, cabecera interna cifrada (salt/session/msg_id/seq_no/len) y relleno 12..27 bytes. Desviación documentada: **AES-256-GCM en vez de IGE** (IGE no está autenticado). Sobre `PCE3:`. | `AUTH_KEY_BYTES`, `PADDING_MIN`, `PADDING_MAX`, `INTERNAL_HEADER_BYTES`, `DOMAIN`, `authKeyId`, `generateAuthKey`, `deriveKeys`, `computeMsgKey`, `buildPadding`, `buildInternalHeader`, `readInternalHeader`, `encrypt`, `decrypt`, `keyFingerprint`, `nextMsgId`, `msgIdAcceptable` | `crypto/setup.js`, `crypto/user-auth-keys.js`, `chat/messages.js`, `users/store.js`, `ops/crypto/reencrypt-master.js` |
| `src/crypto/user-auth-keys.js` | 117 | Gestión de la `auth_key` **por usuario** (tabla `user_auth_keys`): carga/crea/cachea la clave (cifrada en reposo con la llave maestra), rota la sal cada 30 min y expone `encryptForUser`/`decryptForUser` (PCE3 con la `auth_key`, PCE1 heredado con la maestra) más `messageContextBytes` (contexto ligado al cifrado). Vive aparte para que el servidor y el script de migración usen **exactamente** la misma implementación. | `createUserAuthKeys({db, Stmt, encryptAtRest, decryptAtRest})` → `{ authKeyRecord, ensureAuthKey, rotateSaltIfNeeded, encryptForUser, decryptForUser, messageContextBytes, randomUint64, authKeyCache, SALT_ROTATION_MS }`; además `AUTH_KEY_CACHE_MAX`, `SALT_ROTATION_MS` | `crypto/setup.js`, `ops/crypto/reencrypt-master.js` |
| `src/crypto/setup.js` | 55 | Punto único de instanciación: crea la llave maestra y el `messageCrypto` (con la `auth_key` del autor como semilla de firma), y expone la API de cifrado que consume el resto del servidor. | `masterKey`, `messageCrypto`, `encryptAtRest`, `decryptAtRest`, `authKeys`, `authKeyRecord`, `ensureAuthKey`, `rotateSaltIfNeeded`, `encryptForUser`, `decryptForUser`, `messageContextBytes` | casi todos los módulos (`users/`, `chat/`, `groups/`, `stories/`, `calls/`, `push/`, `profile/`) |
| `src/crypto/transport.js` | 212 | Claves y sobre del **canal**: deriva el par X25519 de la llave maestra (HKDF-SHA256 + *clamping*), publica la clave pública y cifra/descifra sobres con ChaCha20 y HMAC-SHA256 (cifrar-y-luego-autenticar), atados a método, ruta, tiempo y estado. El mismo módulo sirve al HTTP y al WebSocket (con otro dominio de HKDF). | `TRANSPORT_ALGO`, `MAX_CLOCK_SKEW_MS`, `transportPublicKey`, `sessionFromEphemeral`, `decryptEnvelope`, `encryptEnvelope`, `requestAad`, `responseAad`, `deriveSessionKey`, `seal`, `open` | `http/transport.js`, `realtime/encrypted.js`, `meta/routes.js`, `test/http/transport.test.js` |

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
| `src/users/store.js` | 659 | Almacén de cuentas. Hidrata cada cuenta desde SQLite (perfil, contactos, stickers, grupos vistos, clave del dispositivo, nota, privacidad, apariencia, silencios, bloqueos y —desde v10— su `rid` de revocación y sus marcas), carga el estado global al arrancar (`loadFromDb`) y persiste (`writeUserRows` reescribe las ~8 tablas de la cuenta; `saveStickers`/`saveMutedPeers`/`saveChatSettings` son guardados quirúrgicos). También `regenerateAuthKey`: genera una `auth_key` nueva y **re-cifra** todo el contenido del usuario para no perder el historial. | `hydrateUserFromDb`, `loadFromDb`, `regenerateAuthKey`, `userFromRow`, `loadUserFromRow`, `accountByName`, `purgeUserFromMemory`, `writeUserRows`, `saveStickers`, `saveMutedPeers`, `saveChatSettings`, `saveUserToDb` | `server.js`, `auth/routes.js`, `auth/sessions.js`, `chat/routes.js`, `contacts/routes.js`, `profile/routes.js`, `groups/store.js`, `stickers/routes.js`, `realtime/websocket.js`, `db/transactions.js` |
| `src/users/helpers.js` | 67 | Utilidades de cuenta: `byId`/`byName` sobre la RAM, `parseJsonSafe` (JSON tolerante a datos corruptos), `usernameTakenInDb`, `accountId` (id estable aunque la cuenta no exista), `pairKeyFromIds` (clave de DM ordenada), `freshNote` (nota con caducidad) y silencios. | `uniq`, `parseJsonSafe`, `byId`, `byName`, `usernameTakenInDb`, `accountId`, `pairKeyFromIds`, `freshNote`, `mutedChatPeers`, `isChatMuted` | prácticamente todos los módulos de dominio |
| `src/users/privacy.js` | 125 | Privacidad **por función** (`foto`, `nota`, `descripcion`, `online`, `historias`, `llamadas`, `mensajes`, `compartir`): modos `server`/`contacts`/`nobody`/`except`/`only` con listas de usuarios. El bloqueo entre dos cuentas siempre gana a la regla de privacidad. | `PRIV_KEYS`, `PRIV_DEF`, `normPriv`, `isContact`, `accountsBlocked`, `privacyFor`, `permite`, `permiteDescripcion`, `isBlockedBy` | `router.js`, `chat/routes.js`, `contacts/routes.js`, `profile/routes.js`, `stories/routes.js`, `chat/media.js`, `realtime/notify.js`, `realtime/websocket.js` |

---

## 8. `src/chat/` — mensajes

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/chat/messages.js` | 315 | Núcleo del mensaje. `prepareStoredMessage` firma (Ed25519) y cifra el cuerpo con la `auth_key` del autor (PCE3) ligando el contexto del mensaje; `rowToMessage` hace el camino inverso y valida versión, descifrado y firma (devuelve `null` si algo falla). `resolveReply` resuelve la cita contra el mensaje real (nunca confía en el id ni en el autor que envía el cliente). `readMessagePage` pagina, `filterForViewer` aplica los borrados por usuario **al servir** (no al cachear), `getChatPage` cachea páginas de DM con **cota global de bytes** (`CHAT_PAGE_CACHE_MAX_BYTES`, 64 MiB) además del tope de entradas. `replyPreviewText`/`enrichReplies` preparan las citas para el cliente. | `messageBody`, `prepareStoredMessage`, `updateStoredMessage`, `rowToMessage`, `findMessage`, `findMessageRow`, `REPLY_ID_RE`, `resolveReply`, `replyPreviewText`, `enrichReplies`, `readMessagePage`, `filterForViewer`, `getChatPage`, `invalidateChatPage`, `deleteMessageById` | `http/router.js`, `chat/routes.js`, `groups/store.js`, `db/transactions.js`, `users/store.js` |
| `src/chat/routes.js` | 606 | Rutas HTTP del chat 1:1: envío (`/send`), lectura paginada (`/messages`), acuses (`/receipt`, con `receiptLimiter` 120/min), "ver una vez" (`/seen`), edición (`/msg/edit`), borrado (`/msg/delete`, `/chat/delete`), preferencias de silencio (`chatPrefsLimiter`), voto en encuestas, descarga de adjuntos (`/blob/:hash`) y resumen de conversaciones (`/chats/summary`). Aplica las mismas reglas de contenido y cuota que los grupos: medio sin hash limitado a `maxInlineMediaChars` (413 si pasa) y `bytesNuevos` cuenta **siempre** el `data` del mensaje para la cuota de blobs (SECOA-I-001). | `getRoute2197`, `getHave`, `getChatsSummary`, `getChatPreferences`, `postChatPreferences`, `postPollVote`, `postSend`, `postSeen`, `postReceipt`, `postMsgDelete`, `postMsgEdit`, `postChatDelete`, `postMessages` | `http/router.js` |
| `src/chat/summaries.js` | 123 | Resúmenes de conversación 1:1 (el último mensaje de cada chat). Se cifran con la clave del **dueño** del resumen; resuelve los nombres desde la RAM. Mantiene la cadena `prevId` para poder rehacer el resumen si se borra el último mensaje. | `resolveName`, `decorateForClient`, `readSummaryEntry`, `writeSummaryEntry`, `lastEntryFromMsg`, `onMessageSentSummary`, `onReadSummary`, `onMessageDeletedSummary`, `onChatDeletedSummary`, `renamePeerInSummaries` | `chat/routes.js`, `router.js`, `groups/store.js`, `chat/mentions.js` |
| `src/chat/media.js` | 54 | Adjuntos (blobs). `storeBlob` exige un data-URL y verifica que el SHA-256 del contenido coincida con el hash declarado; `blobAvailableTo` decide el acceso por conversación, grupo o historia (**conocer el hash no da acceso al fichero**). | `blobHashOk`, `storeBlob`, `readBlob`, `blobAvailableTo` | `router.js`, `chat/routes.js`, `shared/gallery.js`, `stories/routes.js` |
| `src/chat/mentions.js` | 130 | `withMentions` resuelve los usuarios mencionados en un mensaje. `propagateUsernameChange` reescribe el nombre en todo el estado (perfiles, bloqueos, notas, historias, grupos, resúmenes y llamadas) cuando una cuenta cambia de nombre. En las llamadas reindexa por el blind index del nombre viejo (`peer_hash`) y reescribe **las dos copias** del par: la columna cifrada y el nombre dentro del blob `data` del dueño (si no, el historial seguiría mostrando el nombre viejo tras reiniciar), más las listas en RAM del resto de usuarios. | `withMentions`, `propagateUsernameChange` | `router.js`, `profile/routes.js` |

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
| `src/auth/sessions.js` | 280 | Sesiones y cookies **stateless** (v10). El token es un JWT HS256 (secreto derivado de la llave maestra por HKDF-SHA256) que va solo en la cookie `HttpOnly` + `SameSite=Lax`: el servidor lo GENERA pero NO lo guarda (ni tabla ni RAM). Cada petición verifica firma, caducidad y el `checksum` del estado vigente de la cuenta (recalculado con `checksumCoincide`, comparación en tiempo constante). La revocación es POR CUENTA y la dispara `rotateRid` (rota el `rid` de `user_rid`: logout, cambio de contraseña, cambio de cuenta): el checksum descuadra y caen todos sus tokens, también en otros dispositivos; `emitidoAntes` añade la barrera por tiempo (`iat` vs `password_changed_at`/`logged_out_at`). Cookie de cuenta (`chatlocal_account_<id>`) para varias cuentas en el mismo navegador, cada una con su PROPIO token (`jti` aleatorio: sin él, emitidos en el mismo segundo serían idénticos). `originAllowed` es la primera barrera contra CSRF. `requestEncrypted`/`cookieSecure`/`isLoopbackPeer` deciden si la conexión es segura (TLS real o proxy de confianza) y si el cliente es el propio equipo: sobre ellas se apoyan la cookie `Secure` y el portillo del modo degradado. | `TOKEN_ISSUER`, `TOKEN_TTL_MS`, `decodeToken`, `sessionFromToken`, `sessionUser`, `sessionUserFromCookie`, `cookieValue`, `sessionCookie`, `accountCookieName`, `accountCookies`, `appendCookie`, `rotateRid`, `setSessionCookie`, `setAccountSessionCookie`, `clearCookie`, `clearSessionCookie`, `createSession`, `createLinkedAccountSession`, `originAllowed`, `isLoopbackPeer`, `requestEncrypted`, `cookieSecure` | `auth/routes.js`, `profile/routes.js`, `http/router.js`, `realtime/websocket.js`, `stickers/routes.js` |
| `src/auth/rid.js` | 61 | **Núcleo de la revocación sin almacén (v10).** Genera el `rid` aleatorio de cada cuenta (16 bytes + firma HMAC con subclave HKDF de la llave maestra, dominio `zlapy/rid/v1`) y calcula el `checksum` que ata el token al estado vigente de la cuenta: SHA-256 del JSON canónico `id | username | password_hash | rid` (canonicalización: fechas a ISO, `null` a `'null'`). | `generateRid`, `computeChecksum`, `canonical` | `auth/sessions.js`, `db/statements.js`, `users/store.js`, `db/schema.js` |
| `src/profile/routes.js` | 341 | Perfil y cuenta: `GET /profile` con la privacidad aplicada, edición de perfil, ajustes de apariencia, notas, regeneración de la clave de cifrado (`/account/regenerate-key`) y **borrado irreversible de la cuenta** (exige contraseña). Incluye *rollback* manual si el renombrado falla a medias. | `getAccountChatSettings`, `getProfile`, `getNotes`, `postAccountProfile`, `postAccountChatSettings`, `postAccountRegenerateKey`, `postAccountDelete`, `postProfile`, `postNotes` | `http/router.js` |
| `src/contacts/routes.js` | 160 | Solicitudes de contacto (enviar, aceptar, rechazar, cancelar), lista de contactos y bloqueo entre cuentas. Al bloquear se rompe el contacto, se cancelan las solicitudes pendientes y se descartan las ofertas de llamada en curso. | `getContactsRequests`, `getContactsRequestsSent`, `postContacts`, `postContactsRemove`, `postContactsCancel`, `postContactsRespond`, `postBlock` | `http/router.js` |
| `src/stories/routes.js` | 175 | Historias: publicar, listar, ver, dar like, editar y borrar. Cada historia se guarda cifrada con la clave de su autor; el fan-out respeta la privacidad (`permite(..., 'historias', ...)`). El medio que se publica **sin hash** se limita a `CONFIG.storyInlineCharLimit` (4 000 000 caracteres → 413; SECOA-A-001); el flujo normal sube blob + hash. `like`/`view` responden con `200 {ok:false}` en lugar de 404 para no servir de oráculo de existencia. | `getStories`, `postStory`, `postStoryLike` | `http/router.js` |
| `src/stickers/routes.js` | 66 | Proxy de búsqueda de GIPHY (la clave del operador **no** sale del servidor; exige sesión y tiene límite por cuenta) y gestión de stickers favoritos (validados antes de guardarse, máx. 30). | `getGiphySearch`, `getStickers`, `postStickers` | `http/router.js` |
| `src/calls/routes.js` | 31 | Historial de llamadas de la cuenta (filtrando los interlocutores bloqueados) y registro del cierre de una llamada. | `getCalls`, `postCallLog` | `http/router.js` |
| `src/calls/store.js` | 85 | Registro de llamadas por cuenta (en RAM y cifrado en la base) y estado de cada llamada. `addCall` escribe el par cifrado **y su índice a ciegas** (`peer_hash`) en la misma inserción. `endUserCalls` cierra las llamadas vivas cuando se cae la última conexión, para no dejar la contraparte colgada. | `addCall`, `updateCall`, `hasCall`, `hasPendingCall`, `CALL_TERMINAL_STATES`, `endUserCalls` | `realtime/websocket.js`, `calls/routes.js` |
| `src/crypto/peer-index.js` | 54 | **Índice a ciegas de nombres de par (v11).** HMAC-SHA256 del nombre normalizado (trim + minúsculas) con subclave HKDF de la llave maestra (dominio `zlapy/calls-peer-index/v1`): la columna `calls.peer_hash` permite localizar y purgar llamadas por nombre sin descifrar nada (O(log n) en vez de barrido completo). Determinista entre procesos, unidireccional (no revela el nombre). Se carga en perezoso para no arrancar el servidor criptográfico al importarlo. | `peerHash` | `db/statements.js`, `calls/store.js`, `chat/mentions.js`, `db/schema.js` |
| `src/push/routes.js` | 53 | Alta y baja de suscripciones de dispositivos (las claves se guardan cifradas en reposo) y envío de una notificación de prueba. | `postPushSubscribe`, `postPushUnsubscribe`, `postPushTest` | `http/router.js` |
| `src/push/vapid.js` | 118 | Genera y guarda la clave VAPID (cifrada en reposo en `meta`), firma el JWT de autorización (ES256) y cifra cada notificación con WebPush (aes128gcm). `notifyUser` limpia las suscripciones caducadas (404/410) y las zombi por cambio de clave (403 «the VAPID credentials … do not correspond»: creadas con otra clave del servidor nunca entregarán) y avisa por log de los fallos. | `b64u`, `b64uDec`, `vapidRecord`, `VAPID`, `hkdfExtract`, `hkdfExpand`, `vapidAuth`, `pushTo`, `notifyUser`, `pushNameOf` | `http/router.js`, `chat/routes.js`, `contacts/routes.js`, `realtime/websocket.js`, `auth/routes.js` |
| `src/meta/routes.js` | 39 | Metadatos y salud: `GET /healthz` (comprueba que **ambas** bases respondan) y el volcado de límites que consume el cliente. | `getConfig`, `getHealthz` | `http/router.js` (solo `getHealthz`) |

---

## 11. `src/realtime/` — WebSocket

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/realtime/websocket.js` | 429 | Servidor WebSocket: upgrade (valida el *handshake* RFC 6455, exige sesión y origen válido), tope de 8 conexiones por cuenta, *token bucket* por conexión (200 frames/s, ráfaga 600), tope de buffer entrante (768 KB) y *heartbeat* que cierra conexiones colgadas. Acepta el saludo cifrado (`{type:"enc", ephemeral}`), descifra los frames `z1:` y deja el resto del manejo igual. Gestiona los frames de llamada, `typing`/`recording`, y el frame `privacy` (fusión de la matriz de privacidad + nota). Al final, tareas periódicas de limpieza: historias caducadas e intentos de login agotados (las sesiones caducaron solas desde v9: no hay almacén). | `rejectUpgrade`, `wsUpgradeInner`, `wsUpgrade`, `pruneAuthState` | `http/servers.js` |
| `src/realtime/notify.js` | 157 | Escritura de frames a los clientes y difusión. `wsSend`/`pushRawName` construyen la cabecera de frame, cifran el texto si el socket tiene sesión (`z1:`) y respetan el *backpressure* (1 MB pendiente → se corta el socket). `push`/`pushName` entregan a **todas** las conexiones de la cuenta. Además `userList`, `broadcastUsersAround`, `broadcastUsers`, `connectContacts`, `removeContacts` y el reparto de historias según privacidad. | `WS_MAX_PER_USER`, `WS_FRAME_RATE`, `WS_FRAME_BURST`, `WS_MAX_BACKLOG_BYTES`, `textFrameHead`, `wsSend`, `pushRawName`, `push`, `pushName`, `userList`, `broadcastUsersAround`, `broadcastUsers`, `updateContactRequests`, `connectContacts`, `removeContacts`, `liveStories`, `storyForViewer`, `pushStories` | prácticamente todos los módulos de dominio |
| `src/realtime/encrypted.js` | 77 | Sesión cifrada del WebSocket: procesa el saludo `enc` (32 bytes de clave efímera), deriva la clave en el dominio `zlapy-transport-v1/ws`, lleva contadores de nonce por sentido con las etiquetas `zlapyC2S`/`zlapyS2C` y sella/abre los frames `z1:`. Un frame inválido se descarta sin cerrar la conexión; sin saludo, todo sigue en claro. | `WS_PREFIX`, `WS_INFO`, `acceptHandshake`, `openFrame`, `sealFrame`, `wsNonce`, `wsAad` | `realtime/websocket.js`, `realtime/notify.js`, `test/http/transport.test.js` |
| `src/realtime/frames.js` | 118 | Framing WebSocket (RFC 6455) del subconjunto usado: exige frames enmascarados, acota longitud (256 KB/frame) y buffer (768 KB) con close 1009, rechaza frames de control fragmentados o >125 B (close 1002), contesta ping, ensambla fragmentación con tope de 4096 trozos y rechaza opcodes binarios (close 1003). | `parseFrames(socket, buf, onText)`, `closeFrame(code, reason)`, `MAX_FRAME_BYTES`, `MAX_BUFFER_BYTES`, `MAX_FRAGMENTS` | `realtime/websocket.js` |

---

## 12. `src/http/` — servidor HTTP

| Fichero | Líneas | Qué hace | Exporta | Consumido por |
|---|---:|---|---|---|
| `src/http/router.js` | 730 | **El enrutador.** Mantiene el orden de comprobaciones: forzado de TLS (301 a HTTPS) → rutas públicas (`/config`, `/healthz`, `/avatar/:id.svg`, páginas estáticas) → sesión → **portillo del modo degradado: `publicAuthPost` desde fuera de loopback → 503** → método → origen válido (CSRF) → cuerpo JSON con tope por ruta (8 KiB en las de auth, `MAX_HTTP_BODY_BYTES` en el resto). Si el `POST` trae `X-Zlapy-Enc`, descifra el cuerpo antes de interpretarlo y envuelve la respuesta. Contiene las acciones de grupo en línea (`join`, `leave`, `addMember`, `removeMember`, `approveAdmin`, políticas, *keyboxes*, envío de mensajes de grupo) con estas reglas de la ronda SECOA: **tope de `maxGroupMembers`** al crear/entrar/añadir, **el propietario no se puede expulsar** (403) y **cinco políticas de grupo son solo-admins** (`visibility`, `join_policy`, `add_policy`, `edit_policy`, `mention_all_policy`; 403 para el resto). | `handleRequest`, `handler` | `http/servers.js` |
| `src/http/transport.js` | 154 | Sobre cifrado en el ciclo HTTP: `isEncrypted` detecta la cabecera, `openRequest` valida versión/tiempo/clave/nonce/HMAC y devuelve el JSON descifrado más la sesión, y `sealResponse` intercepta `writeHead`/`end` para quitar `Content-Length`, anunciar `X-Zlapy-Enc`/`X-Zlapy-Resp-Nonce` y cifrar el cuerpo. **Anti-replay**: memoria de nonces (`nonceUsado`, `NONCE_MEMORY_MS`, tope 8192 entradas) que se registra **solo tras validar el MAC** — y rechaza nonce vacío o de más de 32 bytes (sin eso, un sobre sin nonce eludía el registro). | `isEncrypted`, `openRequest`, `sealResponse`, `nonceUsado`, `NONCE_MEMORY_MS` | `http/router.js`, `test/http/transport.test.js` |
| `src/http/servers.js` | 150 | Arranque y cierre ordenado. Crea el servidor HTTP y, si existen `cert.pem`/`key.pem`, el HTTPS; un `dispatcher` TCP decide por el primer byte si la conexión es TLS (0x16) y enruta el *upgrade* WebSocket por el mismo puerto. `SO_REUSEADDR` para reenganchar el puerto tras un reinicio. Con `FORCE_TLS` activo y sin certificados **no aborta**: marca `tlsState.degradedNoCert` (HTTP total, pero el router cierra la autenticación pública desde fuera de loopback). En `SIGTERM`/`SIGINT` cierra sockets, hace `wal_checkpoint(TRUNCATE)` y cierra las bases. | `httpSrv`, `httpsSrv`, `dispatcher`, `orderlyShutdown` | `server.js` |
| `src/http/responses.js` | 49 | Cabeceras de seguridad para **toda** respuesta (`nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP) y la CSP por petición (el host se valida con `CSP_HOST_RE` antes de meterse en la cabecera). `json()` es el envoltorio con `Cache-Control: no-store`. | `securityHeaders`, `CSP_HOST_RE`, `cspFor(host)`, `json(res, code, obj)` | todos los módulos de rutas |
| `src/http/rate-limit.js` | 82 | Contadores de fuerza bruta y **once limitadores por cuenta** (ventana deslizante de 60 s): mensajería (30), GIPHY (30), perfil (10), historias (15), vistas de historias (60), contactos (20), creación de grupos (10), ofertas de llamada (5), preferencias de chat (20), verificación de contraseña (5) y acuses de lectura (120, `receiptLimiter`, añadido en la ronda SECOA: cada uno recorre hasta 500 ids y descifra cada fila). Contadores de login/registro en Map en RAM con purga perezosa; todo podado con `unref()`. También cuenta el barrido periódico de blobs huérfanos. | `loginAttempts`, `registerAttempts`, `messageRateLimiter`, `giphyLimiter`, `profileLimiter`, `storyLimiter`, `storyViewLimiter`, `contactLimiter`, `groupCreateLimiter`, `callOfferLimiter`, `chatPrefsLimiter`, `passwordCheckLimiter`, `receiptLimiter` | `auth/routes.js`, `http/helpers.js`, `stickers/routes.js`, `profile/routes.js`, `stories/routes.js`, `users/store.js`, `chat/routes.js`, `http/router.js`, `realtime/websocket.js` |
| `src/http/helpers.js` | 51 | Utilidades de respuesta: mapa de tipos MIME de los estáticos, `rejectRateLimitedMessage` (429 con `Retry-After`), `rejectRateLimited` genérico y `safeDecodeSegment` (decodifica un segmento de ruta sin lanzar). | `mimeMap`, `rejectRateLimitedMessage`, `rejectRateLimited`, `safeDecodeSegment` | `http/router.js`, `chat/routes.js`, `profile/routes.js`, `stories/routes.js`, `stickers/routes.js` |

---

## 13. `ops/` — scripts de operación

Organizados por dominio, igual que `src/`: `install/` (dependencias y binario nativo), `runtime/` (supervisor), `db/` (visores), `backup/`, `crypto/`, `auth/`, `net/`, `config/` y `data/` (generadores).

| Fichero | Líneas | Qué hace | Notas |
|---|---:|---|---|
| `ops/install/ensure-deps.js` | ~230 | Preflight de dependencias: verifica las librerías de `package.json` (+ Node `>=22` + binario nativo de `better-sqlite3`) e instala las que falten (`npm install`). Camino feliz en milisegundos (comprobación por ficheros); si algo falta, carga real en proceso hijo para enumerar lo roto. `npm start` lo ejecuta antes del supervisor; `verifyDeps()` lo usa `server.js` al arrancar (exit 79 si falta algo). | `verifyDeps`, `ensureDeps`, `dependencies`, `minNodeMajor`; CLI: `npm run deps`. Salidas: 0 ok · 1 Node antiguo · 3 no se pudo. |
| `ops/install/check-native.js` | ~90 | `postinstall`. Comprueba el binario nativo de `better-sqlite3`; si falta, intenta compilarlo (`build-sqlite.js`, el caso Termux/Android sin prebuilds). | Sin exports cuando es principal; lo lanza `ensure-deps.js` indirectamente vía npm. |
| `ops/install/build-sqlite.js` | ~90 | `npm run rebuild:sqlite`. Compila better-sqlite3 en la plataforma actual (node-gyp). | Sin exports. |
| `ops/runtime/supervisor.js` | 503 | `npm start`. Vigila `node server.js`: preflight de dependencias antes del primer arranque, canal **IPC** con el hijo (`ready`/`hb`/`deps-missing` · `stop`), backoff exponencial (1 s → 30 s), cortacircuito de fallos de arranque (exit 70), caídas en caliente que nunca dejan el servicio apagado, *watchdog* de salud contra `/healthz` + **watchdog de latido** (45 s sin latido estando en marcha → reinicio), PID en `.zlapy.pid` (0600), cierre en cascada en SIGINT/SIGTERM/SIGHUP y salida 78 (credencial) / 79 (dependencias: instala y relanza sin backoff) sin bucle de reinicios. | `checkHealth`, `killUnhealthy`, `classifyExit`, `getState`; solo arranca si es el módulo principal. |
| `ops/net/tunnel.js` | 165 | `npm run tunnel`. Levanta `cloudflared` con la configuración de `zty.yml` y el token de `CLOUDFLARE_TUNNEL_TOKEN`. El token **no viaja en argv**: se entrega por `--token-file` (fichero temporal 0600 en directorio 0700, borrado al salir) o, si la versión no lo soporta, por la variable de entorno `TUNNEL_TOKEN`. La salida del proceso se filtra para redactar el token. | Sin exports. |
| `ops/backup/backup.js` | ~110 | `npm run backup`. Copia las dos bases con la API de backup de SQLite (seguro con el servidor en marcha) y el `.env` como `credencial.env`: sin la credencial el respaldo es inservible. Fija permisos 0700/0600 de forma incondicional. | Sin exports. |
| `ops/auth/owner-credentials.js` | ~640 | `npm run owner`. CLI de la credencial del propietario: `init` (base nueva), `credential` (migra y re-cifra TODO), `rotate` (sal nueva), `check` (auditoría), `show`, `unlock-check`, `export-kit` (kit de recuperación) y `reset` (borra las bases). Acepta `--env`/`--db`/`--blob-db` para pruebas. No muestra la contraseña por pantalla. | Sin exports (es un CLI). |
| `ops/config/env-writer.js` | ~90 | Escritura atómica de secretos (`writeSecretFile`: temporal 0600 + fsync + rename), `setEnvValue` y lectura directa de variables (`readEnvValue`, misma mecánica de regex que `src/crypto/master-key.js`). Módulo diminuto sin dependencias: lo comparten el generador de llave y el motor de re-cifrado sin círculos de require. | `writeSecretFile`, `setEnvValue`, `readEnvValue` |
| `ops/crypto/reencrypt-master.js` | ~460 | Motor de ROTACIÓN de la llave maestra con re-cifrado completo (verifica todos los sobres con la llave vieja, copia el `.env` a `.env.master-bak`, entra la llave nueva y re-cifra `user_auth_keys`, `groups.keys_cipher`, `meta` VAPID y `blobs.data` en transacciones; reversión compensada ante fallo). **Exige el servidor parado**: `serverIsRunning()` lee el fichero de PID de ESA instalación y aborta si el proceso sigue vivo (si no, el proceso viejo seguiría escribiendo con la llave anterior). `auditMasterKey()` enumera, en solo lectura, el material que no descifra con la llave actual. | `rotateMasterKey(options)`, `hasMasterDataAtRest(dbPath, blobPath)`, `isMasterEnvelope(value)`, `auditMasterKey(options)`, `serverIsRunning(options)`, `resolvePidFile(options)` |
| `ops/crypto/repair-unreadable-auth-keys.js` | ~150 | `npm run repair [-- --apply]`. Repara las `auth_key` que NO se descifran con la llave actual (típico de haber girado la llave con el servidor en marcha): respaldo de `data/zlapy.db`, borra la fila ilegible y limpia los campos de perfil cifrados con esa clave. Sin `--apply` solo simula. El contenido cifrado con la clave perdida no se recupera: hace falta la llave anterior del respaldo. | Sin exports. |
| `ops/data/generate-emoji-data.js` | ~200 | `npm run generate:emojis`. Genera los índices JSON de emojis que consume el cliente. | Sin exports. |
| `ops/data/generate-animated-bbot-pack.js` | ~600 | Genera el paquete animado bbot (WebP) registrado en la biblioteca de stickers; lo invoca `src/stickers/default-pack.js` cuando falta. | Sin exports. |

---

## 14. `public/` — cliente web

Desde la reordenación del cliente, los ficheros compartidos viven en `public/js/`
y `public/css/`; en la raíz de `public/` solo quedan las páginas y **dos
`shims` de compatibilidad** (ver al final de la tabla).

| Fichero | Líneas | Qué hace | Notas |
|---|---:|---|---|
| `public/index.html` | 23128 | La SPA principal en un único fichero: HTML + CSS + JS inline (chat, grupos, historias, llamadas WebRTC, ajustes, notas, encuestas, menciones, adjuntos, stickers). | Rutas de API: `/auth/*`, `/account/*`, `/send`, `/messages`, `/receipt`, `/seen`, `/msg/*`, `/chat/*`, `/contacts/*`, `/groups/*`, `/stories`, `/story/*`, `/profile`, `/block`, `/poll/vote`, `/stickers`, `/push/*`, `/blob/*`, `/avatar/*`, `/call/log`, `/config`. Carga `/css/theme.css`, `avatar-editor.css`, `popmenu.css` y `/js/{transport-crypto.js, transport.js, avatar-editor.js, popmenu.js, autogrow.js, local-data.js}`. Registra el service worker en `/sw.js?v=42`. |
| `public/login.html` | 202 | Pantalla de acceso (login y registro), separada de la SPA: si no hay sesión, `index.html` redirige aquí. | Carga `/css/theme.css`, `/css/login.css`, `/js/transport-crypto.js` y `/js/transport.js`; hace `POST /auth/login` o `POST /auth/register`. |
| `public/group-create.html` | 242 | Formulario de creación de grupo: nombre, descripción, miembros elegibles y avatar. | Carga `/css/{theme,group-create,avatar-editor}.css` y `/js/{autogrow,avatar-editor,group-create,transport-crypto,transport}.js`. |
| `public/group-details.html` | 337 | Ficha del grupo: ajustes y políticas según el rol, integrantes y solicitudes de entrada. | Carga `/css/{theme,group-create,group-details,popmenu,avatar-editor}.css` y `/js/{autogrow,avatar-editor,group-details,popmenu,transport-crypto,transport}.js`. |
| `public/profile.html` | 409 | Pantalla de "Mi perfil": datos de la cuenta, cambio de nombre y contraseña, preferencias de privacidad y ajustes de apariencia. | Carga `/css/{theme,avatar-editor}.css` y `/js/{appearance,autogrow,avatar-editor,transport-crypto,transport}.js`. |
| `public/view.html` | 380 | Visor de perfil de un contacto (sin sidebar). Se usa en `iframe` dentro de `index.html`. | Carga `/css/theme.css` y `/js/{appearance,transport-crypto,transport}.js`. |
| `public/stories.html` | 2391 | Visor de historias a pantalla completa (con visualizaciones, likes, editor de publicación y hoja de stickers). | Carga `/css/{theme,popmenu}.css` y `/js/{popmenu,appearance,transport-crypto,transport}.js`. |
| `public/privacy.html` | 615 | Política de privacidad estática. | Carga `/css/theme.css` y `/js/{appearance,transport-crypto,transport}.js`. |
| `public/css/theme.css` | 639 | Hoja de estilos común: tokens CSS, tema oscuro, formularios y controles. La cargan todas las páginas. | — |
| `public/css/fonts.css` | 41 | Tipografía Outfit servida en local: dos `@font-face` variables (`latin` y `latin-ext`), la pila `--font-ui` y el `font-family` base de la interfaz. La cargan todas las páginas antes que el resto de CSS. | — |
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
| `public/js/local-data.js` | 352 | Medición y limpieza de los datos que el navegador guarda: Cache Storage (shell offline), `localStorage` por categorías, `sessionStorage`, cookies visibles y adjuntos en RAM. La limpieza no toca la cookie de sesión (`HttpOnly`): la sesión no se cierra. | UMD (`window.ZlapyLocalData` / `module.exports`); lógica pura con API inyectadas para probarla sin navegador (`collectReport`, `cleanLocalData`). Lo usa Ajustes > Datos locales. |
| `public/js/sw.js` | 73 | Service worker: cachea el *shell* (`zlapy-v156`, fuentes Outfit incluidas), sirve offline solo las navegaciones del shell (el resto falla de forma explícita, sin inventar un 504 vacío) y gestiona las notificaciones push y su clic. | — |
| `public/sw.js` | 1 | **Shim** de compatibilidad: `importScripts('/js/sw.js')`. Los navegadores que ya registraron `/sw.js` siguen recibiendo actualizaciones a través de él. | Sin lógica propia. |
| `public/transport-crypto.js` | 4 | **Shim** de compatibilidad: comenta que la ruta histórica sigue existiendo y hace `require('./js/transport-crypto.js')` para la suite de Node. | Se borrará cuando ningún test cargue la ruta antigua. |
| `public/manifest.webmanifest` | 14 | Manifiesto PWA: nombre, `display: standalone`, colores e iconos. | — |
| `public/image/icon-192-border.webp` | binario | Icono 192×192. | — |
| `public/image/icon-512-border.webp` | binario | Icono 512×512 (también `maskable`). | — |
| `public/image/icon-512-full.webp` | binario | Icono 512×512 sin borde. | — |
| `public/image/isotype-308.webp` | binario | Isotipo 308×308. | — |
| `public/image/isotype-512-full.webp` | binario | Isotipo 512×512 (el de la pantalla de acceso). | — |
| `public/fonts/outfit/outfit-latin.woff2` | binario | Outfit variable (peso 100–900) para el subconjunto latino. Se sirve sin sesión con MIME `font/woff2`. | — |
| `public/fonts/outfit/outfit-latin-ext.woff2` | binario | Outfit variable para el subconjunto latino ampliado (acentos y signos de Europa del Este). | — |

---

## 15. `test/` — suite de pruebas

Partida por dominio, igual que `src/` y `ops/`: `auth/`, `calls/`, `chat/`, `client/`, `crypto/`, `db/`, `groups/`, `http/`, `profile/`, `push/`, `runtime/`, `shared/`, `stickers/`. En la raíz se quedan el arnés común (`bootstrap.js`, `helpers.js`). El script `npm test` descubre los ficheros con glob recursivo (`test/**/*.test.js`).

Se ejecuta con `npm test` → `node --test --require ./test/bootstrap.js "test/**/*.test.js"` (Node expande el glob; el arnés común sigue en la raíz de `test/`).

| Fichero | Líneas | Qué cubre |
|---|---:|---|
| `test/helpers.js` | 246 | Utilidad (no es un test): arranca `server.js` como proceso hijo con `DATA_DIR` temporal y puerto libre, y provee `api()`, `register()`, `rawRequest()` y un cliente WebSocket mínimo (`WsClient`) con framing propio, acceso a los textos crudos y envío de texto. |
| `test/shared/appearance.test.js` | 49 | Normalización de la apariencia del chat y persistencia del fondo. |
| `test/auth/auth-tokens.test.js` | 269 | Tokens JWT **stateless** (v10): payload con `checksum` (y sin `ver`), token manipulado/inventado no autentica, rid rotado en la base mata el token, contraseña y logout revocan TODOS los tokens de la cuenta, cambio de cuenta revoca el token saliente, y el secreto sobrevive al reinicio (con la revocación). |
| `test/profile/avatar.test.js` | 46 | Identicon SVG estable y determinista. |
| `test/calls/calls-peer-index.test.js` | 164 | Índice a ciegas de llamadas (v11-v12): alta con par cifrado + `peer_hash`, renombre actualiza columna e interior del blob, borrado de cuenta purga por hash y, tras reiniciar, el historial de CADA extremo sigue en su sitio. |
| `test/profile/presence-privacy.test.js` | 184 | Privacidad de presencia: los 5 modos de `online`, el bloqueo gana sobre los demás modos, y la persistencia al re-guardar (el `POST` reemplaza el conjunto completo). |
| `test/runtime/config.test.js` | 31 | `.env.example` válido, valores por defecto y overrides de `loadConfig`. |
| `test/http/frames.test.js` | 135 | Framing RFC 6455: máscaras, longitudes, fragmentación, códigos de cierre. |
| `test/chat/gallery.test.js` | 63 | Validación de galerías y acotado de metadatos. |
| `test/auth/owner-credential.test.js` | ~200 | CLI de la credencial: init, contraseña débil, base con datos, migración completa, rotate, check, export-kit, reset. |
| `test/crypto/kdf.test.js` | ~80 | Derivación determinista, sal/usuario/contraseña cambian la llave, pre-hash de bcrypt, contraseñas triviales. |
| `test/crypto/field-crypto.test.js` | ~70 | Cifrado por columna con AAD propio; el mapa `FIELD_TABLES` cubre las columnas que re-cifra el motor. |
| `test/crypto/plaintext.test.js` | ~120 | Los BYTES CRUDOS de las bases no contienen nombres, fotos, invitaciones ni colores en claro. |
| `test/auth/password.test.js` | ~70 | bcrypt (worker) + verificación del formato antiguo scrypt; basura en el hash no revienta. |
| `test/crypto/master-key-guards.test.js` | ~250 | Guardas de desincronización de llaves: fila ilegible ≠ fila ausente (error claro, no `UNIQUE`), auditoría del material ilegible y su impacto, rotación bloqueada con servidor vivo, vigilante del `.env` y script de reparación. |
| `test/shared/limits.test.js` | 34 | Límites por tipo y limitador de frecuencia (ventana deslizante). |
| `test/client/local-data.test.js` | 306 | Datos locales del navegador: medición por categorías, plan de limpieza acotado a lo seleccionado, borrado de cookies visibles sin tocar la sesión (`HttpOnly`) y empaquetado del módulo (`index.html` + SHELL del service worker). |
| `test/push/push-sub-cleanup.test.js` | 5 casos | Limpieza de suscripciones push muertas: 403 por credenciales VAPID ajenas (suscripción creada con otra clave del servidor) elimina la fila y la entrada de RAM; 403 ajeno a credenciales, 201 y error local la conservan; 410 sigue eliminando. |
| `test/crypto/message-crypto.test.js` | 57 | Cifrado de mensajes con AAD ligado al contexto y firma. |
| `test/chat/message-data.test.js` | 29 | Desencriptado de los campos heredados (`PCE1:`). |
| `test/crypto/master-rotation.test.js` | 156 | El script de migración: simula, migra, conserva el contenido y el servidor funciona sin él. |
| `test/crypto/mtproto-server.test.js` | 129 | Integración del cifrado en nube: `auth_key` por usuario, aislamiento entre cuentas, huella publicada y regeneración sin perder historial. |
| `test/crypto/mtproto.test.js` | 122 | Primitivas MTProto: ida y vuelta, derivación de claves, cabecera interna, relleno y ventanas de `msg_id`. |
| `test/db/schema.test.js` | 486 | Esquema v12: idempotencia, cascadas del borrado de cuenta (y que no purga grupos cuyo `gid` contenga el uuid de la víctima), `UNIQUE`/`CHECK`/FK, migraciones v9→v12 (crea `user_rid`, retira `sessions` y `auth_version`, añade `calls.peer_hash`, reconstruye la PK de `calls`). |
| `test/http/security-regressions.test.js` | 270 | Regresiones de la auditoría de seguridad del 2026-10-19 (una cuenta no puede leer lo de otra, enumeración de cuentas, CSRF, etc.). |
| `test/http/server-http.test.js` | 121 | Integración HTTP contra `server.js` real: request-targets malformados, auth, borrado de cuenta y reinicio. |
| `test/http/server-ws.test.js` | 130 | Integración WebSocket: handshake, multi-dispositivo, límites de frame/buffer, *rate limit* y cierre de llamadas al desconectar. |
| `test/http/static-path.test.js` | 51 | Traversal y trucos de ruta en los estáticos. |
| `test/runtime/supervisor.test.js` | 90 | Humo del supervisor: arranca, `/healthz` responde, mata al hijo y lo reinicia (puerto y `DATA_DIR` temporales). Incluye `classifyExit` (79 deps / 78 config / crash) y el preflight de dependencias. |
| `test/runtime/ensure-deps.test.js` | 6 casos | Preflight de dependencias: con las del repo pasa sin instalar nada; detecta y «instala» solo lo que falta (instalador inyectado, sin tocar npm); Node antiguo y fallos de instalación con mensaje accionable. |
| `test/runtime/process-guards.test.js` | 3 casos | Guardas con procesos hijos reales: error NO fatal → el proceso sigue vivo y queda en `data/log/errors.log`; error FATAL (`ENOSPC`) → salida con código 1; `isFatal` distingue SQLITE corrupta de un bug corriente. |
| `test/http/transport.test.js` | 277 | Sobre del canal HTTP y WebSocket: primitivas del cliente contra Node (incluido un vector RFC 8439), ida y vuelta de 2 MB, rechazo de sobres manipulados/otra ruta/otro tiempo, publicación de la clave en `/config` y `/healthz`, registro y mensajes cifrados, `400` con sobre roto, compatibilidad en claro y handshake `enc` con frames `z1:`. |
| `test/shared/types.test.js` | 55 | Encuestas y tarjetas de contacto. |

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
| `docs/DECISIONES-AUDITORIA.md` | 223 | Decisiones de diseño tomadas tras las auditorías (V-12, V-18, CSP, SECOA…): qué se decidió no cambiar y por qué, más el estado actual (v9→v12) de las decisiones que parecen fallos sin contexto. |
| `docs/esquema/esquema.js` | 980 | Datos del visor 2D del esquema de la base (transcritos de `src/db/schema.js`). |
| `docs/esquema/index.html` | 64 | Página del visor del esquema. |
| `docs/esquema/esquema.css` | 510 | Estilos del visor del esquema. |
| `.github/workflows/ci.yml` | 37 | CI: `npm ci` (con la caché de npm alimentada por `package-lock.json`) + `npm test` en Node 22. Sin secretos; `permissions: contents: read`. |

---

## 17. Glosario de símbolos exportados

Referencia rápida: **qué** exporta cada módulo y **quién** lo consume. "—" significa que no hay consumidor fuera del propio fichero.

### 17.1 `src/` (núcleo)

| Módulo | Exporta | Consumido por |
|---|---|---|
| `config.js` | `DEFAULTS`, `loadConfig`, `ROOT`, `CONFIG`, `tlsState`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `GIPHY_API_KEY`, `PORT`, `PUBLIC`, `DATA`, `DB_PATH`, `BLOB_DB_PATH` | `config.test.js`, `shared/limits.js`, `shared/gallery.js`, `db/database.js`, `http/router.js`, `http/servers.js`, `crypto/master-key.js`, `auth/sessions.js`, `users/store.js`, `chat/routes.js`, `chat/messages.js`, `stories/routes.js`, `profile/routes.js`, `meta/routes.js`, `realtime/websocket.js`, `realtime/notify.js`, `push/vapid.js`, `stickers/routes.js`, `groups/routes.js`, `ops/backup/backup.js`, `ops/crypto/reencrypt-master.js` |
| `state.js` | `setStories`, `setNotesMap`, `setCallFiles` + 13 estructuras de estado + `CHAT_PAGE_TTL`, `CHAT_PAGE_MAX`, `AUTH_SESSION_TTL` | todos los módulos de dominio (y `state.js` es la única fuente de los mapas mutables) |

### 17.2 `src/db/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `database.js` | `db`, `blobDb`, `messageSchema` | `db`/`blobDb`: `statements.js`, `transactions.js`, `schema.js`, `http/servers.js`, `users/store.js`, `chat/mentions.js`, `stories/routes.js`, `realtime/websocket.js`, `meta/routes.js`, `push/routes.js`, `crypto/setup.js`. `messageSchema`: — (solo interno) |
| `schema.js` | `SCHEMA_VERSION`, `SCHEMA_SQL`, `applySchema`, `ensureSchema`, `tableExists`, `tableColumns`, `tableSql`, `backfillUserRids`, `backfillCallPeerHashes`, `deleteAccountRows`, `deleteGroupRows`, `deleteMessageRowsWhere` | `ensureSchema`/`applySchema`: `database.js`. `backfillUserRids`/`backfillCallPeerHashes`: `server.js`. `deleteAccountRows`/`deleteGroupRows`: `transactions.js`. `SCHEMA_VERSION`: `server.js`, `users/store.js`, `meta/routes.js`. `tableExists`/`tableColumns`/`applySchema`/`SCHEMA_SQL`: `test/db/schema.test.js` |
| `statements.js` | `Stmt` (~126 sentencias preparadas) + `deleteGroupSummary` + `getRid`/`upsertRid` + `listCallsByPeerHash`/`deleteCallsByPeerHash` | `Stmt`: prácticamente todos los dominios. `deleteGroupSummary`: `http/router.js`, `groups/store.js`. `getRid`/`upsertRid`: `db/schema.js` (backfill), `users/store.js`, `auth/sessions.js` (rotar el rid = revocar tokens v10). `listCallsByPeerHash`: `chat/mentions.js`. `deleteCallsByPeerHash`: `db/schema.js` (purga de cuenta) |
| `transactions.js` | `stmtBlobHasReference`, `stmtBlobRemove`, `pruneBlobHashes`, `blobAccessWhereCache`, `removeBlobAccess`, `tx` | `pruneBlobHashes`/`removeBlobAccess`/`tx`: `http/router.js`, `chat/routes.js`, `chat/messages.js`, `stories/routes.js`, `profile/routes.js`, `realtime/websocket.js`, `users/store.js` |

### 17.3 `src/crypto/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `master-key.js` | `getMasterKeyBytes` | `crypto/setup.js` |
| `message-crypto.js` | `createMessageCrypto` | `crypto/setup.js`, `ops/crypto/reencrypt-master.js`, `test/message-crypto.test.js` |
| `mtproto.js` | `AUTH_KEY_BYTES`, `PADDING_MIN`, `PADDING_MAX`, `INTERNAL_HEADER_BYTES`, `DOMAIN`, `authKeyId`, `generateAuthKey`, `deriveKeys`, `computeMsgKey`, `buildPadding`, `buildInternalHeader`, `readInternalHeader`, `encrypt`, `decrypt`, `keyFingerprint`, `nextMsgId`, `msgIdAcceptable` | `crypto/setup.js`, `crypto/user-auth-keys.js`, `chat/messages.js`, `users/store.js`, `ops/crypto/reencrypt-master.js`, `test/mtproto.test.js` |
| `user-auth-keys.js` | `createUserAuthKeys`, `AUTH_KEY_CACHE_MAX`, `SALT_ROTATION_MS` | `crypto/setup.js`, `ops/crypto/reencrypt-master.js` |
| `setup.js` | `masterKey`, `messageCrypto`, `encryptAtRest`, `decryptAtRest`, `authKeys`, `authKeyRecord`, `ensureAuthKey`, `rotateSaltIfNeeded`, `encryptForUser`, `decryptForUser`, `messageContextBytes` | `chat/messages.js`, `chat/media.js`, `chat/summaries.js`, `groups/store.js`, `stories/routes.js`, `calls/store.js`, `push/routes.js`, `push/vapid.js`, `profile/routes.js`, `users/store.js` |
| `transport.js` | `TRANSPORT_ALGO`, `MAX_CLOCK_SKEW_MS`, `transportPublicKey`, `sessionFromEphemeral`, `decryptEnvelope`, `encryptEnvelope`, `requestAad`, `responseAad`, `deriveSessionKey`, `seal`, `open` | `http/transport.js`, `realtime/encrypted.js`, `meta/routes.js`, `test/http/transport.test.js` |

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
| `auth/sessions.js` | `TOKEN_ISSUER`, `TOKEN_TTL_MS`, `decodeToken`, `sessionFromToken`, `sessionUser`, `sessionUserFromCookie`, `cookieValue`, `sessionCookie`, `accountCookieName`, `accountCookies`, `appendCookie`, `rotateRid`, `setSessionCookie`, `setAccountSessionCookie`, `clearCookie`, `clearSessionCookie`, `createSession`, `createLinkedAccountSession`, `originAllowed`, `isLoopbackPeer`, `requestEncrypted`, `cookieSecure` | `auth/routes.js`, `profile/routes.js`, `http/router.js`, `realtime/websocket.js`, `stickers/routes.js` |

### 17.8 `src/realtime/` y `src/http/`

| Módulo | Exporta | Consumido por |
|---|---|---|
| `realtime/websocket.js` | `rejectUpgrade`, `wsUpgradeInner`, `wsUpgrade` | `http/servers.js` |
| `realtime/notify.js` | `WS_MAX_PER_USER`, `WS_FRAME_RATE`, `WS_FRAME_BURST`, `WS_MAX_BACKLOG_BYTES`, `textFrameHead`, `wsSend`, `pushRawName`, `push`, `pushName`, `userList`, `broadcastUsersAround`, `broadcastUsers`, `updateContactRequests`, `connectContacts`, `removeContacts`, `liveStories`, `storyForViewer`, `pushStories` | `http/router.js`, `chat/routes.js`, `groups/routes.js`, `contacts/routes.js`, `profile/routes.js`, `stories/routes.js`, `calls/store.js`, `push/vapid.js`, `realtime/websocket.js`, `auth/sessions.js`, `auth/routes.js`, `chat/mentions.js`, `users/store.js`, `groups/store.js` |
| `realtime/frames.js` | `parseFrames`, `closeFrame`, `MAX_FRAME_BYTES`, `MAX_BUFFER_BYTES`, `MAX_FRAGMENTS` | `realtime/websocket.js` |
| `realtime/encrypted.js` | `WS_PREFIX`, `WS_INFO`, `acceptHandshake`, `openFrame`, `sealFrame`, `wsNonce`, `wsAad` | `realtime/websocket.js`, `realtime/notify.js`, `test/http/transport.test.js` |
| `http/router.js` | `handleRequest`, `handler` | `http/servers.js` |
| `http/transport.js` | `isEncrypted`, `openRequest`, `sealResponse`, `nonceUsado`, `NONCE_MEMORY_MS` | `http/router.js`, `test/http/transport.test.js` |
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
| **Cambiar el esquema de la base** | `src/db/schema.js` (`SCHEMA_SQL`) + `src/db/statements.js` (`Stmt`) + `src/db/schema.js` (cascadas en JS: `deleteAccountRows`/`deleteGroupRows`) + `test/db/schema.test.js` + `docs/ESQUEMA-BD.md`. Ojo: `SCHEMA_VERSION` y `meta.crypto_version` son dos cosas distintas (esquema vs formato de cifrado) y `server.js` aborta si la segunda no es `2`. |
| **Cambiar el cifrado** | `src/crypto/*` — `master-key.js` (llave maestra), `message-crypto.js` (AES-GCM + Ed25519), `mtproto.js` (estructura MTProto 2.0), `user-auth-keys.js` (clave por usuario), `setup.js` (instanciación). Si cambia el *formato del sobre*, hay que tocar también `src/chat/messages.js` (lectura/escritura) y `ops/crypto/reencrypt-master.js`. |
| **Cambiar la clave de cifrado de una cuenta** | `src/users/store.js` (`regenerateAuthKey`) + `src/profile/routes.js` (`postAccountRegenerateKey`) |
| **Cambiar un límite** (longitud de mensaje, cuota, tamaño de cuerpo, TTL) | `src/config.js` (`DEFAULTS` + validación) + `.env.example` + `src/shared/limits.js` (lo que se consume) |
| **Cambiar la privacidad por función** | `src/users/privacy.js` (`PRIV_KEYS`, `PRIV_DEF`, `permite`) + `src/db/schema.js` (`user_privacy`) + `src/profile/routes.js` (lectura/escritura) |
| **Cambiar las reglas de un grupo** (políticas por tipo) | `src/groups/store.js` (`groupPolicies`, `normalizeGroup`) + `src/http/router.js` (validación de envío) + `src/chat/routes.js` (DM: reutiliza `groupPolicies`) + `src/db/schema.js` (`groups.content_policy`) |
| **Cambiar el enrutado / la seguridad HTTP** | `src/http/router.js` (orden de comprobaciones), `src/http/responses.js` (cabeceras y CSP), `src/http/servers.js` (TLS, apagado), `src/shared/static-path.js` (estáticos) |
| **Tocar el cliente web** | `public/index.html` (SPA principal), `public/login.html` (acceso), `public/profile.html`, `public/view.html`, `public/stories.html`, `public/privacy.html`, `public/theme.css`, `public/appearance.js`, `public/sw.js`, `public/manifest.webmanifest` |
| **Añadir un test** | `test/<dominio>.test.js` (unitario: `require('../src/<dominio>/<fichero>')`) o `test/server-http.test.js` / `test/server-ws.test.js` (integración, con `test/helpers.js`). Se ejecutan con `npm test` → `node --test test/*.test.js` |
| **Cambiar el proceso de arranque / el apagado** | `server.js` + `src/http/servers.js` + `ops/runtime/supervisor.js` |
| **Cambiar los respaldos** | `ops/backup/backup.js` (copia) + `ops/crypto/reencrypt-master.js` (respaldo previo) + `docs/ESQUEMA-BD.md` |
| **Cambiar el túnel / el despliegue público** | `ops/net/tunnel.js` + `zty.yml.example` + `.env.example` (`CLOUDFLARE_TUNNEL_TOKEN`) |

---

## 19. Ficheros que NO se versionan

| Ruta | Qué es | Por qué no se versiona |
|---|---|---|
| `.env` | Configuración real: `DB_USER`+`DB_PASSWORD` (la credencial del propietario), `CLOUDFLARE_TUNNEL_TOKEN`, `GIPHY_API_KEY`, `PORT`, `DATA_DIR`, `DB_NAME`, `SUPERVISOR_*` | Contiene secretos. El token del túnel permite secuestrar el túnel; la credencial deriva la llave que descifra todo. Se versiona solo `.env.example`. |
| `cert.pem`, `key.pem` | Certificado y clave privada TLS (autofirmados) | Clave privada. El servidor arranca sin HTTPS si no existen (`src/http/servers.js`). |
| `data/` | `zlapy.db` y `blob.db` (con sus WAL y shm) | Persistencia mutable: cambia con cada escritura, no es código. Es lo que protege la llave maestra. |
| `backups/` | Copias fechadas de las bases + llave maestra | Contienen datos de cuentas (hashes de contraseña, sesiones, mensajes cifrados). `ops/backup/backup.js` los deja en `0700/0600`. |
| `zty.yml` | Configuración real de `cloudflared` (UUID del túnel, hostname, ingress) | Copia local de `zty.yml.example`; puede contener nombres de host internos. |
| `.zlapy.pid` | PID del proceso servidor, escrito por `ops/runtime/supervisor.js` | Estado de ejecución; cambia en cada arranque. En `.gitignore` aunque el comentario que lo acompaña esté bajo "Dependencias" (descolocado). |
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
  - `ops/crypto/reencrypt-master.js:33-37` → `require('../src/config')` y compañía.
  - Todos los ficheros de `test/` → `require('../src/...')` sin extensión.
- Recomendación al añadir código nuevo: **usar siempre la extensión `.js`**.

### 20.3 `'use strict'`

- En `src/`, `ops/` y `server.js` (54 ficheros), **44** llevan `'use strict';` **inmediatamente después del comentario de cabecera**.
- Los módulos más "puros" (sin cabecera informativa) son `src/config.js`, `src/crypto/message-crypto.js`, `src/crypto/kdf.js`, `src/crypto/field-crypto.js` y los 7 módulos de `src/shared/` (`appearance.js`, `avatar.js`, `gallery.js`, `limits.js`, `message-data.js`, `static-path.js`, `types.js`).
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
   llama `test/db/schema.test.js`.
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
6. **`'use strict'` ausente** en algunos ficheros de `src/` (ver §20.3): los 7
   módulos puros de `src/shared/`, `src/crypto/message-crypto.js` y
   `src/config.js`. No es un problema funcional (Node no es sloppy por defecto
   en CommonJS), pero rompe la homogeneidad.
7. **Exports que nadie consume**: `findMessageRow`
   (`src/chat/messages.js`) y `messageSchema` (`src/db/database.js`), que solo
   se usa dentro del propio fichero.
8. **Ficheros de ejemplo sin equivalente versionado**: `zty.yml.example` existe
   y `zty.yml` está en `.gitignore` (correcto), pero el `.gitignore` situaba
   `.zlapy.pid` bajo el comentario "Dependencias", que no es donde corresponde.
9. **`public/index.html` tiene 17757 líneas** en un único fichero (HTML + CSS + JS). Sigue siendo el mayor fichero del repositorio y el punto de fragilidad del cliente; cualquier separación exigiría cambiar la CSP (`unsafe-inline`). El grueso del cliente compartido ya vive fuera (en `public/js/` y `public/css/`); lo que queda dentro es solo la SPA.

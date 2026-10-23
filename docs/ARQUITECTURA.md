# Arquitectura de Zlapy

Documento técnico de referencia del backend de Zlapy: un clon de WhatsApp
autoalojado en la red local, con servidor Node.js, persistencia SQLite,
tiempo real por WebSocket y llamadas de voz/vídeo P2P (WebRTC).

Todo lo que sigue está verificado contra el código del repositorio. Las
referencias son `ruta:línea` o nombre de fichero.

---

## 1. Visión general

### 1.1 Qué es el sistema

Zlapy es un servidor de mensajería **monolítico en proceso, partido en
módulos por dominio**. Un único proceso Node.js:

- sirve la SPA de `public/` por HTTP y HTTPS **en el mismo puerto**;
- mantiene el tiempo real por un WebSocket propio (no usa `ws`): implementa
  el subconjunto de RFC 6455 que necesita (`src/realtime/frames.js`);
- guarda el estado de las cuentas, los chats, los grupos y las historias en
  **dos bases SQLite** (`data/zlapy.db` y `data/blob.db`);
- entrega las llamadas de voz/vídeo **de punto a punto entre dispositivos**
  (WebRTC); el servidor solo señaliza;
- envía notificaciones **Web Push** (RFC 8291 + VAPID) a los dispositivos
  suscritos.

El backend se ejecuta siempre **bajo un supervisor** (`ops/supervisor.js`),
que lo relanza con backoff exponencial si muere y lo reinicia si se queda
colgado (`npm start` → `node ops/supervisor.js`).

### 1.2 Componentes

| Componente | Dónde vive | Función |
| --- | --- | --- |
| Entrypoint | `server.js` | Comprueba la versión de cifrado de la base, hidrata la RAM y arranca los servidores. |
| Configuración | `src/config.js` | Lee `.env` con `dotenv`, valida rangos y expone rutas (`DATA`, `DB_PATH`, `BLOB_DB_PATH`, `PUBLIC`). |
| Estado en RAM | `src/state.js` | Caché compartida entre módulos (cuentas, grupos, sesiones, historias, notas, llamadas, push, caché de páginas). |
| Base de datos | `src/db/` | Apertura (`database.js`), esquema v3 (`schema.js`), sentencias preparadas (`statements.js`), transacciones (`transactions.js`). |
| Cifrado | `src/crypto/` | Llave maestra, cifrado en reposo, cifrado por usuario (MTProto 2.0), firmas Ed25519. |
| HTTP | `src/http/` | Router, respuestas con cabeceras de seguridad, limitadores, arranque de servidores. |
| Tiempo real | `src/realtime/` | Framing WebSocket, servidor WebSocket, envío de eventos a los clientes. |
| Dominios | `src/auth/`, `users/`, `profile/`, `contacts/`, `chat/`, `groups/`, `stories/`, `calls/`, `stickers/`, `push/`, `meta/` | Reglas de negocio y rutas HTTP de cada área. |
| Utilidades puras | `src/shared/` | Validación, límites, tipos, galería, apariencia, ruta estática segura, avatar SVG. |
| Operación | `ops/` | Supervisor, túnel de Cloudflare, respaldo, llave maestra, migración de cifrado. |

### 1.3 Diagrama de componentes

```
                    ┌───────────────────────────────────────────┐
                    │           NAVEGADOR / PWA (public/)        │
                    │  index.html · profile.html · stories.html  │
                    │  view.html · privacy.html · sw.js (push)   │
                    └───────┬──────────────────────┬────────────┘
                            │ HTTP(S) / REST       │ WSS /ws
                            │                      │ (frames RFC 6455 propios)
        ┌───────────────────▼──────────────────────▼───────────────────┐
        │                  PROCESO NODE (server.js)                   │
        │                                                             │
        │  ┌───────────────────────────────────────────────────────┐  │
        │  │ dispatcher  (net.Server, src/http/servers.js)        │   │
        │  │   lee 1 byte:  0x16 → HTTPS   ·   resto → HTTP      │    │
        │  └───────────────┬────────────────────────┬──────────────┘  │
        │                  │                        │                 │
        │           ┌──────▼──────┐          ┌──────▼──────┐          │
        │           │  httpSrv   │          │  httpsSrv  │            │
        │           │  (handler) │          │  (handler) │            │
        │           └──────┬──────┘          └──────┬──────┘          │
        │                  └───────────┬────────────┘                 │
        │                              ▼                              │
        │                   ┌──────────────────────┐                  │
        │                   │ handleRequest        │                  │
        │                   │ (src/http/router.js) │                  │
        │                   │ sesión → CSRF →      │                  │
        │                   │ origin → ruta →      │                  │
        │                   │ módulo de dominio    │                  │
        │                   └──────────┬───────────┘                  │
        │                              │                              │
        │   ┌──────────────────────────┼───────────────────────┐      │
        │   ▼                          ▼                       ▼      │
        │ ┌──────────┐ ┌────────────────────┐ ┌──────────────────┐    │
        │ │ src/auth │ │  src/chat, groups, │ │ src/users,       │    │
        │ │ sessions │ │  stories, calls,   │ │ profile, contacts│    │
        │ │ cookies  │ │  stickers, push     │ │ privacy, helpers │   │
        │ └────┬─────┘ └─────────┬──────────┘ └────────┬─────────┘    │
        │      └─────────────────┼──────────────────────┘             │
        │                        ▼                                    │
        │        ┌──────────────────────────────┐                     │
        │        │  ESTADO EN RAM (src/state.js) │                    │
        │        │  users · groups · sessions ·  │                    │
        │        │  stories · notes · calls ·    │                    │
        │        │  pushSubs · chatPageCache     │                    │
        │        └──────────────┬───────────────┘                     │
        │                       │  (lectura) / (escritura)            │
        │   ┌───────────────────┴────────────────────┐                │
        │   ▼                                        ▼                │
        │ ┌───────────────────┐        ┌────────────────────────┐     │
        │ │ data/zlapy.db     │        │ data/blob.db           │     │
        │ │ cuentas, chats,   │        │ blobs deduplicados     │     │
        │ │ grupos, resúmenes │        │ por hash SHA-256       │     │
        │ └───────────────────┘        └────────────────────────┘     │
        │                                                             │
        │  ┌──────────────────────────────────────────────────────┐   │
        │  │ WebRTC  (P2P, DTLS-SRTP) — NO pasa por el servidor   │   │
        │  └──────────────────────────────────────────────────────┘   │
        └─────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                 Servicios de push del navegador (FCM/Mozilla/Apple/Samsung)
                 + servicios GIPHY (proxy de stickers)
```

> El audio/vídeo de las llamadas **nunca pasa por el servidor**: solo la
> señalización (SDP/ICE) viaja por el WebSocket. Ver §8.

---

## 2. Arranque

### 2.1 Secuencia exacta

`server.js` es deliberadamente corto: solo cuatro pasos.

```
node server.js
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ 1. require('./src/db/statements')  →  require('./src/db/database')
│      · new Database(DATA/zlapy.db)   + pragmas:
│          journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON,
│          busy_timeout=CONFIG.sqliteBusyTimeoutMs (5000 ms),
│          cache_size=-CONFIG.sqliteCacheSizeKb (-64000 KiB),
│          temp_store=MEMORY
│      · new Database(DATA/blob.db)  → misma configuración
│          + CREATE TABLE IF NOT EXISTS blobs (hash PK, data)
│      · CHECK de compatibilidad: meta.crypto_version ≠ '2' → throw
│      · ensureSchema(db)  → aplica SCHEMA_SQL (todo IF NOT EXISTS,
│          idempotente) y escribe meta.schema_version = 3
│      · verifica que messages.crypto_version / crypto_group_id /
│        signature / signing_public_key existen
└──────────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. Comprobación de versión de cifrado (server.js:39-46)      │
│      cryptoVersion = Stmt.getMeta.get('crypto_version')      │
│      if (cryptoVersion !== '2'):                             │
│          si hay mensajes o la versión existe → THROW         │
│          si no → Stmt.setMeta('crypto_version','2')          │
│      (base vacía → se marca; base con datos → no se arranca) │
└──────────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. loadFromDb()  (src/users/store.js:133-184)                │
│      · users ← SELECT * FROM users  → users + usernameIndex  │
│      · hydrateUserFromDb(acc) por cada cuenta:               │
│          perfil (nombre/bio/nota descifrados), contactos,    │
│          stickers (≤30), grupos vistos, clave del dispositivo│
│          nota personal, privacidad, apariencia del chat      │
│          silenciados, bloqueados                             │
│      · sesiones no caducadas → sessionCache; borra caducadas │
│      · push_subs → pushSubs (descifrado por usuario)         │
│      · calls (100 por usuario) → callFiles                   │
│      · historias vivas (ts > now-TTL) → stories              │
│      · grupos → readGroup() uno a uno → groupCache           │
│      · log: "[load] v3: N usuarios, M grupos, K historias"   │
└──────────────────────────────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. require('./src/http/servers')                             │
│      · crea httpSrv y (si existen cert.pem/key.pem) httpsSrv │
│      · engancha 'upgrade' → wsUpgrade en ambos               │
│      · crea el dispatcher net.Server y lo pone a escuchar    │
│      · registra SIGTERM/SIGINT/uncaughtException/            │
│        unhandledRejection                                    │
└──────────────────────────────────────────────────────────────┘
```

Detalles que importan:

- **El esquema es idempotente, no hay migraciones.** `ensureSchema()`
  (`src/db/schema.js:365`) ejecuta un `CREATE TABLE/INDEX IF NOT EXISTS`
  sobre `SCHEMA_SQL` y luego registra `schema_version = 3`. Una base en un
  formato anterior no es compatible: el servidor se niega a arrancar.
- **Hay dos "versiones de cifrado" distintas** y no deben confundirse:
  `meta.crypto_version` (valor `'2'`) es la versión del **formato de la
  base**; `messages.crypto_version` (entero `3`) es la versión del
  **cifrado de cada mensaje** (`PCE3:` = MTProto 2.0). La comprobación de
  `server.js` es sobre la primera.
- **La llave maestra se resuelve al importarse el código**, no cuando se
  usa: `server.js` importa `src/users/store.js` → `src/crypto/setup.js` →
  `src/crypto/master-key.js`, y ahí `getMasterKeyBytes()` decide si se
  arranca o se aborta. En la práctica, el *fail-fast* de la llave
  (**base con datos y sin llave → no arranca**) ocurre **antes** de la
  comprobación de `crypto_version` del paso 2.
- El orden de `require` importa: `src/db/statements.js` compila **todas**
  las sentencias al cargarse, porque `better-sqlite3` no cachea `prepare()`
  entre llamadas (`src/db/statements.js:5-7`).

### 2.2 El dispatcher: HTTP y HTTPS en el mismo puerto

`src/http/servers.js:38-47` sustituye al `http.Server` por un
`net.Server` que decide el protocolo leyendo el **primer byte** de la
conexión:

```js
const dispatcher = net.createServer({ allowHalfOpen: false }, sock => {
    sock.once('readable', () => {
        const first = sock.read(1);
        if (!first) return;
        sock.unshift(first);                 // devuelve el byte al stream
        const isTls = useTls && first[0] === 0x16;
        (isTls ? httpsSrv : httpSrv).emit('connection', sock);
    });
    sock.on('error', () => { });
});
```

```
        Cliente
          │  conecta a 0.0.0.0:PORT
          ▼
   ┌──────────────────────────────────┐
   │  dispatcher (net.Server)         │
   │  sock.read(1) → primer byte      │
   └───────────────┬──────────────────┘
                   │
      ┌────────────┴────────────┐
      │                         │
  byte == 0x16                otro
 (TLS record,                (HTTP ASCII:
  handshake ClientHello)      "GET /…")
      │                         │
      ▼                         ▼
  httpsSrv                  httpSrv
 (cert.pem/key.pem)        (sin TLS)
      │                         │
      └───────────┬─────────────┘
                  ▼
        handler(req,res)  →  src/http/router.js
```

- `0x16` es el *content type* del primer registro TLS (`handshake`). Si no
  hay `cert.pem`/`key.pem` en la raíz, `useTls` es `false` y todo se sirve
  en HTTP (`src/http/servers.js:27-28`).
- El byte se devuelve al stream con `sock.unshift(first)`, de modo que el
  servidor HTTP/HTTPS real lo lee normalmente.
- El WebSocket se sirve en **el mismo puerto**: `httpSrv.on('upgrade',
  wsUpgrade)` y `httpsSrv.on('upgrade', wsUpgrade)`. El cliente abre
  `ws://host/ws` o `wss://host/ws` según el esquema (`public/index.html`).
- `dispatcher.listen({ port: PORT, host: '0.0.0.0', exclusive: false })`
  reengancha el puerto sin esperar al `TIME_WAIT` (equivalente a
  `SO_REUSEADDR`), necesario para reinicios del supervisor.
- Si el puerto está ocupado: log explícito (`"Usa PORT=3001 npm start"`) y
  `process.exit(1)`.

---

## 3. Ciclo de una petición HTTP

### 3.1 Flujo

 ```
  ┌─────────┐
  │ Cliente │
  └────┬────┘
       │ GET / POST  /ruta
       ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ 1. Parseo de la URL  (new URL(req.url, "http://x"))              │
 │    · error de parseo → 400 "bad request"                         │
 │ 2. OPTIONS → 204 (preflight)                                     │
 │ 3. Cabeceras de seguridad por petición:                          │
 │      CSP = cspFor(req.headers.host)  (connect-src = ws://<host>) │
 │      HSTS si req.socket.encrypted o x-forwarded-proto: https     │
 │ 4. Rutas públicas sin sesión:                                    │
 │      GET /config · /healthz · /push/vapid · /auth/session        │
 │      GET /avatar/:id.svg  →  exige sesión (401)                  │
 │ 5. Determinación de lo "público":                                │
 │      publicPage     = GET y (pathname "/" o extensión estática)  │
 │      publicAuthPost = POST en /auth/register|login|logout|switch │
 │      sin sesión y no público → 401                               │
 │ 6. Método distinto de GET/POST → 405                             │
 │ 7. POST → política de origen (CSRF):                             │
 │      !originAllowed(req) → 403 "cross-origin request rejected"   │
 │      sec-fetch-site: cross-site → 403                            │
 │      originAllowed: sin cabecera Origin → permitido;             │
 │      con Origin → host(Origin) == host de la petición            │
 │ 8. req.authUser = sesión;  actor = authUser.username             │
 └──────────────────────────────────────────────────────────────────┘
       │
       ├──────────────── GET ────────────────────────────────┐
       │   enrutado directo a la ruta (sin cuerpo)          │
       │                                                    ▼
       └──────────────── POST ────────────────────────────────┐
   ┌──────────────────────────────────────────────────────────────────┐
   │ 9. Límite de cuerpo por ruta                                     │
   │      SMALL_BODY_ROUTES (auth) → 8 KiB                            │
   │      resto → CONFIG.maxHttpBodyBytes (32 MiB)                    │
   │      content-length > límite → 413 (req.resume())                │
   │      si se excede durante la lectura → 413                       │
   │ 10. JSON.parse → 400 si falla o no es un objeto                  │
   └──────────────────────────────────────────────────────────────────┘
            │
            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 11. NORMALIZACIONES (el cliente NO fija la identidad;            │
   │      la reescribe el servidor)                                   │
   │      /account/profile → data.username = trim().toLowerCase()     │
   │      /profile /notes /push/* /call/log                           │
   │      /account/delete /stickers  → data.username = actor          │
   │      /send /receipt /chat/delete /block /messages                │
   │                         → data.from = actor                      │
   │      /story /story/delete /story/edit → data.from = actor        │
   │      /story/view /story/like → data.viewer = actor               │
   │ 12. if (!req.authUser) → 401                                     │
   └──────────────────────────────────────────────────────────────────┘
            │
            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 13. Enrutado al módulo de dominio                                │
   │      chat/routes.js · groups/routes.js · stories/routes.js       │
   │      contacts/routes.js · profile/routes.js · calls/routes.js    │
   │      stickers/routes.js · push/routes.js · auth/routes.js        │
   │      meta/routes.js                                              │
   │      (acciones de grupo: POST /groups/:id → router)              │
   └──────────────────────────────────────────────────────────────────┘
            │
            ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 14. Respuesta                                                    │
   │      json(res, code, obj):                                       │
   │        Content-Type: application/json                            │
   │        Cache-Control: no-store                                   │
   │        + securityHeaders                                         │
   │      Estáticos: resolvePublicFile() + stream,                    │
   │        X-Content-Type-Options: nosniff,                          │
   │        no-store en .html/.js/.css/.webmanifest                   │
   │ 15. try/catch: 500 "Error interno del servidor."                 │
   │      + red de seguridad en `handler` (400)                       │
   └──────────────────────────────────────────────────────────────────┘
 ```

### 3.2 Las normalizaciones, en detalle

Es la pieza de seguridad más importante del router: el cuerpo JSON que
llega del cliente **nunca** decide quién es el actor.

| Ruta | Campo reescrito | Valor |
| --- | --- | --- |
| `/account/profile` | `data.username` | `trim().toLowerCase()` (el nombre nuevo de la cuenta) |
| `/profile`, `/notes`, `/push/*`, `/call/log`, `/account/delete`, `/stickers` | `data.username` | `actor` |
| `/send`, `/receipt`, `/chat/delete`, `/block`, `/messages` | `data.from` | `actor` |
| `/story`, `/story/delete`, `/story/edit` | `data.from` | `actor` |
| `/story/view`, `/story/like` | `data.viewer` | `actor` |

Consecuencias: un cliente no puede enviar mensajes en nombre de otro
(`/send`), ni atribuir a otro la vista o el "me gusta" de una historia
(`/story/view`, `/story/like`), ni editar la nota, el perfil o las
suscripciones de push de otra cuenta.

### 3.3 Cabeceras de seguridad

Definidas en `src/http/responses.js:17-39` y aplicadas a **toda** respuesta:

| Cabecera | Valor | Motivo |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | Evita que el navegador interprete el contenido como otro tipo. |
| `X-Frame-Options` | `SAMEORIGIN` | La app **inserta en iframes sus propias páginas** (`stories.html`, `view.html`); `DENY` rompería eso, pero `SAMEORIGIN` sigue bloqueando el clickjacking de terceros. |
| `Referrer-Policy` | `no-referrer` | No filtra URLs internas a terceros. |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), fullscreen=(self)` | Cámara y micrófono solo para el propio origen (necesario para WebRTC). |
| `Cross-Origin-Opener-Policy` | `same-origin` | Aislamiento de contexto. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Los recursos no se comparten con otros orígenes. |
| `Content-Security-Policy` | por petición (`cspFor(host)`) | `default-src 'self'`, `script-src/style-src 'self' 'unsafe-inline'` (la SPA es un único archivo con scripts inline), `img-src 'self' data: blob: https:`, `media-src 'self' data: blob:`, `connect-src 'self' data: blob: ws://<host> wss://<host>`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`. El `host` se valida con `CSP_HOST_RE` antes de meterse en la cabecera. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Solo si la conexión va cifrada (`req.socket.encrypted` o `x-forwarded-proto: https`). |

---

## 4. Mapa de módulos

### 4.1 Carpetas

| Módulo | Responsabilidad | Ficheros |
| --- | --- | --- |
| `server.js` | Entrypoint: versión de cifrado → hidratación → arranque. | `server.js` |
| `src/` (raíz) | Configuración y estado compartido. | `config.js`, `state.js` |
| `src/db/` | Apertura de las dos bases, esquema v3, sentencias preparadas, transacciones y purga de blobs. | `database.js`, `schema.js`, `statements.js`, `transactions.js` |
| `src/crypto/` | Llave maestra, cifrado en reposo (AES-256-GCM), cifrado por usuario (MTProto 2.0), firmas Ed25519. | `master-key.js`, `message-crypto.js`, `mtproto.js`, `user-auth-keys.js`, `setup.js` |
| `src/http/` | Router, respuestas con cabeceras, limitadores de frecuencia, arranque y cierre de servidores. | `router.js`, `servers.js`, `responses.js`, `helpers.js`, `rate-limit.js` |
| `src/realtime/` | Framing RFC 6455, servidor WebSocket, envío de eventos a clientes. | `frames.js`, `websocket.js`, `notify.js` |
| `src/auth/` | Sesiones, cookies, hashing de contraseñas y rutas de autenticación. | `sessions.js`, `routes.js` |
| `src/users/` | Cuentas en RAM, hidratación/persistencia, privacidad por función, helpers de lookup. | `store.js`, `privacy.js`, `helpers.js` |
| `src/profile/` | Perfil, ajustes de cuenta, notas, apariencia, borrado de cuenta. | `routes.js` |
| `src/contacts/` | Contactos, solicitudes, bloqueos. | `routes.js` |
| `src/chat/` | Mensajes, resúmenes 1:1, adjuntos, menciones y renombrados. | `messages.js`, `routes.js`, `summaries.js`, `media.js`, `mentions.js` |
| `src/groups/` | Grupos: miembros, políticas, invitaciones, keyboxes, resúmenes de grupo. | `store.js`, `routes.js` |
| `src/stories/` | Publicación, listado, likes, vistas, edición y borrado de historias. | `routes.js` |
| `src/calls/` | Registro de llamadas y cierre de llamadas vivas. | `store.js`, `routes.js` |
| `src/stickers/` | Proxy de búsqueda en GIPHY y stickers favoritos. | `routes.js` |
| `src/push/` | Suscripciones push, VAPID y envío de notificaciones. | `routes.js`, `vapid.js` |
| `src/meta/` | `/healthz` y volcado de configuración. | `routes.js` |
| `src/shared/` | Utilidades puras sin estado: validación, límites, tipos, galería, apariencia, ruta estática, avatar. | `validation.js`, `limits.js`, `types.js`, `gallery.js`, `appearance.js`, `message-data.js`, `static-path.js`, `avatar.js` |
| `ops/` | Scripts de operación (no forman parte del servidor). | `supervisor.js`, `tunnel.js`, `backup.js`, `generate-master-key.js` |

### 4.2 Ficheros clave

| Fichero | Qué hace exactamente |
| --- | --- |
| `src/config.js` | `loadConfig(env)` valida enteros con rango (`integerSetting`) y devuelve un objeto congelado. Carga `.env` con `dotenv` (las variables ya presentes en el entorno mandan). Calcula `DATA`, `DB_PATH`, `BLOB_DB_PATH`, `PUBLIC`. |
| `src/state.js` | Declara los `Map`/`Set` globales y los *setters* `setStories`, `setNotesMap`, `setCallFiles`. |
| `src/db/schema.js` | `SCHEMA_SQL` (20 bloques de tablas), `SCHEMA_VERSION = 3`, `ensureSchema()`, y las reglas de borrado en cascada que SQL no expresa (`deleteAccountRows`, `deleteGroupRows`, `deleteMessageRowsWhere`). |
| `src/db/statements.js` | Compila ~120 sentencias preparadas una sola vez en `Stmt`. |
| `src/db/transactions.js` | `tx.sendMessage`, `tx.deleteMessage`, `tx.markSeenMessage`, `tx.deleteGroup`, `tx.deleteAccount`, `tx.saveUser` (transacciones `better-sqlite3`), `removeBlobAccess()` y `pruneBlobHashes()`. |
| `src/crypto/master-key.js` | Lee `CHAT_MASTER_KEY` (base64, exactamente 32 bytes) o `.zlapymasterkey` (0600). Si falta la llave **y ya hay bases**, aborta. Genera una si no hay bases. |
| `src/crypto/message-crypto.js` | `PCE1:` (AES-256-GCM en reposo, llave maestra), `PCE2:` (AES-256-GCM con AAD de contexto), firmas Ed25519 derivadas por HKDF de la `auth_key` del usuario (o de la llave maestra). |
| `src/crypto/mtproto.js` | Réplica de la estructura MTProto 2.0: `auth_key` de 2048 bits, `auth_key_id` = 64 bits bajos del SHA-1, `msg_key` = 128 bits centrales del SHA-256, derivación `aes_key`/`aes_iv`, cabecera interna cifrada, relleno 12–27 bytes, sobre `PCE3:`. |
| `src/crypto/user-auth-keys.js` | `auth_key` por usuario (caché LRU de 500), rotación de sal cada 30 min, `encryptForUser`/`decryptForUser`, `messageContextBytes` (contexto ligado). |
| `src/http/router.js` | El enrutador completo (649 líneas): orden de comprobaciones, normalizaciones, rutas GET/POST y acciones de grupo. |
| `src/http/servers.js` | Dispatcher, arranque, cierre ordenado con `wal_checkpoint(TRUNCATE)`. |
| `src/realtime/frames.js` | Parser de frames RFC 6455 con límites y ensamblado de fragmentos O(1). |
| `src/realtime/websocket.js` | Upgrade, autenticación, reparto de frames, token bucket, presencia y tareas periódicas de limpieza. |
| `src/realtime/notify.js` | `push`/`pushName`/`pushRawName`, `userList`, presencia, reparto de historias. |
| `src/users/privacy.js` | Normalización y resolución de las reglas de privacidad. |
| `src/users/store.js` | `loadFromDb`, `hydrateUserFromDb`, `writeUserRows`, `regenerateAuthKey`, `purgeUserFromMemory`. |

---

## 5. Estado en memoria y su relación con la base

### 5.1 Qué vive en RAM

`src/state.js` centraliza todas las estructuras mutables:

| Estructura | Clave → valor | Origen |
| --- | --- | --- |
| `users` | id → objeto de cuenta | `users` + `hydrateUserFromDb` |
| `usernameIndex` | username → id | `users` |
| `profiles` | username → `{ name, avatar, desc, note, noteTs, privacy, chatAppearance, mutedChatPeers, blocked }` | `user_profiles`, `user_privacy`, `user_chat_settings`, `user_muted_peers` |
| `groupCache` | gid → grupo normalizado | `groups` + `group_members` + `group_join_requests` |
| `groupPubCache` | `gid\0viewer` → vista pública del grupo | derivado de `groupCache` |
| `blockedSet` | username → `Set<username>` | `blocked` |
| `sessionCache` | hash(token) → `{ userId, expiresAt }` | `sessions` |
| `pushSubs` | userId → array de suscripciones | `push_subs` |
| `notesMap` | username → nota (texto, fondo, ts) | `user_notes` |
| `callFiles` | username → array de llamadas | `calls` |
| `stories` | array de historias vivas | `stories` |
| `pendingOffers` | `to:callId` → oferta de llamada en curso | en memoria pura |
| `chatPageCache` | `idA__idB` → `{ messages, savedAt, more }` | caché derivada de `messages` |

### 5.2 Fuente de verdad

**SQLite es la fuente de verdad; la RAM es una caché.** Eso se ve en el
código en varios puntos:

- `hydrateUserFromDb()` lee los **contactos desde la base**, no desde la
  RAM: el comentario es explícito —"la lista no debe depender solo de la
  RAM (la privacidad por defecto 'solo contactos' denegaría los DMs en
  silencio si la lista llegara vacía)" (`src/users/store.js:52-56`).
- `sessionUser()` busca en `sessionCache`; si no está, consulta
  `sessions` y, si la cuenta no está en RAM, la **carga de la base**
  (`loadUserFromRow`) o descarta la sesión huérfana
  (`src/auth/sessions.js:63-78`).
- `accountByName()` usa la base como autoridad y **repara** el índice de
  RAM si estaba sucio (permite borrar una cuenta y volver a registrar el
  mismo nombre sin reiniciar) (`src/users/store.js:333-349`).
- `readGroup()` cachea en `groupCache`; `writeGroupMeta()` es la única
  vía de escritura y actualiza la caché a la vez
  (`src/groups/store.js:110-158`).

### 5.3 Cuándo se escribe en la base

| Momento | Qué se escribe | Cómo |
| --- | --- | --- |
| Registro / login | `users`, `user_profiles`, `sessions` | `saveUserToDb` → `tx.saveUser` |
| Envío de mensaje | `messages`, `blob_access` | `tx.sendMessage` (`src/db/transactions.js:47`) |
| Envío en grupo | `messages`, `blob_access`, `group_summaries` (1 upsert por miembro) | `tx.sendMessage` + `Stmt.bumpGroupSummary` |
| Acuse / visto | `messages` (re-cifrado), `summaries` | `updateStoredMessage` + `writeSummaryEntry` |
| Edición / borrado | `messages`, `blob_access` | `updateStoredMessage` / `tx.deleteMessage` |
| Publicación de historia | `stories`, `blob_access` | transacción en `src/stories/routes.js:59-67` |
| Like / vista de historia | `stories` (columna `data` re-cifrada) | `Stmt.updateStoryData` |
| Cambio de perfil / privacidad | ~8 tablas de la cuenta | `tx.saveUser` → `writeUserRows` |
| Eventos triviales (visto de grupo, stickers, silencios, apariencia) | **una sola tabla** | `saveStickers`, `saveMutedPeers`, `saveChatSettings`, `Stmt.upsertGroupSeen` |
| Suscripción push | `push_subs` | `Stmt.insertPushSub` + `trimPushSubs` |
| Registro de llamada | `calls` | `Stmt.insertCall` + `trimCalls` |
| Cambio de grupo | `groups`, `group_members`, `group_join_requests` | `writeGroupMeta` |
| Borrado de cuenta | cascada completa | `tx.deleteAccount` → `deleteAccountRows` |

**Guardados quirúrgicos**: `writeUserRows()` reescribe el conjunto
completo de tablas de la cuenta (perfil, clave, privacidad, apariencia,
silenciados, nota, stickers, grupos vistos). Para eventos de alta
frecuencia existen escrituras parciales (`src/users/store.js:464-489`) que
tocan **una sola tabla**, evitando reescribir 8 tablas por cada "visto de
grupo" o cada sticker.

### 5.4 `setStories` / `setNotesMap` / `setCallFiles`: mutar, no reasignar

Tres de las estructuras de `src/state.js` se filtran a menudo (historias
caducadas, notas caducadas, llamadas recortadas) y el filtro produce un
**array/objeto nuevo**. Como todos los módulos los importan con
`const { stories } = require('../state.js')` —que se queda con el **valor**
del momento de la importación—, reasignar la variable dejaría a los
importadores mirando la lista antigua (una historia borrada seguía
apareciendo, por ejemplo).

Por eso los *setters* **mutan** la estructura existente en lugar de
sustituirla:

```js
// src/state.js
const setStories = list => { stories.length = 0; for (const item of list) stories.push(item); };
const setNotesMap = map => { for (const key of Object.keys(notesMap)) delete notesMap[key]; Object.assign(notesMap, map); };
const setCallFiles = map => { callFiles.clear(); for (const [key, value] of map) callFiles.set(key, value); };
```

Así todas las referencias ven siempre el estado actual.

Quién los usa:

| Setter | Quién llama | Fichero |
| --- | --- | --- |
| `setStories` | Limpieza periódica de historias caducadas | `src/realtime/websocket.js` |
| `setStories` | Borrado de una historia | `src/stories/routes.js` |
| `setStories` | Purga de una cuenta | `src/users/store.js` |
| `setNotesMap` | Limpieza de notas caducadas | `src/realtime/websocket.js` |
| `setCallFiles` | Purga de una cuenta | `src/users/store.js` |

---

## 6. Algoritmos y reglas de negocio

### 6.1 Privacidad por función

**7 funciones** (`PRIV_KEYS`, `src/users/privacy.js:17`):
`foto`, `nota`, `descripcion`, `historias`, `llamadas`, `mensajes`,
`compartir`.

#### Normalización de una regla

`normPriv(raw)` (`src/users/privacy.js:23-32`) reconstruye **las siete**
reglas siempre, aunque el cliente envíe campos raros o ausentes:

```
modo recibido   →  modo normalizado
  'all'         →  'server'        (alias del cliente)
  'server'      →  'server'
  'contacts'    →  'contacts'
  'nobody'      →  'nobody'
  'except'      →  'except'
  'only'        →  'only'
  otro / ausente →  PRIV_DEF[función]   (valor por defecto)
```

- La lista `users` se filtra a strings: `Array.isArray(v.users) ? v.users.filter(u => typeof u === 'string') : []`.
- El **CHECK de la base** acepta exactamente `('server','contacts','nobody','except','only')`
  (`src/db/schema.js:57`), y `writeUserRows` vuelve a aplicar la misma
  traducción `'all' → 'server'` antes de escribir.
- La fusión (no reemplazo) se aplica en el WebSocket (`privacy`,
  `src/realtime/websocket.js:189-197`): un mensaje que solo trae una
  función **no reinicia** las demás a los valores por defecto, que son más
  permisivos.

#### Valores por defecto

`PRIV_DEF` (`src/users/privacy.js:20`):

| Función | Modo por defecto | Efecto |
| --- | --- | --- |
| `foto` | `server` | Visible para cualquiera en el servidor. |
| `descripcion` | `server` | Visible para cualquiera. |
| `nota` | `contacts` | Solo contactos. |
| `historias` | `contacts` | Solo contactos. |
| `llamadas` | `contacts` | Solo contactos. |
| `mensajes` | `contacts` | Solo contactos. |
| `compartir` | `contacts` | Solo contactos. |

Complemento: `privacyFor()` (`src/users/privacy.js:46-55`) respeta los
ajustes globales heredados `privacyPhoto`/`privacyDesc` en modo `private`
**solo si** no existe una regla por función que lo sustituya.

#### Resolución

`permite(owner, key, viewer)` (`src/users/privacy.js:57-69`):

```
1. !owner                          → false
2. viewer === owner.username       → true      (uno mismo siempre puede)
3. !viewer                         → false
4. isBlockedBy(owner, viewer)      → false     (el bloqueo GANA)
5. mode 'server'                   → true
6. mode 'contacts'                 → isContact(owner, viewer)
7. mode 'nobody'                   → false
8. mode 'only'                     → isContact(owner, viewer) && lista.includes(viewer)
9. mode 'except'                   → isContact(owner, viewer) && !lista.includes(viewer)
```

- `isContact(owner, viewer)` (`src/users/privacy.js:34-38`) comprueba que
  el dueño tenga al visor **en su lista de contactos** (`acc.contacts`
  incluye el id del visor). La relación es **unidireccional** en la
  comprobación: el contacto mutuo se crea en `connectContacts`.
- El bloqueo es simétrico (`accountsBlocked`) y **prevalece sobre
  cualquier regla** de privacidad.
- `permiteDescripcion()` es un alias de `permite(owner,'descripcion',viewer)`.

Dónde se aplica:

| Función | Punto de aplicación |
| --- | --- |
| `mensajes` | `POST /send` (`src/chat/routes.js:129`), typing/recording (`src/realtime/websocket.js:167`) |
| `llamadas` | `call-offer` (`src/realtime/websocket.js:139`) |
| `historias` | Listado (`src/stories/routes.js:27`), like (`src/stories/routes.js:99`), vista (`src/stories/routes.js:115`), reparto por WebSocket (`src/realtime/websocket.js:80`, `src/realtime/notify.js:130`), y acceso al blob (`src/chat/media.js:46`) |
| `foto` | `GET /profile` (`src/profile/routes.js:57`), lista de solicitudes de contacto (`src/contacts/routes.js:28`) |
| `descripcion` | `GET /profile`, `permiteDescripcion` (`src/profile/routes.js:59`, `src/contacts/routes.js:29`) |
| `nota` | `GET /profile` (`src/profile/routes.js:58`), la nota caduca a las 24 h (`freshNote`) |
| `compartir` | Se **expone** en `GET /profile` (`perms.compartir`, `src/profile/routes.js:63`) y el cliente lo consulta para ocultar el menú de reenvío (`public/index.html:13544`). |

> Nota: `compartir` es la única de las siete que el servidor **no evalúa**
> en ninguna ruta de reenvío: se publica como permiso y lo aplica el
> cliente. Es el único caso donde la regla no está impuesta por el backend.

### 6.2 Paginación de mensajes

#### Índice

```sql
CREATE INDEX idx_messages_chat_ts ON messages(chat, ts DESC, id DESC);
```
(`src/db/schema.js:227`). La columna `chat` codifica el destino:
`chat:<idA>__<idB>` (ids ordenados) para un DM, `group:<gid>` para un grupo.

#### Tamaño de página

| Contexto | Tope | Fichero |
| --- | --- | --- |
| `readMessagePage()` (genérico) | `limit = clamp(1, 200, limit ?? 20)` | `src/chat/messages.js:164` |
| `POST /messages` | `min(200, max(1, data.limit ?? 20))` | `src/chat/routes.js:390` |
| `GET /groups/:id/messages` | `Number(limit) ?? 30` (el `readMessagePage` lo recorta a 200) | `src/http/router.js:152` |
| `GET /groups/:id` (completo) | 100 | `src/http/router.js:137` |
| `getChatPage()` (caché) | `max(50, limit)` al rellenar la caché | `src/chat/messages.js:197` |

#### Cursor de dirección

El paginado es **hacia atrás** (scroll hacia arriba). Sin cursor se leen
los últimos mensajes; con `beforeId` se leen los anteriores a ese mensaje:

```sql
-- Stmt.prevMessages
SELECT * FROM messages
 WHERE chat = ?
   AND (ts < ? OR (ts = ? AND id < ?))
 ORDER BY ts DESC, id DESC
 LIMIT ?
```

El desempate por `id` (no solo por `ts`) hace que dos mensajes con la
**misma marca de tiempo** no se pierdan ni se dupliquen. La página se
devuelve **en orden ascendente** (`rows.slice(0, lim).map(...).reverse()`).

Se pide `lim + 1` filas para saber si hay más (`more = rows.length > lim`).

#### Caché de páginas

`getChatPage(pairKeyName, limit)` (`src/chat/messages.js:191-203`):

| Parámetro | Valor por defecto | Fuente |
| --- | --- | --- |
| `CHAT_PAGE_CACHE_TTL_MS` | 10 000 ms | `src/config.js:23` |
| `CHAT_PAGE_CACHE_MAX` | 20 entradas | `src/config.js:24` |

- La clave es el *pair key* del DM: `idA__idB` con los ids ordenados
  (`pairKeyFromIds`).
- La caché guarda la página **completa** (`fetchLimit = max(50, limit)`),
  no solo lo pedido: así una segunda petición con `limit` mayor se sirve
  sin volver a la base.
- Condición de acierto: `now - savedAt < TTL` **y**
  `cached.messages.length >= limit`. Si la caché tiene menos mensajes de
  los pedidos, se vuelve a la base.
- **Evacuación**: al insertar, si `chatPageCache.size > CHAT_PAGE_MAX` se
  borra la entrada **más antigua** (`chatPageCache.keys().next().value`,
  orden de inserción).
- La caché **no** se usa cuando hay `beforeId`: esas páginas se leen
  siempre de la base (`src/chat/routes.js:392`).
- La caché es **compartida por los dos interlocutores** de un DM. Por eso
  el filtro de borrados se aplica **al servir**, no al cachear
  (`filterForViewer`, `src/chat/messages.js:178-189`).

**Invalidación** (`invalidateChatPage(pk)`):

| Evento | Fichero |
| --- | --- |
| Envío de mensaje | `src/chat/routes.js:203` |
| Borrado de mensaje | `src/chat/messages.js:214` |
| Edición de mensaje | `src/chat/routes.js:340` |
| Acuses (`/receipt`) | `src/chat/routes.js:278` |
| Mensaje "ver una vez" | `src/chat/routes.js:239` |
| Voto en encuesta | `src/chat/routes.js:112` |
| Borrado de conversación | `src/chat/routes.js:377` |

### 6.3 Resúmenes de chat

Dos tablas, con la misma forma:

| Tabla | Clave | Contenido |
| --- | --- | --- |
| `summaries` | `(owner, peer)` | `unread` (entero) + `last_data` (último mensaje, **cifrado**) |
| `group_summaries` | `(owner, gid)` | `unread` (entero) + `last_data` (último mensaje, **cifrado**) |

`last_data` se cifra con la `auth_key` del **dueño** del resumen
(`encryptForUser(owner, ...)`), porque sin cifrar expondría en claro los
primeros 200 caracteres del mensaje (`src/chat/summaries.js:40-48`,
`src/groups/store.js:214-223`).

**1:1** (`src/chat/summaries.js`):

| Función | Qué hace |
| --- | --- |
| `onMessageSentSummary(msg)` | Actualiza **los dos** resúmenes (emisor y receptor). Fija `last` al mensaje nuevo (guardando `prevId` = id del `last` anterior) e **incrementa `unread` solo del receptor** (`if (owner === msg.toId && msg.status !== 'read')`). |
| `onReadSummary(owner, peer)` | Pone `unread = 0` (se llama en `/receipt` con `status: 'read'`). |
| `onMessageDeletedSummary(msg)` | Si el `last` era el mensaje borrado, retrocede al `prevId` (o lo deja en `null`). |
| `onChatDeletedSummary(a, b)` | Borra **solo** el resumen de quien pidió el borrado. |
| `renamePeerInSummaries(owner, peer, newName)` | Actualiza el nombre del par tras un renombrado. |

El `last` es una *entrada ligera*, no el mensaje completo:
`lastEntryFromMsg()` guarda `{ id, prevId, kind, from, fromId, ts, status, once, text }`
donde `text` son como máximo **200 caracteres** y solo si `kind === 'text'`
y no es "ver una vez".

> **Lectura del resumen.** El camino canónico es `readSummaryEntry()`, que
> **descifra** `last_data` con la `auth_key` del dueño. La ruta
> `GET /chats/summary` (`src/chat/routes.js`) descifra igual, con
> `decryptForUser()`, antes de interpretarla: el resumen se guarda cifrado y
> el formato antiguo sin cifrar se tolera tal cual. El contador `unread` y el
> `peer` se leen de la fila.

**Grupos** (`src/groups/store.js`):

| Función | Qué hace |
| --- | --- |
| `updateGroupMessageSummaries(group, msg, senderId)` | **Un solo upsert por miembro** con `Stmt.bumpGroupSummary` (`unread = unread + excluded.unread`): el emisor suma 0, el resto suma 1. Evita un SELECT + INSERT/UPDATE por miembro. |
| `initializeGroupSummary(uuid, gid)` | Crea el resumen de un miembro nuevo y **marca como visto** hasta el último mensaje existente. |
| `groupSummaryFor(owner, gid)` | Devuelve el resumen; si no existe, lo crea a partir del último mensaje del grupo. |
| `writeGroupSummary(owner, gid, entry)` | Escribe (cifrando `last_data`). |

"Ver el grupo" (`POST /groups/:id` con `data.seenTs`) pone `unread = 0` y
guarda el `seenTs` en `user_group_seen` (`src/http/router.js:486-500`).

### 6.4 Límites de frecuencia

#### Limitadores por cuenta (`src/http/rate-limit.js`)

| Limitador | Límite | Ventana | Se aplica en |
| --- | --- | --- | --- |
| `messageRateLimiter` | 30 | 60 000 ms | `POST /send` y mensajes de grupo (`rejectRateLimitedMessage`) |
| `giphyLimiter` | 30 | 60 000 ms | `GET /giphy/search` |
| `profileLimiter` | 10 | 60 000 ms | `POST /profile` |
| `storyLimiter` | 15 | 60 000 ms | `POST /story` |

Implementación: `createMessageRateLimiter(limit, windowMs)`
(`src/shared/limits.js:32-69`) es una **ventana deslizante** por cuenta:
guarda los sellos de tiempo en un array por `accountId`; al superar el
límite devuelve `retryAfterMs` (hasta que expire el sello más antiguo) y la
respuesta incluye la cabecera `Retry-After` en segundos
(`src/http/helpers.js:26-45`).

- La cuota de mensajes se consume **después** de validar el contenido, para
  que una petición inválida no gaste cuota
  (`src/chat/routes.js:153`, `src/http/router.js:363`).
- Purga: `messageRateLimiter.prune()` cada ventana; los otros tres cada
  60 s (`src/http/rate-limit.js:20-21`).

#### Limitadores por IP y por cuenta objetivo (auth)

| Contador | Clave | Umbral | Ventana |
| --- | --- | --- | --- |
| `loginAttempts` | `acct:<nombre>@<ip>` | 8 | 10 min |
| `loginAttempts` | `ip:<ip>` | 30 | 10 min |
| `registerAttempts` | `<ip>` | 15 | 1 hora |

- El bloqueo por cuenta se guarda **por cuenta e IP**: con la IP en la
  clave, el bloqueo alcanza a quien falla desde esa IP y no a la víctima
  (`src/auth/routes.js:111-127`).
- El 429 se devuelve **antes** de comprobar la contraseña: con el contador
  agotado ni un acierto pasa.
- `clientIp()` (`src/shared/validation.js:71-77`) solo confía en la
  cabecera `CF-Connecting-IP` si la conexión viene de loopback (es decir,
  a través del proxy/túnel); un cliente de la LAN no puede falsearla.
- Limpieza cada 10 minutos (`src/realtime/websocket.js:295-301`).

#### Otros límites (no de frecuencia, sino de tamaño)

| Límite | Valor | Dónde |
| --- | --- | --- |
| Cuerpo HTTP máximo | 32 MiB (8 KiB en rutas de auth) | `src/http/router.js:175-181` |
| Datos de mensaje | 24 000 000 caracteres | `CONFIG.maxMessageDataChars` |
| Caracteres por mensaje | 10 000 (DM) / 15 000 (grupo) | `MESSAGE_LIMITS` |
| Elementos de galería | 20 | `CONFIG.maxGalleryItems` |
| Galería codificada | 24 000 000 caracteres | `CONFIG.maxGalleryEncodedChars` |
| Texto de historia | 140 | `CONFIG.storyCharacters` |
| Descripción de perfil | 140 | `CONFIG.profileDescriptionCharacters` |
| Audio de historia | 60 000 ms | `CONFIG.maxAudioDurationMs` |
| Stickers favoritos | 30 | `src/users/store.js:59` |
| Llamadas en el registro | 100 | `src/calls/store.js:24` |
| Suscripciones push por cuenta | 5 | `Stmt.trimPushSubs` |
| Socket WebSocket por cuenta | 8 | `WS_MAX_PER_USER` |
| Frames WebSocket | 200/s sostenidos, ráfaga 600 | `WS_FRAME_RATE` / `WS_FRAME_BURST` |

### 6.5 Borrados con alcance por usuario

Un mensaje se guarda **una sola vez** para los dos interlocutores. Para que
"borrar para mí" no destruya la copia del otro, existen dos tablas de
anotaciones:

| Tabla | Clave | Significado |
| --- | --- | --- |
| `message_deletions` | `(message_id, user_id)` | Este usuario ha ocultado este mensaje para sí. |
| `chat_deletions` | `(chat, user_id)` | Este usuario ha quitado esta conversación de su lista. |

Ambas se limpian en cascada (`ON DELETE CASCADE`) al borrarse el mensaje o
la cuenta.

**Qué borra de verdad y qué es solo "borrar para mí"** (`POST /msg/delete`,
`src/chat/routes.js:287-315`):

| Quién pide | Qué ocurre | Alcance |
| --- | --- | --- |
| **El autor** (`row.from_id === req.authUser.id`) | `deleteMessageById()` → borra la fila de `messages`, los permisos de `blob_access` y purga el blob si queda huérfano. Se actualizan los resúmenes de ambos lados y se notifica `msgDelete` / `group-message-delete`. | **Global**: desaparece para los dos. |
| **El destinatario** | `Stmt.insertMessageDeletion.run(id, userId, now)` y nada más: el texto, el adjunto y la firma siguen en el historial del emisor. | **Solo para mí**: se oculta alServidor. |

El filtro se aplica **al servir la página**, no al leerla
(`filterForViewer`, `src/chat/messages.js:182-189`):

```
si hay chat_deletions(chat, viewer)  → []
si no, se filtran los ids de message_deletions del viewer
```

El borrado de conversación (`POST /chat/delete`) es **siempre "para mí"**:
inserta en `chat_deletions`, borra el resumen del que lo pidió y **no
avisa al otro** ("no es su conversación"). Un mensaje nuevo **reabre** la
conversación: `Stmt.deleteChatDeletion.run(...)` (`src/chat/routes.js:202`,
`src/http/router.js:421`).

En grupos, `data.deleteMessage` solo lo puede hacer el autor del mensaje o
un admin, y el borrado **sí es global** para todos los miembros
(`src/http/router.js:530-545`).

### 6.6 Contactos y solicitudes

**Tres modos** en `users.add_policy` (`src/db/schema.js:30`):

| Modo | Efecto al solicitar contacto |
| --- | --- |
| `all` | Conexión **inmediata y mutua**. |
| `request` (por defecto) | Se crea una `contact_requests` y el otro debe aceptar. |
| `nobody` | `403 "No acepta contactos."` — no se puede ni solicitar. |

**Flujo completo** (`src/contacts/routes.js`):

```
A quiere añadir a B
      │
      ▼
POST /contacts { username }
      │
      ├─ B no existe                    → 404
      ├─ B === A                        → 400 "No puedes agregarte."
      ├─ A ya tiene a B en contactos    → 200 { status: 'contact' }
      ├─ bloqueo activo (A o B)         → 403 "Bloqueo activo."
      ├─ B ya tiene a A en contactos    → connectContacts()  ← aceptación mutua implícita
      ├─ B.addPolicy === 'nobody'       → 403 "No acepta contactos."
      ├─ B.addPolicy === 'all'          → connectContacts()
      └─ B.addPolicy === 'request'      → INSERT contact_requests
                                            + push 'contact-requests' a B
                                            + push (Web Push) "Nueva solicitud"
                                            → 200 { status: 'request' }
```

Aceptación (`POST /contacts/respond`):

| `accept` | Efecto |
| --- | --- |
| `true` | `connectContacts(A, B)`: inserta el contacto **en los dos sentidos**, borra las solicitudes en ambos sentidos, actualiza `acc.contacts` en RAM, guarda ambas cuentas y difunde la presencia (`broadcastUsersAround`). Se empuja `contact-request-accepted` al solicitante. |
| `false` | Borra la solicitud y actualiza los contadores. |

- `removeContacts()` hace lo inverso (rompe el vínculo en ambos sentidos).
- **Bloquear** (`POST /block`) es una alternancia: bloquear **rompe el
  contacto**, cancela las solicitudes pendientes en ambos sentidos y
  descarta las ofertas de llamada en curso; desbloquear solo borra la fila
  (`src/contacts/routes.js:119-149`).
- Las listas de contactos son **privadas**: cada cuenta ve solo la suya
  (`userList()` en `src/realtime/notify.js:56-68`).

### 6.7 Grupos

#### Roles y políticas

| Concepto | Valores | Columna |
| --- | --- | --- |
| Rol del miembro | `admin`, `member` | `group_members.role` |
| Visibilidad | `public`, `private` | `groups.visibility` |
| Política de entrada | `open`, `request`, `closed` | `groups.join_policy` |
| Política de escritura | `all`, `admins` | `groups.write_policy` |
| Política de alta de miembros | `all`, `admins` | `groups.add_policy` |
| Política de edición | `all`, `admins` | `groups.edit_policy` |
| Política de mención a todos | `all`, `admins` | `groups.mention_all_policy` |

**Permisos por tipo de contenido** (`groups.content_policy`, JSON;
`groupPolicies`, `src/groups/store.js:23-32`):

| Tipo | Valores admitidos |
| --- | --- |
| `text` | `all`, `admins` |
| `image`, `video`, `audio`, `file`, `sticker`, `contact`, `poll` | `all`, `admins`, `off` |

Regla de escritura (`src/http/router.js:352-366`): `off` → 403 "Desactivado.";
`admins` y el actor no es admin → 403 "Solo admins."; `writePolicy === 'admins'`
bloquea a los no admins **para todos los tipos**.

Menciones: `@usuario` (regex `/@([a-zA-Z0-9_.-]{3,24})/g`, solo miembros) y
`@all`/`@todos` (reservado a admins si `mention_all_policy === 'admins'`).
El propio autor se excluye de las menciones (`src/http/router.js:377-398`).

#### Invitaciones

- El **código de invitación** es `crypto.randomBytes(18).toString('base64url')`
  (24 caracteres), generado en `normalizeGroup()` y almacenado en
  `groups.invite_code`.
- Es una **credencial de acceso**: con `joinPolicy: 'open'` permite entrar
  directamente en un grupo **privado** (`src/http/router.js:306-308`).
- `pub()` **solo lo entrega a los administradores**
  (`src/groups/store.js:176-179`); `GET /groups` lo borra siempre
  (`src/groups/routes.js:45`).
- Las admins pueden compartirlo en un chat con el tipo de mensaje
  `group-invite`, que incluye `code`, `name`, `visibility`, `joinPolicy`
  y los primeros 4 miembros (`src/chat/routes.js:186-197`). El servidor
  **valida** el código contra el grupo antes de construir la invitación.

#### Solicitudes de entrada

`joinPolicy: 'request'` → el solicitante entra en `group_join_requests` y
los admins reciben un push `group-request` + notificación Web Push. Los
admins aprueban (`approveJoin`) o rechazan (`rejectJoin`, que empuja
`group-request-rejected`) (`src/http/router.js:517-529`).

#### El UUID interno del grupo

- `groups.crypto_id` es un **UUID v4** (`crypto.randomUUID()`), regenerado
  por `normalizeGroup()` si no cumple el formato v4 esperado.
- Es el identificador del **material de cifrado extremo a extremo del
  grupo**: viaja cifrado junto con los *keyboxes* en la columna
  `keys_cipher` (`encryptAtRest`), nunca en claro.
- Cada mensaje de grupo guarda ese identificador en
  `messages.crypto_group_id` (`tx.sendMessage(msg, 'group:' + id, g.cryptoId)`),
  de modo que el material criptográfico queda **ligado al mensaje**.
- Los *keyboxes* (la clave de cada miembro para cada destinatario) se
  suben con `POST /groups/:id/groupkey`. El servidor **impone** que el
  autor del keybox sea quien lo sube (`box.by = req.authUser.username`) y
  que un miembro no pueda escribir el slot de otro (salvo admins)
  (`src/http/router.js:199-224`).

### 6.8 Historias

**Ciclo de vida (24 h)**:

| Fase | Qué ocurre | Dónde |
| --- | --- | --- |
| Publicación | Se valida (texto ≤ 140, medio como data-URL o hash, fondo `#rrggbb`), se guarda en `stories` **cifrada con la `auth_key` del autor** y se copia a `stories` en RAM. | `src/stories/routes.js:31-72` |
| Reparto | `pushStories()` envía a cada usuario **conectado** solo las historias que su privacidad le permite ver, ya transformadas para ese visor (`storyForViewer`). | `src/realtime/notify.js:126-134` |
| Consulta | `GET /stories` → mismas reglas de privacidad. | `src/stories/routes.js:25-29` |
| Like / vista | Se anota en `viewers`/`likes` y se re-cifra la fila. | `src/stories/routes.js:98-130` |
| Edición | Solo texto, con las mismas validaciones; marca `edited`. | `src/stories/routes.js:131-146` |
| Borrado | Borra de RAM y de la base, y purga el blob. | `src/stories/routes.js:84-96` |
| Caducidad | Cada 60 s se filtran las RAM y se borran las filas `ts <= cutoff`, junto con sus permisos de blob. | `src/realtime/websocket.js:277-292` |

`STORY_TTL_MS` = 86 400 000 ms (24 h) por defecto
(`src/config.js:27`). `liveStories()` filtra por `now - s.ts < TTL`.

**Fan-out limitado**:

| Elemento | Techo | Dónde |
| --- | --- | --- |
| Claves por historia (`keys`) | Los **últimos 200** (`slice(-200)`) | `src/stories/routes.js:46` |
| `likes` | **1000** (se recortan los más antiguos) | `src/stories/routes.js:104-105` |
| `viewers` | **1000** | `src/stories/routes.js:119-120` |
| Historias por minuto y cuenta | 15 | `storyLimiter` |

**Privacy de la vista**: `storyForViewer(s, username)`
(`src/realtime/notify.js:120-125`) elimina `viewers`, `likes` y `keys` de
la historia que se envía a otros usuarios, sustituye `keys` por el
`keybox` específico de ese visor, y añade `liked: boolean`. El autor
recibe la historia completa.

Respuesta uniforme: `/story/like` y `/story/view` devuelven
`200 { ok: false }` tanto si la historia no existe como si la privacidad no
la deja ver — un 404 distinguiría los casos y serviría de **oráculo de
existencia** (`src/stories/routes.js:78-82`).

### 6.9 Cifrado por usuario: qué va cifrado y qué no

Dos niveles de cifrado:

| Nivel | Clave | Formato | Uso |
| --- | --- | --- | --- |
| **En reposo, global** | Llave maestra (`.zlapymasterkey` / `CHAT_MASTER_KEY`) | `PCE1:` | Datos de infraestructura que no pertenecen a un usuario concreto. |
| **Por usuario** | `auth_key` del usuario (2048 bits, MTProto 2.0) | `PCE3:` | Todo el contenido sensible de una cuenta. |

#### Contenido cifrado **con la `auth_key` del usuario**

| Dato | Tabla / columna | Cifrado en |
| --- | --- | --- |
| Mensajes | `messages.data` | `PCE3:` con clave por mensaje (MTProto 2.0) |
| Nombre visible | `user_profiles.display_name` | `encryptForUser` |
| Biografía | `user_profiles.bio` | `encryptForUser` |
| Nota del perfil | `user_profiles.note` | `encryptForUser` |
| Nota personal (estado) | `user_notes.data` | `encryptForUser` |
| Último mensaje del resumen 1:1 | `summaries.last_data` | `encryptForUser` |
| Último mensaje del resumen de grupo | `group_summaries.last_data` | `encryptForUser` |
| Historial de llamadas | `calls.data` | `encryptForUser` |
| Suscripción push (endpoint + claves) | `push_subs.data` | `encryptForUser` |
| Historia (contenido) | `stories.data` | `encryptForUser` |
| Clave pública del dispositivo | `user_keys.key_cipher` | `encryptForUser` |
| `auth_key` itself | `user_auth_keys.auth_key` | `encryptAtRest` (llave maestra) |

#### Contenido cifrado **con la llave maestra** (`PCE1:`)

| Dato | Dónde |
| --- | --- |
| Clave VAPID (privada y JWK) | `meta.vapid` (`src/push/vapid.js:26-35`) |
| Blobs (adjuntos) | `blobs.data` (`src/chat/media.js:28`) |
| Material E2E de los grupos (`crypto_id` + keyboxes) | `groups.keys_cipher` (`src/groups/store.js:112-115`) |

#### Lo que queda **en claro**

| Dato | Por qué |
| --- | --- |
| `users.id` (UUID), `username`, `password_hash`, `password_salt`, `add_policy`, `created_at`, `last_seen` | Identificadores y autenticación; el hash de la contraseña es un scrypt con sal. |
| `user_profiles.avatar` | Es público por definición (`src/users/store.js:396-399`). |
| `messages.chat`, `ts`, `from_id`, `to_id`, `kind`, `hash`, `once`, `edited`, `crypto_version`, `crypto_group_id`, `signature`, `signing_public_key` | Metadatos necesarios para indexar, enrutar y verificar. El **cuerpo** (`data`) sí va cifrado. |
| `groups.name`, `description`, `avatar`, políticas, `invite_code` | Visibles para los miembros; `invite_code` se entrega solo a admins. |
| `blob_access` (hash, permisos) | El hash es la dirección del blob; el contenido va cifrado. |
| `calls.id`, `owner`, `peer`, `ts` | El `peer` es el **nombre de usuario** a propósito: el historial sobrevive a un renombrado o al borrado de la otra cuenta (`src/db/schema.js:302-304`). |

**Firma de mensajes**: cada mensaje se firma con **Ed25519**; la semilla
del par de claves se deriva por HKDF de la `auth_key` del autor (con el
`userId` como *salt* y el dominio `dp/message-signature/ed25519/v2`). Al
verificar se aceptan **dos** semillas: la `auth_key` y la llave maestra
(para que los mensajes firmados con esta última sigan siendo válidos)
(`src/crypto/message-crypto.js:125-138`, `183-197`). La firma cubre el
contexto (id, chat, ts, autor, destinatario, tipo) **y** el cuerpo. Una
firma inválida descarta el mensaje (`rowToMessage` devuelve `null`).

**Contexto ligado**: el cifrado PCE3 usa como AAD el contexto del mensaje
(`messageContextBytes`, `src/crypto/user-auth-keys.js:95-102`), de forma
que una fila movida de chat o de autor deja de descifrar.

**Regeneración de clave** (`POST /account/regenerate-key` →
`regenerateAuthKey`, `src/users/store.js:194-297`): se genera una
`auth_key` nueva, **se instala antes de re-cifrar** (para que las firmas se
rehagan con la clave nueva) y luego se re-cifran mensajes, resúmenes,
notas, perfiles, llamadas, push e historias con la clave nueva. Devuelve
`{ keyId, reencrypted }`.

### 6.10 Notificaciones push

**VAPID** (`src/push/vapid.js`):

- Se genera un par **ECDH P-256** (`crypto.createECDH('prime256v1')`) la
  primera vez; la clave pública y el JWK (con la parte privada `d`) se
  guardan en `meta.vapid` **cifrados en reposo con la llave maestra**
  (quién la obtenga podría firmar notificaciones falsas para todos los
  dispositivos).
- Un registro guardado sin cifrar se re-cifra al vuelo, sin migración
  (`src/push/vapid.js:32-35`).
- `GET /push/vapid` expone **solo** `publicKey`.
- La cabecera `Authorization: vapid t=<jwt>, k=<pubkey>` se firma con
  ES256 (`dsaEncoding: 'ieee-p1363'`), `aud` = origen del endpoint y
  `exp` = ahora + 12 h (`vapidAuth`, `src/push/vapid.js:42-49`).

**Cifrado de la carga**: Web Push `aes128gcm` (RFC 8291) con ECDH
efímero, HKDF (`WebPush: info`, `Content-Encoding: aes128gcm`,
`Content-Encoding: nonce`), sal de 16 bytes y registro `0x02` +
payload (`src/push/vapid.js:50-85`).

**Almacenamiento de suscripciones**:

| Paso | Detalle |
| --- | --- |
| Alta | `POST /push/subscribe` → `Stmt.insertPushSub(userId, endpoint, encryptForUser(id, JSON.stringify(sub)))`. |
| Recorte | `trimPushSubs` deja las **5 más recientes** por cuenta. |
| RAM | `pushSubs` (userId → array) se recarga de la base tras cada cambio. |
| Baja | `POST /push/unsubscribe` o respuesta 404/410 del servicio → se borra de la base y de la RAM. |
| Envío | `notifyUser(username, payload)` itera las suscripciones; avisa por log si alguna falla (`src/push/vapid.js:87-105`). |

**Anti-SSRF**: `validPushEndpoint()` (`src/shared/validation.js:49-66`)
exige `https:` y una **allowlist de hosts**:

| Host | Navegador |
| --- | --- |
| `fcm.googleapis.com` | Chrome / Android |
| `updates.push.services.mozilla.com` | Firefox |
| `web.push.apple.com` | Safari |
| `push.samsungmax.com` | Samsung |
| `*.notify.windows.com` | Windows / Edge |
| `*.push.apple.com` | subdominios de Apple |

La comprobación se hace **dos veces**: al suscribirse
(`src/push/routes.js:23-24`) y **justo antes de enviar**
(`src/push/vapid.js:56`), como defensa en profundidad frente a
suscripciones antiguas o DNS rebinding.

---

## 7. WebSocket

### 7.1 Protocolo de frames propio

`src/realtime/frames.js` implementa el subconjunto de RFC 6455 que usa
Zlapy. **No usa la librería `ws`**: las dependencias son solo
`better-sqlite3` y `dotenv` (`package.json`).

| Límite | Valor | Efecto |
| --- | --- | --- |
| `MAX_FRAME_BYTES` | 262 144 (256 KiB) | Tope por frame y por mensaje ensamblado → close **1009**. |
| `MAX_BUFFER_BYTES` | 786 432 (768 KiB) | Tope del buffer de entrada → close **1009**. |
| `MAX_FRAGMENTS` | 4096 | Trozos máximo por mensaje fragmentado → close **1009**. |

Reglas del parser:

| Regla | Código de cierre |
| --- | --- |
| Los frames del cliente **deben** venir enmascarados | 1002 |
| Un frame de control no puede ir fragmentado (`fin = 0` y opcode ≥ 0x8) | 1002 |
| Un frame de control no puede pasar de 125 bytes | 1002 |
| Opcode binario (`0x2`) | 1003 |
| Opcode reservado | 1002 |
| Continuación sin mensaje inicial (`0x0` sin `0x1` previo) | 1002 |

- `ping` → `pong` con el mismo payload.
- `close` → se responde con el mismo código (1005 → 1000) y se cierra.
- El servidor escribe frames **sin máscara** (`textFrameHead`,
  `src/realtime/notify.js:24-30`), como manda el RFC.

**Ensamblado de fragmentos en O(1)** (`src/realtime/frames.js:91-107`):

```js
frag.size += payload.length;                 // O(1): tamaño acumulado
if (frag.size > MAX_FRAME_BYTES)  → 1009    // mensaje fragmentado demasiado grande
if (frag.parts.length >= MAX_FRAGMENTS) → 1009
frag.parts.push(payload);
if (fin) onText(Buffer.concat(frag.parts).toString());
```

El tamaño se lleva **acumulado** en `frag.size` en lugar de recalcular
`sum(parts.length)` en cada fragmento: hacerlo sería O(k²) y un único
mensaje de 256 KiB partido en miles de trozos bloquearía el event loop
del servidor (y con él a todos los usuarios) durante segundos. El
`Buffer.concat` final sí es O(n), pero ocurre **una vez** por mensaje.

**Backpressure**: si `socket.writableLength > WS_MAX_BACKLOG_BYTES` (1 MiB)
se destruye la conexión (`src/realtime/notify.js:31-37`, `40-50`).

**Token bucket por conexión**: 200 frames/s sostenidos, ráfaga inicial de
600; al agotarlo se envía close **1008** y se cierra
(`src/realtime/websocket.js:105-117`).

### 7.2 Upgrade y autenticación

`wsUpgradeInner` (`src/realtime/websocket.js:43-84`):

```
1. La ruta debe ser /ws                              → si no, 404
2. originAllowed(req)                                → si no, 403  (misma política CSRF)
3. Upgrade: websocket / versión 13 / Sec-WebSocket-Key → si no, 400
4. Cookie chatlocal_session → hash SHA-256 → sessionCache o tabla sessions
5. Sin sesión viva                                   → 401
6. Se calcula Sec-WebSocket-Accept = base64(SHA1(key + GUID))
7. Se responde 101 Switching Protocols
```

- Una cuenta puede tener **hasta 8 conexiones** (`WS_MAX_PER_USER`); al
  superar el tope se corta **la más antigua**, para que nunca queden
  sockets huérfanos fuera del control del heartbeat
  (`src/realtime/websocket.js:68-72`).
- Al conectar, el servidor empuja: `users` (lista de contactos con
  presencia), `contact-requests` (contadores) y `stories` (filtradas por
  privacidad). Además entrega las ofertas de llamada pendientes de menos
  de 30 s (`src/realtime/websocket.js:77-84`).

### 7.3 Tipos de mensaje

**Del cliente al servidor** (`src/realtime/websocket.js`):

| Tipo | Efecto |
| --- | --- |
| `ping` | Actualiza `lastSeen` y responde `pong`. |
| `typing` / `recording` | Reenvía al destinatario (si hay permiso `mensajes` y no hay bloqueo). |
| `group-typing` / `group-recording` | Reenvía a los miembros del grupo (verifica pertenencia). |
| `privacy` | Actualiza nombre, nota, descripción, avatar y **fusiona** la privacidad. Persiste y difunde `profile`. |
| `call-offer` | Inicia una llamada: registra el estado, avisa al otro, y crea `pendingOffers` si está desconectado. |
| `call-accept` / `call-reject` / `call-cancel` / `call-end` | Transición de estado de la llamada. |
| `call-busy` | Marca la llamada como ocupada. |
| `call-sdp` / `call-ice` / `call-mute` | **Señalización** reenviada al otro extremo. |

**Del servidor al cliente**:

| Grupo | Tipos |
| --- | --- |
| Mensajería | `message`, `msgEdit`, `msgDelete`, `receipt`, `seen`, `chatDelete`, `poll-update` |
| Grupos | `group`, `group-message`, `group-message-seen`, `group-message-delete`, `group-request`, `group-request-rejected`, `group-left` |
| Llamadas | `call-incoming`, `call-log`, `call-accepted`, `call-rejected`, `call-cancelled`, `call-ended`, `call-busy`, `call-missed`, `call-blocked`, `call-denied` |
| Presencia / social | `users`, `profile`, `contact-requests`, `contact-request-accepted`, `blocked-change`, `stories` |
| Control | `pong` |

Cada frame de texto es un JSON. El servidor **valida los identificadores
que llegan del cliente antes de tocar la base**: `m.to`, `m.callId` y
`m.groupId` deben ser cadenas (`src/realtime/websocket.js:124-126`), y
todo el manejo va dentro de un `try/catch` que, ante un frame malformado,
cierra **solo esa conexión** (close 1011) sin tumbar el proceso
(`src/realtime/websocket.js:242-248`).

### 7.4 Presencia

| Evento | Efecto |
| --- | --- |
| Upgrade | `u.online = true`, `u.lastSeen = null`, `u.lastHeartbeat = now`, `broadcastUsersAround(u.id)`. |
| Cierre del socket | Se quita de `u.sockets`; **solo si no quedan sockets** se marca `online = false` y `lastSeen = Date.now()`, que se persiste con `Stmt.touchUser`. |
| Heartbeat | Cada 15 s se destruyen los sockets sin datos en los últimos **90 s**. |
| Lista de usuarios | `userList(viewerId)` devuelve el propio usuario + sus contactos, excluyendo a quienes lo han bloqueado. |
| Difusión | `broadcastUsersAround(uuid)` avisa al usuario, a sus contactos y a quienes lo tienen como contacto. |

Tareas periódicas adicionales del WebSocket:

| Tarea | Periodicidad | Qué hace |
| --- | --- | --- |
| Heartbeat de sockets | 15 s | Cierra conexiones colgadas. |
| Limpieza de historias caducadas | 60 s | Filtra RAM, borra filas y purga blobs. |
| Limpieza de sesiones e intentos | 600 s | Borra sesiones caducadas y contadores de login/registro. |
| Limpieza de notas caducadas | 600 s | Borra `user_notes` caducadas y limpia la nota del perfil. |

---

## 8. Llamadas

### 8.1 Modelo

**La señalización pasa por el servidor; los medios no.**

```
   Navegador A                          Servidor                          Navegador B
       │                                    │                                 │
       │  WS  call-offer {to,callId,video}  │                                 │
       │───────────────────────────────────►│  comprueba bloqueo/privacidad   │
       │                                    │────────────────────────────────►│  WS call-incoming
       │◄───────────────────────────────────│                                 │
       │                                    │                                 │
       │  WS call-accept  ─────────────────►│                                 │
       │                                    │                                 │
       │  WS call-sdp   ──────────────────► │  (señalización)                 │
       │  WS call-ice   ──────────────────► │  (señalización)                 │
       │◄───────────────────────────────────│─────────────────────────────────│
       │                                    │                                 │
       │═══════ WebRTC P2P: DTLS-SRTP, audio y vídeo directos ═══════════════ │
       │       (nunca pasan por el servidor)                                  │
```

### 8.2 Señalización (por el WebSocket del servidor)

Los tipos `call-offer`, `call-accept`, `call-reject`, `call-cancel`,
`call-end`, `call-busy`, `call-sdp`, `call-ice` y `call-mute` viajan por
`/ws` (`src/realtime/websocket.js:133-236`). El servidor:

1. **Valida** la sesión, el tipo del id y la existencia del destinatario.
2. **Aplica la privacidad**: `permite(targetP, 'llamadas', from)`; si se
   deniega, marca la llamada como `denied` y empuja `call-denied`.
3. **Aplica el bloqueo**: si cualquiera de los dos bloqueó al otro, la
   llamada se marca `blocked` y se corta.
4. **Registra** la llamada en ambos historiales (`addCall`), cifrada en
   reposo.
5. **Reenvía** la señalización al otro extremo sin tocar el contenido.

Cuando el destinatario está **desconectado**, la oferta queda en
`pendingOffers` con una ventana de **30 s**; si no se contesta, ambas
partes pasan a `missed` y se empuja `call-missed`. Si el destinatario se
conecta dentro de la ventana, recibe la oferta pendiente
(`src/realtime/websocket.js:81-84`).

**Los medios (audio/vídeo) son P2P con DTLS-SRTP**, en el momento y sin
guardarse: el servidor nunca los ve. Es el mismo modelo que los chats
"normales" de Telegram (no los chats secretos), tal y como documenta
`src/crypto/mtproto.js:9-16`.

### 8.3 Registro de llamadas

| Aspecto | Detalle |
| --- | --- |
| Dónde vive | `callFiles` (RAM) + tabla `calls` (cifrado en reposo con la `auth_key` del dueño). |
| Tope | 100 por cuenta (`callFiles.slice(-100)` y `Stmt.trimCalls`). |
| Estados terminales | `ended`, `missed`, `rejected`, `cancelled`, `busy`, `blocked`, `denied`. |
| Al desconectarse | `endUserCalls(username)` cierra las llamadas vivas de ese usuario y avisa a la contraparte, para que no quede una llamada colgada (`src/calls/store.js:51-63`). |
| Lectura | `GET /calls` **filtra** las llamadas con interlocutores bloqueados (`src/calls/routes.js:15-18`). |
| Renombrado | `calls.peer` guarda el **nombre** del otro extremo; `Stmt.renameCallsPeer` lo actualiza al cambiar de nombre (`src/chat/mentions.js:69`). |

---

## 9. Operación

### 9.1 Supervisor (`ops/supervisor.js`)

`npm start` → `node ops/supervisor.js`. El supervisor **no** habla con la
base: vigila el proceso hijo (`node server.js`).

```
 supervisor
    │
    ├─ carga el MISMO .env (dotenv) antes de resolver su configuración
    ├─ spawn(process.execPath, ['server.js'], { cwd: ROOT, env: process.env })
    ├─ stdout del hijo → se canaliza (pipe) y se reenvía tal cual
    │     └─ se busca el banner "✅ Zlapy (SQLite) en el puerto NNNN"
    │        para saber el puerto REAL en el que hay que sondear
    ├─ stderr del hijo → heredado
    │
    ├─ watchdog de salud: cada SUPERVISOR_HEALTH_MS (15 s) sondea
    │     GET /healthz en 127.0.0.1:<puerto> con timeout de 5 s
    │     · solo un 2xx cuenta como sano
    │     · 3 fallos consecutivos → killUnhealthy() → SIGTERM → SIGKILL a los 5 s
    │
    ├─ al salir el hijo:
    │     · si estaba sano   → CAÍDA EN CALIENTE → backoff y reinicio SIEMPRE
    │     · si no llegó a servir → FALLO DE ARRANQUE → backoff; al superar
    │       MAX_RESTARTS (10) → CIRCUITO ABIERTO → exit(70) y hay que
    │       arrancar a mano
    │
    └─ escribe el PID del hijo en SUPERVISOR_PID_FILE (.zlapy.pid)
```

| Aspecto | Detalle |
| --- | --- |
| **Backoff exponencial** | `min(BASE * 2^n, MAX)` = 1 s → 30 s (`SUPERVISOR_BACKOFF_MS` / `SUPERVISOR_BACKOFF_MAX_MS`). |
| **Ciclo abierto** | Solo protege del **fallo de arranque**. La caída en caliente reinicia siempre: "el servicio no se queda apagado". |
| **Alerta de crash-loop** | A partir de `SUPERVISOR_HOT_CRASH_THRESHOLD` (5) caídas en caliente seguidas se avisa por log (y cada 10 después). |
| **Ventana estable** | Tras `SUPERVISOR_STABLE_MS` (60 s, nunca menos que `gracia + fallos × intervalo`) sano, se olvida la racha de fallos. |
| **Gracia de arranque** | `SUPERVISOR_STARTUP_MS` (30 s) sin exigir respuesta; se acorta cuando llega el banner (el servidor ya escuchó). |
| **Health check** | `SUPERVISOR_HEALTH_PATH` (`/healthz`), `SUPERVISOR_HEALTH_MS` (15 s), `SUPERVISOR_HEALTH_TIMEOUT_MS` (5 s), `SUPERVISOR_FAILURES_BEFORE_KILL` (3). |
| **Puerto** | Se empieza con `SUPERVISOR_HEALTH_PORT` o `PORT`; se sustituye por el puerto real del banner. |
| **PID file** | `SUPERVISOR_PID_FILE`, por defecto `.zlapy.pid` en la raíz. Se escribe al arrancar y se vacía al salir. |
| **Señales** | `SIGINT`/`SIGTERM` → propaga al hijo, cancela el reinicio pendiente, `exit(0)` a los 5 s. |
| **Timer de reinicio** | **Sin `unref()` a propósito**: es lo único que mantiene vivo al supervisor entre la caída del hijo y el siguiente arranque. |
| **Sondeo** | Nunca se solapan dos sondeos (`pendingProbe`). |

### 9.2 Cierre ordenado del servidor

`orderlyShutdown` en `src/http/servers.js:75-98`, ante `SIGTERM`/`SIGINT`:

```
1. hardExit = setTimeout(exit(0), 5000).unref()      ← red de seguridad
2. Destruir los sockets de todos los usuarios conectados
3. dispatcher.close() · httpSrv.close() · httpsSrv.close()
4. httpSrv.closeAllConnections() · httpsSrv.closeAllConnections()
     (si no, close() espera a que el cliente suelte el socket y el puerto
      sigue ocupado)
5. db.pragma('wal_checkpoint(TRUNCATE)')  ← checkpoint WAL
   blobDb.pragma('wal_checkpoint(TRUNCATE)')
6. db.close() · blobDb.close()
7. clearTimeout(hardExit) · process.exit(0)
```

`uncaughtException` hace el checkpoint y cierra las bases antes de
`exit(1)`; `unhandledRejection` **solo se registra** (una promesa
rechazada no debe tumbar el servidor).

### 9.3 Scripts de `ops/`

| Script | Qué hace | Notas |
| --- | --- | --- |
| `supervisor.js` | Vigila y relanza el servidor (ver §9.1). | `npm start`. |
| `backup.js` | Copia `zlapy.db` y `blob.db` con la **API de backup de SQLite** (`db.backup()`, segura con el servidor corriendo y WAL activo) y copia `.zlapymasterkey`. | `npm run backup [dir]`. El destino se crea con 0700 y los ficheros con 0600. Si la llave viene de `CHAT_MASTER_KEY` avisa de que hay que guardarla aparte. |
| `generate-master-key.js` | Genera `CHAT_MASTER_KEY` (32 bytes en base64) en el `.env`, con modo 0600. | `npm run key [-- --force \| --null]`. No muestra la clave; no sobrescribe una clave existente sin `--force`. |
| `tunnel.js` | Levanta `cloudflared` con la configuración `zty.yml` y el token de `CLOUDFLARE_TUNNEL_TOKEN`. | `npm run tunnel`. El token **no viaja en `argv`** (se entrega por `--token-file` en un fichero 0600 dentro de un directorio 0700, o por `TUNNEL_TOKEN` en el entorno si el binario es antiguo), y la salida del proceso se **redacta** para que no pueda aparecer en los logs. |
| `migrate-to-mtproto.js` | Convierte de golpe el contenido antiguo al esquema nuevo: mensajes `PCE2` → `PCE3` y el resto (resúmenes, notas, perfiles, llamadas, push, historias) a cifrado con la `auth_key` del usuario. | `npm run migrate:mtproto [-- --apply]`. Sin `--apply` es simulación. Hace un respaldo automático antes de escribir, es idempotente y **verifica cada registro ida y vuelta antes de tocarlo**. |

### 9.4 Copias de seguridad y llave maestra

La llave maestra es **irreemplazable**: sin ella los mensajes, historias y
adjuntos son ilegibles. `src/crypto/master-key.js` se niega a arrancar si
la base ya tiene datos y la llave no está disponible
("Regenerarla en silencio haría irreversibles todos los mensajes,
historias y adjuntos cifrados con la llave anterior").

---

## 10. Anexo: índice de referencias

| Tema | Ficheros |
| --- | --- |
| Arranque | `server.js`, `src/db/database.js`, `src/db/schema.js`, `src/users/store.js`, `src/http/servers.js` |
| Configuración | `src/config.js`, `.env.example` |
| HTTP | `src/http/router.js`, `src/http/servers.js`, `src/http/responses.js`, `src/http/helpers.js`, `src/http/rate-limit.js` |
| Sesiones | `src/auth/sessions.js`, `src/auth/routes.js` |
| Cuentas | `src/users/store.js`, `src/users/helpers.js`, `src/users/privacy.js` |
| Chat | `src/chat/routes.js`, `src/chat/messages.js`, `src/chat/summaries.js`, `src/chat/media.js`, `src/chat/mentions.js` |
| Grupos | `src/groups/store.js`, `src/groups/routes.js` |
| Historias | `src/stories/routes.js` |
| Contactos | `src/contacts/routes.js` |
| Perfil | `src/profile/routes.js` |
| Llamadas | `src/calls/store.js`, `src/calls/routes.js` |
| Push | `src/push/vapid.js`, `src/push/routes.js`, `public/sw.js` |
| Tiempo real | `src/realtime/frames.js`, `src/realtime/websocket.js`, `src/realtime/notify.js` |
| Cifrado | `src/crypto/master-key.js`, `src/crypto/message-crypto.js`, `src/crypto/mtproto.js`, `src/crypto/user-auth-keys.js`, `src/crypto/setup.js` |
| Base de datos | `src/db/schema.js`, `src/db/statements.js`, `src/db/transactions.js`, `docs/ESQUEMA-BD.md` |
| Utilidades | `src/shared/*.js` |
| Operación | `ops/*.js` |

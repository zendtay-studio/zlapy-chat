# API de Zlapy

Documentación de la API HTTP + WebSocket del servidor de Zlapy (Node.js + SQLite).

El servidor expone un único puerto (por defecto `3000`, variable `PORT`) que sirve a la vez
la API REST, la SPA estática de `public/` y el endpoint WebSocket `/ws`. Por defecto los
cuerpos viajan como JSON en claro; opcionalmente pueden ir dentro de un sobre cifrado
(véase §1.9) y los frames WebSocket también pueden cifrarse (véase §4.7). Los adjuntos y el
SVG del avatar tienen sus propios tipos MIME.

- Enrutador: `src/http/router.js` (decide qué ruta atiende cada petición).
- Cabeceras y envoltorio JSON: `src/http/responses.js`.
- Límites de frecuencia: `src/http/rate-limit.js` y `src/http/helpers.js`.
- Implementaciones por dominio: `src/auth/`, `src/users/`, `src/profile/`, `src/contacts/`,
  `src/chat/`, `src/groups/`, `src/stories/`, `src/calls/`, `src/stickers/`, `src/push/`,
  `src/realtime/`, `src/meta/`, `src/shared/`.

---

## 1. Convenciones HTTP

### 1.1 Autenticación

La sesión viaja en una **cookie `HttpOnly`**; no hay cabeceras `Authorization` ni token en el
cuerpo.

| Cookie | Contenido | Uso |
|---|---|---|
| `chatlocal_session` | Token opaco de 32 bytes en base64url | Sesión principal de la cuenta conectada. |
| `chatlocal_account_<uuid>` | Otro token opaco | Sesión de una cuenta **vinculada** (varias cuentas abiertas en el mismo navegador). |

Atributos de la cookie (`src/auth/sessions.js:79-90`): `HttpOnly; SameSite=Lax; Path=/; Max-Age=<AUTH_SESSION_TTL/1000>`,
y `Secure` solo si la conexión va cifrada (`socket.encrypted` o `X-Forwarded-Proto: https`).
El TTL por defecto son 30 días (`AUTH_SESSION_TTL_MS`, `src/config.js:28`).

El servidor guarda el hash SHA-256 del token, nunca el token en claro
(`hashSessionToken`, `src/auth/sessions.js:23`).

**Cualquier ruta no pública exige sesión.** El corte se hace en `src/http/router.js:100-101`:

```js
const authUser = sessionUser(req);
if (!authUser && !publicPage && !publicAuthPost) return json(res, 401, { error: 'authentication required' });
```

- **Públicas**: `GET /config`, `GET /healthz`, `GET /auth/session`, `GET /push/vapid`, la SPA
  estática (`/` y ficheros con extensión `.html .js .css .svg .png .webmanifest .json`) y
  `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `POST /auth/switch`.
- **Todo lo demás** requiere cookie de sesión válida (`401 authentication required`).
  `GET /avatar/<user>.svg` también la exige, para que no se puedan enumerar cuentas
  (`src/http/router.js:82`).

### 1.2 Origen y CSRF

Toda petición `POST` debe superar dos comprobaciones (`src/http/router.js:103-104`):

1. `originAllowed(req)`: el `host` de la cabecera `Origin` debe coincidir con el de `Host`
   (`src/auth/sessions.js:114-118`). Si no hay `Origin`, se acepta.
2. `sec-fetch-site` no debe ser `cross-site`.

Si alguna falla: `403 { "error": "cross-origin request rejected" }`.

### 1.3 Parámetros

- **Query string**: `?clave=valor`, se leen con `url.searchParams.get('clave')`.
  Ejemplos: `?light=1` (grupo), `?beforeId=...&limit=30` (mensajes de grupo), `?hash=...`
  (`/have`), `?username=...` (`/profile`, `/key`), `?q=...&offset=...&limit=...` (`/giphy/search`).
- **Cuerpo**: `application/json`. El servidor **no** mira `Content-Type`; hace `JSON.parse`
  del cuerpo y, si falla, responde `400 { "error": "Cuerpo JSON inválido." }`
  (`src/http/router.js:239`). Cuerpo vacío en un `POST` sin `X-Zlapy-Enc` se
  interpreta como `{}` (por ejemplo: `/auth/logout` sin cuerpo sigue siendo válido).
- El cuerpo debe ser un objeto JSON: si no lo es, `400 { "error": "..." }`
  (`src/http/router.js:240-242`).

### 1.4 Límite de tamaño del cuerpo

`MAX_HTTP_BODY_BYTES` (por defecto **32 MiB**, `src/config.js`).
Si se supera: `413 { "error": "Contenido demasiado grande." }` (`src/http/router.js:204-206`).

Excepción: las rutas de autenticación aceptan como máximo **8 KiB**, porque solo llevan
usuario y contraseña (`SMALL_BODY_ROUTES`, `src/http/router.js:203-204`):

`/auth/register`, `/auth/login`, `/auth/add-account`, `/auth/switch`, `/auth/logout`,
`/auth/account-remove`.

Además, en el nivel de aplicación (`src/config.js`):

| Límite | Valor por defecto | Qué acota |
|---|---:|---|
| `MAX_MESSAGE_DATA_CHARS` | 24 000 000 | campo `data` de un mensaje |
| `MAX_GALLERY_ENCODED_CHARS` | 24 000 000 | galería codificada |
| `MAX_INLINE_MEDIA_CHARS` | 262 144 | medio (`image`/`video`/`audio`/`file`) enviado en `/send` **sin `hash`** → `413` si se pasa; el flujo normal sube blob y manda `hash` |
| `STORY_INLINE_CHAR_LIMIT` | 4 000 000 | medio de una historia publicado **sin `hash`** → `413` si se pasa |
| Cuota de adjuntos | 512 MiB por cuenta, 20 GiB globales | `src/chat/media.js` → `413`/`429` según el caso |

### 1.5 Cabeceras de seguridad

`securityHeaders` (`src/http/responses.js:17-28`) se añaden a **toda respuesta JSON** y a los
adjuntos, al avatar y a los ficheros estáticos:

| Cabecera | Valor |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` (la app enmarca sus propias páginas) |
| `Referrer-Policy` | `no-referrer` |
| `Permissions-Policy` | `camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), fullscreen=(self)` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

Además, en **cada** petición se fija `Content-Security-Policy` calculada con el host propio
(`cspFor`, `src/http/responses.js:33-39`; se aplica en `src/http/router.js:76`):

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:; media-src 'self' data: blob:;
connect-src 'self' data: blob: ws://<host> wss://<host>;
font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'
```

`Strict-Transport-Security: max-age=31536000; includeSubDomains` se añade solo cuando la
conexión va cifrada (`src/http/router.js:78`).

Las respuestas JSON llevan además `Content-Type: application/json` y `Cache-Control: no-store`
(`src/http/responses.js:40-43`).

### 1.6 Métodos

- `OPTIONS` → `204` sin cuerpo, sin ninguna otra cabecera (`src/http/router.js:57`).
- Un método distinto de `GET`/`POST` → `405 { "error": "method not allowed" }`
  (`src/http/router.js:130`).

### 1.6 bis Modo degradado (`FORCE_TLS=true` sin certificados)

Si el servidor arranca con `FORCE_TLS` activo pero no existen `cert.pem`/`key.pem`,
**sigue en marcha** en HTTP puro (`tlsState.degradedNoCert`), pero las cuatro rutas
públicas de autenticación (`/auth/register`, `/auth/login`, `/auth/logout`,
`/auth/switch`) solo se aceptan desde loopback. Desde otra máquina:
`503 { "error": "HTTPS requerido: instala cert.pem/key.pem o arranca con FORCE_TLS=false para uso HTTP." }`
(`src/http/router.js:128-130`). El resto del acceso (por ejemplo consultar con sesión ya
abierta) funciona: el objetivo es que nadie mande credenciales en claro desde fuera.

### 1.7 Códigos de error habituales

| Código | Cuándo | Cuerpo |
|---|---|---|
| `400` | Petición malformada, JSON inválido, campo obligatorio ausente o valor fuera de rango | `{ "error": "..." }` (o `{}` si el JSON no se pudo interpretar) |
| `401` | Sin cookie de sesión válida, o credenciales incorrectas | `{ "error": "authentication required" }` / `{ "error": "Invalid username or password." }` |
| `403` | Acción permitida por rol pero no por la política vigente; origen rechazado; bloqueo activo; expulsar al propietario del grupo | `{ "error": "Solo admins." }`, `{ "error": "cross-origin request rejected" }`, `{ "error": "No se puede expulsar al propietario del grupo." }`, `{ "error": "Ese ajuste es solo para admins." }` |
| `404` | Recurso inexistente, no visible para quien pregunta, o ruta desconocida | `{ "error": "..." }` (o `{}` si la ruta no existe) |
| `409` | Conflicto de estado (usuario ocupado, ID de grupo en uso) | `{ "error": "..." }` |
| `413` | Cuerpo por encima del límite, `data` de un mensaje demasiado largo, medio en línea por encima de `MAX_INLINE_MEDIA_CHARS` / `STORY_INLINE_CHAR_LIMIT` | `{ "error": "Contenido demasiado grande." }` |
| `429` | Límite de frecuencia agotado (con cabecera `Retry-After`) | `{ "error": "Límite alcanzado: ...", "retryAfter": <segundos> }` |
| `500` | Excepción no controlada en el handler | `{ "error": "Error interno del servidor." }` |
| `502` / `503` | Fallo del proxy de Giphy o de la base de datos; arranque degradado sin TLS desde fuera de loopback | `{ "error": "Giphy no disponible." }`, `{ "error": "database unavailable" }`, `{ "error": "HTTPS requerido: …" }` |

### 1.8 Límites de frecuencia

| Ámbito | Límite | Dónde |
|---|---|---|
| Envío de mensajes (DM y grupo) | 30 por minuto y cuenta | `MESSAGE_RATE_LIMIT` / `MESSAGE_RATE_WINDOW_MS` (`src/shared/limits.js`) |
| Proxy de Giphy | 30 por minuto y cuenta | `giphyLimiter` (`src/http/rate-limit.js:17`) |
| Escritura de perfil | 10 por minuto y cuenta | `profileLimiter` (`src/http/rate-limit.js:18`) |
| Publicación de historias | 15 por minuto y cuenta | `storyLimiter` (`src/http/rate-limit.js:19`) |
| Registro | 15 por hora y IP | `src/auth/routes.js:69` |
| Login | 8 por cuenta+IP y 30 por IP (ventana de 10 min) | `src/auth/routes.js:125-127` |

Todos devuelven `429` con la cabecera `Retry-After` en segundos.

### 1.9 Cifrado del canal (sobre HTTP)

El servidor puede recibir el cuerpo de un `POST` cifrado con una clave de sesión X25519.
El algoritmo y la clave pública se publican en `GET /config` y `GET /healthz`:

```json
{ "transportAlgorithm": "x25519-chacha20-hmac-v1", "transportPublicKey": "<32 bytes base64>" }
```

Una petición cifrada lleva estas cabeceras:

| Cabecera | Obligatoria | Contenido |
|---|---|---|
| `X-Zlapy-Enc` | Sí | `x25519-chacha20-hmac-v1` |
| `X-Zlapy-Ephemeral` | Sí | clave pública efímera del cliente (32 bytes, base64) |
| `X-Zlapy-Nonce` | Sí | nonce de 12 bytes (base64) |
| `X-Zlapy-Time` | Sí | milisegundos del reloj del cliente; se admite ±60 s |
| `Content-Type` | Sí | `application/octet-stream` |

El cuerpo es `ciphertext ‖ HMAC-SHA256` (32 bytes de etiqueta). El cliente que usa el
sobre debe enviar una clave efímera nueva por petición; el servidor no guarda estado.

Reglas y errores:

- `X-Zlapy-Enc` distinto → `400 { error: "Versión de cifrado no soportada." }`.
- `X-Zlapy-Time` no numérico o fuera de ±60 s → `400 { error: "Marca de tiempo fuera de rango." }`.
- Clave efímera/nonce con longitud incorrecta o HMAC inválido → `400 { error: "No se pudo descifrar el sobre." }`.
- Cuerpo descifrado que no es JSON o no es un objeto → `400 { error: "Cuerpo JSON inválido." }` o
  `400 { error: "El cuerpo debe ser un objeto JSON." }`.

Si el sobre es válido, el enrutador procesa el JSON como si hubiera llegado en claro: no hay
rutas distintas para clientes cifrados.

La respuesta a una petición cifrada también va cifrada con la misma clave de sesión:

```
Content-Type: application/octet-stream
X-Zlapy-Enc: x25519-chacha20-hmac-v1
X-Zlapy-Resp-Nonce: <12 bytes base64>
```

El cliente debe descifrarla con `X-Zlapy-Resp-Nonce` y el AAD
`zlapy-transport-v1|RSP|<método>|<ruta>|<time>|<estado>`. La petición usa
`zlapy-transport-v1|REQ|<método>|<ruta>|<time>`.

> Solo se cifran los `POST` con cuerpo JSON y los frames WebSocket. Las cabeceras (incluida la
> cookie de sesión), las respuestas `GET` y los metadatos (ruta, método, tamaño, hora) siguen
> en claro, así que esta capa **no sustituye a HTTPS**. Detalle completo, derivación de claves
> y modelo de amenazas: [`docs/CRIPTOGRAFIA.md`](CRIPTOGRAFIA.md#11-cifrado-del-canal-de-transporte).

---

## 2. Tabla de rutas

### 2.1 `GET`

| Ruta | Auth | Descripción | Parámetros | Respuesta |
|---|---|---|---|---|
| `/config` | Pública | Límites del servidor que el cliente necesita conocer y clave pública del canal | — | `{ directMessageCharacters, groupMessageCharacters, storyCharacters, profileDescriptionCharacters, maxAudioDurationMs, storyTtlMs, noteTtlMs, maxMessageDataChars, maxGalleryItems, maxGalleryEncodedChars, transportAlgorithm, transportPublicKey }` |
| `/healthz` | Pública | Comprobación de salud; consulta las dos bases y publica la clave del canal | — | `200 { ok: true, schema, uptime, transportAlgorithm, transportPublicKey }` / `503 { ok: false, error: "database unavailable" }` |
| `/avatar/:user.svg` | Sesión | Avatar SVG generado en el servidor. `:user` es un UUID o un nombre de usuario | — | `200 image/svg+xml` (`Cache-Control: private, max-age=31536000, immutable` si es UUID, `private, max-age=3600` si es nombre) / `404 { error: "avatar not found" }` |
| `/auth/session` | Pública | Estado de la sesión actual | — | `200 { authenticated: true, user: { id, username } }` o `200 { authenticated: false }` o `200 { authenticated: false, gone: true, accountId }` (la cuenta ya no existe) |
| `/push/vapid` | Pública | Clave pública VAPID para suscribir el service worker | — | `200 { publicKey }` |
| `/giphy/search` | Sesión | Proxy de búsqueda de stickers; la clave de GIPHY no sale del servidor | `?q` (≤100), `?offset` (1-4 dígitos), `?limit` (1-3 dígitos) | `200` con el JSON de Giphy tal cual / `503 { error: "Stickers no configurados." }` / `502 { error: "Giphy no disponible." }` |
| `/blob/:hash` | Sesión | Adjunto (media) por hash SHA-256; el acceso depende de la conversación, el grupo o la historia | — | `200 text/plain` con el data-URL, `ETag: "<hash>"`, `Cache-Control: private, max-age=86400` / `404 {}` |
| `/users` | Sesión | Lista de la cuenta y de sus contactos | — | `200 { users: [ { id, username, online, lastSeen } ] }` |
| `/contacts` | Sesión | Alias de `/users` (misma respuesta) | — | `200 { users: [ … ] }` |
| `/contacts/requests` | Sesión | Solicitudes de contacto **recibidas** | — | `200 { requests: [ { id, username, sentAt, name, avatar, description } ] }` |
| `/contacts/requests/sent` | Sesión | Solicitudes de contacto **enviadas** | — | `200 { requests: [ { username, name, sentAt } ] }` |
| `/groups/requests` | Sesión | Solicitudes de entrada a grupos que el usuario ha enviado | — | `200 { requests: [ { id, name, description, avatar, visibility, sentAt } ] }` |
| `/have` | Sesión | ¿Existe el adjunto con ese hash y tengo acceso? | `?hash` (SHA-256 hex) | `200 { ok: true \| false }` |
| `/chats/summary` | Sesión | Resumen de las conversaciones 1:1 | — | `200 { chats: [ { peer, peerId, unread, last } ] }` (ordenado por `last.ts` descendente) |
| `/stories` | Sesión | Historias vivas visibles para quien pregunta | — | `200 { stories: [ … ] }` |
| `/key` | Sesión | Clave pública de cifrado de la cuenta propia | `?username` (opcional; si es otro usuario → `404`) | `200 { username, pubKey }` (`pubKey` puede ser `null`) |
| `/groups` | Sesión | Grupos de la cuenta | — | `200 [ { id, name, description, members, admins, createdAt, avatar, visibility, joinPolicy, writePolicy, addPolicy, editPolicy, contentPolicy, mentionAllPolicy, joinRequests, last, unread } ]` — **es un array desnudo**, no un objeto |
| `/groups/discover` | Sesión | Grupos públicos en los que el usuario no está | — | `200 { groups: [ { id, name, description, avatar, members, joinPolicy, requested } ] }` |
| `/groups/:id` | Sesión | Ficha de un grupo (solo si el usuario es miembro) | `?light=1` | `200` con el objeto de grupo. Sin `light`: añade `messages` y `more`. Con `light=1`: añade `brief`, `seenTs` y `unread` |
| `/groups/:id/messages` | Sesión | Página de mensajes de un grupo | `?beforeId`, `?limit` (por defecto 30) | `200 { messages: [ … ], more: bool }` |
| `/calls` | Sesión | Registro de llamadas de la cuenta | — | `200 { calls: [ { id, ts, peer, dir, video, state, duration? } ] }` |
| `/stickers` | Sesión | Stickers favoritos de la cuenta | — | `200 { stickers: [ … ] }` |
| `/chat/preferences` | Sesión | Contactos silenciados | — | `200 { mutedPeers: [ "<username>" ] }` |
| `/account/chat-settings` | Sesión | Apariencia del chat de la cuenta | — | `200 { settings: { wall, opacity, blur, sender, receiver, senderText, receiverText, image, fontSize, autoText } \| null }` |
| `/profile` | Sesión | Perfil de una cuenta con la privacidad aplicada | `?username` | `200 { username, signingPublicKey, encryptionKeyId, id?, name?, permisos, online?, lastSeen?, note?, noteTs?, blocked?, privacy?, avatar?, desc?, blockedBy? }` |
| `/notes` | Sesión | Nota personal de la cuenta (caduca a las 24 h) | — | `200 { data: { text, bg, ts } \| null }` o `200 { data: null, expired: true }` |

`GET /` y el resto de ficheros estáticos los sirve `public/` con `Cache-Control: no-store`
para `.html .js .css .webmanifest` (`src/http/router.js:611-628`).

### 2.2 `POST`

Todos los cuerpos son JSON. Salvo indicación contraria, el servidor **impone** el `username`
o el `from` a la cuenta de la sesión (`src/http/router.js:235-242`), de modo que el cliente no
puede suplantar a otro usuario.

| Ruta | Auth | Descripción | Cuerpo JSON | Respuesta |
|---|---|---|---|---|
| `/auth/register` | Pública | Crea una cuenta | `{ username, password, name? }` — usuario `[a-z0-9_.-]{3,24}`, contraseña 8-128, nombre visible opcional (≤64 caracteres) | `201 { ok: true, user: { id, username } }` + cookie de sesión. `400` si los datos no valen, `409 { error: "Username is already taken." }` si el nombre está ocupado, `429` si se superan los registros por IP. El avatar **no** se acepta aquí (el cuerpo está limitado a 8 KiB): se guarda después con `POST /profile` |
| `/auth/login` | Pública | Inicia sesión | `{ username, password }` | `200 { ok: true, user: { id, username } }` + cookie. `401 { error: "Invalid username or password." }`, `429 { error: "Too many login attempts." }` |
| `/auth/add-account` | Sesión | Vincula otra cuenta en este navegador | `{ username, password }` (+ `expectedAccountId` opcional: UUID de la cuenta que se espera) | `200 { ok: true, user: { id, username } }` + cookie `chatlocal_account_<uuid>`. `401` si la contraseña no es, `409 { error: "Esas credenciales no son de la cuenta seleccionada." }` si se pasó `expectedAccountId` y las credenciales son de otra cuenta, `429` por intentos |
| `/auth/switch` | Cookie de cuenta | Cambia a una cuenta vinculada (rota el token de sesión) | `{ accountId }` (UUID) | `200 { ok: true, user: { id, username } }`. `400 { error: "Cuenta inválida." }`, `401 { error: "Sesión no disponible.", relogin: true }` (la cookie de la cuenta caducó o se perdió, pero la cuenta **sigue existiendo**: hay que volver a iniciar sesión) o `401 { error: "Cuenta no disponible.", gone: true }` (la cuenta ya no está en la base: se quita de la lista de cuentas conectadas). **Sin sesión vigente** la respuesta es `401 { error: "Sesión no disponible." }` sin marcas: la ruta es pública y distinguirlas la convertiría en un oráculo de existencia de cuentas |
| `/auth/account/remove` | Sesión | Elimina una cuenta vinculada de este navegador | `{ accountId }` (UUID) | `200 { ok: true }`. `400` si es la cuenta en uso |
| `/auth/logout` | Pública | Cierra la sesión y revoca **todas** las cuentas abiertas en el navegador | — (sin cuerpo) | `200 { ok: true }` + cookies de sesión borradas |
| `/key` | Sesión | Guarda la clave pública de cifrado de la cuenta | `{ pubKey }` (objeto) | `200 { ok: true }`. `400 { error: "clave inválida" }` |
| `/groups/:id/groupkey` | Sesión | Publica los *keyboxes* cifrados del grupo para los destinatarios indicados | `{ recipients: [ { recipient, iv, ct } ] }` | `200 { ok: true }`. `400 { error: "id inválido" }`, `404 { error: "no existe" }`, `403 { error: "no eres miembro" }` |
| `/stickers` | Sesión | Guarda los stickers favoritos (máx. 30) | `{ stickers: [ "<url https de giphy>" ] }` | `200 { ok: true, stickers: [ … ] }`. `400 { error: "stickers must be an array" }` |
| `/chat/preferences` | Sesión | Silencia o quita el silencio de un chat | `{ peer, muted }` (`muted` booleano) | `200 { ok: true, mutedPeers: [ … ] }`. `400 { error: "Preferencia de chat inválida." }` |
| `/poll/vote` | Sesión | Vota (o retira el voto) en una encuesta | `{ messageId, optionId }` | `200 { ok: true, message: { … } }`. `400 { error: "Opción de encuesta inválida." }`, `403`, `404 { error: "Encuesta no disponible." }` |
| `/contacts` | Sesión | Envía una solicitud de contacto | `{ username }` | `200 { ok: true, status: "contact" \| "request" }`. `404 { error: "No account found." }`, `400`, `403 { error: "No acepta contactos." }` / `{ error: "Bloqueo activo." }` |
| `/contacts/remove` | Sesión | Elimina un contacto | `{ username }` | `200 { ok: true }`. `404 { error: "No disponible." }` |
| `/contacts/cancel` | Sesión | Retira una solicitud enviada | `{ username }` | `200 { ok: true }`. `404 { error: "No disponible." }` |
| `/contacts/respond` | Sesión | Acepta o rechaza una solicitud recibida | `{ username, accept }` (`accept` booleano) | `200 { ok: true, accepted, username }`. `400 { error: "Indica aceptar." }`, `403 { error: "Bloqueo activo." }`, `404` |
| `/account/profile` | Sesión | Cambia el nombre de usuario y/o la contraseña | `{ currentPassword, username?, password? }` | `200 { ok: true, user: { id, username } }`. `400 { error: "Contraseña actual requerida." }`, `403 { error: "Contraseña incorrecta." }`, `409 { error: "Usuario ocupado." }`. Si cambia la contraseña, **revoca todas las sesiones** y abre una nueva |
| `/account/chat-settings` | Sesión | Guarda la apariencia del chat | `{ settings: { wall, opacity, blur, sender, receiver, senderText?, receiverText?, image?, fontSize, autoText? } }` | `200 { ok: true }`. `400 { error: "Ajustes inválidos o foto de fondo no válida." }`, `409 { error: "No se pudieron guardar los ajustes." }` |
| `/account/regenerate-key` | Sesión | Regenera la clave de cifrado de la cuenta (equivalente a `auth.resetAuthorizations`) y re-cifra el historial | — | `200 { ok: true, keyId, reencrypted }` |
| `/account/delete` | Sesión | Borra la cuenta (irreversible) | `{ password }` | `200 { ok: true, deleted: "<username>" }`. `400 { error: "Indica tu contraseña para confirmar." }`, `401 { error: "Contraseña incorrecta." }` |
| `/push/subscribe` | Sesión | Suscribe un dispositivo a las notificaciones push | `{ sub: { endpoint, keys: { p256dh, auth } } }` | `200 { ok: true }`. `400 { error: "Endpoint de push no permitido." }` (allowlist anti-SSRF) |
| `/push/unsubscribe` | Sesión | Da de baja un dispositivo | `{ endpoint }` | `200 { ok: true }` |
| `/push/test` | Sesión | Envía una notificación push de prueba | — | `200 { ok, sent, total }` |
| `/profile` | Sesión | Edita el perfil propio | `{ name?, note?, desc?, avatar?, chatAppearance?, privacy? }` | `200 { ok: true }`. `403 { error: "Solo puedes editar tu propio perfil." }`, `400` (límites: nombre 64, nota 500, descripción según `profileDescriptionCharacters`), `429` |
| `/notes` | Sesión | Guarda la nota personal (texto + fondo) | `{ data: { text, bg } }` — o `{}` para borrarla | `200 { ok: true }`. `400 { error: "Nota inválida." }`, `400 { error: "Nota demasiado grande." }` (>4096 caracteres) |
| `/send` | Sesión | Envía un mensaje 1:1 | `{ to, kind, data, hash?, gallery?, mime?, name?, caption?, once?, reply?, enc?, groupId?, inviteCode? }` | `200 { ok: true, message: { … } }`. `404 { error: "contact does not exist" }`, `200 { ok: false, blocked: true }`, `200 { ok: false, denied: true }`, `400`, `413`, `429` |
| `/seen` | Sesión | Marca como visto un mensaje de una sola vista (lo destruye) | `{ id }` | `200 { ok: true }`. `400 { ok: false }`, `404 { ok: false }`, `409 { ok: false, error: "Este mensaje no es de una sola vista." }` |
| `/receipt` | Sesión | Acuses de entrega/lectura | `{ status: "delivered" \| "read", ids: [ "<id>" ] }` (máx. 500) | `200 { ok: true }`. `400 { error: "Invalid receipt." }` |
| `/msg/delete` | Sesión | Borra un mensaje | `{ id }` | `200 { ok: true }` o `200 { ok: true, scope: "me" }` si quien borra es el destinatario (se oculta solo para él). `400 { ok: false }`, `404 { ok: false }` |
| `/msg/edit` | Sesión | Edita un mensaje de texto propio | `{ id, data, enc? }` | `200 { ok: true }`. `400 { ok: false }`, `403 { ok: false, error: "No puedes editar este mensaje." }`, `404 { ok: false }` |
| `/chat/delete` | Sesión | Borra una conversación (o varias) | `{ to }` o `{ peers: [...] }`, con `clearBoth: true` (vaciar para los dos) o `keepSummary: true` (dejar el chat en la lista) | `200 { ok: true, scope: "me" }` (borrar solo para mí), `200 { ok: true, scope: "both", cleared: [...] }` (vaciar para los dos: se borran los mensajes de verdad). `404 { error: "chat not found" }` |
| `/block` | Sesión | Bloquea o desbloquea a una cuenta (conmutador) | `{ target }` | `200 { ok: true, blocked: bool }`. `404 { error: "No disponible." }` |
| `/story` | Sesión | Publica una historia | `{ kind, text, bg, mime, data, hash?, enc?, keys? }` | `200 { ok: true }`. `400 { error: "Color inválido." }`, `400 { error: "Historia inválida: …" }`, `429` |
| `/story/like` | Sesión | Marca (o desmarca) "me gusta" en una historia ajena | `{ from, ts }` (`from` = autor, `ts` = marca de tiempo) | `200 { ok: true, liked, count }` o `200 { ok: false }` (no revela si la historia existe) |
| `/story/view` | Sesión | Registra que se ha visto una historia | `{ from, ts }` | `200 { ok: true }` o `200 { ok: false }` |
| `/story/edit` | Sesión | Edita el texto y el fondo de una historia propia (solo de tipo texto) | `{ ts, text, bg? }` | `200 { ok: true }`. `404 { error: "No es texto." }`, `400` |
| `/story/delete` | Sesión | Borra una historia propia | `{ ts }` | `200 { ok: true }`. `404 { ok: false }` |
| `/groups` | Sesión | Crea un grupo | `{ name, members?, description?, avatar?, visibility?, joinPolicy?, writePolicy?, addPolicy?, editPolicy?, mentionAllPolicy?, contentPolicy?, id? }` | `200` con el objeto de grupo. `400 { error: "Nombre inválido." }`, `400` si los miembros iniciales superan el tope (200), `403 { error: "Solo contactos." }`, `409 { error: "ID en uso." }` |
| `/groups/:id` | Sesión | Acciones sobre un grupo (ver §2.3) | según la acción | según la acción |
| `/messages` | Sesión | Página de mensajes de un chat 1:1 | `{ to, limit?, beforeId? }` (`limit` 1-200, por defecto 20) | `200 { messages: [ … ], more: bool }`. `404 { messages: [], more: false }` |
| `/call/log` | Sesión | Registra el cierre de una llamada | `{ callId, state?, duration? }` | `200 { ok: true, calls: [ … ] }` |

### 2.3 `POST /groups/:id`: catálogo de acciones

`POST /groups/:id` no es una ruta única: el **cuerpo decide la acción** (`src/http/router.js:296-592`).
Solo una acción por petición; si no se reconoce ninguna: `400 { error: "Acción no reconocida." }`.

| Acción (campo del cuerpo) | Descripción | Requisitos | Respuesta |
|---|---|---|---|
| `join: true` | Une al usuario al grupo | `inviteCode` si el grupo es privado; `joinPolicy` `open` o `request` | `200` con el grupo; `200 { ok: true, requested: true }` si la política es `request`; `400` si el grupo ya alcanzó el tope de miembros; `404 { error: "No disponible." }`; `403 { error: "Cerrado." }` |
| `cancelJoin: true` | Retira su solicitud de entrada | — | `200 { ok: true }`; `404 { error: "No disponible." }` |
| `seenMessage: "<id>"` | Marca como vista una historia de "una vez" del grupo | ser miembro; el mensaje debe ser `once` y de otro autor | `200 { ok: true }`; `403 { error: "No abrible." }`; `404 { error: "No existe." }` |
| `message: { … }` | Envía un mensaje al grupo | `kind` en la allowlist (ver abajo) | `200 { ok: true, message: { … } }`; `400`, `403 { error: "Desactivado." }`, `403 { error: "Solo admins." }`, `429` |
| `addMember: "<username>"` | Añade un contacto al grupo | `addPolicy: "all"` o ser admin | `200` con el grupo; `403 { error: "Solo admins." }`, `403 { error: "Solo contactos." }`, `404 { error: "No existe." }`, `400` si se supera el tope de miembros |
| `removeMember` / `removed: "<username>"` | Expulsa a un miembro | ser admin; no puede ser uno mismo **ni el propietario** | `200` con el grupo; `403 { error: "Solo admins." }`, `403 { error: "No se puede expulsar al propietario del grupo." }`, `400 { error: "Usa salir." }` |
| `leave: true` | Sale del grupo | ser miembro | `200` con el grupo; si el grupo se queda vacío, se elimina |
| `seenTs: <número>` | Marca el grupo como leído hasta esa marca de tiempo | ≥ 0 | `200 { ok: true, seenTs }` |
| `deleteGroup: true` | Elimina el grupo | ser admin | `200 { ok: true, deleted: true }`; `403 { error: "Solo admins." }` |
| `approveJoin` / `rejectJoin: "<username>"` | Aprobar o rechazar una solicitud de entrada | ser admin | `200` con el grupo; `403`, `404 { error: "No disponible." }` |
| `deleteMessage: "<id>"` | Borra un mensaje del grupo | autor o admin | `200 { ok: true }`; `403 { error: "Sin permiso." }`, `404 { error: "No existe." }` |
| `approveAdmin` / `removeAdmin: "<username>"` | Da o quita el rol de admin | ser admin; no puede quitarse el rol a sí mismo | `200` con el grupo; `400 { error: "No puedes quitarte tu propio rol." }`, `404 { error: "No está en el grupo." }` |
| `rename`, `description`, `avatar` | Cambia nombre (≤40), descripción (≤500) o avatar | `editPolicy: "all"` o ser admin | `200` con el grupo; `400 { error: "Nombre inválido." }` / `"Descripción inválida."` / `"Avatar inválido."`; `403 { error: "Solo admins." }` |
| `visibility`, `joinPolicy`, `writePolicy`, `addPolicy`, `editPolicy`, `mentionAllPolicy` | Cambia políticas | **`visibility`, `joinPolicy`, `addPolicy`, `editPolicy` y `mentionAllPolicy` son solo-admins** (reciben `403 { error: "Ese ajuste es solo para admins." }`); `editPolicy: "all"` ya no abre esos cinco campos a los miembros | `200` con el grupo; `400 { error: "<clave> inválido." }` |
| `contentPolicy` | Cambia la política por tipo de contenido | idem | `200` con el grupo; `400 { error: "contentPolicy inválido." }` |

Valores admitidos:

| Política | Valores |
|---|---|
| `visibility` | `public`, `private` |
| `joinPolicy` | `open`, `request`, `closed` |
| `writePolicy`, `addPolicy`, `editPolicy`, `mentionAllPolicy` | `all`, `admins` |
| `contentPolicy` (por tipo) | `all`, `admins`, `off` (solo para los tipos que no sean `text`) |

Tipos de contenido (`groupPolicies`, `src/groups/store.js:23-32`): `text`, `image`, `video`,
`audio`, `file`, `sticker`, `contact`, `poll`. En DM se admite además `group-invite`
(`src/chat/routes.js:141`).

**Mensaje de grupo** (`POST /groups/:id` con `message`): los campos son `id` (opcional),
`kind`, `data`, `hash`, `gallery`, `name`, `mime`, `caption`, `once`, `reply`, `enc`
(`e2` o `g2`). Para `image`/`video`/`audio`/`file` es obligatorio `hash` o `gallery`.

---

## 3. Objetos JSON principales

### 3.1 Mensaje

Construido en `src/chat/summaries.js:24-34` (`decorateForClient`) y `src/chat/messages.js:107-119`:

```jsonc
{
  "id": "uuid", "kind": "text", "ts": 1700000000000,
  "fromId": "uuid", "from": "alice",     // 'eliminado' si la cuenta ya no existe
  "toId": "uuid",   "to":   "bob",       // solo en DM
  "data": "texto",                       // '' cuando el contenido va cifrado
  "hash": "sha256-hex",                  // '' si no lleva adjunto
  "mime": "image/png", "name": "", "caption": "",
  "gallery": [ { "hash": "…", "mime": "image/png", "width": 800, "height": 600 } ],
  "once": false, "edited": false,
  "status": "sent|delivered|read", "readAt": 0,
  "reply": { "fromId": "…", "from": "…", "id": "…", "preview": "…" },
  "mentions": [ "uuid" ], "mentionLabels": { "uuid": "alice" },
  "mentionUsers": [ { "id": "uuid", "username": "alice" } ],
  "invite": { "groupId": "…", "code": "…", "name": "…", "members": [ … ] },
  "enc": "",                              // '' | 'e2' | 'g2'
  "signature": "…", "signingPublicKey": "…", "signatureValid": true
}
```

### 3.2 Grupo

`pub(g, viewerId)` (`src/groups/store.js:165-184`):

```jsonc
{
  "id": "g_xxx", "name": "…", "description": "…", "avatar": "",
  "members": [ "alice", "bob" ], "admins": [ "alice" ],
  "createdAt": 1700000000000,
  "visibility": "public|private", "joinPolicy": "open|request|closed",
  "writePolicy": "all|admins", "addPolicy": "all|admins", "editPolicy": "all|admins",
  "mentionAllPolicy": "all|admins",
  "contentPolicy": { "text": "all", "image": "all", … },
  "joinRequests": [ { "userId": "…", "username": "…", "ts": 0 } ],  // solo para admins
  "inviteCode": "…",   // solo para admins (undefined en el JSON si no)
  "keybox": { "recipient": "…", "by": "…", "iv": "…", "ct": "…", "ts": 0 }  // el del visor
}
```

### 3.3 Perfil y permisos

`GET /profile` (`src/profile/routes.js:33-86`) devuelve siempre `username` y `signingPublicKey`,
y un objeto `permisos` con siete banderas calculadas por la privacidad del dueño:

| Clave de `permisos` | Función de privacidad |
|---|---|
| `verFoto` | `foto` |
| `verNota` | `nota` |
| `verDescripcion` | `descripcion` |
| `verHistorias` | `historias` |
| `llamar` | `llamadas` |
| `escribir` | `mensajes` |
| `compartir` | `compartir` |

Cada función de privacidad tiene un modo (`src/users/privacy.js:20,23-32`): `server` (todo el
mundo; `all` se normaliza a `server`), `contacts`, `nobody`, `only` (contactos de la lista) y
`except` (contactos menos los de la lista). El bloqueo entre cuentas siempre gana a la regla
de privacidad.

El campo `id` (UUID interno) solo se entrega a la propia cuenta y a los contactos; servirlo a
cualquier sesión convertiría la ruta en un oráculo de enumeración de cuentas
(`src/profile/routes.js:52-54`).

### 3.4 Privacidad y `agregarme`

`POST /profile` acepta `privacy: { foto: { mode, users }, nota: { … }, … }`. Además, el campo
`privacy.agregarme.mode` (`all` | `request` | `nobody`) fija la política de "quién puede
agregarme" de la cuenta (`src/profile/routes.js:271-277`).

---

## 4. WebSocket

### 4.1 Endpoint y handshake

Endpoint: **`/ws`**, en el **mismo puerto** que el HTTP (`src/http/servers.js:33-34`).
La conexión es un WebSocket RFC 6455 sobre HTTP (`ws://` o `wss://`).

Requisitos del upgrade (`src/realtime/websocket.js:43-64`):

| Requisito | Si falla |
|---|---|
| Ruta `/ws` | `404 Not Found` |
| `Origin` con el mismo host que `Host` | `403 Forbidden` |
| `Upgrade: websocket`, `Sec-WebSocket-Version: 13`, `Sec-WebSocket-Key` | `400 Bad WebSocket Handshake` |
| Cookie `chatlocal_session` con sesión viva | `401 Unauthorized` |

Si todo es correcto, el servidor responde `101 Switching Protocols` con
`Sec-WebSocket-Accept`.

Límites por cuenta: `WS_MAX_PER_USER = 8` conexiones simultáneas; al superarlo se corta la
más antigua (`src/realtime/notify.js:19`, `src/realtime/websocket.js:68-72`).

Heartbeat: el servidor cierra cualquier socket que no haya enviado datos en **90 s**
(comprobación cada 15 s, `src/realtime/websocket.js:269-274`).

### 4.2 Framing

Implementación propia en `src/realtime/frames.js` (no se usa la librería `ws`).

**Qué es un frame WebSocket.** Cada mensaje de la aplicación va dentro de uno o varios frames
(unidades de datos del protocolo). Un frame tiene una cabecera con: bit `FIN`, opcode de 4
bits, bit `MASK` y longitud de payload en 7 bits (o 16 bits si vale 126, o 64 bits si vale 127).

**Reglas que impone el servidor** (`src/realtime/frames.js`):

| Regla | Código de cierre | Referencia |
|---|---|---|
| Todo frame del cliente debe ir **enmascarado** | `1002` | `frames.js:51` |
| Un frame de control (opcode ≥ 0x8) no puede ir fragmentado | `1002` | `frames.js:52` |
| Un frame de control no puede pasar de 125 bytes | `1002` | `frames.js:77` |
| Solo se aceptan mensajes de **texto** (opcode `0x1`); el binario (`0x2`) se rechaza | `1003` | `frames.js:90` |
| Opcode reservado | `1002` | `frames.js:113` |
| Longitud del payload o del mensaje ensamblado > **256 KiB** (`MAX_FRAME_BYTES = 262144`) | `1009` | `frames.js:62,66,99` |
| Más de **4096** fragmentos por mensaje (`MAX_FRAGMENTS`) | `1009` | `frames.js:100` |
| Buffer de entrada acumulado > **768 KiB** (`MAX_BUFFER_BYTES = 786432`) | `1009` | `frames.js:45`, `websocket.js:95` |
| Exceso de tráfico (token bucket) | `1008` | `websocket.js:110-116` |
| Error al procesar un frame | `1011` | `websocket.js:242-248` |

**Ensamblado de fragmentos.** Un mensaje fragmentado llega como un frame inicial con `FIN = 0`
(opcode `0x1`) seguido de frames de continuación (opcode `0x0`). El servidor guarda los trozos
en `socket._wsFrag` y los concatena **solo cuando llega el frame con `FIN = 1`**
(`frames.js:91-112`). El tamaño acumulado se lleva en O(1) (`frag.size`) para no bloquear el
event loop con un mensaje de 256 KiB partido en miles de trozos (`frames.js:94-100`).
Una continuación sin mensaje inicial es un error de protocolo (`1002`).

**Frames de control.** El servidor responde al `ping` del cliente con un `pong` de la misma
longitud (`frames.js:84-87`) y al `close` con un frame de cierre del mismo código
(`frames.js:78-83`). El `pong` del cliente se ignora.

**Dirección servidor → cliente.** El servidor escribe frames de **texto sin máscara** (`0x81`),
con la longitud en 7, 16 o 64 bits según el tamaño (`textFrameHead`, `src/realtime/notify.js:24-30`).
Si un cliente lento acumula más de **1 MiB** pendientes (`WS_MAX_BACKLOG_BYTES`), se le corta
la conexión (`src/realtime/notify.js:22,34,47`).

**Tráfico.** Token bucket por conexión: **200 frames/s** sostenidos (`WS_FRAME_RATE`) con una
ráfaga inicial de **600** (`WS_FRAME_BURST`) (`src/realtime/notify.js:20-21`,
`src/realtime/websocket.js:107-117`). Superar la cuota cierra la conexión con `1008`.

### 4.3 Formato de los mensajes

Cada mensaje es un objeto JSON con un campo **`type`** que identifica el evento. Los tipos
desconocidos se ignoran silenciosamente; un JSON inválido también (`src/realtime/websocket.js:118-119`).

Antes de procesar nada, el servidor descarta el frame si `to`, `callId` o `groupId` no son
cadenas (`src/realtime/websocket.js:124-126`).

### 4.4 Tipos que acepta el servidor (cliente → servidor)

| `type` | Campos | Qué hace |
|---|---|---|
| `call-offer` | `to`, `callId`, `video?` | Inicia una llamada. Si el destinatario está bloqueado o no permite llamadas, responde con `call-blocked` / `call-denied`; si no contesta en 30 s, ambos pasan a `missed` |
| `call-busy` | `to`, `callId` | Marca la llamada como ocupada y lo reenvía al par |
| `call-accept` | `to`, `callId` | Acepta la llamada (estado `active`) |
| `call-reject` | `to`, `callId` | Rechaza la llamada (estado `rejected` / `missed` en el par) |
| `call-cancel` | `to`, `callId` | Cancela la llamada antes de que arranque |
| `call-end` | `to`, `callId` | Cierra la llamada |
| `call-sdp` | `to`, `callId`, `sdp` | Reenvía la oferta/respuesta SDP al par |
| `call-ice` | `to`, `callId`, `candidate` | Reenvía un candidato ICE al par |
| `call-mute` | `to`, `callId`, `muted` | Reenvía el estado de micrófono al par |
| `typing` | `to`, `on` | Indica que el usuario está escribiendo |
| `recording` | `to`, `on` | Indica que el usuario está grabando audio |
| `group-typing` | `groupId`, `on` | Igual que `typing`, pero dentro de un grupo (se emite como `typing` con `group: true`) |
| `group-recording` | `groupId`, `on` | Igual que `recording`, pero dentro de un grupo |
| `privacy` | `privacy`, `name?`, `note?`, `desc?`, `avatar?` | Actualiza la privacidad y el perfil. La matriz de privacidad se **fusiona**, no se sustituye |
| `ping` | — | Keep-alive; el servidor responde `pong` |

Tipos aceptados: **15**.

### 4.5 Tipos que emite el servidor (servidor → cliente)

| `type` | Campos | Cuándo |
|---|---|---|
| `users` | `users: [ { id, username, online, lastSeen } ]` | Cambio en la lista de usuarios/contactos (`src/realtime/notify.js:78,77,81`) |
| `stories` | `stories: [ … ]` | Historias actualizadas (`src/realtime/notify.js:132`) |
| `contact-requests` | `count`, `sentCount` | Cambian las solicitudes de contacto (`src/realtime/notify.js:86`) |
| `contact-request-accepted` | `username` | Alguien acepta tu solicitud (`src/contacts/routes.js:115`) |
| `profile` | `username` | Cambia un perfil (`src/profile/routes.js:303`) |
| `blocked-change` | `by`, `blocked` | Alguien te bloquea o desbloquea (`src/contacts/routes.js:147`) |
| `message` | `message: { … }` | Mensaje nuevo 1:1 (`src/chat/routes.js:206-207`) |
| `poll-update` | `message`, `groupId` | Voto en una encuesta (`src/chat/routes.js:117-119`) |
| `seen` | `id`, `readAt`, `signature`, `signingPublicKey`, `signatureValid` | Mensaje de una sola vista destruido (`src/chat/routes.js:241-242`) |
| `receipt` | `ids`, `status`, `readAt` | Acuse de entrega o lectura (`src/chat/routes.js:282`) |
| `msgDelete` | `id` | Mensaje borrado (`src/chat/routes.js:307`) |
| `msgEdit` | `id`, `data`, `enc`, `signature`, `signingPublicKey`, `signatureValid` | Mensaje editado (`src/chat/routes.js:341-345`) |
| `chatDelete` | `peer` | Conversación borrada (`src/chat/routes.js:379`) |
| `typing` | `from`, `on`, `group?`, `groupId?` | Indicador de escritura (`src/realtime/websocket.js:169,180`) |
| `recording` | `from`, `on`, `group?`, `groupId?` | Indicador de grabación (`src/realtime/websocket.js:169,180`) |
| `group` | `group: { … }` | El grupo cambió (miembros, políticas) (`src/groups/routes.js:102`, `src/http/router.js:324`) |
| `group-message` | `groupId`, `message` | Mensaje nuevo en un grupo (`src/http/router.js:427`) |
| `group-message-delete` | `groupId`, `messageId` | Mensaje de grupo borrado (`src/http/router.js:543`) |
| `group-message-seen` | `groupId`, `messageId`, `signature`, `signingPublicKey`, `signatureValid` | Historia de una sola vista vista en el grupo (`src/http/router.js:344-348`) |
| `group-left` | `groupId` | Alguien salió del grupo o el grupo se eliminó (`src/http/router.js:467,483,514`) |
| `group-request` | `groupId` | Hay una solicitud de entrada pendiente (`src/http/router.js:316`) |
| `group-request-rejected` | `groupId` | Tu solicitud de entrada fue rechazada (`src/http/router.js:523`) |
| `call-incoming` | `from`, `video`, `callId` | Llamada entrante (`src/realtime/websocket.js:82,142`) |
| `call-accepted` | `from`, `callId` | La otra parte acepta (`src/realtime/websocket.js:218`) |
| `call-rejected` | `from`, `callId` | La otra parte rechaza (`src/realtime/websocket.js:225-228`) |
| `call-cancelled` | `from`, `callId` | La otra parte cancela (`src/realtime/websocket.js:225-228`) |
| `call-ended` | `from`, `callId` | La otra parte cuelga (`src/realtime/websocket.js:225-228`) |
| `call-busy` | `from`, `callId` | La otra parte está ocupada (`src/realtime/websocket.js:163`) |
| `call-missed` | `from`, `callId` | Llamada no atendida (`src/realtime/websocket.js:154-155`) |
| `call-blocked` | `from`, `callId` | El destinatario te tiene bloqueado (`src/realtime/websocket.js:137-138`) |
| `call-denied` | `from`, `callId` | La privacidad no permite llamadas (`src/realtime/websocket.js:139`) |
| `call-log` | `call: { … }` | Entrada en tu registro de llamadas (`src/realtime/websocket.js:143`) |
| `call-sdp` | `from`, `callId`, `sdp`, `candidate`, `muted` | Reenvío de SDP (`src/realtime/websocket.js:234`) |
| `call-ice` | `from`, `callId`, `candidate` | Reenvío de candidato ICE (`src/realtime/websocket.js:234`) |
| `call-mute` | `from`, `callId`, `muted` | Estado de micrófono (`src/realtime/websocket.js:234`) |
| `pong` | `ts` | Respuesta a `ping` (`src/realtime/websocket.js:239`) |

Un mismo evento `type` puede tener semántica distinta según el sentido: `typing` y
`recording` se usan en los dos; `call-busy` también.

### 4.6 Ejemplos

```jsonc
// cliente → servidor
{ "type": "typing", "to": "bob", "on": true }
{ "type": "call-offer", "to": "bob", "callId": "c-42", "video": true }
{ "type": "call-sdp", "to": "bob", "callId": "c-42", "sdp": { "type": "offer", "sdp": "…" } }
{ "type": "group-typing", "groupId": "g_abc", "on": true }
{ "type": "ping" }

// servidor → cliente
{ "type": "message", "message": { "id": "…", "kind": "text", "from": "alice", "data": "hola", "ts": 1700000000000 } }
{ "type": "typing", "from": "alice", "on": true }
{ "type": "call-incoming", "from": "alice", "video": true, "callId": "c-42" }
{ "type": "pong", "ts": 1700000000000 }
```

### 4.7 Cifrado de frames

El upgrade no cambia: el cifrado es una negociación posterior dentro del WebSocket. El
cliente envía como primer frame de texto, **en claro**:

```json
{ "type": "enc", "ephemeral": "<32 bytes base64>" }
```

El servidor comprueba que la clave mida 32 bytes, deriva la clave de la conexión con HKDF en
el dominio `zlapy-transport-v1/ws` y responde `{"type":"enc-ok"}` ya cifrado. Desde ese
momento:

- Cada frame de texto, en ambas direcciones, es `z1:<base64>`.
- El cuerpo es `ciphertext ‖ HMAC-SHA256`, con el mismo esquema que el sobre HTTP.
- El nonce es un contador de 32 bits little-endian por sentido seguido de la etiqueta ASCII
  `zlapyC2S` (cliente → servidor) o `zlapyS2C` (servidor → cliente).
- El AAD es `zlapy-transport-v1|WS|<C2S|S2C>|<contador>`.
- Los frames que no empiezan por `z1:` se descartan; no cierran la conexión.
- Si el saludo no es válido, el servidor no responde y la conexión sigue en claro. Un cliente
  que nunca envía el saludo sigue funcionando sin cifrado (compatibilidad).

Los contadores son independientes por dirección y se cortan en `0xFFFFFFFF`. La clave es por
conexión: cada reconexión usa una efímera nueva.

Ejemplo de la forma de un frame cifrado (el contenido no es real):

```
z1:q83v…base64…==
```

La implementación está en `src/realtime/encrypted.js` y `public/transport.js`; el detalle
criptográfico, en
[`docs/CRIPTOGRAFIA.md`](CRIPTOGRAFIA.md#116-websocket-cifrado).

---

## 5. Errores

### 5.1 Formato

El servidor responde con JSON. El formato habitual de error es:

```json
{ "error": "mensaje legible" }
```

Dos excepciones, ambas en `src/http/router.js`:

- JSON malformado o cuerpo que no es un objeto → `400 {}` (objeto vacío, **sin** clave `error`)
  (`src/http/router.js:194-195`).
- Ruta `POST` desconocida → `404 {}` (`src/http/router.js:601`).

### 5.2 Ejemplos reales tomados del código

| Código | Mensaje | Origen |
|---|---|---|
| 400 | `cross-origin request rejected` (403 en realidad) | `src/http/router.js:132` |
| 400 | `Contenido demasiado grande.` | `src/http/router.js:178,193` |
| 400 | `Invalid username or password.` | `src/auth/routes.js:78` |
| 400 | `Cuenta inválida.` | `src/auth/routes.js:180` |
| 400 | `id inválido` | `src/http/router.js:127,128,201,202,298,299` |
| 400 | `Nombre inválido.` | `src/groups/routes.js:71` |
| 400 | `Descripción inválida.` | `src/http/router.js:566` |
| 400 | `Avatar inválido.` | `src/http/router.js:570` |
| 400 | `Tipo inválido.` | `src/http/router.js:356`, `src/chat/routes.js:143` |
| 400 | `Falta hash.` | `src/http/router.js:366`, `src/chat/routes.js:145` |
| 400 | `Hash inválido.` | `src/http/router.js:401`, `src/chat/routes.js:158` |
| 400 | `Archivo inválido.` | `src/http/router.js:403`, `src/chat/routes.js:159` |
| 400 | `Archivo no disponible.` | `src/http/router.js:404`, `src/chat/routes.js:163` |
| 400 | `Galería inválida.` | `src/http/router.js:365`, `src/chat/routes.js:150` |
| 400 | `Sticker inválido.` | `src/http/router.js:367`, `src/chat/routes.js:137` |
| 400 | `Contacto inválido.` | `src/http/router.js:370` |
| 400 | `Encuesta inválida.` | `src/http/router.js:374` |
| 400 | `Mensaje inválido.` | `src/http/router.js:353` |
| 400 | `Opción de encuesta inválida.` | `src/chat/routes.js:104` |
| 400 | `Invalid receipt.` | `src/chat/routes.js:249` |
| 400 | `stickers must be an array` | `src/stickers/routes.js:53` |
| 400 | `Contraseña actual requerida.` | `src/profile/routes.js:99` |
| 400 | `Contraseña 8-128.` | `src/profile/routes.js:105` |
| 400 | `Usuario inválido.` | `src/profile/routes.js:103` |
| 400 | `Nota inválida.` | `src/profile/routes.js:316` |
| 400 | `Nota demasiado grande.` | `src/profile/routes.js:320` |
| 400 | `Apariencia inválida.` | `src/profile/routes.js:269` |
| 400 | `Color inválido.` | `src/stories/routes.js:40,135` |
| 400 | `Preferencia de chat inválida.` | `src/chat/routes.js:75` |
| 400 | `Endpoint de push no permitido.` | `src/push/routes.js:24` |
| 400 | `Búsqueda demasiado larga.` | `src/stickers/routes.js:31` |
| 400 | `Acción no reconocida.` | `src/http/router.js:673` |
| 401 | `authentication required` | `src/http/router.js:90,122,281` |
| 401 | `Invalid username or password.` | `src/auth/routes.js:122,193` |
| 401 | `Usuario o contraseña incorrectos.` | `src/auth/routes.js:234` |
| 401 | `Sesión no disponible.` | `src/auth/routes.js:267,273` |
| 401 | `Cuenta no disponible.` | `src/auth/routes.js:268,280` |
| 401 | `Contraseña incorrecta.` | `src/profile/routes.js:208` |
| 403 | `cross-origin request rejected` | `src/http/router.js:132` |
| 403 | `Solo admins.` | `src/http/router.js:359,439,502,518,547,560` |
| 403 | `Solo contactos.` | `src/http/router.js:442`, `src/groups/routes.js:73` |
| 403 | `no eres miembro` | `src/http/router.js:205` |
| 403 | `Desactivado.` | `src/http/router.js:358` |
| 403 | `Cerrado.` | `src/http/router.js:309` |
| 403 | `No abrible.` | `src/http/router.js:339` |
| 403 | `Sin permiso.` | `src/http/router.js:535` |
| 403 | `No puedes editar este mensaje.` | `src/chat/routes.js:329` |
| 403 | `No puedes invitar.` | `src/chat/routes.js:188` |
| 403 | `Invitación inválida.` | `src/chat/routes.js:189` |
| 403 | `Bloqueo activo.` | `src/contacts/routes.js:61,108` |
| 403 | `No acepta contactos.` | `src/contacts/routes.js:69` |
| 403 | `Solo puedes editar tu propio perfil.` | `src/profile/routes.js:246` |
| 403 | `Contraseña incorrecta.` | `src/profile/routes.js:101` |
| 404 | `avatar not found` | `src/http/router.js:80,85` |
| 404 | `no existe` | `src/http/router.js:130,204,301,333` |
| 404 | `No existe.` | `src/http/router.js:337,441,532,534` |
| 404 | `No disponible.` | `src/http/router.js:308,328,520`, `src/contacts/routes.js:84,92,101,103,121` |
| 404 | `No está en el grupo.` | `src/http/router.js:549` |
| 404 | `contact does not exist` | `src/chat/routes.js:126` |
| 404 | `chat not found` | `src/chat/routes.js:363,366` |
| 404 | `No account found.` | `src/contacts/routes.js:57` |
| 404 | `Encuesta no disponible.` | `src/chat/routes.js:89` |
| 409 | `Username is already taken.` | `src/auth/routes.js:79,85` |
| 409 | `Usuario ocupado.` | `src/profile/routes.js:114` |
| 409 | `ID en uso.` | `src/groups/routes.js:84` |
| 409 | `No se pudo guardar el perfil. Elige otro nombre de usuario.` | `src/profile/routes.js:165` |
| 409 | `No se pudieron guardar los ajustes.` | `src/profile/routes.js:182` |
| 409 | `Este mensaje no es de una sola vista.` | `src/chat/routes.js:219` |
| 413 | `Contenido demasiado grande.` | `src/chat/routes.js:135` |
| 429 | `Límite alcanzado: máximo <MESSAGE_RATE_LIMIT> mensajes por minuto.` (30 por defecto) | `src/http/helpers.js:31` |
| 429 | `Límite alcanzado: máximo 30 búsquedas de stickers por minuto.` | `src/http/helpers.js:43` (vía `src/stickers/routes.js:26`) |
| 429 | `Demasiados registros desde esta red. Prueba más tarde.` | `src/auth/routes.js:70` |
| 429 | `Too many login attempts.` | `src/auth/routes.js:127` |
| 429 | `Demasiados intentos. Espera un momento e inténtalo de nuevo.` | `src/auth/routes.js:157` |
| 500 | `Error interno del servidor.` | `src/http/router.js:604` |
| 500 | `No se pudo crear la cuenta.` | `src/auth/routes.js:107` |
| 502 | `Giphy no disponible.` | `src/stickers/routes.js:43` |
| 503 | `Stickers no configurados.` | `src/stickers/routes.js:27` |
| 503 | `database unavailable` | `src/meta/routes.js:31` |

### 5.3 Códigos con la cabecera `Retry-After`

`429` incluye `Retry-After` en segundos (`src/http/helpers.js:30,42`) y, en el caso del
límite de mensajes, también el campo `retryAfter` en el cuerpo.

---

## 6. Notas y detalles que sorprenden

- **`GET /users` y `GET /contacts` devuelven exactamente lo mismo**: `{ users: [...] }` con la
  cuenta propia y sus contactos (`src/http/router.js:112-113`). No es la lista de contactos
  completa.
- **`GET /groups` devuelve un array JSON desnudo**, sin envoltorio (`src/groups/routes.js:51`),
  a diferencia del resto de rutas de listado.
- **`POST /auth/switch` es "pública" en el enrutador** (`publicAuthPost`, `src/http/router.js:120`)
  pero en la práctica necesita la cookie `chatlocal_account_<uuid>` de la cuenta a la que se
  quiere cambiar. Esa cookie lleva una sesión **propia**, distinta de la principal
  (`src/auth/sessions.js`): al cambiar de cuenta se revocan las sesiones de la cuenta
  abandonada y acto seguido se le emite una sesión vinculada nueva, de modo que se puede volver
  a ella sin volver a iniciar sesión. Si la cookie caducó o el navegador la perdió, la respuesta
  es `401 { error: "Sesión no disponible.", relogin: true }`: la cuenta **sigue existiendo**, así que
  el cliente la conserva en la lista y explica que hay que volver a agregarla con «Agregar
  cuenta» (no pide la contraseña). Solo cuando la cuenta ya no está en la base responde
  `401 { error: "Cuenta no disponible.", gone: true }` y el cliente la quita de la lista.
- **`POST /auth/logout` revoca todas las cuentas del navegador**, no solo la actual
  (`src/auth/routes.js:309-331`).
- **Los identificadores de remitente los impone el servidor.** En `/send`, `/receipt`,
  `/chat/delete`, `/block` y `/messages` se fuerza `data.from = actor`; en `/profile`, `/notes`,
  `/push/*`, `/call/log`, `/account/delete` y `/stickers` se fuerza `data.username = actor`; en
  `/story`, `/story/delete` y `/story/edit` se fuerza `data.from = actor`; en `/story/view` y
  `/story/like` se fuerza `data.viewer = actor` (`src/http/router.js:235-242`).
- **`POST /story/like` y `POST /story/view` no distinguen "no existe" de "no me la dejan ver"**:
  ambos devuelven `200 { ok: false }` para no servir de oráculo de existencia
  (`src/stories/routes.js:80-82`).
- **`POST /msg/delete` es global solo para el autor**; el destinatario lo oculta solo para sí
  (`scope: "me"`, `src/chat/routes.js:295-298`).
- **`POST /chat/delete` sin `clearBoth` es "borrar para mí"**: la conversación y los adjuntos
  siguen existiendo para la otra parte. Con `clearBoth: true` ("vaciar chat") los mensajes se
  borran de verdad para los dos, se limpian los dos resúmenes y se avisa a la otra parte por
  WebSocket (`type: "chat-cleared"`).
- **`GET /blob/:hash` devuelve el contenido en `text/plain`**, no binario: lo que se guarda es
  un data-URL (`src/chat/media.js:22-30`, `src/chat/routes.js:35-49`).
- **Los adjuntos se referencian por hash SHA-256 del contenido** y el acceso se decide por
  conversación, grupo o historia: conocer el hash no basta para leer el archivo
  (`src/chat/media.js:38-49`).
- **La cookie de avatar por nombre de usuario** no es pública: `/avatar/:user.svg` exige sesión.
- **No existe ninguna ruta con `match` en el cuerpo ni rutas tipo `/groups/:id/members/:uuid`.**
  La gestión de miembros de un grupo se hace con las acciones `addMember` / `removeMember` /
  `approveAdmin` / `removeAdmin` de `POST /groups/:id` (§2.3). Las únicas rutas con parámetros
  en la URL son `/avatar/:user.svg`, `/blob/:hash`, `/groups/:id`, `/groups/:id/messages` y
  `/groups/:id/groupkey`.

# API de Zlapy

Contrato HTTP y WebSocket del servidor. El enrutador y los módulos de cada
dominio son la referencia final.

## 1. Convenciones

- Puerto compartido para HTTP, HTTPS, estáticos y `/ws`: **1820** por defecto.
- JSON salvo adjuntos, avatares y sobres cifrados.
- `GET` para lectura y `POST` para acciones. `OPTIONS` responde 204; otros
  métodos, 405.
- Las respuestas JSON usan `Cache-Control: no-store` y cabeceras de seguridad.

### Autenticación

| Cookie | Uso |
| --- | --- |
| `zlapy_session` | JWT HS256 de la cuenta activa, `HttpOnly` y `SameSite=Lax`. |
| `zlapy_account_<uuid>` | JWT independiente de una cuenta vinculada en el mismo navegador. |

No hay tabla de sesiones. Cada token se valida por firma, caducidad, checksum
(`id | username | password_hash | rid`) y marcas de revocación. `Secure` depende
del canal y de la configuración TLS. La sesión normal dura 30 días; una emitida
por HTTP desde otra máquina, 8 horas por defecto.

Son públicos `/config`, `/healthz`, `/auth/session`, `/push/vapid`, los avatares
push, los estáticos y los POST `/auth/register`, `/auth/login`, `/auth/logout` y
`/auth/switch`. El resto exige sesión, incluido `/avatar/:user.svg`.

### Origen y cuerpos

Los POST comprueban que `Origin` tenga el mismo host que `Host` y rechazan
`Sec-Fetch-Site: cross-site`. Un cuerpo vacío equivale a `{}`; si hay contenido,
debe ser un objeto JSON válido.

| Cuerpo | Tope predeterminado |
| --- | ---: |
| General | `MAX_HTTP_BODY_BYTES`, 32 MiB |
| Autenticación | 8 KiB |
| `POST /key` | 64 KiB |
| `data` de mensaje | `MAX_MESSAGE_DATA_CHARS` |
| Medio en línea de mensaje/historia | `MAX_INLINE_MEDIA_CHARS` / `STORY_INLINE_CHAR_LIMIT` |
| Adjuntos | 512 MiB por cuenta y 20 GiB globales |

Superar el cuerpo máximo devuelve 413. Los límites de frecuencia devuelven 429
con `Retry-After`.

### Errores

| Código | Uso |
| --- | --- |
| 400 | Entrada inválida o error marcado con `statusCode/status=400` o `BAD_REQUEST`. |
| 401 | Sesión ausente/inválida o credenciales incorrectas. |
| 403 | Origen, rol, política, privacidad o bloqueo no permite la acción. |
| 404 | Recurso inexistente o no visible para quien pregunta. |
| 409 | Conflicto de identidad o estado. |
| 413 | Cuerpo, contenido o cuota por encima del límite. |
| 429 | Frecuencia agotada. |
| 500 | Excepción inesperada: `{ "error": "Error interno del servidor." }`. |
| 502 | Upstream de Giphy no disponible. |
| 503 | Base no disponible, TLS requerido o auth_key ilegible con la llave actual. |

Los fallos síncronos y los rechazos `async` siguen la misma clasificación y no
exponen `error.message` al cliente.

### Frecuencia predeterminada

Los valores se configuran con `RATE_LIMIT_<NOMBRE>_PER_MINUTE`.

| Ámbito | Por minuto |
| --- | ---: |
| API autenticada / pública por IP / autenticación por IP | 600 / 300 / 60 |
| Mensajes | 30 por cuenta |
| Giphy / creación de stickers | 30 / 10 |
| Perfil / regeneración de clave | 10 / 5 |
| Historias / vistas y likes | 15 / 60 |
| Contactos / creación de grupos | 20 / 10 |
| Ofertas de llamada / preferencias de chat | 5 / 20 |
| Verificación de contraseña / subida de clave | 5 / 30 |
| Recibos / reacciones | 120 / 120 |

`/healthz` y los estáticos no consumen la cota base. Registro y login añaden
frenos propios por IP y cuenta.

## 2. Sobre cifrado HTTP

`/config` y `/healthz` publican `transportAlgorithm` y `transportPublicKey`.
Un POST cifrado usa `X-Zlapy-Enc: x25519-chacha20-hmac-v1` y estas cabeceras:

| Cabecera | Contenido |
| --- | --- |
| `X-Zlapy-Ephemeral` | Clave pública X25519 efímera, 32 bytes en base64. |
| `X-Zlapy-Nonce` | Nonce de 12 bytes. |
| `X-Zlapy-Time` | Milisegundos; se admite una desviación de ±60 s. |
| `Content-Type` | `application/octet-stream`. |

La respuesta usa `X-Zlapy-Resp-Nonce`. El AAD liga método, ruta, tiempo y, en la
respuesta, estado. Nonce, HMAC, tiempo y formato se validan antes de procesar el
JSON; la memoria anti-replay está acotada.

Esta capa no cifra cabeceras, cookies ni GET y no autentica al servidor: **no
sustituye HTTPS**. Consulta [Criptografía](CRIPTOGRAFIA.md#7-canal-http).

## 3. Rutas GET

| Ruta | Auth | Respuesta y parámetros principales |
| --- | --- | --- |
| `/config` | Pública | Límites del cliente, versión y clave pública de transporte. |
| `/healthz` | Pública | `GET`/`HEAD`: salud de ambas bases, esquema, versión, uptime y transporte; 503 si alguna falla. |
| `/auth/session` | Pública | `{authenticated:true,user,linked}` o `{authenticated:false}`. Sin sesión viva no devuelve `gone` ni limpia cookies por UUID. |
| `/push/vapid` | Pública | `{publicKey}`. |
| `/avatar/push/:user.svg` | Pública | Identicon de persona o grupo sin revelar si existe. |
| `/avatar/push/t/:token.jpg` | Pública | Miniatura push asociada a un token no adivinable; 404 si no existe. |
| `/avatar/:user.svg` | Sesión | Identicon SVG de cuenta o grupo; alias opaco solo con relación autorizada. |
| `/users`, `/contacts` | Sesión | Sin parámetros: `{users,more:false,total}`. Con `q`, `limit`, `offset`: página de usuarios. |
| `/contacts/requests` | Sesión | Solicitudes recibidas. |
| `/contacts/requests/sent` | Sesión | Solicitudes enviadas. |
| `/groups/requests` | Sesión | Solicitudes de entrada enviadas por la cuenta. |
| `/have?hash=<sha256>` | Sesión | `ok` como indicador de existencia y autorización del blob; no es un booleano garantizado. |
| `/chats/summary` | Sesión | Resúmenes DM con último elemento y no leídos. |
| `/stories` | Sesión | Historias visibles para quien pregunta. |
| `/key?username=<propio>` | Sesión | Clave pública de la cuenta propia, o `null`. |
| `/groups` | Sesión | **Array** de grupos propios, sin `inviteCode`. |
| `/groups/discover` | Sesión | `{groups,more}`; `q` ≤100, `limit` 1–50 y `offset` 0–10000. |
| `/groups/:id` | Sesión | Grupo si se es miembro; `light=1` evita mensajes. `membersLimit` recorta la primera página. |
| `/groups/:id/messages` | Sesión | `{messages,more}`; `beforeId` y `limit` (30 inicialmente). |
| `/groups/:id/members` | Sesión | `{members,total,offset,more}`; `limit` ≤100 y `offset`. |
| `/calls` | Sesión | Historial de llamadas, filtrando pares bloqueados. |
| `/stickers` | Sesión | Favoritos de la cuenta. |
| `/stickers/discover` | Sesión | `{stickers,hasMore}`; filtros `tags`, `prefix`, `q`, `offset`, `limit`. |
| `/stickers/blob/:hash` | Sesión | Bytes WebP/GIF con su `Content-Type` correspondiente, o 404. |
| `/stickers/bbot-v3/:exp.webp` | Sesión | Sticker local por expresión. |
| `/giphy/search` | Sesión | Proxy Giphy; `q` ≤100, `offset`, `limit`. Timeout de 8 s. |
| `/blob/:hash` | Sesión | Data-URL del adjunto si la relación autoriza el hash; 404 en caso contrario. |
| `/chat/preferences` | Sesión | `{mutedPeers:[…]}`. |
| `/account/chat-settings` | Sesión | Apariencia y preferencias de chat de la cuenta. |
| `/profile?username=<cuenta>` | Sesión | Perfil con privacidad, presencia y claves públicas permitidas. |
| `/notes` | Sesión | Nota personal o `{data:null,expired:true}`. |

Los estáticos de `public/` se sirven sin sesión; `.html`, `.js`, `.css` y
`.webmanifest` no se cachean.

## 4. Rutas POST

El servidor impone el actor autenticado en `from`, `username` o `viewer` según la
ruta; esos campos nunca se confían al cliente.

| Ruta | Cuerpo y resultado principal |
| --- | --- |
| `/auth/register` | `{username,password,name?}` → 201 + cookie. Usuario 3–24 y contraseña 8–128; 409 si está ocupado. |
| `/auth/login` | `{username,password}` → 200 + cookie; 401 uniforme si falla. |
| `/auth/add-account` | Credenciales y `expectedAccountId` opcional → cookie vinculada. |
| `/auth/switch` | `{accountId,username?}` cambia la cuenta sin cerrar otros dispositivos. `relogin` si la cookie caducó; `gone` solo con sesión vigente. |
| `/auth/account/remove` | `{accountId}` elimina la vinculación local, no la cuenta ni otras sesiones. |
| `/auth/logout` | Limpia cookies y sockets de este navegador, sin rotar rid ni cerrar otros dispositivos. |
| `/key` | `{pubKey}` guarda la clave pública propia. |
| `/groups` | Crea grupo con nombre, miembros/contactos, políticas, `id` y `customId` opcionales. |
| `/groups/:id/groupkey` | `{recipients:[{recipient,iv,ct}]}` publica keyboxes autorizados. |
| `/groups/:id` | Ejecuta una acción del catálogo siguiente. |
| `/messages` | `{to,limit?,beforeId?}` pagina un DM; límite máximo 200. |
| `/send` | Envía DM con `to`, `kind`, `data` y metadatos/adjuntos permitidos. |
| `/seen` | `{id}` consume un mensaje de una sola vista. |
| `/receipt` | `{status:'delivered'|'read'|'played',ids:[…]}`; hasta 500 ids. |
| `/msg/edit` | `{id,data,enc?}` edita texto propio. |
| `/msg/delete` | `{id}`: borrado global para autor; oculto para destinatario. |
| `/message/reaction` | `{messageId,emoji?,groupId?}` alterna una reacción. |
| `/poll/vote` | `{messageId,optionId}` vota o retira voto. |
| `/chat/delete` | `{to}` o `{peers:[…]}`; `clearBoth` vacía para ambos, `keepSummary` conserva la entrada. |
| `/chat/preferences` | `{peer,muted}` cambia el silencio. |
| `/contacts` | `{username}` crea contacto o solicitud según la política del destino. |
| `/contacts/remove` | `{username}` elimina la relación. |
| `/contacts/cancel` | `{username}` cancela una solicitud enviada. |
| `/contacts/respond` | `{username,accept}` acepta o rechaza una recibida. |
| `/block` | `{target}` alterna bloqueo; al bloquear rompe contacto y solicitudes. |
| `/profile` | Edita nombre, nota, descripción, avatar, apariencia y privacidad propia. |
| `/account/profile` | `{currentPassword,username?,password?}` cambia identidad o contraseña y reemite sesión. |
| `/account/chat-settings` | `{settings}` guarda apariencia. |
| `/account/regenerate-key` | `{password}` recifra con una nueva auth_key; devuelve `{keyId,reencrypted}`. |
| `/account/delete` | `{password}` borra irreversiblemente la cuenta. |
| `/notes` | `{data:{text,bg}}` guarda nota; `{}` la elimina. |
| `/story` | Publica historia con `kind`, texto/fondo y medio o hash autorizado. |
| `/story/like` | `{from,ts}` alterna like; `ok:false` uniforme si no está disponible. |
| `/story/view` | `{from,ts}` devuelve `ok:false` si la historia no está disponible en RAM; si existe, responde `ok:true` y añade el visor solo cuando la privacidad lo permite. |
| `/story/edit` | `{ts,text,bg?}` edita una historia de texto propia. |
| `/story/delete` | `{ts}` elimina una historia propia. |
| `/stickers` | `{stickers:[…]}` reemplaza favoritos, máximo 30. |
| `/stickers/create` | `{data,hash?,publish?,tags?}` guarda sticker; publicar exige `publish:true`, etiquetas y procedencia propia. |
| `/push/subscribe` | `{sub:{endpoint,keys:{p256dh,auth}}}` registra un endpoint permitido. |
| `/push/unsubscribe` | `{endpoint}` elimina la suscripción. |
| `/push/test` | Envía una prueba; `{ok,sent,total}`. Los envíos tienen timeout de 5 s. |
| `/call/log` | `{callId,state?,duration?}` registra cierre de llamada. |

## 5. Acciones de `POST /groups/:id`

Solo una acción por petición. Si ninguna coincide, responde 400.

| Campo | Efecto |
| --- | --- |
| `join:true` | Entra por grupo público o `inviteCode`; con política `request` crea solicitud. |
| `cancelJoin:true` | Cancela la solicitud propia. |
| `leave:true` | Sale; un grupo vacío se elimina. |
| `deleteGroup:true` | Elimina el grupo: lo hace el propietario o, si el grupo no tiene propietario, un admin. |
| `addMember` | Añade contacto respetando `addPolicy` y el tope de miembros. |
| `removeMember` / `removed` | Expulsa, salvo a uno mismo o al propietario. |
| `approveAdmin` / `removeAdmin` | Cambia rol sin permitir auto-retirarlo. |
| `approveJoin` / `rejectJoin` | Resuelve solicitudes como admin. |
| `message:{…}` | Envía contenido permitido por rol y `contentPolicy`. |
| `deleteMessage` | Borra globalmente como autor o admin. |
| `seenMessage` | Consume un mensaje `once` de otro autor. |
| `seenTs` | Actualiza la marca de lectura del grupo. |
| `rename`, `description`, `avatar` | Edita presentación según `editPolicy`. |
| `visibility`, `joinPolicy`, `addPolicy`, `editPolicy`, `mentionAllPolicy` | Ajustes solo para admins. |
| `writePolicy`, `contentPolicy` | Cambia permisos de contenido según rol y política. |

Políticas: `visibility=public|private`; `joinPolicy=open|request|closed`;
`writePolicy`, `addPolicy`, `editPolicy`, `mentionAllPolicy=all|admins`;
`contentPolicy=all|admins|off` salvo `text`, que no admite `off`.

## 6. Objetos y privacidad

### Mensaje

Los campos habituales son `id`, `kind`, `ts`, `fromId`, `from`, `toId`, `to`,
`data`, `hash`, `mime`, `name`, `caption`, `gallery`, `once`, `edited`, `status`,
`readAt`, `reply`, `mentions`, `invite`, `enc`, `signature`, `signingPublicKey`
y `signatureValid`. Los nombres ocultos se sustituyen por alias opacos cuando la
relación y la privacidad lo exigen.

### Grupo

Incluye identidad, presentación, miembros/admins, políticas, resumen y, según el
rol, solicitudes, `inviteCode` y keybox propio. `GET /groups` elimina siempre el
código de invitación; en la ficha se entrega a todos los miembros, nunca a no
miembros.

### Privacidad

Modos: `server`/`all`, `contacts`, `nobody`, `only` y `except`. El bloqueo gana a
cualquier modo. Se aplica a foto, nota, descripción, historias, llamadas,
mensajes, compartir, presencia, lecturas y nombre de usuario.

`GET /profile` usa `permisos` para indicar qué puede hacer quien consulta. El UUID
interno y la presencia solo viajan cuando la relación y las reglas lo permiten.

## 7. WebSocket

### Conexión y límites

Endpoint `/ws`, mismo puerto. El upgrade exige ruta válida, origen propio,
`Upgrade: websocket`, versión 13, clave y sesión viva.

| Límite | Valor |
| --- | ---: |
| Conexiones por cuenta | 8; al superarla se cierra la más antigua |
| Frames por conexión y por cuenta | 200/s, ráfaga 600 |
| Frame/mensaje | 256 KiB |
| Buffer de entrada | 768 KiB |
| Fragmentos | 4096 |
| Salida pendiente | 1 MiB |
| Inactividad | 90 s |

El parser exige máscara del cliente, texto y controles válidos. Los errores de
protocolo usan cierres 1002/1003/1008/1009/1011 según el caso.

### Cliente → servidor

| Tipos | Función |
| --- | --- |
| `call-offer`, `call-busy`, `call-accept`, `call-reject`, `call-cancel`, `call-end` | Ciclo de llamada |
| `call-sdp`, `call-ice`, `call-mute`, `call-video` | Señalización WebRTC y estado de medios |
| `typing`, `recording`, `sending` | Actividad efímera en DM |
| `group-typing`, `group-recording`, `group-sending` | Actividad efímera en grupo |
| `privacy` | Fusiona privacidad y actualiza perfil |
| `ping` | Keep-alive; genera `pong` |
| `enc` | Negocia cifrado con `ephemeral` |

`to`, `callId` y `groupId` deben ser cadenas. Los alias opacos se resuelven solo
con una relación autorizada.

### Servidor → cliente

| Familia | Tipos principales |
| --- | --- |
| Social | `users`, `profile`, `contact-requests`, `contact-request-accepted`, `blocked-change` |
| DM | `message`, `msgEdit`, `msgDelete`, `receipt`, `seen`, `chatDelete`, `chat-cleared`, `poll-update` |
| Grupos | `group`, `group-message`, `group-message-delete`, `group-message-seen`, `group-left`, `group-request`, `group-request-rejected` |
| Historias | `stories`, `story-meta` |
| Actividad | `typing`, `recording`, `sending` |
| Llamadas | `call-incoming`, `call-log`, `call-accepted`, `call-rejected`, `call-cancelled`, `call-ended`, `call-busy`, `call-missed`, `call-blocked`, `call-denied`, `call-sdp`, `call-ice`, `call-mute`, `call-video` |
| Cuenta | `keychange` |
| Control | `pong`, `enc-ok` |

### Cifrado

El primer frame puede ser `{type:'enc',ephemeral:'<base64>'}`. Tras `enc-ok`,
los frames usan `z1:<base64>` con ChaCha20 + HMAC-SHA256, contadores independientes
por dirección y AAD de dirección/contador. Los frames cifrados inválidos se
descartan. Sin saludo se conserva compatibilidad en claro.

Más detalle en [Criptografía](CRIPTOGRAFIA.md#8-canal-websocket).

## 8. Visores locales

`npm run dbview` y `npm run sqliteview` abren visores independientes de solo
lectura en `127.0.0.1:3001` y `:3002`. Sus `/api/*` exigen `X-Viewer-Token`; el
token se muestra en el fragmento de la URL, que el navegador no envía. `Host`
está limitado a loopback/IP o una allowlist. `?reveal=1` desenmascara los valores
almacenados; no descifra sobres ni claves.

# Mapa de ficheros de Zlapy

Guía para localizar el código sin depender de números de línea ni de una lista
frágil de exports. Para contratos y decisiones de diseño, consulta los documentos
enlazados al final.

## Lectura recomendada

1. `server.js`: arranque y cargas iniciales.
2. `src/config.js`: configuración y rutas de datos.
3. `src/http/servers.js` y `src/http/router.js`: servidores y ciclo HTTP.
4. `src/db/`: esquema, consultas y transacciones.
5. `src/crypto/`: claves y formatos de cifrado.
6. El dominio concreto (`chat`, `groups`, `auth`, etc.) y sus pruebas.

## Estructura general

```text
server.js                 entrada del servidor
package.json              scripts y dependencias
.env.example              plantilla de configuración, sin secretos
zty.yml.example           plantilla de cloudflared
src/                      backend por dominios
public/                   SPA, páginas, estilos y service worker
ops/                      instalación, operación y mantenimiento
test/                     pruebas unitarias e integración
docs/                     documentación técnica
.github/workflows/        integración continua
```

## Backend

| Ruta | Responsabilidad |
|---|---|
| `server.js` | Comprueba dependencias y credencial, abre el servicio, endurece permisos, valida la base y carga el estado. |
| `src/config.js` | Valida `process.env`, crea/completa `.env` desde `.env.example` y resuelve puerto, TLS, límites y rutas SQLite. |
| `src/state.js` | Cachés y estado mutable en RAM; SQLite sigue siendo la fuente persistente. |
| `src/process-guards.js` | Registro de errores, cierre ante fallos fatales y latido IPC del supervisor. |

### HTTP y tiempo real

| Ruta | Responsabilidad |
|---|---|
| `src/http/servers.js` | HTTP/HTTPS en el mismo puerto, dispatcher TCP, upgrades y apagado ordenado. |
| `src/http/router.js` | Guards comunes y delegación en handlers de rutas públicas, GET, POST, estáticos y grupos. |
| `src/http/transport.js` | Sobres cifrados HTTP, validación y memoria anti-replay. |
| `src/http/responses.js` | JSON, CSP y cabeceras de seguridad. |
| `src/http/rate-limit.js` | Límites por IP/cuenta y purga de contadores. |
| `src/http/helpers.js` | MIME, respuestas 429 y decodificación segura de segmentos. |
| `src/realtime/websocket.js` | Handshake, sesiones WebSocket, límites y tipos de frame. |
| `src/realtime/frames.js` | Framing RFC 6455, fragmentación y cotas de buffer. |
| `src/realtime/encrypted.js` | Handshake y cifrado de frames. |
| `src/realtime/notify.js` | Difusión, presencia y listas de usuarios con backpressure. |

### Persistencia

| Ruta | Responsabilidad |
|---|---|
| `src/db/database.js` | Abre datos y blobs con WAL, `synchronous=FULL`, claves ajenas y `busy_timeout`. |
| `src/db/schema.js` | Esquema v12, migraciones idempotentes y borrados que requieren lógica JS. |
| `src/db/statements.js` | Sentencias preparadas compartidas. |
| `src/db/transactions.js` | Escrituras atómicas, cuotas y limpieza de blobs sin referencia. |

`SCHEMA_VERSION` describe tablas e índices. `meta.crypto_version` describe el
formato de cifrado de los datos: son versiones independientes.

### Criptografía

| Ruta | Responsabilidad |
|---|---|
| `src/crypto/setup.js` | Instanciación única de la llave maestra y los servicios criptográficos. |
| `src/crypto/master-key.js`, `owner-key.js`, `kdf.js` | Credencial del propietario, derivación, validación y vigilancia de cambios. |
| `src/crypto/message-crypto.js` | AES-256-GCM, contextos y firmas Ed25519. |
| `src/crypto/mtproto.js` | Sobres PCE3/MTProto, AES-256-IGE, LRU de sesiones y volcado de secuencias por auth_key. |
| `src/crypto/user-auth-keys.js` | Auth keys por cuenta, caché, lectura/escritura y poda al rotar o borrar. |
| `src/crypto/aad.js`, `field-crypto.js` | Contextos autenticados por pieza y columna. |
| `src/crypto/transport.js` | Primitivas del canal HTTP/WebSocket. |
| `src/crypto/peer-index.js` | Índice ciego para localizar llamadas sin descifrar nombres. |

La guía de formatos y límites de confianza está en [CRIPTOGRAFIA.md](CRIPTOGRAFIA.md).

### Dominios

| Carpeta | Responsabilidad |
|---|---|
| `src/auth/` | Registro, login, cookies JWT, cuentas vinculadas, contraseñas y revocación. |
| `src/users/` | Hidratación/persistencia de cuentas, privacidad, alias opacos y regeneración de auth key. |
| `src/chat/` | Mensajes directos, historial, resúmenes, reacciones, adjuntos y preferencias. |
| `src/groups/` | Grupos, miembros, invitaciones, políticas, keyboxes y resúmenes. |
| `src/profile/` | Perfil, apariencia, notas, cambio de clave y borrado de cuenta. |
| `src/contacts/` | Contactos, solicitudes y bloqueos. |
| `src/stories/` | Historias, likes y visualizaciones. |
| `src/stickers/` | Stickers, paquetes locales y proxy GIPHY con timeout. |
| `src/calls/` | Historial y registro de llamadas. |
| `src/push/` | Suscripciones, VAPID y WebPush con timeout. |
| `src/meta/` | Configuración pública mínima y `/healthz`. |
| `src/shared/` | Validación, límites, galerías, avatares, rutas estáticas y tipos. |

## Operación (`ops/`)

| Carpeta | Contenido |
|---|---|
| `ops/install/` | Verificación de Node/dependencias y compilación de better-sqlite3. |
| `ops/runtime/` | Supervisor, PID, watchdog y candados de mantenimiento. |
| `ops/config/` | Escritura atómica de `.env`, sincronización aditiva y permisos de almacenamiento. |
| `ops/backup/` | Respaldo consistente de bases y credencial con permisos privados. |
| `ops/auth/` | CLI `npm run owner` para credencial y kits de recuperación. |
| `ops/crypto/` | Rotación de llave maestra y reparaciones con servidor detenido. |
| `ops/net/` | Cloudflare Tunnel; token desde `.env`, nunca desde `zty.yml`. |
| `ops/db/` | Visores locales de solo lectura. |
| `ops/data/` | Generadores de emojis y paquetes de stickers. |

## Cliente (`public/`)

| Ruta | Responsabilidad |
|---|---|
| `index.html` | SPA principal: chats, grupos, historias, llamadas y ajustes. |
| `login.html` | Acceso y registro. |
| `group-create.html`, `group-details.html` | Creación/edición y ficha de grupos. |
| `profile.html`, `view.html` | Perfil propio y vista de contacto. |
| `stories.html`, `sticker-creator.html` | Visor de historias y creador de stickers. |
| `privacy.html` | Política de privacidad. |
| `css/` | Tema, fuentes y estilos por página/componente. |
| `js/transport-crypto.js`, `js/transport.js` | Canal cifrado HTTP/WebSocket en navegador. |
| `js/presence.js`, `system-messages.js`, `fecha-flotante.js` | Presencia y etiquetas temporales del chat. |
| `js/group-*.js`, `avatar-editor.js`, `autogrow.js` | Formularios y edición de grupos/perfiles. |
| `js/sticker-editor.js`, `animated-webp.js` | Edición y reproducción de stickers. |
| `js/local-data.js` | Informe y limpieza de almacenamiento local. |
| `js/build.js`, `js/sw.js` | Versión única, shell offline y notificaciones push. |
| `sw.js`, `transport-crypto.js` | Shims de compatibilidad para rutas antiguas. |
| `manifest.webmanifest`, `image/`, `fonts/` | PWA e identidad visual local. |

## Pruebas

`test/` reproduce los dominios del backend: `auth`, `calls`, `chat`, `client`,
`crypto`, `db`, `groups`, `http`, `profile`, `push`, `runtime`, `shared` y
`stickers`.

- `test/bootstrap.js`: aisla cada proceso con datos y credencial de prueba.
- `test/helpers.js`: arranca servidores desechables y ofrece clientes HTTP/WS.
- Runner: `npm test` (Node test runner).
- Añade la prueba en la carpeta del dominio afectado; para refactorizaciones,
  conserva las pruebas de comportamiento existentes.

## Dónde tocar

| Tarea | Archivos principales |
|---|---|
| Añadir una ruta HTTP | `src/http/router.js`, el `routes.js` del dominio, `docs/API.md` y pruebas HTTP. |
| Añadir un frame WebSocket | `src/realtime/websocket.js`, `notify.js`, cliente y pruebas WS. |
| Cambiar tablas o índices | `src/db/schema.js`, `statements.js`, transacciones, `docs/ESQUEMA-BD.md` y pruebas DB. |
| Cambiar un sobre cifrado | `src/crypto/`, lectores/escritores del dominio, herramientas de rotación y pruebas de compatibilidad. |
| Cambiar privacidad | `src/users/privacy.js`, perfil/grupos afectados y pruebas de autorización. |
| Cambiar límites | `src/config.js`, `.env.example`, consumidores y documentación de configuración. |
| Cambiar arranque o apagado | `server.js`, `src/http/servers.js`, `ops/runtime/supervisor.js`. |
| Cambiar respaldos | `ops/backup/`, `ops/config/secure-storage.js` y documentación de recuperación. |
| Cambiar túnel | `ops/net/tunnel.js`, `zty.yml.example` y `.env.example`. |

## Archivos locales que no se versionan

| Ruta | Motivo |
|---|---|
| `.env` | Credencial del propietario y otros secretos. Debe quedar en 0600. |
| `cert.pem`, `key.pem` | Clave privada TLS. |
| `data/` | Bases, WAL/SHM y logs en ejecución. |
| `backups/` | Bases y credenciales de recuperación; directorios 0700 y ficheros 0600. |
| `zty.yml` | UUID, hostname e ingress locales; no debe contener el token. |
| `.zlapy.pid` | Estado del supervisor. |
| `node_modules/` | Se reproduce con `npm ci` desde `package-lock.json`. |

## Convenciones

- Backend CommonJS con `'use strict'` y exports explícitos.
- Rutas relativas con extensión `.js` en código nuevo.
- JavaScript y SQL usan `camelCase` y `snake_case` respectivamente.
- Consultas preparadas; ninguna entrada de usuario se concatena en SQL.
- Las operaciones multi-escritura usan transacciones.
- El servidor revalida autorización, tipos, tamaños y relaciones aunque el cliente
  ya lo haya hecho.
- Los comentarios explican decisiones y riesgos, no repiten cada instrucción.
- Los documentos no incluyen conteos de líneas ni referencias `archivo:línea`:
  se enlaza el archivo o el símbolo para evitar que queden obsoletos.

## Documentación relacionada

- [Instalación y operación](INSTALACION.md)
- [API HTTP y WebSocket](API.md)
- [Arquitectura](ARQUITECTURA.md)
- [Criptografía](CRIPTOGRAFIA.md)
- [Esquema de base de datos](ESQUEMA-BD.md)
- [Decisiones vigentes](DECISIONES-AUDITORIA.md)

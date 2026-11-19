# Arquitectura de Zlapy

Visión actual de los componentes y flujos. Para localizar archivos usa el
[mapa de ficheros](FICHEROS.md); para contratos concretos, [API](API.md).

## 1. Componentes

```text
Navegador/PWA
   │ HTTP, HTTPS y WebSocket, mismo puerto
   ▼
src/http/servers.js → src/http/router.js → rutas por dominio
   │                                         │
   │                                         ├─ src/realtime/ (difusión)
   │                                         ├─ src/crypto/   (claves y sobres)
   │                                         └─ src/db/       (persistencia)
   ▼
SQLite principal + SQLite de blobs + estado RAM acotado
```

- `server.js` coordina arranque, credencial, permisos y carga inicial.
- `src/config.js` valida `.env` y resuelve rutas y límites.
- `src/state.js` contiene cuentas, grupos y cachés mutables; no es la fuente
  persistente.
- `ops/runtime/supervisor.js` mantiene el proceso y sus health checks.
- `public/` contiene la SPA, páginas auxiliares y service worker.

No hay ORM ni framework HTTP: se usa Node, `better-sqlite3` y sentencias
preparadas.

## 2. Arranque

1. Se comprueban Node y dependencias antes de cargar módulos nativos.
2. Se instalan guardas de proceso y el latido IPC.
3. `.env` se crea si falta y se completa de forma aditiva desde `.env.example`;
   el entorno del proceso tiene prioridad.
4. Se valida la credencial del propietario y se deriva la llave maestra.
5. Se abren ambas bases y se aplica el esquema idempotente.
6. Se comprueban formato de cifrado, manifiesto de integridad y compatibilidad
   de filas.
7. Se endurecen permisos de `data/`, `.env`, bases y, recursivamente, `backups/`.
8. Se cargan cuentas, grupos e historias y se completan índices necesarios.
9. Se inicia el dispatcher HTTP/HTTPS y el latido del supervisor.

Una credencial inválida o un formato incompatible detiene el arranque; nunca se
genera otra llave sobre datos existentes.

### Dispatcher

El mismo puerto acepta HTTP, HTTPS y upgrades WebSocket. El primer byte distingue
TLS y cada conexión se entrega al servidor correspondiente. `FORCE_TLS` redirige
a HTTPS cuando hay certificados; sin ellos, el modo degradado limita la
autenticación pública a loopback.

## 3. Ciclo HTTP

`handleRequest` conserva los guards y delega en handlers por tipo de ruta:

1. Parseo de URL y `OPTIONS`.
2. Redirección TLS, CSP y HSTS cuando procede.
3. Rate limit por IP o cuenta; `/healthz` queda exento.
4. Rutas públicas y avatares.
5. Resolución de sesión y comprobación del modo degradado.
6. Método y protección de origen/CSRF.
7. GET, POST o estáticos.

En POST se aplica el tope de cuerpo por ruta, se descifra el sobre si existe, se
valida el objeto JSON y se impone el actor autenticado antes de llamar al
dominio.

Un respondedor único clasifica errores síncronos y rechazos `async`:

- 400 solo para errores de cliente explícitos.
- 500 genérico para excepciones inesperadas.
- 503 para una auth_key ilegible con la llave maestra actual.

El detalle se registra en el servidor; no se devuelve `error.message` al cliente.

## 4. Persistencia y estado

### Bases SQLite

| Base | Contenido |
| --- | --- |
| Principal | Cuentas, relaciones, grupos, mensajes, historias, llamadas, push, permisos y metadatos. |
| Blobs | Adjuntos cifrados y volcado temporal de secuencias MTProto. |

Ambas usan WAL, `synchronous=FULL`, claves ajenas y `busy_timeout` de 15 s por
defecto. FULL prioriza commits durables ante una caída del SO; la espera evita
errores prematuros por contención transitoria de escritores.

El esquema principal es v12. `SCHEMA_VERSION` no es lo mismo que
`meta.crypto_version`, que identifica el formato de los datos.

### RAM

Las cachés aceleran cuentas, presencia, grupos, historias, llamadas, suscripciones
y páginas. Tienen cotas según el recurso. Las reglas de autorización se vuelven a
aplicar al servir; una entrada en RAM no sustituye a la base ni concede acceso.

Las mutaciones de estado compartido se hacen mediante las funciones de
`src/state.js` para no dejar referencias obsoletas.

### Transacciones y blobs

Las escrituras que deben ser atómicas se agrupan en `src/db/transactions.js`.
SQLite principal y blobs no comparten una transacción distribuida:

1. Se escribe el blob antes del mensaje; un resto sin referencia es inaccesible.
2. Al borrar, `pruneBlobHashes` elimina solo hashes sin referencias vivas.
3. Un barrido periódico retira huérfanos restantes.

La autorización depende de las referencias de la base principal, no de la mera
presencia física del blob.

## 5. Mensajería

### Cifrado y firma

Los mensajes usan la auth_key del autor con PCE3/MTProto y AES-256-IGE. El
contexto liga id, chat, autor, destino, tipo y grupo. La firma Ed25519 cubre el
contexto y el contenido relevante; la clave pública almacenada debe coincidir con
la derivada para ese autor.

Resúmenes, perfiles, notas, historias y llamadas usan PCE3A con contexto propio.
La infraestructura y los blobs usan PCE1v2/AES-256-GCM con subclaves y AAD.

El servidor posee las claves necesarias para descifrar: no es E2E frente al
servidor. [Criptografía](CRIPTOGRAFIA.md) detalla el modelo.

### Paginación y caché

El historial se lee hacia atrás con cursor `(ts,id)`, evitando duplicados cuando
dos mensajes comparten tiempo. Se solicita una fila adicional para calcular
`more` y la respuesta se devuelve en orden ascendente.

La caché de páginas recientes de DM tiene TTL, máximo de entradas y cota global
de bytes. No se usa para cursores `beforeId`. Los borrados por visor se filtran al
servir porque la página puede ser compartida por los dos participantes.

### Resúmenes y no leídos

Cada cuenta tiene su resumen cifrado y contador. Un envío actualiza ambos lados y
solo incrementa el receptor; una lectura lo pone a cero. Al borrar el último
mensaje se retrocede al anterior disponible. Los grupos mantienen un resumen por
miembro y actualizan todos en una transacción.

### Borrados

- Autor de un mensaje: borrado global.
- Destinatario: fila en `message_deletions`, oculta solo para esa cuenta.
- `chat_deletions`: quita una conversación de la lista sin destruir la vista del
  otro.
- `clearBoth`: vaciado real para ambos participantes.
- Administrador de grupo: puede borrar mensajes del grupo según sus reglas.

## 6. Cuentas, privacidad y grupos

### Sesiones y privacidad

Las sesiones son JWT sin tabla. `user_rid` y el checksum de cuenta permiten
revocar sin almacenar tokens. Logout y cambio de cuenta son locales al navegador;
cambiar contraseña revoca globalmente.

`/auth/session` anónimo es uniforme para UUID existentes e inexistentes, tanto en
cuerpo como en `Set-Cookie`. La información de cuentas vinculadas solo se expone
con una sesión válida.

Los modos de privacidad se combinan con relación y bloqueo. Los alias opacos solo
se resuelven para contactos, solicitudes o grupos compartidos autorizados.

### Contactos

`add_policy=all` conecta directamente; `request` crea solicitud; `nobody` rechaza.
Aceptar conecta en ambos sentidos. Bloquear rompe contacto y solicitudes y gana a
cualquier regla de privacidad.

### Grupos

Los roles son `admin` y `member`. Visibilidad, entrada y políticas de escritura,
alta, edición y menciones se validan en el servidor. Hay un tope de miembros y el
propietario no puede ser expulsado. Las operaciones sensibles son solo-admin;
eliminar el grupo entero exige ser propietario, salvo que ya no haya propietario.

Las invitaciones son credenciales: `inviteCode` se entrega a todos los miembros,
nunca a no miembros, y `GET /groups` siempre lo omite. Rota si un grupo público
pasa a privado. `customId` admite enlaces cortos únicos y validados.

### Regeneración de auth_key

La rotación recifra la cuenta en una transacción y usa upsert para cubrir también
una fila reparada/ausente. La clave anterior solo se olvida tras confirmar; en
rollback se restaura su caché y se poda la nueva. Al borrar una cuenta, la sesión
se poda después del commit y la cuenta siempre sale de la RAM.

## 7. Contadores MTProto

`msg_id` usa un high-water global de proceso que nunca retrocede. `seq_no` es
independiente por auth_key y sigue `1, 3, 5…`.

El LRU de contadores tiene 500 entradas. Al expulsar una, su contador interno
`seq` se guarda en `mtproto_session_spill`; al reutilizar la clave se recupera y
el siguiente `seq_no` emitido se calcula como `seq * 2 + 1`. Esto acota la RAM
sin escribir en SQLite por cada mensaje y sin compartir secuencias entre sesiones.

El volcado no contiene mensajes ni claves, se vacía al abrir un proceso nuevo y
se elimina al rotar o borrar. Un fallo al guardar una expulsión aborta el
cifrado; un fallo al podar se registra como limpieza pendiente sin invertir el
resultado ya confirmado.

## 8. Historias, llamadas y push

### Historias

Caducan según `STORY_TTL_MS`. Se validan texto, fondo y medio, y se sirven según
privacidad. Likes, vistas y ediciones emiten `story-meta` con solo el cambio, no
todas las historias. `like` devuelve `ok:false` si no existe o no hay permiso;
`view` devuelve `ok:false` si no está disponible en RAM y `ok:true` al procesar
una historia existente, aunque la privacidad impida añadir ese visor.

### Llamadas

El servidor señaliza por WebSocket; audio y vídeo usan WebRTC P2P con DTLS-SRTP
y no pasan por el servidor. Oferta, aceptación, rechazo, SDP, ICE, mute y vídeo se
validan por sesión, relación, bloqueo y privacidad. Las ofertas pendientes
caducan a los 30 s y el historial está acotado por cuenta.

### Web Push

VAPID y suscripciones se guardan cifradas. El servicio valida el endpoint con una
allowlist anti-SSRF antes de registrar y antes de enviar. Los envíos tienen 5 s
de timeout; Giphy, 8 s. Respuestas 404/410 y ciertos 403 eliminan suscripciones
obsoletas.

La miniatura push es pública mediante token no adivinable y rota al sustituirla.
El identicon público no revela si una cuenta existe.

## 9. WebSocket y presencia

`src/realtime/frames.js` implementa el subconjunto necesario de RFC 6455:
máscara, texto, fragmentación, ping/pong y cierres. Hay límites de frame, buffer,
fragmentos, conexiones por cuenta, frecuencia y salida pendiente.

Los eventos se validan por tipo y autorización antes de tocar la base. Un error
de frame cierra solo esa conexión.

El saludo `enc` negocia X25519/HKDF; después, los frames `z1:` usan ChaCha20 +
HMAC con contadores separados por dirección. Sin saludo se conserva
compatibilidad en claro.

La presencia cambia al conectar y solo pasa a desconectada cuando se cierra la
última conexión de la cuenta. La visibilidad de `online` y `lastSeen` depende de
la privacidad.

## 10. Cliente

`public/index.html` concentra la SPA; los módulos compartidos están en
`public/js/` y los estilos en `public/css/`.

- `transport*.js`: sobres HTTP y WebSocket.
- `presence.js`, `system-messages.js`, `fecha-flotante.js`: presencia y tiempo.
- `group-*.js`, `avatar-editor.js`: formularios y edición.
- `local-data.js`: informe y limpieza local.
- `build.js`: versión única usada por Ajustes y service worker.
- `sw.js`: shell offline y notificaciones push.

La versión visible y el nombre de caché derivan del mismo archivo para evitar
inconsistencias de despliegue.

## 11. Operación

### Supervisor

`npm start` ejecuta preflight y supervisor. Este usa `/healthz`, latidos IPC,
backoff y cortacircuito de arranque. Exit 78 exige credencial; exit 79 instala
dependencias. Escribe el PID con permisos 0600 y evita sondeos solapados.

### Apagado y errores

El cierre ordenado destruye sockets, cierra servidores, hace checkpoint WAL y
cierra ambas bases. Los errores globales quedan en consola y `data/log/errors.log`;
los fatales cierran para que el supervisor levante un proceso limpio.

### Respaldos y mantenimiento

`npm run backup` copia bases y credencial con la API de SQLite. Los respaldos usan
0700/0600 y el arranque endurece todo el árbol sin seguir symlinks.

Las rotaciones y reparaciones usan candados y exigen servidor detenido cuando
modifican bases. El token de Cloudflare vive solo en `.env`; `zty.yml` contiene
configuración no secreta del túnel.

## 12. Pruebas

`npm test` ejecuta Node test runner con datos temporales y puertos libres. Las
pruebas cubren unidades, integración HTTP/WebSocket, cifrado, rollback,
contención SQLite, permisos, timeouts y regresiones de privacidad. No usan las
bases de la instalación real.

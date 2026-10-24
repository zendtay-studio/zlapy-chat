# Decisiones de diseño tras la auditoría

La auditoría (run-1, `REPORT.md`) dejó tres hallazgos que no se resuelven con
un parche, sino con una decisión de diseño. Aquí queda asentado qué se
decidió y por qué, para que no se confunda con un olvido.

## 1. Existencia de cuentas deducible por el registro (V-12)

**Decisión: se conserva el contrato actual y el riesgo se mitiga con los
límites de frecuencia nuevos.**

Sitio en el código: `POST /auth/register` responde **409** cuando el nombre
ya está ocupado y **400** cuando la petición es inválida; el perfil de una
cuenta inexistente devuelve la forma vacía. El formulario del cliente
distingue el 409 del 400 para mostrar "nombre ya en uso", y el SPA trata la
cuenta inexistente como cuenta sin datos. Ambos comportamientos son parte de
la superficie del cliente desplegada.

Por qué no se cambia a propósito:

- Unificando la respuesta, **el dato saldría igualmente por el tiempo**:
  registrar una cuenta real hace scrypt y una escritura con índice único.
  La filtración por temporización es la forma clásica de romper la
  uniformidad, y disimularla exige trucos de duración constante que
  trasladan el problema en vez de eliminarlo.
- El colisionador aparece de todas formas en la base: el índice
  `UNIQUE COLLATE NOCASE` de `users.username` rechaza el segundo registro.
  Ocultarlo de verdad exigiría nombres cifrados y verificables (MAC) con un
  secreto del servidor: un rediseño del modelo de identidad completo.
- En la práctica los nombres no son secretos: aparecen en conversaciones,
  grupos y permisos, y el universo de nombres de una instancia doméstica es
  pequeño. El valor que extrae el atacante del 409 es marginal.
- Lo que sí corta la vía abusable es lo ya aplicado en esta ronda:
  registro limitado por IP del socket (15 por hora) y por servicio (60 por
  hora, con enfriamiento global de 15 minutos), y el freno por cuenta en el
  login. Enumerar nombres a gran escala exige proxies falsos; no un script
  de una tarde.

## 2. Cifrado de metadatos (V-18)

**Decisión: trabajo futuro propio (migración y diseño de claves); no entra
en esta ronda.**

Sitio hoy:

- El **cuerpo** de los mensajes viaja sellado para el cliente (columna
  `data`, con `crypto_version` y firma). Los adjuntos viven en la base de
  blobs y no guardan texto.
- En claro quedan metadatos: `username`, `add_policy`, `created_at` y
  `last_seen` (tabla `users`); y en `messages`: `chat` (clave de
  conversación), `ts`, `kind`, `hash` (SHA-256 del adjunto, que sirve para
  desreferenciar el blob), `once` y `edited`.

Por qué no es un parche de una tarde:

- El índice `idx_messages_chat_ts` pagina cada conversación sin descifrar
  nada (consulta O(log n) por página). Con `ts` cifrado —con IV distinto
  por fila— el índice deja de servir: habría que escanear la conversación
  entera por petición, inviable en móviles modestos (Termux incluido).
- Los resúmenes de la lista de chats ordenan y cuentan con esos mismos
  campos; cifrarlos obligaría a descifrar todo el histórico para pintar la
  lista.
- El `hash` del adjunto no puede cifrarse: `blob_access` y
  `blob_access_members` se referencian por ese hash, y el deduplicado por
  contenido depende de él.
- Las claves: conseguir que ni el operador vea metadatos pide claves por
  destinatario con rotación y pivote compatibles con lo que ya existe; eso
  es una pieza de diseño nueva sobre la que el cliente actual no da
  respaldo.

Camino que tendría sentido, por partes:

1. Primero lo barato y útil: convertir `last_seen` en franjas gruesas
   (día o franja horaria). Es el metadato más revelador de actividad y hoy
   se guarda al minuto.
2. Después, mover la paginación a metadatos cifrados por conversación: cada
   página se descifra y se ordena en el cliente, y el índice de SQLite se
   sustituye por identificadores estrictamente crecientes.
3. Anonimizar la columna `chat` es lo último y lo más caro: probablemente
   exige rediseñar el modelo de identidad del punto 1 en conjunto.

## 3. Content-Security-Policy sin `unsafe-inline`

**Decisión: refactor de cliente aparte.**

Hoy el SPA (`public/index.html`) lleva scripts embebidos y 96 atributos
`onclick=` (además de `oninput`, `onchange`, `onsubmit`); `login.html`
también lleva guiones propios. Quitar `'unsafe-inline'` del `script-src`
exige:

1. Sacar todos los scripts embebidos a ficheros externos y sustituir los
   atributos inline por manejadores asignados por código.
2. Elegir el mecanismo de exención: o `nonce` por respuesta (que implica
   custodiar la HTML en runtime, hoy es fichero estático), o una lista de
   `hashes` por fichero.
3. Revisar el service worker y las URLs `blob:` para no romper avatares,
   galerías ni historias.

Es un refactor del tamaño del propio cliente y su regresión debe
acompañarse con pruebas de navegador (Playwright). Queda en la lista de
trabajo de cliente, independiente de esta ronda del servidor. Mientras
tanto, la superficie de XSS sigue cubierta por la saneación que el cliente
aplica a cada dato antes de pintarlo (escape centralizado), que conviene
mantener como severidad propia con o sin CSP.

## Referencia

- Commit principal de la ronda: `4a16582` (cita los arreglos hallazgo por
  hallazgo) y `c164713` (purga de filas de acceso huérfanas).
- Informe fuente de la auditoría (fuera del repositorio):
  `zlapy-chat/run-1/REPORT.md`.

---

# Ronda SECOA — 23 oct 2026 (segunda auditoría ofensiva, con explotación real)

La segunda auditoría se hizo **ejecutando el servidor en un puerto de
aislamiento** (`DATA_DIR` temporal, `FORCE_TLS=false`, sin tocar `data/` real)
y reproduciendo cada hallazgo con peticiones reales antes de tocar una línea.
Con eso se separaron tres grupos: **hallazgos reales cerrados**, **falsos
positivos descartados** (el agente los propuso, el código ya los cubría) y
**decisiones que siguen vivas a propósito**.

## 4. Hallazgos confirmados y cerrados (con la prueba)

Todos se reprodujeron en la sandbox **antes** del parche y se verificó el
cierre después; la suite completa (`npm test`, 162 pruebas) pasó en verde con
los cambios puestos.

| Hallazgo | Qué permitía | Cómo quedó |
| --- | --- | --- |
| SECOA-I-001 / I-002 | `/send` aceptaba el medio **en línea sin hash** de 24 MB sin gastar cuota de adjuntos, y `POST /messages` amplificaba cada lectura a ~24 MB JSON (330-363 ms) | `MAX_INLINE_MEDIA_CHARS` (256 KiB → `413`), `bytesNuevos` cuenta **siempre** el `data` del mensaje (`src/chat/routes.js:246-284`) |
| SECOA-I-004 | `/receipt` sin limitador: cada uno recorre hasta 500 ids y descifra cada fila | `receiptLimiter` (120/min, `src/chat/routes.js:376`) |
| SECOA-A-001 | historias con medio en línea de 24 MB | `STORY_INLINE_CHAR_LIMIT` = 4 000 000 (`src/stories/routes.js`, `413` si pasa) |
| SECOA-A-002 | un miembro sin rol podía abrir un grupo privado (`visibility`) o dejarlo `joinPolicy: open` | cinco ajustes quedaron **solo-admins** (`src/http/router.js`, `403 "Ese ajuste es solo para admins."`) |
| SECOA-A-003 | un admin podía **expulsar al propietario**: la comprobación apuntaba a `groups.owner_id` (columna `SET NULL`), no al rol real, y dejaba el grupo huérfano | guarda explícita: `403 "No se puede expulsar al propietario del grupo."` (y se eliminó el bloque muerto) |
| SECOA-B-001 | `FORCE_TLS` sin certificados: arranque abortado o, si se forzaba, credenciales en claro desde fuera | arranque **degradado** + `503` para `publicAuthPost` desde fuera de loopback (`src/http/router.js:128-130`) |
| SECOA-C-011 | la caché de páginas sostenía cientos de MB en RAM con páginas de adjuntos grandes | cota global de bytes `CHAT_PAGE_CACHE_MAX_BYTES` (64 MiB) + desalojo (`src/chat/messages.js`) |
| SECOA-D-001 / E-001 | `data/` nacía `0755` y las bases `0644`: lectura para cualquier usuario local del equipo | `server.js` paso 0: `0700`/`0600` al arrancar, `best-effort` con aviso |
| SECOA-E-006 | el anti-replay del canal se registraba **antes** de validar el MAC (flood de basura expulsable) | registro del nonce **tras** verificar HMAC + rechazo de nonce vacío (`src/http/transport.js`) |
| SECOA-I-003 | sesiones sin tope por cuenta | `MAX_SESSIONS_PER_USER` = 20, recorta las más antiguas (`src/auth/sessions.js`) |
| SECOA-G | grupos sin tope de miembros (coste por mensaje lineal en N) | `MAX_GROUP_MEMBERS` = 200 en creación/`join`/`addMember` |
| (limpieza) | `.zlapy.pid` en `0644` y un limitador (`keyLimiter`) sin consumidor | PID `0600`; `keyLimiter` eliminado |

## 5. Falsos positivos descartados (no se tocó el código)

El agente auditor los propuso como fallos; la verificación sobre el código
mostró que **ya estaban resueltos**. Queda aquí para no volver a "arreglarlos":

- **Mismo-origen/CSRF en `POST`**: Origin + `sec-fetch-site` ya se comprobaban
  en `src/http/router.js`, y el *upgrade* WebSocket tiene su propia comprobación
  de origen (`src/realtime/websocket.js`).
- **Índices de `sessions`**: `idx_sessions_user` y `idx_sessions_exp` existen
  desde el esquema v3 (`src/db/schema.js`).
- **Caché de sesiones sin validar caducidad**: `getSessionFromCache` ya
  descarta las expiradas (`src/auth/sessions.js`).
- **`data.from` falsificable en `/story`**: el router lo sobrescribe con el
  actor antes de llamar a la ruta.
- **Duplicación de blobs por `INSERT OR IGNORE`**: el almacén es idempotente
  por diseño, no había fuga: el hallazgo se retiró.

## 6. Lo que sigue sin cambiar, a propósito

- **La identidad por IP bajo túnel de Cloudflare** (SECOA-C-002): con
  `X-Forwarded-*` detrás de `cloudflared`, un cliente podría falsear la IP de
  origen de los limitadores por IP. **Decisión: no se cambia.** Son de
  referencia para el registro/login, que **ya** tienen además límite por
  cuenta; elevar "la IP real" a fuente de verdad desde una cabecera
  introduciría un bypass nuevo. La restricción real de IP se mantiene en el
  *socket* (`clientIp`), que un cliente de la LAN no puede falsear.
- **La rotación de clave en una sola transacción** (SECOA-D-004):
  `regenerateAuthKey` re-cifra todo el material del usuario dentro de una
  transacción única por atomicidad. **Decisión: se conserva.** Dividirla en
  trozos reintroduciría estados intermedios ilegibles — que es justo el fallo
  que se corrigió en `4a16582`/`d3b977f`.
- **La purga coherente de dos bases** (SECOA-D-005): los blobs huérfanos se
  barren periódicamente en lugar de purgarse en la misma transacción que
  borra el mensaje. **Decisión: se conserva**: es un barrido acotado que no
  bloquea el servicio, y la referencia de acceso es la fuente de verdad.
- **El pin del compilador nativo** (SECOA-E-013): `better-sqlite3` se compila
  con el node-gyp del sistema. **Decisión: fuera de alcance**: cambiar el
  *toolchain* de un proyecto desplegado por `npm ci` es una operación de
  release, no un parche de seguridad.

## 7. Rutas privadas en el histórico

Tras esta ronda se reescribió el historial del repositorio para **eliminar
rutas personales del host** que se habían colado en dos documentos de auditoría;
el contenido (commits y mensajes) es el mismo, con hashes nuevos. Los informes
originales viven **fuera del repositorio** y se citan solo con rutas relativas
(`zlapy-chat/run-1/REPORT.md`).

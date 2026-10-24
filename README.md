# Zlapy — mensajes y llamadas en tu red

Clone de WhatsApp que corre **100 % en tu red local**: servidor Node, chats en
tiempo real por WebSocket y **llamadas de voz/video P2P (WebRTC)**.

- **Mensajería** en tiempo real (1:1 y grupos), con ticks de enviado/entregado/leído.
- **Llamadas** de voz y vídeo P2P: el audio y el vídeo van directos entre
  dispositivos (DTLS-SRTP); el servidor solo hace de señalización.
- **Cuentas** con usuario, contraseña y UUID permanente; **contactos** con
  solicitud de aceptación mutua; **grupos** con roles y permisos por tipo de
  contenido.
- **Historias** de 24 h, **notas**, **galerías**, **archivos** (deduplicados por
  hash SHA-256), **menciones**, **reacciones** y **borrados con alcance por
  usuario**.
- **Cifrado**: en reposo con AES-256-GCM, en la nube con un modelo derivado de
  **MTProto 2.0** (clave por cuenta, clave por mensaje, firma Ed25519) y **del
  canal** con X25519 + ChaCha20 + HMAC, incluso cuando se sirve por HTTP sin TLS.
- **PWA** instalable, con **notificaciones push** (Web Push, VAPID).

Todo vive en dos ficheros SQLite: `data/zlapy.db` (datos de la plataforma) y
`data/blob.db` (adjuntos multimedia, deduplicados por hash).

---

## Índice

1. [Requisitos](#requisitos)
2. [Instalación](#instalación)
3. [Arranque](#arranque)
4. [Configuración](#configuración)
5. [HTTPS y el móvil](#https-y-el-móvil)
6. [Uso](#uso)
7. [Arquitectura](#arquitectura)
8. [Cifrado](#cifrado)
9. [Base de datos](#base-de-datos)
10. [API](#api)
11. [Estructura de ficheros](#estructura-de-ficheros)
12. [Pruebas y CI](#pruebas-y-ci)
13. [Copias de seguridad](#copias-de-seguridad)
14. [Operación](#operación)
15. [Seguridad](#seguridad)
16. [Resolución de problemas](#resolución-de-problemas)
17. [Documentación](#documentación)

---

## Requisitos

| | |
| --- | --- |
| **Node.js** | **22 o superior** (`better-sqlite3` v13 lo exige) |
| **Compilador** | `python3`, `make` y `g++`/`clang` (solo si hay que compilar `better-sqlite3`) |
| **Disco** | SQLite + adjuntos: cuenta con el espacio de los multimedia que quieras subir |
| **Red** | Los dispositivos que chatean entre sí deben verse (misma WiFi/LAN o un túnel) |

Comprobación rápida de la versión:

```bash
node -v      # debe ser v22 o mayor
npm -v
```

---

## Instalación

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y git python3 make g++ build-essential
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci                 # instala lo que fija package-lock.json
```

### Termux (Android)

```bash
pkg update && pkg upgrade -y
pkg install git python make clang sqlite
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
```

O en un solo paso, con el script del propio proyecto:

```bash
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm run termux   # actualiza paquetes, instala las herramientas, compila y arranca
```

> **Nota (npm 12 o superior).** Desde npm 12 los *scripts de instalación* de las
> dependencias están bloqueados por defecto, así que el binario nativo de
> `better-sqlite3` no se compila solo. El proyecto ya lo aprueba en su
> `package.json` (`allowScripts`) y, además, el `postinstall` comprueba el
> binario y **lo compila si falta**. Si prefieres hacerlo a mano:
>
> ```bash
> npm install-scripts approve better-sqlite3   # solo si npm te lo pide
> npm run rebuild:sqlite                        # compila en el sitio
> ```
>
> En Android no existe binario publicado: la compilación es obligatoria
> (`pkg install python make clang` antes).

### Primera instalación: no hay que hacer nada más

`npm start` funciona en una instalación nueva sin pasos manuales:

| Qué pasa | Resultado |
| --- | --- |
| No existe `.env` | Se crea a partir de `.env.example` con los valores por defecto (permisos `600`) |
| No existe la llave maestra | Se genera y se guarda sola en el `.env` (`CHAT_MASTER_KEY`, permisos `600`) |
| No existe la base de datos | Se crea vacía en `data/` |

Si la base de datos **ya tiene cuentas** y falta la llave maestra, el servidor
se niega a arrancar (generar una llave nueva dejaría ilegibles los mensajes,
historias y adjuntos cifrados): hay que restaurar la llave de tu respaldo.

### Windows / macOS

```bash
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
```

En Windows hace falta **PowerShell** y las *Build Tools* de Visual Studio (o
`npm install --global windows-build-tools`) para compilar `better-sqlite3`.
En macOS, `xcode-select --install`.

> `npm ci` instala exactamente las versiones del `package-lock.json` (que está
> versionado), de modo que la instalación es reproducible. `npm install` también
> funciona, pero puede resolver versiones nuevas.

<details>
<summary>Instalación detallada por plataforma, servicio en segundo plano y diagnóstico</summary>

Guía completa: [`docs/INSTALACION.md`](docs/INSTALACION.md) — incluye systemd,
pm2, Termux:Boot, apertura de firewall, generación de certificados y tabla de
síntomas → causa → solución.

</details>

---

## Arranque

```bash
npm start        # con supervisor: si el proceso se cae, lo reinicia
```

| Comando | Qué hace |
| --- | --- |
| `npm start` | Arranca el servidor **bajo el supervisor** (`ops/supervisor.js`): health check, backoff exponencial (1 s → 30 s), reinicio automático y cortacircuito ante fallos de arranque |
| `npm test` | Suite completa (`node --test test/*.test.js`): unitarias + integración en instancias aisladas |
| `npm run backup` | Respaldo consistente de las dos bases (la llave maestra va en el `.env`: copia también ese fichero) |
| `npm run key` | Genera la llave maestra (`--force` para girarla — re-cifrando el almacenamiento si la base ya tiene datos —, `--null` para vaciar) |
| `npm run rebuild:sqlite` | Compila `better-sqlite3` en el sitio (obligatorio en Android/Termux) |
| `npm run termux` | Todo en uno para Termux: actualiza, instala herramientas, compila y arranca |
| `npm run tunnel` | Publica el servidor con un túnel de Cloudflare |
| `npm run migrate:mtproto` | Migración **manual** del histórico al esquema de cifrado en la nube (`--apply` la ejecuta de verdad) |

Para arrancar **sin** supervisor (útil para depurar, porque la salida va directa
a la consola):

```bash
node server.js
```

Al arrancar, el servidor imprime las URLs:

```
✅ Zlapy (SQLite) en el puerto 3000

   Esta PC:   http://localhost:3000
   Tu red:    http://192.168.x.x:3000

   También por HTTPS (necesario para cámara/micrófono en el móvil):
               https://localhost:3000
               https://192.168.x.x:3000   (acepta el aviso de certificado)
```

> Ejecuta el servidor **en un solo sitio**: dos instancias se pelean el puerto
> (la segunda muere con «Puerto ocupado» y el supervisor entra en backoff).

### Como servicio en segundo plano

| Entorno | Cómo |
| --- | --- |
| **systemd** (Linux) | Unidad de servicio con `ExecStart=.../node .../ops/supervisor.js` y `Restart=always` → [`docs/INSTALACION.md`](docs/INSTALACION.md#51-systemd-linux) |
| **pm2** | `pm2 start ops/supervisor.js --name zlapy && pm2 save && pm2 startup` |
| **Termux:Boot** | Script en `~/.termux/boot/` que lanza `npm start` al arrancar el móvil |

---

## Configuración

Los parámetros se leen de `.env` (plantilla en [`.env.example`](.env.example)).
**El supervisor carga el mismo `.env` que el servidor**, así que `PORT` y todas
las variables `SUPERVISOR_*` tienen efecto real sobre `npm start`.
El fichero `.env` no se versiona.

```bash
cp .env.example .env   # crea tu configuración local
```

### Aplicación

| Variable | Por defecto | Para qué sirve |
| --- | ---: | --- |
| `PORT` | `3000` | Puerto TCP donde escucha (http y https a la vez) |
| `DATA_DIR` | `data` | Carpeta de las bases y los adjuntos (vacío = `data/` dentro del proyecto) |
| `CHAT_MASTER_KEY` | vacío | Llave maestra en Base64 (32 bytes). Vacía = el servidor genera una en el primer arranque (base sin datos) y la guarda en el propio `.env` |
| `MESSAGE_DIRECT_CHAR_LIMIT` | `10000` | Máx. caracteres por mensaje directo |
| `MESSAGE_GROUP_CHAR_LIMIT` | `15000` | Máx. caracteres por mensaje de grupo |
| `STORY_TEXT_CHAR_LIMIT` | `140` | Máx. caracteres del texto de una historia |
| `PROFILE_DESCRIPTION_CHAR_LIMIT` | `140` | Máx. caracteres de la descripción del perfil |
| `MESSAGE_RATE_LIMIT` / `MESSAGE_RATE_WINDOW_MS` | `30` / `60000` | Mensajes por cuenta y ventana (ms) |
| `MAX_AUDIO_DURATION_MS` | `60000` | Duración máx. de la grabación de audio |
| `MAX_HTTP_BODY_BYTES` | `33554432` | Tamaño máx. del cuerpo HTTP (32 MiB) |
| `MAX_MESSAGE_DATA_CHARS` | `24000000` | Tamaño máx. de los datos multimedia de un mensaje |
| `MAX_GALLERY_ITEMS` / `MAX_GALLERY_ENCODED_CHARS` | `20` / `24000000` | Límites de las galerías |
| `NOTE_TTL_MS` / `STORY_TTL_MS` | `86400000` | Vigencia de la nota y de las historias (24 h) |
| `AUTH_SESSION_TTL_MS` | `2592000000` | Vigencia de la sesión (30 días) |
| `CHAT_PAGE_CACHE_MAX` / `CHAT_PAGE_CACHE_TTL_MS` | `20` / `10000` | Caché de páginas de chat (0 desactiva) |
| `SQLITE_CACHE_SIZE_KB` / `SQLITE_BUSY_TIMEOUT_MS` | `64000` / `5000` | Caché y espera de SQLite |
| `GIPHY_API_KEY` | vacío | Stickers de Giphy (solo la usa el servidor) |
| `CLOUDFLARE_TUNNEL_TOKEN` | vacío | Token del túnel de Cloudflare |
| `SUPERVISOR_*` | ver `.env.example` | Intervalo del health check, backoff, tope de reinicios, fichero de PID |

Los valores se **validan al arrancar**: un límite incoherente (por ejemplo,
`MAX_MESSAGE_DATA_CHARS > MAX_HTTP_BODY_BYTES`) detiene el arranque con un
error claro en vez de fallar luego en caliente.

### Llave maestra

El servidor cifra los datos en reposo con una llave de 32 bytes:

- Si `CHAT_MASTER_KEY` está definida en el `.env`, se usa esa.
- Si está vacía y la base **no tiene cuentas todavía**, el servidor genera
  una llave aleatoria (32 bytes, CSPRNG) y la escribe en el propio `.env`.
- Si está vacía y la base **ya tiene datos**, el arranque aborta
  (regenerarla en silencio haría los datos irrecuperables).

```bash
npm run key             # genera una llave y la guarda en .env
npm run key -- --force  # gírala: con base con datos, re-cifra todo el material dependiente con la nueva
npm run key -- --null   # vacía CHAT_MASTER_KEY (el servidor NO arrancará con datos; en una base vacía se genera otra en el siguiente arranque)
```

---

## HTTPS y el móvil

El mismo puerto sirve **http y https**: el dispatcher lee el primer byte de la
conexión y, si es el handshake de TLS (`0x16`), lo pasa al servidor HTTPS.

Genera los certificados autofirmados (en la raíz del proyecto). **El `subjectAltName`
es obligatorio**: los navegadores modernos ignoran el `CN` y sin el SAN de tu IP
te dicen «el certificado no coincide con la dirección»:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 397 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=zlapy" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.100.184" \
  -addext "basicConstraints=critical,CA:TRUE"
chmod 600 key.pem cert.pem
```

Sustituye `192.168.100.184` por la IP actual de la máquina (`ip addr` / `ifconfig`);
si tu router cambia la IP por DHCP, reserva una fija en el router o repite el
comando. El `CA:TRUE` permite **instalar el certificado como CA de confianza** en
el móvil (Ajustes → Seguridad → Cifrado y credenciales → Instalar certificado →
certificado CA) y que deje de avisar del todo. Reinicia el servidor tras
regenerarlos (el certificado se lee al arrancar).

> **Las llamadas y el push en el móvil exigen `https`**: los navegadores solo
> dan cámara/micrófono en un contexto seguro, y Web Push solo funciona sobre
> HTTPS. Si el navegador avisa del certificado, pulsa «Avanzado / Continuar».

Aunque no configures TLS, el **cuerpo** de las peticiones y de los frames
WebSocket viaja cifrado por la capa de transporte de la aplicación: el servidor
publica su clave pública en `/config` y `/healthz`, y el cliente construye un
sobre con una clave efímera para cada petición. Eso evita que quien escuche la
red lea las contraseñas o los mensajes en el cuerpo, pero **no sustituye a
HTTPS**: las cabeceras y las cookies siguen viajando en claro, así que un
observador puede robar la cookie de sesión y actuar como la cuenta; y un
atacante activo puede cambiar la clave pública por la suya. Para proteger eso
está TLS.

Si el puerto 3000 está ocupado: `PORT=3001 npm start` (y ábrelo en el
firewall).

---

## Uso

1. Abre la URL y pulsa **Crear cuenta**: usuario en minúsculas y contraseña de
   al menos 8 caracteres. El **nombre visible** admite mayúsculas y espacios.
2. En el otro dispositivo, crea otra cuenta o entra con sus credenciales.
3. Añade contactos con el **+** de la lista usando su usuario exacto. Los chats
   y grupos solo aparecen a sus participantes.

Cada cuenta tiene un **UUID permanente** (independiente del usuario, que se
puede cambiar desde Ajustes). La contraseña se guarda como hash con sal; nunca
en claro. La sesión viaja en una cookie `HttpOnly` de hasta 30 días y se
invalida al cerrar sesión, al cambiar la contraseña o al reiniciar el servidor.

### Funciones

**Mensajería**
- Chats en tiempo real con ticks ✓ / ✓✓ azul (enviado, entregado, leído).
- Cuentas independientes, con usuario, contraseña y UUID permanente.
- Contactos por usuario; el servidor solo entrega la lista propia.
- Notas a uno mismo, respuestas, edición, borrado y compartir.
- Fotos, vídeo, audio y cualquier archivo, con barra de progreso; las
  imágenes se convierten a WebP para quitar metadatos; las selecciones
  múltiples se envían como galería con comentario opcional.
- Deduplicación de adjuntos por hash SHA-256 en `data/blob.db`.
- Notas de voz con grabación y previsualización.
- **Ver una vez** (se borra al verlo).
- Paginación de mensajes antiguos al hacer scroll arriba.
- Historias de 24 h con vistas, edición y borrado.
- Perfiles: avatar, nombre, descripción, nota y privacidad.
- Privacidad por dato (7 funciones: foto, nota, descripción, historias,
  llamadas, mensajes, compartir) con modos **Servidor**, **Contactos**,
  **Nadie**, **Solo…** y **Excepto…**.
- Política de contacto por cuenta: directa, por solicitud (con aceptación
  mutua) o desactivada.
- Grupos con foto, descripción, visibilidad pública o privada, unión directa o
  por solicitud, administración compartida y permisos separados para
  escritura, archivos, fotos, vídeos, audio y stickers.
- Menciones `@usuario` y `@all` / `@todos` con autorización configurable.
- Compartir grupos por enlace dentro de los chats; los administradores pueden
  aprobar entradas, promover administradores y administrar integrantes.
- Bloquear contactos: las cuentas bloqueadas no ven presencia, perfil,
  historias ni conversaciones directas.
- Eliminar chat (para mí), eliminar mensajes (el autor borra de verdad; el
  destinatario los oculta para sí) y eliminar la cuenta con borrado en cascada
  (la interfaz pide la contraseña actual).
- Regenerar la clave de cifrado de la cuenta desde **Ajustes → Cuenta**:
  re-cifra el contenido y conserva el historial.
- Historial de ventanas coherente: **Atrás** cierra primero Perfil, luego
  Ajustes y al final vuelve al inicio; dentro de Ajustes, cada sección vuelve
  a su menú antes de cerrar la hoja.
- Búsqueda, PWA instalable y diseño responsive.

**Llamadas (WebRTC P2P)**
- Voz y vídeo, con señalización por el WebSocket del servidor y medios
  **directos entre dispositivos**.
- Pantalla de llamada entrante con timbre, atender y rechazar.
- En llamada: silenciar micrófono, apagar cámara, cronómetro y colgar.
- Registro de llamadas: perdidas, rechazadas, canceladas y en curso.

**Notificaciones push**
- Avisos de mensajes y llamadas aunque la pestaña no esté visible; se pueden
  probar y activar desde Ajustes.
- Requieren un navegador con Push API, permiso de notificaciones y una URL
  HTTPS. La entrega con el navegador cerrado depende del servicio push del
  navegador y de que el sistema operativo no limite su actividad en segundo
  plano.

---

## Arquitectura

```
                 navegador / PWA  ──HTTP/HTTPS──┐
                 navegador / PWA  ──WebSocket──┤
                                              ▼
  ┌───────────────────────────────────────────────────────────┐
  │ server.js  (punto de entrada)                             │
  │   comprueba la versión de cifrado · carga la base · arranca│
  └───────────────┬───────────────────────────────────────────┘
                  ▼
  src/http/router.js ──► rutas por dominio (src/auth, src/chat, src/groups…)
        │                    │
        │                    ├─► src/db/*     (SQLite + adjuntos por hash)
        │                    ├─► src/crypto/* (llave maestra, MTProto 2.0)
        │                    └─► src/realtime/* (WebSocket, presencia, push)
        ▼
  src/state.js  (estado en memoria: cuentas, grupos, historias, sesiones, caché)
```

- **`server.js`** es solo el punto de entrada: comprueba que la base use el
  formato de cifrado actual, hidrata los datos en memoria y arranca los
  servidores.
- **El enrutador** (`src/http/router.js`) resuelve cada petición a la ruta que le
  corresponde, respetando el orden de comprobaciones: primero las rutas
  públicas, después la sesión, y por último las mutaciones (que exigen origen
  válido).
- **Los módulos de dominio** (`src/auth/`, `src/chat/`, `src/groups/`…) son
  funciones puras por ruta: reciben `(req, res, url, data, actor)` y devuelven
  la respuesta.
- **El estado en memoria** (`src/state.js`) acelera las lecturas; la base de
  datos sigue siendo la fuente de verdad.
- **Las llamadas no pasan por el servidor**: solo la señalización; el audio y
  el vídeo van directos entre dispositivos.

Detalle completo (flujo de una petición, caché, paginación, privacidad,
borrados, WebSocket, grupos): [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

---

## Cifrado

El modelo es el de **nube multi-dispositivo de MTProto 2.0** (el de Telegram
para los chats normales, **no** el de los chats secretos de extremo a extremo).

- **Cada cuenta tiene su propia `auth_key`** de 2048 bits, aleatoria y **no
  derivada de la llave maestra**, con su identificador (`auth_key_id`: los 64
  bits bajos del SHA-1 de la clave) y su sal, que se rota cada 30 minutos. El
  servidor la guarda cifrada con su llave maestra.
- **Cada mensaje se cifra con una clave propia**, derivada como en MTProto:
  `msg_key` = los 128 bits centrales del SHA-256 del mensaje (con relleno
  aleatorio de 12 a 27 bytes) precedido por 32 bytes de la `auth_key`, y de ahí
  `aes_key` y `aes_iv`.
- El mensaje lleva dentro una **cabecera interna** cifrada (sal, sesión,
  `msg_id` monotónico y longitud) y, en claro, su `auth_key_id` y su `msg_key`:
  al leerlo se **recalcula el `msg_key` y se comprueba que coincide** (la regla
  de MTProto). La ventana anti-repetición de MTProto (300 s hacia atrás, 30 s
  hacia delante) está implementada y probada, pero no se aplica al historial
  almacenado —un mensaje de hace una hora quedaría fuera de ella—: la
  protección real la dan el recálculo del `msg_key` y el **contexto
  autenticado**, que impiden mover una fila de mensaje a otra conversación.
- **La llave maestra ya no descifra el contenido de nadie por sí sola**: haría
  falta además la base de datos.
- Cada mensaje lleva una **firma Ed25519**; el servidor la verifica al leerlo.
  Las firmas detectan alteraciones de la base, pero **no prueban autoría** frente
  a un servidor comprometido (el servidor conoce la clave del usuario).
- **Todo el contenido sensible se cifra en reposo**: resúmenes de chat, nota
  personal, bio, nombre visible, registro de llamadas, claves push y la clave
  privada VAPID. El avatar y los identificadores siguen en claro (son públicos
  por definición).
- `POST /account/regenerate-key` regenera la clave **re-cifrando el contenido**,
  para no perder el historial.

> **Desviación deliberada de MTProto:** allí el cifrado es AES-256 en modo IGE,
> que **no autentica** el texto cifrado. Aquí se usa la **misma derivación de
> claves** pero con **AES-256-GCM**, que sí lleva etiqueta de autenticación:
> es estrictamente más fuerte.

**El servidor NO migra al arrancar**: lee los dos formatos (el antiguo y el
nuevo) y escribe siempre el nuevo, así que el contenido viejo se re-cifra solo
a medida que se reescribe — y `POST /account/regenerate-key` re-cifra el
histórico entero de una vez. No hay ningún paso de migración: arrancar es todo
lo que hay que hacer.

**Perfiles cifrados dos veces (reparación puntual).** Si el servidor llegó a
pintar un texto ya cifrado (porque al arrancar leía el perfil con la función
equivocada) y alguien guardó ese perfil sin tocarlo, el texto quedó cifrado
dos veces: `PCE3( PCE3( "texto real" ) )`. A simple vista es basura, pero se
puede desenvolver:

```bash
node ops/repair-double-encrypted.js            # simulación: dice lo que haría
node ops/repair-double-encrypted.js --apply    # repara (con respaldo previo en backups/)
```

Conviene **parar el servidor** mientras repara. Es **idempotente** y
**verifica cada registro** (ida y vuelta) antes de tocarlo.

### Cifrado del canal (HTTP y WebSocket)

El cifrado en reposo protege la base de datos, no el cable. Para las redes
locales en las que no hay TLS, el servidor deriva de la llave maestra un par de
claves **X25519** —la privada no se guarda aparte: se recalcula con HKDF-SHA256,
así que no hay un secreto nuevo que respaldar— y publica la pública en
`/config` y `/healthz`:

```json
{
  "transportAlgorithm": "x25519-chacha20-hmac-v1",
  "transportPublicKey": "…"
}
```

Cada `POST` con cuerpo JSON puede viajar como sobre:

| Cabecera | Contenido |
| --- | --- |
| `X-Zlapy-Enc` | `x25519-chacha20-hmac-v1` |
| `X-Zlapy-Ephemeral` | clave pública efímera del cliente (32 bytes, base64) |
| `X-Zlapy-Nonce` | nonce aleatorio de 12 bytes (base64) |
| `X-Zlapy-Time` | milisegundos del cliente (margen de ±60 s) |

El cliente genera un par efímero, calcula con X25519 el secreto compartido y
deriva de él 64 bytes con HKDF-SHA256 (32 para ChaCha20 y 32 para HMAC). El
cuerpo va cifrado y autenticado con HMAC-SHA256 (cifrar-y-luego-autenticar); el
contexto autenticado (AAD) incluye método, ruta y marca de tiempo y, en la
respuesta, también el código de estado. Así un cuerpo no se puede mover a otra
ruta ni reutilizar más tarde. La respuesta se cifra con la misma clave y lleva
`X-Zlapy-Enc` + `X-Zlapy-Resp-Nonce`.

El WebSocket se cifra igual: el cliente envía un saludo en claro
`{"type":"enc","ephemeral":"…"}`, el servidor responde `enc-ok` y desde ahí cada
frame es `z1:<base64>`, con contadores de nonce independientes por dirección.
Los clientes que no mandan el saludo siguen funcionando en claro.

El cliente cifra en JavaScript puro (`public/transport-crypto.js`), no con
`crypto.subtle`: esa API solo existe en contextos seguros (HTTPS o `localhost`)
y el objetivo es precisamente proteger el acceso por HTTP a la LAN. Si la clave
pública no está disponible o algo falla, el cliente vuelve al envío en claro
para no romper la aplicación.

> **Límite honesto:** esta capa protege el **cuerpo** frente a quien escucha el
> tráfico, no las cabeceras: la cookie de sesión viaja en claro, así que un
> observador puede robarla y usar la API directamente (las respuestas `GET`
> también van en claro). Tampoco protege frente a un atacante activo que
> suplante al servidor y entregue su propia clave pública. Para todo eso hace
> falta HTTPS. El servidor ve el contenido al descifrarlo: no es cifrado de
> extremo a extremo.

Detalle completo (derivaciones, formatos `PCE`, firmas, ciclo de vida, sobre de
transporte y modelo de amenazas):
[`docs/CRIPTOGRAFIA.md`](docs/CRIPTOGRAFIA.md).

---

## Base de datos

El esquema es **v3** (tablas normalizadas con índices para las columnas hijas
de las claves ajenas) y se aplica al arrancar de forma idempotente: si falta
algo, se crea; si ya está, no se toca nada.

**No hay migraciones**: una base en un formato anterior no es compatible con
este servidor — restáurala desde un respaldo de `backups/` o arranca con una
base nueva. El arranque lo comprueba y detiene el proceso con un error claro.

- Cuentas con columnas reales (`users`), perfil, claves, privacidad, colores,
  notas, stickers y silenciados en tablas propias.
- Claves ajenas `ON DELETE CASCADE` en todo: **borrar una cuenta lo borra
  todo** (perfil, contactos en ambos sentidos, mensajes de sus chats 1:1, sus
  mensajes de grupo, historias, llamadas, sesiones, push…). El grupo sobrevive y
  la administración pasa a otro miembro.
- El nombre de usuario queda libre al instante: se puede borrar una cuenta y
  volver a registrarla **sin reiniciar el servidor**.
- **Los borrados tienen alcance por usuario**: un mensaje y una conversación se
  guardan una sola vez para los dos interlocutores. `/msg/delete` borra de
  verdad si lo pide el **autor**; si lo pide el **destinatario**, el mensaje se
  oculta solo para él. `/chat/delete` es siempre «borrar para mí»: el otro
  interlocutor conserva su copia.

Referencia completa (tabla por tabla, con reglas de borrado e invariantes):
[`docs/ESQUEMA-BD.md`](docs/ESQUEMA-BD.md).

### Caché de páginas de chat

Los mensajes viven en SQLite con el índice `messages(chat, ts, id)`: leer una
página es una consulta indexada, no un recorrido del historial. Encima, el
servidor conserva en RAM las últimas páginas descifradas (`CHAT_PAGE_CACHE_MAX`
páginas, TTL de `CHAT_PAGE_CACHE_TTL_MS`, por defecto 20 páginas / 10 s), que se
invalida al enviar, editar o borrar mensajes. Los grupos mantienen además un
resumen por integrante (`group_summaries`: último mensaje + contador de no
leídos).

> **Privacidad:** la caché temporal conserva mensajes descifrados en memoria.
> Los blobs no se almacenan en esta caché.

---

## API

- HTTP sobre el mismo puerto que el WebSocket.
- Autenticación por cookie `HttpOnly` de sesión; el cuerpo es JSON.
- Rutas públicas: `/config`, `/healthz`, `/auth/register`, `/auth/login`,
  `/auth/logout`, `/auth/switch`, `/avatar/<usuario>.svg`, `/push/vapid` y los
  ficheros estáticos de `public/`.
- El resto exige sesión; las mutaciones exigen además origen válido.

Referencia completa (todas las rutas, cuerpos y respuestas, y el protocolo del
WebSocket): [`docs/API.md`](docs/API.md).

---

## Estructura de ficheros

```
server.js              punto de entrada: comprueba la base, carga los datos y arranca
src/                   el backend, partido por dominios
  config.js            configuración (fichero .env y valores por defecto)
  state.js             estado compartido en memoria (cuentas, grupos, sesiones, caché)
  auth/                sesiones, cookies y rutas de autenticación
  users/               cuentas, perfiles y privacidad por función
  profile/             perfil, notas y ajustes de la cuenta
  contacts/            contactos, solicitudes y bloqueos
  chat/                mensajes, resúmenes, adjuntos y menciones
  groups/              grupos, claves de grupo y sus rutas
  stories/             historias
  calls/               llamadas y su señalización
  stickers/            proxy del catálogo de stickers
  push/                notificaciones push (VAPID)
  realtime/            WebSocket: framing, cifrado de frames, envío a los clientes y mensajes
  http/                router, respuestas, cabeceras, sobre cifrado y arranque de los servidores
  db/                  base de datos: apertura, sentencias, transacciones y esquema
  crypto/              llave maestra, cifrado en reposo, cifrado en la nube y claves del canal
  shared/              validaciones y utilidades puras
  meta/                configuración pública y health check
ops/                   scripts de operación (se ejecutan a mano)
  supervisor.js        arranca el servidor y lo revive si se cae (npm start)
  tunnel.js            publica el servidor con Cloudflare (npm run tunnel)
  backup.js            copia consistente de las bases (npm run backup)
  generate-master-key.js  crea la llave maestra (npm run key)
  repair-double-encrypted.js  repara los perfiles que quedaron cifrados dos veces
public/                el cliente web (PWA): index.html, login.html, profile.html,
                       view.html, stories.html, privacy.html, sw.js, theme.css,
                       login.css, popmenu.css/js (menu desplegable comun),
                       autogrow.js, avatar-editor.css/js, appearance.js,
                       transport-crypto.js (primitivas) y transport.js (sobre y WS)
docs/                  documentación (ver el índice final)
test/                  pruebas unitarias y de integración (node --test)
  server-http.test.js      rutas HTTP: registro, contactos, mensajes, grupos
  server-ws.test.js         WebSocket: frames, suscripciones y mensajes
  transport.test.js        sobre cifrado HTTP y WebSocket (ida y vuelta y rechazos)
  security-regressions.test.js  regresiones de la auditoría de seguridad (2026-10-19)
  mtproto.test.js        tests del esquema de cifrado en la nube (MTProto 2.0)
  mtproto-server.test.js tests de integración del cifrado en la nube en el servidor
  legacy-read.test.js    el servidor lee el esquema de cifrado antiguo sin migrar
  supervisor.test.js      arranque del supervisor y reinicio del hijo
.github/workflows/ci.yml        CI: npm ci + npm test
data/                  persistencia (sobrevive reinicios; no se versiona)
  zlapy.db             SQLite: usuarios, mensajes, contactos, grupos, historias y llamadas
  blob.db              archivos e imágenes deduplicados por hash SHA-256
backups/               respaldos manuales (no se versiona)
cert.pem / key.pem     HTTPS autofirmado (para cámara/micrófono en el móvil)
.zlapy.pid             PID del servidor hijo mientras corre el supervisor (no se versiona)
```

Mapa fichero por fichero (qué hace cada uno, qué exporta, dónde tocar para cada
tarea): [`docs/FICHEROS.md`](docs/FICHEROS.md).

---

## Pruebas y CI

```bash
npm test
```

La suite (101 pruebas) cubre:

- **Rutas HTTP** sobre instancias aisladas (directorio de datos y puerto
  temporales): registro, login, contactos, aceptación, mensajes, grupos,
  historias, llamadas, notas, push y borrados.
- **WebSocket**: handshake, frames, ensamblado de fragmentos, presencia y
  señalización de llamadas.
- **Regresiones de seguridad**: los 45 hallazgos de la auditoría ofensiva del
  2026-10-19, cada uno con su prueba.
- **Cifrado en la nube**: derivación de claves, sobres, firmas, ventana
  anti-repetición y migración.
- **Cifrado del canal**: primitivas del cliente contra las de Node, sobre HTTP
  ida y vuelta, rechazo de sobres manipulados o caducados y frames WebSocket
  cifrados, además de la compatibilidad con clientes en claro.
- **Supervisor**: arranque, health check y reinicio del hijo.

La CI (`.github/workflows/ci.yml`) ejecuta `npm ci` + `npm test` en cada push
con Node 22. `package-lock.json` está versionado, así que las instalaciones
son reproducibles.

---

## Copias de seguridad

```bash
npm run backup                 # → backups/zlapy-backup-<fecha>/
npm run backup -- /sdcard/copia   # destino a elegir
```

Copia de forma **consistente** las dos bases (con la API `backup()` de SQLite,
segura incluso con el servidor corriendo y WAL activo) y la llave maestra, con
permisos 0600.

> **La llave maestra y las bases siempre van JUNTAS**: sin `CHAT_MASTER_KEY`
> (la línea del `.env`), los mensajes, historias y adjuntos del respaldo son
> irrecuperables. Guarda una copia del `.env` (o de esa línea) en un lugar
> distinto al disco de la aplicación.

Para **restaurar**:

1. Para el servidor (`Ctrl+C` o `SIGTERM`: cierra ordenado con checkpoint WAL).
2. Copia `zlapy.db` y `blob.db` del respaldo a la carpeta de datos (`DATA_DIR`,
   por defecto `data/`) y define la MISMA `CHAT_MASTER_KEY` en el `.env`
   (la clave del respaldo).
3. Arranca y comprueba `http://localhost:3000/healthz` → `{"ok":true,...}`.

> Copiar solo el `.db` con el servidor corriendo **no** es un respaldo válido:
> el WAL queda fuera. Usa siempre `npm run backup` (o `db.backup()`).

---

## Operación

- **Health check:** `GET /healthz` responde `{"ok":true,"schema":3,...}`
  comprobando ambas bases; es público y no expone datos.
- **Cierre ordenado:** con `SIGTERM`/`SIGINT` el servidor deja de aceptar
  conexiones, cierra los sockets de los clientes, hace *checkpoint* del WAL y
  cierra las bases antes de salir. El supervisor propaga esas señales a su hijo.
- **Supervisor:** `npm start` corre el servidor bajo el supervisor (backoff,
  watchdog de salud y cortacircuito; publica el PID del hijo en `.zlapy.pid`).
  El cortacircuito (`exit 70`) protege solo de los **fallos de arranque**: una
  caída en caliente se reinicia siempre con backoff topado y una alerta, sin
  dejar el servicio apagado.
- **Túnel de Cloudflare:** `npm run tunnel` publica la instancia en internet.
  Necesita `cloudflared` instalado, `CLOUDFLARE_TUNNEL_TOKEN` en `.env` y
  `zty.yml` (copiado de `zty.yml.example`) con tu dominio. El token **no**
  viaja en `argv`: queda en el entorno del proceso.
- **CI:** ver «Pruebas y CI».

---

## Seguridad

Estado tras la auditoría ofensiva del **2026-10-19** (9 agentes, 45 hallazgos
validados).

**Lo que bloquea el servicio:**
- Un frame WebSocket malformado solo cierra **esa** conexión: el manejador
  valida el tipo de los identificadores que llegan del cliente y va dentro de un
  `try/catch`.
- El ensamblado de fragmentos WebSocket es **O(1) por fragmento** (contador
  acumulado) y con tope de fragmentos: un mensaje de 256 KB ya no bloquea el
  event loop de todos los usuarios.
- El supervisor distingue fallo de arranque de caída en caliente y **no deja el
  servicio apagado** por un crash-loop.

**Lo que protege los datos:**
- Una cita de respuesta se **resuelve en el servidor** contra el mensaje real:
  si no existe o no es de esa conversación, se descarta. Se acabaron el XSS
  almacenado (`reply.id` en un `onclick`) y el preview atribuido a otra persona.
- `/seen` solo destruye los mensajes de **una sola vista**.
- Referenciar el hash de un adjunto que ya existe exige **tener acceso a él**
  (mismo control que la galería).
- Borrar la cuenta **exige la contraseña actual**; la interfaz la pide antes
  de enviar la solicitud.
- El bloqueo de intentos de login se guarda por **cuenta e IP**.
- Los resúmenes, notas, bios, llamadas, claves push y la clave VAPID se
  cifran en reposo; los mensajes se cifran en la nube con clave por cuenta.
- El cuerpo de los `POST` y los frames WebSocket se cifran con una clave de
  sesión X25519 aunque el servidor se sirva por HTTP; el sobre se ata a método,
  ruta, marca de tiempo y estado, y la clave privada del servidor se deriva de
  la llave maestra (no hay un secreto nuevo que custodiar).
- Las cabeceras de respuesta incluyen CSP por petición, HSTS (cuando la
  conexión va cifrada), `Permissions-Policy`, COOP y CORP.

**Lo que se ha endurecido en el cliente:** los `onclick` usan un saneador propio
para cadenas JS (`jsArg`), el cierre de sesión borra la identidad de la cuenta
anterior del almacenamiento local, los stickers remotos solo se cargan desde
hosts permitidos y el overlay de depuración no se activa con `?dbg`.

**Lo que sigue abierto (no es un bug del código):** el túnel de Cloudflare
expone la instancia a internet y el producto está diseñado para una red de
confianza local; conviene revisar las reglas de la cuenta de Cloudflare
(`Access`/WAF) antes de dejarlo abierto.

---

## Resolución de problemas

| Síntoma | Causa habitual | Solución |
| --- | --- | --- |
| «Puerto ocupado» | Ya hay una instancia en el mismo puerto | `PORT=3001 npm start`, o para el supervisor: mata la otra instancia |
| `Cannot find module 'better-sqlite3'` | Falta el binario nativo | Compílalo en el sitio: `cd node_modules/better-sqlite3 && npm exec -- node-gyp rebuild --release --force_build=1` (`npm rebuild better-sqlite3` **no** compila: el paquete no trae script `install`) |
| «Database crypto version is incompatible» | La base es de un formato anterior | Restaura desde un respaldo de `backups/` o empieza con una base nueva (no hay migraciones) |
| «falta la llave maestra» | `CHAT_MASTER_KEY` no está en el `.env` y la base ya tiene datos | Recupera la llave del respaldo y pégala en el `.env`; **no** la pierdas: sin ella los datos son irrecuperables |
| El móvil no abre la cámara | Contexto no seguro | Usa la dirección `https://` y acepta el certificado |
| «Marca de tiempo fuera de rango» al enviar | El reloj del dispositivo se desvía más de 60 s | Activa la hora automática en el dispositivo y recarga |
| Las notificaciones push no llegan | El navegador exige HTTPS o permiso | Sirve por `https://`, concede el permiso y prueba con el botón de Ajustes |
| El supervisor se reinicia en bucle | Fallo de arranque (p. ej. puerto ocupado) | Arranca `node server.js` a mano para ver el error real |
| El cliente no carga | Ficheros estáticos bloqueados por un proxy | Comprueba que el proxy sirve `/` y `/sw.js` |

Guía completa: [`docs/INSTALACION.md`](docs/INSTALACION.md#10-diagnóstico).

---

## Documentación

| Documento | Contenido |
| --- | --- |
| [`docs/INSTALACION.md`](docs/INSTALACION.md) | Instalación en Linux, Termux, Windows y macOS; arranque; systemd, pm2 y Termux:Boot; configuración; certificados; respaldos; diagnóstico |
| [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) | Componentes, arranque, ciclo de una petición, estado en memoria, algoritmos (privacidad, paginación, caché, límites, borrados, grupos, historias), WebSocket, llamadas y operación |
| [`docs/CRIPTOGRAFIA.md`](docs/CRIPTOGRAFIA.md) | Llave maestra, cifrado en reposo (`PCE1`/`PCE2`/`PCE3`), derivación MTProto 2.0, firmas Ed25519, rotación, migración y modelo de amenazas |
| [`docs/ESQUEMA-BD.md`](docs/ESQUEMA-BD.md) | Esquema v3 tabla por tabla, índices, cascadas de borrado, base de adjuntos e invariantes |
| [`docs/API.md`](docs/API.md) | Todas las rutas HTTP (método, autenticación, cuerpo y respuesta) y el protocolo del WebSocket |
| [`docs/FICHEROS.md`](docs/FICHEROS.md) | Mapa fichero por fichero: qué hace cada uno, qué exporta y dónde tocar para cada tarea |

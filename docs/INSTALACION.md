# Instalación de Zlapy

Guía completa para instalar, arrancar, verificar y mantener Zlapy (servidor
Node.js + SQLite + WebSocket) en Linux, Android (Termux), Windows y macOS.

- [1. Requisitos](#1-requisitos)
- [2. Instalación paso a paso](#2-instalación-paso-a-paso)
- [3. Configuración inicial](#3-configuración-inicial)
- [4. Arranque](#4-arranque)
- [5. Ejecutar como servicio](#5-ejecutar-como-servicio)
- [6. Verificación de la instalación](#6-verificación-de-la-instalación)
- [7. Certificados HTTPS](#7-certificados-https)
- [8. Copias de seguridad y restauración](#8-copias-de-seguridad-y-restauración)
- [9. Actualizar](#9-actualizar)
- [10. Diagnóstico](#10-diagnóstico)
- [11. Red local y exposición a internet](#11-red-local-y-exposición-a-internet)

---

## 1. Requisitos

### 1.1 Node.js

**Node 22 o superior es obligatorio.** No es una recomendación: está declarado
en dos sitios y en los dos casos es un requisito duro.

| Dónde | Qué dice | Consecuencia |
| --- | --- | --- |
| `package.json` → `engines.node` | `">=22"` | `npm install` avisa (y con `engine-strict` falla) si bajas de 22 |
| `better-sqlite3@13.0.3` → `engines.node` | `">=22"` | El paquete también queda fuera de rango por debajo de 22 (y el proyecto usa funciones de Node moderno) |

Comprueba la versión antes de nada:

```bash
node --version    # debe ser v22.x o superior
npm --version
```

Si necesitas instalar Node 22:

| Sistema | Comando / fuente |
| --- | --- |
| Linux (Debian/Ubuntu) | `sudo apt install nodejs npm` (puede ser anterior a 22 → usa [Nodesource](https://github.com/nodesource/distributions) o `nvm`) |
| Linux (Fedora/Arch) | `sudo dnf install nodejs` / `sudo pacman -S nodejs npm` |
| Windows | Instalador oficial de <https://nodejs.org> o `winget install OpenJS.NodeJS.LTS` |
| macOS | `brew install node@22` o el instalador oficial de <https://nodejs.org> |
| Termux (Android) | `pkg install nodejs` (comprueba `node -v`) |

### 1.2 Herramientas de compilación

`better-sqlite3` es un **módulo nativo**: incluye un binding de C++ que se
compila (o se descarga como binario precompilado) durante la instalación.

**En la mayoría de plataformas no hace falta compilar nada**: `better-sqlite3`
v13.0.3 trae binarios precompilados para:

| Prebuild | Plataforma |
| --- | --- |
| `linux-x64`, `linux-arm64` | Linux glibc |
| `linuxmusl-x64`, `linuxmusl-arm64` | Linux musl (Alpine) |
| `darwin-x64`, `darwin-arm64` | macOS |
| `win32-x64`, `win32-arm64` | Windows |

**Excepción: Termux/Android.** Ahí `process.platform` es `android`, para el que
**no existe prebuild**: hay que compilar el módulo en el propio dispositivo.
Por eso el script `postinstall` del proyecto comprueba que el binario nativo
existe y avisa con las instrucciones exactas.

Si te toca compilar, necesitas el toolchain de `node-gyp`:

| Herramienta | Para qué | Debian/Ubuntu | Fedora | Arch |
| --- | --- | --- | --- | --- |
| Python 3 | `node-gyp` ejecuta `python3` para configurar la compilación | `sudo apt install python3` | `sudo dnf install python3` | `sudo pacman -S python` |
| make | drive de compilación | `sudo apt install build-essential` | `sudo dnf install make` | `sudo pacman -S make` |
| C++17 (`g++` o `clang`) | compilar el binding | `sudo apt install build-essential` | `sudo dnf install gcc-c++` | `sudo pacman -S base-devel` |

Comprobación rápida de que el toolchain está completo:

```bash
python3 --version && make --version && g++ --version
```

### 1.3 Otros requisitos

| Requisito | Detalle |
| --- | --- |
| `git` | Para clonar el repositorio |
| `openssl` | Solo si quieres HTTPS autofirmado (Linux: `sudo apt install openssl`; Termux: `pkg install openssl`) |
| `cloudflared` | Solo si quieres exponer el servidor a internet (`npm run tunnel`) |
| `curl` | Para comprobar `/healthz` |
| Espacio en disco | Dependencias + bases + adjuntos (los vídeos y audios se guardan como blobs en `data/blob.db`) |

---

## 2. Instalación paso a paso

### 2.0 Los tres pasos comunes a todas las plataformas

1. **Clonar** el repositorio.
2. **Instalar dependencias** con `npm ci` (usa `package-lock.json`, versionado, y
   por tanto es reproducible) o `npm install`.
3. **Crear la configuración y el directorio de datos**: `cp .env.example .env` y
   `mkdir -p data`.

> **El directorio de datos debe existir.** El código abre `data/zlapy.db` y
> `data/blob.db` con SQLite, y SQLite **no crea el directorio**: si falta, el
> arranque aborta con `Cannot open database because the directory does not exist`.
> Si configuras `DATA_DIR` a otra ruta, crea también ese directorio.

### 2.1 Linux (Debian/Ubuntu, Fedora, Arch)

#### Debian / Ubuntu

```bash
# Dependencias del sistema (solo si vas a compilar; en x64/arm64 hay prebuild)
sudo apt update
sudo apt install -y git python3 make g++ build-essential

# Node 22+ (si tu distro trae una versión anterior, usa Nodesource o nvm)
node --version   # debe ser v22 o superior

# Clonar e instalar
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci

# Configuración y datos
cp .env.example .env
mkdir -p data
```

#### Fedora

```bash
sudo dnf install -y git python3 make gcc-c++ gcc-c++-make
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
cp .env.example .env
mkdir -p data
```

#### Arch

```bash
sudo pacman -S --needed git base-devel python
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
cp .env.example .env
mkdir -p data
```

#### Si `npm ci` falla al compilar `better-sqlite3`

En Linux, macOS y Windows con arquitectura soportada **no debería ocurrir**
(los prebuilds cubren `linux-x64/arm64`, `linuxmusl-x64/arm64`,
`darwin-x64/arm64` y `win32-x64/arm64`). Si ocurre, el error típico de
`node-gyp` es que falta Python o falta un compilador: instala el toolchain de
la tabla 1.2 y compila a mano:

```bash
npm run rebuild:sqlite
```

> **Aviso verificado en esta versión:** con `better-sqlite3@13.0.3` el paquete
> **ya no trae script `install`** y declara `"gypfile": false`. Por eso
> `npm rebuild better-sqlite3` **no compila nada** (imprime "rebuilt
> dependencies successfully" y no genera ningún binario), **tampoco con
> `--build-from-source`**: no hay script que ejecutar. La única vía que
> funciona es invocar `node-gyp` explícitamente, como hace
> `npm run rebuild:sqlite` (`ops/build-sqlite.js`).
>
> Eso deja el binario en `node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
> que es una de las rutas que comprueba el `postinstall` del proyecto.
>
> El `postinstall` del proyecto (`ops/check-native.js`) **intenta compilar
> solo** cuando falta el binario, así que en Android/Termux `npm ci` ya
> compila el módulo sin pasos extra.

#### Verificar que el binario nativo está en su sitio

El `postinstall` del proyecto ya lo hace al instalar; si quieres comprobarlo a
mano:

```bash
node -e "console.log(require.resolve('better-sqlite3/package.json'))"
ls node_modules/better-sqlite3/prebuilds/     # prebuild descargado
ls node_modules/better-sqlite3/build/Release/  # o compilado a mano
```

### 2.2 Termux (Android)

En Android, `better-sqlite3` **no tiene prebuild** (`platform` = `android`), así
que hay que compilarlo en el móvil. Requiere instalar Termux desde **F-Droid**
(la versión de Play Store está obsoleta).

#### Instalación manual

```bash
# 1. Paquetes del sistema: python, make, clang y sqlite
pkg update && pkg upgrade -y
pkg install python make clang sqlite git nodejs openssl

# 2. Clonar
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat

# 3. Instalar dependencias
npm ci
#    El postinstall comprueba el binario nativo y, como en Android no hay
#    prebuild, lo compila en el dispositivo. Tarda varios minutos: deja el
#    teléfono enchufado y no cierres la terminal.

# 4. Si la compilación falló (faltaba el toolchain), instálalo y repite:
pkg install python make clang
npm run rebuild:sqlite

# 5. Arrancar
npm start
```

> **npm 12 o superior.** Los *scripts de instalación* de las dependencias
> están bloqueados por defecto, así que npm puede pedirte aprobar el de
> `better-sqlite3`:
>
> ```bash
> npm install-scripts approve better-sqlite3
> npm run rebuild:sqlite
> ```
>
> El proyecto ya lo aprueba en su `package.json` (campo `allowScripts`), así
> que normalmente no hace falta. El aviso de npm sobre `better-sqlite3` es un
> error conocido de npm con la versión 13 de ese paquete: el paquete **sí**
> trae los binarios precompilados dentro del tarball (funciona en Linux,
> macOS y Windows); en Android no existe ninguno y hay que compilar.

El `.env` y la llave maestra **se crean solos** en la primera ejecución
(el `.env` a partir de `.env.example`, y la llave maestra escrita en su
línea `CHAT_MASTER_KEY`), así que no hace falta ningún paso de configuración
manual.

Compilar `better-sqlite3` en un móvil ARM tarda varios minutos: no cierres la
terminal y deja el teléfono enchufado (evita que Android mate el proceso).

#### Script todo-en-uno: `npm run termux`

```bash
npm run termux
```

Equivale exactamente a:

```
pkg update && pkg upgrade -y && pkg install python make clang sqlite
  && npm i --ignore-scripts && npm run rebuild:sqlite
  && node ops/check-native.js && npm start
```

Es decir: instala los paquetes de Termux, instala las dependencias **sin**
scripts (para que el `postinstall` no falle antes de compilar), compila
`better-sqlite3` en el dispositivo, comprueba el binario y arranca el servidor.

#### Almacenamiento externo (opcional)

Si quieres los datos o los respaldos en la tarjeta SD:

```bash
termux-setup-storage      # concede acceso a /sdcard (Android 11+ lo restringe)
```

Después, en `.env`: `DATA_DIR=/sdcard/Download/zlapy-data` (crea el
directorio antes) y para los respaldos: `npm run backup -- /sdcard/Download/zlapy-backups`.

#### Mantener el móvil vivo

Android suspende las apps en segundo plano y puede cerrar el proceso de
Termux. Para evitarlo:

```bash
termux-wake-lock
```

### 2.3 Windows (PowerShell / CMD)

```powershell
# 1. Node 22+ (winget o instalador oficial de nodejs.org)
winget install OpenJS.NodeJS.LTS
node --version

# 2. Clonar
git clone https://github.com/zendtay-studio/zlapy-chat.git
Set-Location zlapy-chat

# 3. Dependencias
npm ci

# 4. Configuración y datos
Copy-Item .env.example .env
New-Item -ItemType Directory -Force data | Out-Null
```

En CMD equivalente:

```cmd
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
copy .env.example .env
mkdir data
```

**Notas específicas de Windows:**

- En x64 y ARM64 hay prebuild (`win32-x64`, `win32-arm64`): **no hace falta
  Visual Studio** ni Python para instalar.
- Si el prebuild no sirviera, habría que instalar **Build Tools de Visual
  Studio** (carga de trabajo "Desarrollo de C++") y **Python 3**, y compilar
  con `node-gyp` como en Linux.
- `npm test` funciona igual: Node 22 resuelve el patrón `test/*.test.js` por
  su cuenta (no depende del intérprete de comandos).
- Ejecuta siempre desde la raíz del proyecto: `DATA_DIR=data` es una ruta
  **relativa al directorio de trabajo actual**.

### 2.4 macOS (Homebrew)

```bash
# 1. Node 22+
brew install node@22
# (o `brew install node` para la última LTS)
# node@22 es "keg-only": para que `node` apunte a él, enlázalo
brew link --force --overwrite node@22
node --version

# 2. Clonar e instalar
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci

# 3. Configuración y datos
cp .env.example .env
mkdir -p data
```

En Apple Silicon (arm64) e Intel (x64) hay prebuild: **no hace falta Xcode ni
compilador**.

---

## 3. Configuración inicial

### 3.1 El fichero `.env`

El servidor **y** el supervisor leen el **mismo** `.env` de la raíz del
proyecto (con `dotenv`). Las variables ya presentes en el entorno tienen
prioridad sobre el fichero, por eso `PORT=3001 npm start` manda sobre el
`PORT` del `.env`.

```bash
cp .env.example .env
chmod 600 .env          # contiene la llave maestra: solo tú debes leerlo
```

Los valores se **validan al arrancar** (`src/config.js`): un valor fuera de
rango aborta el arranque con un mensaje explícito
(`PORT must be between 1 and 65535`). **Después de editar el `.env` hay que
reiniciar el servidor.**

#### Variables más habituales

| Variable | Por defecto | Qué hace | Rango válido |
| --- | ---: | --- | --- |
| `PORT` | `3000` | Puerto TCP donde escucha el servidor (http **y** https en el mismo puerto) | 1–65535 |
| `DATA_DIR` | `data` | Carpeta de `zlapy.db` y `blob.db`. Vacío = `data/` dentro del proyecto | Ruta (relativa al CWD) |
| `CHAT_MASTER_KEY` | *(vacío)* | Clave maestra Base64 de exactamente 32 bytes. Vacía = el servidor la genera en el primer arranque (base sin datos) y la guarda en esta línea | Base64 de 32 bytes |
| `MESSAGE_DIRECT_CHAR_LIMIT` | `10000` | Máx. caracteres por mensaje directo | 1–1 000 000 |
| `MESSAGE_GROUP_CHAR_LIMIT` | `15000` | Máx. caracteres por mensaje de grupo | 1–1 000 000 |
| `STORY_TEXT_CHAR_LIMIT` | `140` | Máx. caracteres del texto de una historia | 1–100 000 |
| `PROFILE_DESCRIPTION_CHAR_LIMIT` | `140` | Máx. caracteres de la descripción del perfil | 1–100 000 |
| `MESSAGE_RATE_LIMIT` | `30` | Mensajes máximos por ventana, por cuenta | 1–1 000 000 |
| `MESSAGE_RATE_WINDOW_MS` | `60000` | Tamaño de la ventana del límite (60 000 = 1 min) | 1–31 536 000 000 |
| `MAX_AUDIO_DURATION_MS` | `60000` | Duración máxima de una nota de voz (60 000 = 1 min) | 1 000–3 600 000 |
| `MAX_HTTP_BODY_BYTES` | `33554432` | Tamaño máximo del cuerpo de una petición (32 MiB) | 1 024–1 073 741 824 |
| `MAX_MESSAGE_DATA_CHARS` | `24000000` | Máx. caracteres de datos multimedia cifrados por mensaje | ≤ `MAX_HTTP_BODY_BYTES` |
| `MAX_GALLERY_ITEMS` | `20` | Elementos máximos por galería | 2–100 |
| `MAX_GALLERY_ENCODED_CHARS` | `24000000` | Caracteres codificados máximos de una galería | ≤ `MAX_HTTP_BODY_BYTES` |
| `NOTE_TTL_MS` | `86400000` | Vigencia de la nota de perfil (24 h) | 60 000–2 592 000 000 |
| `STORY_TTL_MS` | `86400000` | Vigencia de las historias (24 h) | 60 000–2 592 000 000 |
| `CHAT_PAGE_CACHE_TTL_MS` | `10000` | Tiempo en caché de una página de chat (0 = sin reutilizar) | 0–3 600 000 |
| `CHAT_PAGE_CACHE_MAX` | `20` | Páginas de chat guardadas en caché (0 = sin caché) | 0–100 000 |
| `SQLITE_CACHE_SIZE_KB` | `64000` | Caché de SQLite en KiB por conexión | 1 024–1 048 576 |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | Espera máxima de SQLite ante una base ocupada | 0–60 000 |
| `AUTH_SESSION_TTL_MS` | `2592000000` | Vigencia de la sesión de autenticación (30 días) | 60 000–31 536 000 000 |
| `CLOUDFLARE_TUNNEL_TOKEN` | *(vacío)* | Token del túnel de Cloudflare (lo usa `npm run tunnel`) | — |
| `GIPHY_API_KEY` | *(vacío)* | Clave de Giphy para los stickers (solo la usa el servidor) | — |

#### Variables del supervisor (`SUPERVISOR_*`)

Solo tienen efecto sobre `npm start` (el supervisor), no sobre `node server.js`.

| Variable | Por defecto | Qué hace |
| --- | ---: | --- |
| `SUPERVISOR_PID_FILE` | `.zlapy.pid` | Fichero donde se publica el PID del servidor hijo (se resuelve **desde la raíz del proyecto**) |
| `SUPERVISOR_HEALTH_PATH` | `/healthz` | Ruta que el supervisor consulta para saber si el servidor está sano |
| `SUPERVISOR_HEALTH_PORT` | *(vacío)* | Puerto inicial del health check; el supervisor lo sustituye por el que el hijo anuncia en su banner |
| `SUPERVISOR_HEALTH_MS` | `15000` | Cada cuánto se comprueba la salud (ms) |
| `SUPERVISOR_STARTUP_MS` | `30000` | Gracia de arranque antes de exigir respuesta (ms) |
| `SUPERVISOR_HEALTH_TIMEOUT_MS` | `5000` | Tiempo de espera de cada comprobación (ms) |
| `SUPERVISOR_FAILURES_BEFORE_KILL` | `3` | Fallos de salud consecutivos antes de matar y reiniciar el hijo |
| `SUPERVISOR_BACKOFF_MS` | `1000` | Backoff inicial entre reinicios (1 s → 2 s → 4 s…) |
| `SUPERVISOR_BACKOFF_MAX_MS` | `30000` | Backoff máximo (30 s) |
| `SUPERVISOR_MAX_RESTARTS` | `10` | Fallos de **arranque** consecutivos antes de abrir el cortacircuito (0 = sin tope) |
| `SUPERVISOR_HOT_CRASH_THRESHOLD` | `5` | Caídas en caliente seguidas a partir de las cuales se avisa del crash-loop (el servicio **no** se apaga) |
| `SUPERVISOR_STABLE_MS` | `60000` | Tiempo sano necesario para olvidar la racha de fallos anteriores |

### 3.2 La llave maestra

El servidor cifra los datos en reposo (mensajes, historias, adjuntos, claves de
push, clave VAPID) con una llave maestra de 32 bytes. Hay dos formas de
tenerla:

| Forma | Dónde vive | Cuándo usarla |
| --- | --- | --- |
| `CHAT_MASTER_KEY` en `.env` | Línea del `.env`, base64 de 32 bytes, modo `600` | Única ubicación. **Se genera sola** en el primer arranque si la base no tiene cuentas. Para gestores de agentes externos: exporta la variable o inyecta el `.env` |

Generar la llave en el `.env` (no se muestra por pantalla):

```bash
npm run key                 # genera una clave nueva (falla si ya hay una)
npm run key -- --force      # gírala: re-cifra el almacenamiento si la base ya tiene datos (o -f)
npm run key -- --null       # vacía CHAT_MASTER_KEY en el .env (o -n)
```

Notas verificadas:

- `npm run key` **crea el `.env`** si no existe (a partir de `.env.example`) y
  necesita que tenga **exactamente una** línea `CHAT_MASTER_KEY=`. Si hay cero
  o dos, falla con `Expected exactly one CHAT_MASTER_KEY assignment in ...`.
- En la **primera instalación** no hace falta ejecutar `npm run key`: el
  servidor crea el `.env` (a partir de `.env.example`, modo `600`) y genera la
  llave maestra en la línea `CHAT_MASTER_KEY` del `.env` (modo `600`) si la
  base de datos está vacía.
- Con `--force` se **gira** la clave. Si la base ya tiene material que
  depende de la maestra (`ops/reencrypt-master.js`), el comando **verifica**
  que la clave vigente descifra todo (auth_key de usuarios, material E2E de
  grupos, VAPID y adjuntos), copia el `.env` en `.env.master-bak` y
  **re-cifra cada dependencia con la nueva** en transacciones SQLite:
  no se pierde nada. Si algo falla, la reversión compensada devuelve todo
  al estado previo. El único hueco: un corte de luz/SIGKILL justo a mitad
  depende del respaldo `.env.master-bak` (dura milisegundos; no interrumpas
  el proceso a mano).
- Si `CHAT_MASTER_KEY` **falta y ya hay una base con datos**, el arranque
  **aborta** con un error claro en vez de regenerarla en silencio
  (`src/crypto/master-key.js`). Es a propósito: una llave nueva haría
  ilegibles todos los mensajes, historias y adjuntos.
- Si defines `CHAT_MASTER_KEY`, el valor debe codificar **exactamente 32 bytes**
  en base64; si no, el arranque falla con
  `CHAT_MASTER_KEY must encode exactly 32 bytes`.

### 3.3 Permisos recomendados

```bash
chmod 600 .env            # contiene la llave maestra
chmod 700 data            # bases + adjuntos
```

El **servidor los aplica solo en cada arranque** (`server.js`, paso 0): fija
`0700` en `data/` (y en `data2/`/`backups/` si existen) y `0600` en
`zlapy.db`, `blob.db` y `.env`. Los comandos de arriba solo hacen falta si
copias bases a mano fuera del servidor. El `chmod` es *best-effort*: si el
sistema no lo permite (otro dueño, sistema sin permisos POSIX), el servidor
sigue arrancando y lo dice por el log (`[perms] no se pudieron ajustar …`);
romper el arranque por un permiso sería peor que avisar. El fichero de PID
del supervisor (`.zlapy.pid`) se escribe con `0600` desde el código.

---

## 4. Arranque

### 4.1 `npm start` (con supervisor)

```bash
npm start
```

Arranca `ops/supervisor.js`, que **no** es el servidor: es el guardián que lo
mantiene vivo.

| Qué hace el supervisor | Detalle |
| --- | --- |
| Lanza el hijo | `node server.js` desde la raíz del proyecto, heredando el entorno (y por tanto el `.env`) |
| Publica el PID | Lo escribe en `SUPERVISOR_PID_FILE` (por defecto `.zlapy.pid`) |
| Watchdog de salud | Cada `SUPERVISOR_HEALTH_MS` (15 s) consulta `/healthz`; **solo un 2xx cuenta como sano** |
| Reinicio por cuelgue | Tras `SUPERVISOR_FAILURES_BEFORE_KILL` (3) fallos seguidos, envía `SIGTERM` y, si el hijo no muere, `SIGKILL` a los 5 s |
| Backoff exponencial | 1 s → 2 s → 4 s … hasta `SUPERVISOR_BACKOFF_MAX_MS` (30 s). Nunca hay bucle rápido |
| Detecta el puerto real | Lee del banner del hijo (`✅ Zlapy (SQLite) en el puerto NNNN`) el puerto en el que escucha y sondea ese, no el supuesto |
| Cortacircuito | Tras `SUPERVISOR_MAX_RESTARTS` (10) **fallos de arranque** consecutivos, deja de reintentar y sale con **código 70** |
| Caída en caliente | Si el hijo ya servía y se cae, **siempre** reinicia con el backoff topado y avisa a partir de 5 caídas seguidas. **Nunca deja el servicio apagado** |
| Apagado ordenado | Propaga `SIGTERM`/`SIGINT` al hijo, que cierra sockets, hace checkpoint del WAL y cierra las bases |

> Ejecuta `npm start` **en un solo sitio**. Dos instancias se pelean el puerto:
> la segunda muere con «Puerto ocupado» y su supervisor entra en backoff hasta
> abrir el cortacircuito.

### 4.2 `node server.js` (sin supervisor, para depurar)

```bash
node server.js
```

Arranca el servidor directamente: **sin watchdog, sin backoff y sin
reinicio automático**. Es el modo indicado para depurar, para ver la traza
completa de un fallo de arranque o para correr bajo un gestor externo que ya
haga de supervisor.

Diferencias prácticas:

- Un fallo de arranque se ve completo en pantalla (el supervisor lo envuelve en
  reintentos con backoff).
- Si el proceso se cae, **se queda caído**.
- Las variables `SUPERVISOR_*` no tienen efecto.
- El cierre es el mismo: `SIGTERM`/`SIGINT` cierran sockets, hacen checkpoint
  del WAL y cierran las bases.

### 4.3 Abrir el firewall (Linux)

El servidor escucha en `0.0.0.0`, así que hace falta permitir el puerto para
que el móvil pueda entrar.

```bash
# ufw (Debian/Ubuntu)
sudo ufw allow 3000/tcp
sudo ufw status

# firewalld (Fedora)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

En un servidor **en internet** no abras el puerto directamente: usa el túnel
de Cloudflare (§11.3).

### 4.4 Qué direcciones imprime

Al arrancar, el servidor muestra sus URLs:

```
✅ Zlapy (SQLite) en el puerto 3000

   Esta PC:   http://localhost:3000
   Tu red:    http://192.168.1.50:3000

   HTTPS:
               https://localhost:3000
               https://192.168.1.50:3000
```

El bloque de HTTPS solo aparece si existen `cert.pem` y `key.pem` en la raíz
del proyecto (§7).

---

## 5. Ejecutar como servicio

El supervisor **ya es** un autoarranque: reinicia el servidor si se cae. Un
gestor externo (systemd, pm2, Termux:Boot) solo hace falta si quieres que
**el propio supervisor** reviva tras un reinicio del sistema.

> No ejecutes `npm start` a mano y a la vez como servicio: Pelean por el puerto.

### 5.1 systemd (Linux)

Crea un usuario de sistema y el directorio de la aplicación:

```bash
sudo adduser --system --group --home /opt/zlapy-chat --no-create-home zlapy
sudo git clone https://github.com/zendtay-studio/zlapy-chat.git /opt/zlapy-chat
sudo chown -R zlapy:zlapy /opt/zlapy-chat
```

Fichero de unidad `/etc/systemd/system/zlapy.service`:

```ini
[Unit]
Description=Zlapy (chat local Node.js + SQLite)
Documentation=https://github.com/zendtay-studio/zlapy-chat
After=network-online.target
Wants=network-online.target
# Evita una tormenta de reinicios si el servicio falla en bucle:
# como máximo 10 arranques en 5 minutos.
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=zlapy
Group=zlapy
WorkingDirectory=/opt/zlapy-chat
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/zlapy-chat/ops/supervisor.js
Restart=always
RestartSec=5
# El cortacircuito del supervisor sale con código 70 (EX_SOFTWARE).
# Con Restart=always systemd lo reinicia igualmente; si prefieres que el
# servicio se quede parado cuando el cortacircuito salta, usa esta línea
# en lugar de Restart=always:
#   Restart=on-failure
#   SuccessExitStatus=70
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zlapy

[Install]
WantedBy=multi-user.target
```

Activar y arrancar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zlapy
systemctl status zlapy
journalctl -u zlapy -f          # logs en vivo
journalctl -u zlapy -n 100      # últimas 100 líneas
sudo systemctl restart zlapy    # reiniciar (lee el .env otra vez)
sudo systemctl stop zlapy
```

Notas:

- `WorkingDirectory` **importa**: el `.env`, el `DATA_DIR=data` relativo y el
  `.zlapy.pid` se resuelven desde la raíz del proyecto. `ExecStart` debe usar
  la ruta **absoluta** de Node (compruébala con `which node`).
- `Environment=NODE_ENV=production` es la convención habitual, pero **el código
  de Zlapy no lee `NODE_ENV`**: no cambia ningún comportamiento. No lo uses
  como si activara un "modo producción".
- El usuario de servicio necesita **escritura** en el directorio del proyecto
  (`data/`, `.zlapy.pid`) y lectura del `.env` (que contiene la llave
  maestra).
- El supervisor escribe el PID del hijo en `/opt/zlapy-chat/.zlapy.pid`.

### 5.2 pm2

```bash
npm i -g pm2

cd /ruta/zlapy-chat
pm2 start ops/supervisor.js --name zlapy

pm2 status              # estado
pm2 logs zlapy          # logs en vivo
pm2 monit               # monitor
pm2 restart zlapy       # reiniciar (relee el .env)
pm2 save                # guarda la lista de procesos
pm2 startup             # imprime la línea que hay que ejecutar con sudo
```

`pm2 startup` imprime un comando `sudo env PATH=... pm2 startup systemd -u
$USER --hp $HOME`: **ejecuta esa línea tal cual** (con `sudo`) para que pm2 se
arranque al iniciar el sistema, y luego `pm2 save` otra vez.

Notas:

- Lanza pm2 **desde la raíz del proyecto**: pm2 usa ese directorio de trabajo
  y de ahí se resuelve el `.env` y el `DATA_DIR=data` relativo.
- `pm2 restart zlapy` reinicia el supervisor, que a su vez reinicia el hijo.
- Para quitarlo: `pm2 delete zlapy && pm2 save`.
- pm2 no aplica el `.env` por sí mismo: lo carga `dotenv` dentro del proceso,
  igual que en el resto de casos.

### 5.3 Termux:Boot (autoarranque en Android)

1. Instala la app **Termux:Boot** desde F-Droid (es una app aparte).
2. Crea el script de arranque:

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/zlapy <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Autoarranque de Zlapy en Android (Termux:Boot)
cd "$HOME/zlapy-chat" || exit 1
# Mantiene el dispositivo despierto mientras el servidor corre:
termux-wake-lock 2>/dev/null
exec npm start
EOF
chmod +x ~/.termux/boot/zlapy
```

3. Reinicia el móvil (o abre la app Termux:Boot y ejecuta el script) y comprueba
   que el servidor responde:

```bash
curl http://localhost:3000/healthz
```

Notas:

- El script debe ser **ejecutable** (`chmod +x`), si no Termux:Boot lo ignora.
- Ajusta la ruta a la tuya si clonaste el repositorio en otro sitio.
- `termux-wake-lock` evita que Android suspenda el proceso; sin él, el
  servidor puede morir con la pantalla apagada.
- Si tu `.env` usa `DATA_DIR` dentro de `/sdcard`, recuerda que Android 11+
  restringe el acceso: usa el almacenamiento interno de Termux
  (`~/zlapy-chat/data`) para los datos.

---

## 6. Verificación de la instalación

### 6.1 Health check

```bash
curl http://localhost:3000/healthz
```

Respuesta esperada (200):

```json
{"ok":true,"schema":3,"uptime":42}
```

- `ok: true` → el servidor responde **y ambas bases** (`zlapy.db` y `blob.db`)
  contestan a una consulta.
- `schema: 3` → versión del esquema de la base de datos.
- `uptime` → segundos desde el arranque.

Si la base no responde, el mismo endpoint devuelve **503**:

```json
{"ok":false,"error":"database unavailable"}
```

`/healthz` es **público** y no expone datos de usuarios.

Con HTTPS:

```bash
curl -k https://localhost:3000/healthz
```

### 6.2 En el navegador

1. Abre `http://localhost:3000` (en el PC) o `http://<IP-del-PC>:3000` (en el
   móvil, misma WiFi).
2. Pulsa **«Crear cuenta»**, elige un usuario (**3–24 caracteres**, minúsculas,
   números, `_`, `.` o `-`) y una contraseña (de **8 a 128** caracteres).
3. Entra y comprueba que la lista de contactos aparece vacía.

Para las **llamadas con cámara/micrófono** en el móvil usa la dirección
**HTTPS** (ver §7): los navegadores solo dan cámara y micrófono en un
*contexto seguro*.

### 6.3 Suite de pruebas

```bash
npm test
```

Ejecuta `node --test test/*.test.js` (Node resuelve el patrón por su cuenta, así
que funciona igual en PowerShell, CMD y shells Unix). La suite levanta
servidores en puertos libres con directorios de datos temporales, no toca tu
`data/` y no interfiere con el servidor en marcha.

Referencia actual: **92 pruebas, todas en verde** (~20 s).

---

## 7. Certificados HTTPS

### 7.1 Por qué hacen falta

| Motivo | Detalle |
| --- | --- |
| Cámara y micrófono | Los navegadores solo los conceden en un **contexto seguro**: `https://` o `localhost`. En el móvil, `http://192.168.x.x` **no** es contexto seguro → las llamadas fallan |
| Notificaciones push | La **Push API** y los *service workers* exigen un origen seguro: `https://` (o `localhost`). Sin HTTPS no hay push |
| HSTS | Cuando la conexión va cifrada, el servidor envía `Strict-Transport-Security: max-age=31536000` |

### 7.2 Generación

El servidor sirve **http y https en el mismo puerto**: un despachador lee el
primer byte de la conexión y, si es `0x16` (el inicio de un *handshake* TLS),
lo pasa al servidor HTTPS (`src/http/servers.js`). Por eso no hay dos puertos
ni dos direcciones que recordar.

```bash
cd /ruta/zlapy-chat
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=zlapy"
```

Resultado:

- `cert.pem` y `key.pem` en la **raíz del proyecto**.
- Si existen ambos, el arranque activa HTTPS automáticamente y el banner
  muestra el bloque `HTTPS:`.
- Si borras o renuevas los certificados, **reinicia el servidor**.

Regenerar el certificado (por ejemplo, tras 365 días):

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=zlapy"
```

> `cert.pem` y `key.pem` están en `.gitignore`: no se suben al repositorio.
> En Termux: `pkg install openssl`.

### 7.3 Aceptar el certificado autofirmado

El certificado es autofirmado, así que el navegador mostrará un aviso de
seguridad (y además puede avisar de que el nombre `zlapy` no coincide con la
IP o el dominio por el que entras):

| Navegador | Cómo continuar |
| --- | --- |
| Chrome / Edge (Android, escritorio) | «Avanzado» → «Continuar a … (unsafe)» |
| Firefox | «Avanzado» → «Aceptar el riesgo y continuar» |
| Safari (iOS/macOS) | «Mostrar detalles» → «visitar este sitio web» → «Aceptar» |

En iOS, si instalaste el certificado en un perfil y no te fía, hay que
activarlo en **Ajustes → General → VPN e gestión de dispositivos → instalar el
certificado**.

> **Importante:** una vez que visitas la versión HTTPS, el navegador guarda la
> directiva HSTS (`max-age=31536000`). Si después quitas `cert.pem`/`key.pem`,
> el navegador seguirá forzando HTTPS durante ese periodo y la versión HTTP
> dejará de funcionar hasta que expire la caché HSTS.

---

## 8. Copias de seguridad y restauración

### 8.1 Crear un respaldo

```bash
npm run backup                 # → backups/zlapy-backup-<fecha-hora>/
npm run backup -- /ruta/dir    # destino a elegir (si ya existe, debe estar vacío)
```

Qué hace (`ops/backup.js`):

| Paso | Detalle |
| --- | --- |
| Copia `zlapy.db` | Con la API `backup()` de SQLite: **consistente aunque el servidor esté corriendo y con WAL activo** |
| Copia `blob.db` | Igual (adjuntos deduplicados por hash) |
| Llave maestra | Vive en el `.env` (`CHAT_MASTER_KEY`): el respaldo avisa de que **copies tú ese fichero** (o al menos esa línea) |
| Permisos | Directorio `0700`, ficheros `0600` (contienen usuarios, sesiones, hashes y mensajes cifrados) |
| Destino ocupado | Si la carpeta existe y **no está vacía**, aborta: no sobrescribe nada |

La llave maestra y las bases **siempre van juntas**: sin `CHAT_MASTER_KEY`
(la línea del `.env`), los mensajes, historias y adjuntos del respaldo son
**irrecuperables**. Guarda el respaldo **fuera** del disco de la aplicación
(por ejemplo, en `/sdcard`, en un disco externo o en otro equipo).

> Copiar solo el `.db` con el servidor corriendo **no** es un respaldo válido:
> el WAL queda fuera. Usa siempre `npm run backup`.

### 8.2 Restaurar

1. **Para el servidor** (`Ctrl+C` o `SIGTERM`; el cierre es ordenado y hace
   checkpoint del WAL):
   ```bash
   # con systemd:  sudo systemctl stop zlapy
   # con pm2:      pm2 stop zlapy
   ```
2. **Copia las bases** del respaldo a la carpeta de datos (`DATA_DIR`, por
   defecto `data/`):
   ```bash
   cp backups/zlapy-backup-<fecha>/zlapy.db data/zlapy.db
   cp backups/zlapy-backup-<fecha>/blob.db data/blob.db
   ```
   Borra los ficheros `-wal` y `-shm` que quedaron en `data/` (son de la base
   anterior):
   ```bash
   rm -f data/zlapy.db-wal data/zlapy.db-shm data/blob.db-wal data/blob.db-shm
   ```
3. **Restaura la llave maestra** en el `.env` (única ubicación):
   ```bash
   # edita .env y pon en CHAT_MASTER_KEY= la clave que guardaste con el respaldo
   chmod 600 .env
   ```
4. **Arranca y comprueba**:
   ```bash
   npm start
   curl http://localhost:3000/healthz     # → {"ok":true,"schema":3,...}
   ```
   Si el arranque falla con `No hay CHAT_MASTER_KEY en el .env y la base de
   datos ya contiene datos`, es que el paso 3 no se hizo bien.

---

## 9. Actualizar

```bash
cd /ruta/zlapy-chat

# 1. Respaldo antes de tocar nada
npm run backup

# 2. Actualizar el código
git pull

# 3. Reinstalar las dependencias (usa el package-lock.json versionado)
npm ci

# 4. Reiniciar
sudo systemctl restart zlapy     # o: pm2 restart zlapy / Ctrl+C y npm start
```

### Aviso importante: no hay migraciones

El esquema se aplica **de forma idempotente** al arrancar (`CREATE TABLE IF
NOT EXISTS`), pero **no existen migraciones**. Si una versión nueva cambia el
formato de la base, el servidor **se niega a arrancar**:

- `Formato de cifrado de la base no compatible (crypto_version=N)` →
  restaura la base desde un respaldo de `backups/` o arranca con una base
  nueva.
- `Database crypto version is incompatible with this server.` → mismo caso.
- `Database schema is incompatible: messages.<columna> is missing.` → la base
  es de un esquema anterior: restaura o empieza de cero.

Planifica las actualizaciones con esta regla: **si el esquema ha cambiado,
restaurar desde un respaldo o empezar con una base vacía**. No existe un
"upgrade" automático.

El script `npm run migrate:mtproto` es otra cosa: es la migración **manual** del
cifrado de los mensajes al formato de nube MTProto 2.0, no del esquema.

```bash
npm run migrate:mtproto            # simulación: dice lo que haría, no escribe nada
npm run migrate:mtproto -- --apply # migra de verdad (hace antes un respaldo)
```

Conviene **parar el servidor** mientras migra. Es idempotente y verifica cada
registro antes de tocarlo.

---

## 10. Diagnóstico

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `❌ Puerto 3000 ocupado. Usa PORT=3001 npm start` | `EADDRINUSE` en el despachador (`src/http/servers.js`): hay **otro Zlapy** (o el supervisor anterior) escuchando | Para el otro proceso (`systemctl stop zlapy`, `pm2 stop zlapy`) o cambia el puerto **en el `.env`** (`PORT=3001`) y reinicia. `PORT=3001 npm start` solo vale para esa ejecución puntual |
| El supervisor entra en bucle de «fallo de arranque» | El hijo muere antes de servir: casi siempre un error de configuración o de la base | Mira el error del hijo en la salida del supervisor; el mensaje concreto está unas líneas más arriba |
| `CIRCUITO ABIERTO: 10 fallos de arranque consecutivos …` y el proceso sale con **código 70** | Se agotó `SUPERVISOR_MAX_RESTARTS` (10) porque el servidor **nunca llegó a servir** | **Corrige la causa y arranca a mano** (`node server.js` para ver el error completo). Con systemd y `Restart=always`, systemd lo reintentará: usa `Restart=on-failure` + `SuccessExitStatus=70` si quieres que se quede parado |
| `CAÍDA EN CALIENTE (code=…, uptime=…) … El servicio no se queda apagado.` | El servidor ya servía y se ha caído. El supervisor reinicia **siempre** con el backoff topado y avisa a partir de 5 caídas | Mira el error del hijo (el supervisor reenvía su stdout/stderr tal cual). Suele ser un `uncaughtException` o una base inaccesible |
| `salud fallida x3 (el health check no responde); reiniciando pid …` | El proceso está **vivo pero colgado**: no devuelve un 2xx en `/healthz` | Comprueba a mano `curl http://localhost:3000/healthz`; si el puerto del `.env` no es el real, ajusta `SUPERVISOR_HEALTH_PORT` (el supervisor lo corrige solo con el banner, pero solo si el hijo llega a imprimirlo) |
| `Cannot open database because the directory does not exist` | La carpeta de datos no existe: SQLite **no crea directorios** | `mkdir -p data` (o `mkdir -p "$DATA_DIR"`); el directorio debe existir **antes** de arrancar |
| `No hay CHAT_MASTER_KEY en el .env y la base de datos ya contiene datos.` | La llave maestra no está en el `.env`, pero la base sí tiene datos (`src/crypto/master-key.js`) | **Pega la clave del respaldo en el `.env` (CHAT_MASTER_KEY=...)** (no generes una nueva: dejaría ilegibles todos los datos cifrados) |
| `Formato de cifrado de la base no compatible (crypto_version=N)` / `Database crypto version is incompatible with this server.` | La base es de una versión anterior del formato de cifrado. **No hay migraciones** | Restaura la base desde `backups/` o arranca con una base nueva (mueve `data/` a otra parte) |
| `Database schema is incompatible: messages.<columna> is missing.` | La base no tiene el esquema v3 | Igual que arriba: restaurar o empezar de cero |
| `No se encuentra el binario nativo de better-sqlite3 para android-arm64` (o `linux-x64`, …) | El `postinstall` del proyecto comprueba que exista el binario nativo y no lo encuentra | En Linux/macOS/Windows con arquitectura soportada: `npm install` descarga el prebuild; si falla, instala el toolchain (python3, make, g++) y compila (ver §2.1). **En Termux hay que compilar** (ver §2.2) |
| `npm rebuild better-sqlite3` dice «rebuilt dependencies successfully» pero no compila nada (tampoco con `--build-from-source`) | `better-sqlite3@13.0.3` **no tiene script `install`** y declara `"gypfile": false`: no hay nada que `npm rebuild` pueda ejecutar | Compila explícitamente: `cd node_modules/better-sqlite3 && npm exec -- node-gyp rebuild --release --force_build=1` |
| Error de `node-gyp` al instalar (`Python executable not found`, `g++ not found`, `make: command not found`) | Falta el toolchain de compilación | Debian/Ubuntu: `sudo apt install python3 make g++ build-essential`; Fedora: `sudo dnf install python3 make gcc-c++`; Arch: `sudo pacman -S base-devel python`; Termux: `pkg install python make clang sqlite` |
| `La clave maestra ya está configurada. Para generar otra, ejecuta: npm run key -- --force` | `npm run key` no sobrescribe una clave existente a propósito | `npm run key -- --force` (o `-f`) **solo si quieres reemplazarla**: los datos cifrados con la anterior quedan ilegibles |
| `Expected exactly one CHAT_MASTER_KEY assignment in …/.env` | El `.env` no existe o tiene la variable duplicada | `cp .env.example .env` y deja **una sola** línea `CHAT_MASTER_KEY=` |
| `No se encontró 'cloudflared' en el PATH.` | `cloudflared` no está instalado | Instálalo: <https://developers.cloudflare.com/cloudflared/install/> |
| `Falta CLOUDFLARE_TUNNEL_TOKEN en .env` | El token del túnel no está en el `.env` | `CLOUDFLARE_TUNNEL_TOKEN=eyJ...` en el `.env` (panel de Cloudflare → Zero Trust → Networks → Tunnels) |
| `No existe zty.yml. Cópialo desde el ejemplo:` | Falta la configuración del túnel | `cp zty.yml.example zty.yml` y edita tu dominio en `ingress` |
| El túnel levanta pero nadie entra | La regla `ingress` de `zty.yml` apunta a un puerto que no es el del servidor, o el dominio no resuelve | Comprueba `service: http://localhost:3000` en `zty.yml` y que `PORT` coincide |
| La **cámara o el micrófono** no funcionan en el móvil | `http://` no es contexto seguro | Usa **HTTPS** (§7) y acepta el certificado autofirmado |
| Las **notificaciones push** no llegan | La Push API exige un origen **HTTPS**, un navegador con soporte de Push, permiso concedido y que el sistema operativo no limite la actividad en segundo plano | Sirve por HTTPS, activa las notificaciones en Ajustes y prueba el envío; el servidor registra los fallos en `[push] N/M notificaciones fallidas` |
| El navegador insiste en HTTPS y `http://` ya no responde | HSTS: al visitar la versión HTTPS el servidor envía `Strict-Transport-Security: max-age=31536000` | Vuelve a servir los certificados (`cert.pem` + `key.pem`) o espera a que expire la caché HSTS del navegador |
| `401 {"error":"authentication required"}` al llamar a una ruta | La sesión no está iniciada o expiró | Inicia sesión en el navegador; las sesiones duran `AUTH_SESSION_TTL_MS` (30 días por defecto) |
| `403 {"error":"cross-origin request rejected"}` | La comprobación de origen: el `Origin` de la petición no coincide con el `Host` | Accede siempre por la **misma URL** que usaste para iniciar sesión (mismo host y puerto, `http` o `https` sin cambiar a mitad de sesión) |
| Los datos aparecen en un sitio y las bases en otro | `DATA_DIR=data` es una ruta **relativa al directorio de trabajo** | Arranca siempre desde la raíz del proyecto; en un servicio, `WorkingDirectory` debe apuntar a ella |
| Dos servidores se matan entre sí | `npm start` ejecutado en dos sitios a la vez | Deja una sola instancia: o el supervisor, o el servicio (systemd/pm2), nunca ambos |

---

## 11. Red local y exposición a internet

### 11.1 Averiguar la IP del PC

```bash
hostname -I
# o
ip addr show | grep "inet "
# o
ip -4 addr show scope global
```

El servidor ya las imprime al arrancar, en el bloque `Tu red:` del banner.

### 11.2 Por qué el móvil y el PC deben estar en la misma red

- El servidor escucha en `0.0.0.0`, así que responde a cualquier IP que
  llegue al puerto 3000.
- El móvil tiene que **alcanzar esa IP**: misma WiFi/router, sin «aislamiento
  de clientes» activado en el router y sin un firewall que bloquee el puerto.
- Desde fuera de tu red, la IP privada (`192.168.x.x`, `10.x.x.x`) **no
  existe**: no hay ruta. O usas una VPN hacia tu casa, o expones el servicio
  por un túnel.

Comprueba desde el móvil (con la app de terminal o el navegador):

```
http://192.168.1.50:3000/healthz
```

Si no responde, el problema es de red (WiFi distinto, aislamiento del router,
firewall), no de Zlapy.

### 11.3 Exponerlo a internet: una decisión consciente

Publicar el servidor en internet **no es un paso de la instalación**: es una
decisión que cambia el modelo de seguridad. Zlapy está diseñado para una
**red de confianza local**:

- Los mensajes **no van cifrados de extremo a extremo**: el servidor los
  descifra, los firma y los retransmite. Quien tenga acceso al servidor (o a
  un túnel que lo exponga) ve el contenido.
- El WebSocket y las sesiones viajan en claro sobre `http://` si no usas
  HTTPS.
- El túnel de Cloudflare **publica la instancia en internet** con la
  configuración que tú escribas.

Si aun así quieres salir a internet:

```bash
# 1. cloudflared instalado
# 2. Token en el .env
#    CLOUDFLARE_TUNNEL_TOKEN=eyJ...
# 3. Configuración del túnel
cp zty.yml.example zty.yml      # y edita el dominio en `ingress`

# 4. Con el servidor ya arrancado, en otra terminal:
npm run tunnel
```

Detalles del túnel (`ops/tunnel.js`):

- El token **nunca viaja en `argv`** (quedaría visible en `ps` y en
  `/proc/<pid>/cmdline`): se entrega por un fichero temporal `0600` dentro de
  un directorio `0700`, o por el entorno del proceso (`TUNNEL_TOKEN`) si tu
  `cloudflared` es antiguo y no admite `--token-file`.
- La salida del proceso se filtra para que el token **no aparezca en los logs**.
- Equivale a `cloudflared -config zty.yml tunnel run --token-file <fichero>`.

Riesgos y precauciones:

| Riesgo | Mitigación |
| --- | --- |
| La instancia queda accesible desde internet | Restringe el acceso en el panel de Cloudflare (`Access` / WAF / reglas de IP) |
| Sin E2E, quien entre ve los mensajes | No lo publiques en una red no confiable; activa HTTPS con un certificado válido (no autofirmado) |
| Fuerza bruta de contraseñas | El servidor ya bloquea por cuenta e IP, pero no publiques a ciegas: pon HTTPS y reglas de acceso |
| El túnel **no** protege los datos en reposo | Sigue haciendo falta `npm run backup` y guardar una copia del `.env` (o de su línea `CHAT_MASTER_KEY`) fuera del servidor |

---

## Anexo: comandos de un vistazo

| Comando | Qué hace |
| --- | --- |
| `npm ci` | Instala las dependencias exactas del `package-lock.json` (reproducible) |
| `npm install` | Instala/actualiza dependencias (ejecuta el `postinstall` que verifica el binario nativo) |
| `npm start` | Arranca el servidor **con supervisor** (`ops/supervisor.js`) |
| `node server.js` | Arranca el servidor **sin supervisor** (depuración) |
| `npm test` | Suite completa (`node --test test/*.test.js`) |
| `npm run backup [-- dir]` | Respaldo consistente de `zlapy.db` y `blob.db` (la llave va en el `.env`: cópialo aparte) |
| `npm run key [-- --force\|--null]` | Genera o vacía `CHAT_MASTER_KEY` en el `.env` |
| `npm run tunnel` | Túnel de Cloudflare (`cloudflared` + `zty.yml` + token en el `.env`) |
| `npm run termux` | Actualiza paquetes, instala el toolchain y arranca (en Termux) |
| `npm run migrate:mtproto [-- --apply]` | Migración manual del cifrado de los mensajes (no del esquema) |

| Ruta | Contenido |
| --- | --- |
| `.env` | Configuración (plantilla: `.env.example`). **No se sube al repo** |
| `cert.pem`, `key.pem` | Certificado HTTPS autofirmado. **No se sube al repo** |
| `data/` | `zlapy.db` (datos) y `blob.db` (adjuntos). **No se sube al repo** |
| `backups/` | Respaldos manuales. **No se sube al repo** |
| `zty.yml` | Configuración del túnel (plantilla: `zty.yml.example`). **No se sube al repo** |
| `.zlapy.pid` | PID del servidor hijo mientras corre el supervisor |

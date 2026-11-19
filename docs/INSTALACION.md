# Instalación y operación de Zlapy

Referencia práctica para instalar dependencias, configurar el servicio, activar
TLS y mantener respaldos recuperables. Para la descripción del producto y el
arranque mínimo, consulta el [README](../README.md).

## 1. Requisitos

- **Node.js 22 o superior** y npm; Git, `curl` y espacio para bases y adjuntos.
- Python 3, `make` y un compilador C++ cuando `better-sqlite3` deba compilarse.
  Android/Termux siempre lo compila.
- Opcional: OpenSSL para certificados y `cloudflared` para el túnel.

```bash
node --version && npm --version
python3 --version && make --version && g++ --version
```

| Plataforma | Herramientas de compilación |
| --- | --- |
| Debian/Ubuntu | `sudo apt install python3 make g++ build-essential` |
| Fedora | `sudo dnf install python3 make gcc-c++` |
| Arch | `sudo pacman -S --needed base-devel python` |
| Termux | `pkg install python make clang sqlite` |
| macOS | `xcode-select --install`, solo si hace falta compilar |
| Windows | Visual Studio Build Tools (C++) y Python 3, solo si hace falta compilar |

El `postinstall` comprueba el binario nativo e intenta compilarlo si falta. El
proyecto aprueba `better-sqlite3` en `allowScripts`; si npm aún lo solicita:

```bash
npm install-scripts approve better-sqlite3
npm run rebuild:sqlite
```

Usa el script del proyecto, no `npm rebuild better-sqlite3`: invoca `node-gyp`
explícitamente y contempla las cabeceras de Termux.

## 2. Instalación por plataforma

### Linux

Instala Node 22+ con tu distribución, Nodesource o nvm si hace falta. En Debian o
Ubuntu:

```bash
sudo apt update
sudo apt install -y git python3 make g++ build-essential curl openssl
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
npm start
```

En Fedora o Arch usa las herramientas de la tabla anterior. `npm ci` instala lo
fijado por el `package-lock.json` versionado.

### Android con Termux

Instala Termux desde F-Droid y ejecuta:

```bash
pkg update && pkg upgrade -y
pkg install git nodejs python make clang sqlite openssl
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
npm start
```

Si falta el binario nativo, ejecuta `npm run rebuild:sqlite` y después `node
ops/install/check-native.js`. Como alternativa, tras clonar, `npm run termux`
actualiza paquetes, instala el toolchain, ejecuta `npm i --ignore-scripts`,
compila, verifica y arranca.

Evita que Android cierre Termux durante la compilación; `termux-wake-lock` reduce
las suspensiones en segundo plano. `termux-setup-storage` habilita `/sdcard`
cuando Android lo permita; crea antes cualquier carpeta usada para `DATA_DIR` o
respaldos. El almacenamiento privado de Termux suele dar menos problemas.

### Windows y macOS

Con Node 22+ instalado, en PowerShell:

```powershell
git clone https://github.com/zendtay-studio/zlapy-chat.git
Set-Location zlapy-chat
npm ci
npm start
```

Si falta el binario, instala Build Tools y ejecuta `npm run rebuild:sqlite`. Los
modos POSIX no equivalen a las ACL de Windows: restringe la carpeta a la cuenta
del servicio.

En macOS instala Node con `brew install node@22` y, si hace falta, `brew link
--force --overwrite node@22`. Después clona, ejecuta `npm ci` y `npm start`;
instala las herramientas de Xcode solo si hay que compilar.

### Primer arranque

Sin `.env`, se crea desde la plantilla con credencial aleatoria y modo `0600`,
sin imprimir secretos. También se crean las carpetas y bases, y una base vacía se
inicializa con esa credencial. Para elegirla en una base nueva:

```bash
npm run owner -- init --user NOMBRE
```

Copiar la plantilla con credenciales vacías no las genera: eso solo ocurre si
`.env` no existe. Con datos existentes, una credencial ausente o incorrecta causa
la salida 78; restaura la original, no inicialices otra.

## 3. Configuración y credencial

Servidor, supervisor y scripts cargan `.env` desde la raíz; el entorno del proceso
tiene prioridad (`PORT=3001 npm start` es un cambio temporal). Reinicia tras
editar. La plantilla completa está en [`.env.example`](../.env.example) y los
valores esenciales se resumen en el [README](../README.md#configuración-esencial).

La sincronización es **aditiva e idempotente**: añade variables y comentarios
ausentes sin reemplazar contenido. Para ejecutarla manualmente:

```bash
node ops/config/sync-env-example.js
chmod 600 .env
```

`DATA_DIR` relativo se resuelve desde el directorio de trabajo. Los nombres
predeterminados son `zlapy.db` y `zlapy-blob.db`; una instalación antigua puede
conservar `blob.db`. Ambas bases usan WAL, `synchronous=FULL` y
`SQLITE_BUSY_TIMEOUT_MS=15000` (ajustable entre 0 y 60000). Los límites numéricos
se validan al arrancar. Push espera 5 segundos y Giphy, 8 segundos.

No edites `DB_USER`, `DB_PASSWORD` o `DB_PASSWORD_FILE` para migrar una base. Con
el servidor detenido:

```bash
npm run owner -- credential --user NUEVO --password NUEVA
npm run owner -- rotate
npm run owner -- export-kit --out /ruta/segura
```

`credential` re-cifra y escribe `.env` al final; `rotate` cambia la sal conservando
la credencial. `--password` puede quedar en el historial y la lista de procesos.
Usa `npm run owner -- check` y `npm run owner -- unlock-check` para verificar.

Sin la credencial original no se recupera el contenido. Guarda credencial y bases
juntas, fuera de la máquina y con acceso restringido; restaura también cualquier
archivo usado por `DB_PASSWORD_FILE`.

## 4. Arranque, verificación y servicios

`npm start` ejecuta preflight y supervisor: vigila `/healthz` y latidos IPC,
reinicia con backoff y distingue arranque fallido de caída en caliente. Ejecuta
`node server.js` para depurar sin reintentos.

```bash
curl http://localhost:1820/healthz
curl -k https://localhost:1820/healthz   # si HTTPS está activo
```

Espera HTTP 200 y `"ok":true`; `/healthz` consulta ambas bases sin exigir sesión.

### Firewall y red local

El modo `auto` escucha en todas las interfaces. Permite el puerto solo en la red
que corresponda:

```bash
sudo ufw allow 1820/tcp
# firewalld:
sudo firewall-cmd --permanent --add-port=1820/tcp && sudo firewall-cmd --reload
```

Otro dispositivo debe alcanzar `http://IP-DEL-SERVIDOR:1820/healthz`. Revisa WiFi,
aislamiento de clientes y firewall. No expongas el puerto directamente a Internet.

### systemd

Crea `/etc/systemd/system/zlapy.service`, ajustando usuario y rutas:

```ini
[Unit]
Description=Zlapy
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=zlapy
Group=zlapy
WorkingDirectory=/opt/zlapy-chat
ExecStart=/usr/bin/npm start --prefix /opt/zlapy-chat
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=zlapy

[Install]
WantedBy=multi-user.target
```

Comprueba npm con `command -v npm`. El usuario necesita leer el proyecto y escribir
datos, respaldos, `.env` y PID. Activa y revisa:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zlapy
systemctl status zlapy
journalctl -u zlapy -f
```

No combines el servicio con otro `npm start`. Para mantenimiento, ejecuta
`sudo systemctl stop zlapy`.

### pm2

```bash
npm install --global pm2
cd /ruta/zlapy-chat
pm2 start npm --name zlapy -- start
pm2 save
pm2 startup       # ejecuta el comando que imprime
pm2 logs zlapy
```

Usa `pm2 stop zlapy` para mantenimiento y `pm2 restart zlapy` tras configurar.

### Termux:Boot

Instala Termux:Boot desde F-Droid, ajusta la ruta y prueba este script:

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/zlapy <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
cd "$HOME/zlapy-chat" || exit 1
termux-wake-lock 2>/dev/null
exec npm start
EOF
chmod +x ~/.termux/boot/zlapy
```

## 5. HTTPS y red

Genera un certificado autofirmado incluyendo todas las IP o nombres usados:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 397 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=zlapy" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.1.50" \
  -addext "basicConstraints=critical,CA:TRUE"
chmod 600 key.pem cert.pem
```

Sustituye la IP de ejemplo y renueva el certificado si cambian IP o nombres;
reinicia después. Para quitar el aviso puedes instalarlo como CA de confianza en
el dispositivo, asumiendo ese riesgo.

Con ambos archivos, HTTP y HTTPS comparten puerto. `FORCE_TLS=true` redirige HTTP
a HTTPS (excepto `/healthz`) y marca las cookies `Secure`. Un proxy local puede
declarar `X-Forwarded-Proto: https`; solo se confía en ella desde loopback.

Sin certificados, el forzado queda degradado y solo permite autenticación local.
Para HTTP deliberado en una LAN de confianza usa `FORCE_TLS=false`; las sesiones
remotas caducan antes.

> El cifrado de cuerpos y WebSocket no protege cookies, cabeceras ni GET ni evita
> la sustitución activa de claves. TLS es necesario para llamadas y push.

HTTPS envía HSTS por un año: si retiras certificados, restáuralos o limpia ese
estado en el navegador.

## 6. Respaldos y restauración

```bash
npm run backup
npm run backup -- /ruta/destino-vacio
```

SQLite copia consistentemente ambas bases, incluso con el servidor activo, y `.env`
se guarda como `credencial.env`. El destino debe estar vacío; copiar un `.db` activo
a mano puede omitir su WAL. Guarda otra copia fuera del servidor y pruébala.

El destino recibe `0700` y sus archivos `0600`. Al arrancar se endurecen
recursivamente los directorios (`0700`) y archivos (`0600`) de `backups/`, sin
seguir symlinks. Los errores de `chmod` se registran sin impedir el arranque.

### Restaurar la configuración predeterminada

Detén el servicio y, desde la raíz, repón bases y credencial del mismo respaldo:

```bash
cp backups/zlapy-backup-FECHA/zlapy.db data/zlapy.db
cp backups/zlapy-backup-FECHA/zlapy-blob.db data/zlapy-blob.db
cp backups/zlapy-backup-FECHA/credencial.env .env
rm -f data/zlapy.db-wal data/zlapy.db-shm \
  data/zlapy-blob.db-wal data/zlapy-blob.db-shm
chmod 600 .env data/zlapy.db data/zlapy-blob.db
chmod 700 data
npm start
```

Con el servidor arrancado, ejecuta `curl http://localhost:1820/healthz` en otra
terminal. Sustituye `FECHA`; adapta nombres si cambiaste `DB_NAME`/`BLOB_DB_NAME`
o usas la base antigua `blob.db`. Restaura también el archivo de `DB_PASSWORD_FILE`,
si existe: sin la credencial original el respaldo es irrecuperable.

Con el servidor parado, `npm run owner -- export-kit --out DIR` copia credencial,
bases y WAL/SHM. `npm run owner -- reset --yes` borra las bases: no es recuperación.

## 7. Cloudflare Tunnel

Publicar en Internet cambia el modelo de riesgo: restringe el acceso con
Cloudflare Access/WAF y utiliza HTTPS. El servidor puede descifrar los mensajes;
el túnel no añade cifrado de extremo a extremo ni sustituye los respaldos.

1. Instala `cloudflared`.
2. Define `CLOUDFLARE_TUNNEL_TOKEN` **únicamente en `.env`**.
3. Crea la configuración sin incluir el token:

```bash
cp zty.yml.example zty.yml
chmod 600 zty.yml .env
```

Edita `zty.yml`: UUID de `tunnel`, `hostname` y `service`. Para el puerto estándar,
el servicio local es `http://localhost:1820`; conserva la regla final
`http_status:404`. El archivo contiene configuración, **nunca
`CLOUDFLARE_TUNNEL_TOKEN` ni otro token**.

```bash
cloudflared --config zty.yml ingress validate
# Con Zlapy ya arrancado, en otra terminal:
npm run tunnel
```

El script prefiere un archivo temporal `0600` dentro de un directorio `0700` para
entregar el token. Si `cloudflared` no admite `--token-file`, usa `TUNNEL_TOKEN`
en el entorno; en ningún caso lo añade a los argumentos. Filtra el token de la
salida y elimina el archivo temporal al terminar.

## 8. Actualización y pruebas

Respalda y detén el servicio antes de sustituir código:

```bash
npm run backup
git pull
npm ci
node ops/config/sync-env-example.js
# Arranca de nuevo el servicio y, después, verifica:
curl http://localhost:1820/healthz
```

El arranque aplica cambios de esquema y rellenos compatibles de forma idempotente.
Ante cifrado, filas o esquema incompatibles se detiene: restaura un respaldo
compatible; nunca fuerces otra llave sobre los datos.

`npm run update` no equivale a `git pull`: reemplaza el código conservando
`data/`, `backups/`, `.env`, `zty.yml` y `node_modules`, pero elimina `.git` y no
conserva `cert.pem`/`key.pem`. Puede borrar otros archivos locales; revísalo y
respalda antes de usarlo.

`npm test` ejecuta `node --test --require ./test/bootstrap.js "test/**/*.test.js"`
con puertos libres y datos temporales. CI usa Node 22, `npm ci`, auditoría de
dependencias y la misma suite.

## 9. Diagnóstico

| Síntoma | Comprobación o solución |
| --- | --- |
| Node demasiado antiguo | Instala Node 22+ y repite `npm ci` |
| Falta `better-sqlite3` o su binario | `npm run deps`; si persiste, instala el toolchain y `npm run rebuild:sqlite` |
| Puerto 1820 ocupado | Detén la otra instancia o cambia `PORT`; no lances otro supervisor |
| Reinicios de arranque | Ejecuta `node server.js` y corrige el primer error mostrado |
| Salida 78 / keycheck inválido | Restaura la credencial original; el supervisor no la reintenta |
| Salida 79 / dependencias | Ejecuta `npm run deps` y revisa red, npm y binario nativo |
| Salida 70 / cortacircuito | Corrige el fallo de arranque antes de reiniciar el servicio |
| Base bloqueada | Revisa escritores concurrentes y `SQLITE_BUSY_TIMEOUT_MS=15000` |
| `database unavailable` | Comprueba permisos, disco y las dos bases en `DATA_DIR` |
| No se puede entrar desde LAN | Revisa IP, WiFi, aislamiento, firewall y `BIND_HOST` |
| Registro remoto exige HTTPS | Instala certificados o decide explícitamente `FORCE_TLS=false` |
| Cámara, micrófono o push fallan | Usa HTTPS, concede permisos y revisa el servicio push del navegador |
| `cross-origin request rejected` | Conserva el mismo esquema, host y puerto usados al iniciar sesión |
| HSTS fuerza HTTPS | Restaura certificados o elimina el estado HSTS del navegador |
| Falta el túnel | Instala `cloudflared`, define el token en `.env` y crea `zty.yml` |
| El túnel no encamina | Valida `zty.yml`, hostname y `service: http://localhost:1820` |
| Errores no fatales repetidos | Revisa la consola y `data/log/errors.log` |

Los errores de credencial o de formato no se arreglan generando otra llave. Antes
de una reparación, crea un respaldo y conserva cualquier credencial anterior.

Otros comandos: `npm run repair` y `npm run repair:double-encrypted` simulan reparaciones (`-- --apply` las aplica con el servidor parado y respaldo previo); no recuperan contenido sin su llave anterior.
`npm run dbview` y `npm run sqliteview` abren visores de solo lectura en `127.0.0.1:3001` y `:3002`; `npm run generate:emojis` regenera los índices de emojis.

# Zlapy

Servidor de mensajería y llamadas para una red local, con cliente web/PWA,
Node.js, SQLite y WebSocket. Las integraciones externas (Giphy, Web Push y
Cloudflare Tunnel) son opcionales.

## Qué incluye

- Chats directos y grupos en tiempo real, con estados de envío, entrega y lectura.
- Contactos, solicitudes, bloqueos, roles de grupo y privacidad por función.
- Respuestas, edición, reacciones, menciones, historias, notas y galerías.
- Adjuntos deduplicados por SHA-256 y almacenados en una base SQLite separada.
- Llamadas de voz y vídeo WebRTC P2P; el servidor solo hace la señalización.
- PWA instalable y notificaciones Web Push compatibles.
- Cifrado en reposo con AES-256-GCM, contenido por cuenta con MTProto 2.0 y
  AES-256-IGE, y una capa adicional para cuerpos HTTP y frames WebSocket.

> **No es cifrado de extremo a extremo.** El servidor puede descifrar el
> contenido. La capa de transporte de la aplicación tampoco sustituye a TLS:
> por HTTP, las cabeceras, las cookies y las respuestas GET pueden quedar
> expuestas, y un atacante activo puede suplantar la clave pública del servidor.

## Inicio rápido

### Requisitos

- **Node.js 22 o superior** y npm.
- Git.
- Python 3, `make` y un compilador C++ si `better-sqlite3` necesita compilarse.
  En Android/Termux la compilación es obligatoria.
- Espacio para las bases y los adjuntos; los dispositivos deben tener acceso de
  red al servidor.

```bash
node --version
npm --version
```

### Instalar y arrancar

```bash
git clone https://github.com/zendtay-studio/zlapy-chat.git
cd zlapy-chat
npm ci
npm start
```

`npm start` comprueba las dependencias antes de lanzar el servidor bajo un
supervisor. No hace falta crear manualmente `.env` ni `data/` en una instalación
nueva:

- `.env` se genera desde `.env.example`, con una credencial de propietario
  aleatoria y permisos `0600`; su valor no se imprime.
- Las carpetas de datos y las bases se crean al abrir SQLite.
- La base nueva se inicializa con la credencial de `.env`.

> **Haz una copia externa de `.env` desde el primer día.** `DB_USER` y
> `DB_PASSWORD` (o el archivo indicado por `DB_PASSWORD_FILE`) permiten derivar
> la llave maestra. Si se pierden, las bases y sus respaldos no se pueden
> descifrar. Nunca publiques ese archivo ni lo confirmes en Git.

Si ya existen datos y la credencial falta o no corresponde, el servidor sale con
código 78 y el supervisor no reintenta: restaura la credencial correcta. No se
genera otra llave sobre una base existente.

### Acceso

El puerto predeterminado es **1820**. El arranque muestra las direcciones
disponibles:

- Esta máquina: `http://localhost:1820`.
- Otro dispositivo en la LAN: `http://IP-DEL-SERVIDOR:1820`.
- Con certificados: las mismas direcciones mediante `https://`.

Comprueba el servicio con:

```bash
curl http://localhost:1820/healthz
```

Una respuesta HTTP 200 contiene `"ok":true`; un 503 indica que alguna base no
responde. Para usarlo desde otro dispositivo puede ser necesario permitir
`1820/tcp` en el firewall. Mantén una sola instancia sobre la misma base y puerto.

La instalación detallada por plataforma, los servicios de arranque automático y
el diagnóstico están en [docs/INSTALACION.md](docs/INSTALACION.md).

## Configuración esencial

La configuración vive en `.env`; [`.env.example`](.env.example) documenta todas
las variables, sus valores y sus rangos. Las variables del entorno del proceso
tienen prioridad sobre el archivo. Reinicia después de editarlo.

Al arrancar, la configuración se sincroniza de forma **aditiva** con la plantilla:
solo se añaden variables y comentarios que falten, sin sustituir valores ni texto
existentes. También puedes ejecutar `node ops/config/sync-env-example.js`.

| Variable | Valor inicial | Uso |
| --- | --- | --- |
| `PORT` | `1820` | HTTP, HTTPS y WebSocket en el mismo puerto |
| `BIND_HOST` | `auto` | Todas las interfaces; `loopback` limita el acceso a esta máquina |
| `FORCE_TLS` | `false` en la plantilla | Redirige a HTTPS y marca la cookie `Secure` cuando hay certificados |
| `DATA_DIR` | `data` | Carpeta de persistencia |
| `DB_NAME` | `zlapy` | Produce `data/zlapy.db` |
| `BLOB_DB_NAME` | Derivado | Produce `data/zlapy-blob.db`; conserva `blob.db` en instalaciones antiguas |
| `DB_USER`, `DB_PASSWORD` | Generados al crear `.env` | Credencial de la llave maestra |
| `DB_PASSWORD_FILE` | Vacío | Archivo `0600` con la contraseña; tiene prioridad sobre `DB_PASSWORD` |
| `SQLITE_BUSY_TIMEOUT_MS` | `15000` | Espera ante bloqueos de SQLite, en milisegundos |
| `AUTH_SESSION_TTL_MS` | `2592000000` | Sesión normal de 30 días |
| `AUTH_PLAIN_SESSION_TTL_MS` | `28800000` | Sesión de 8 horas por HTTP desde otra máquina |
| `GIPHY_API_KEY` | Vacío | Búsqueda de stickers mediante el servidor |
| `CLOUDFLARE_TUNNEL_TOKEN` | Vacío | Secreto usado únicamente por `npm run tunnel` |

Ambas bases usan WAL y `synchronous=FULL`. Los envíos push se cancelan tras
**5 segundos** y las consultas a Giphy tras **8 segundos**, para no dejar peticiones
externas esperando indefinidamente.

## HTTPS, llamadas y push

HTTP y HTTPS comparten puerto. Para activar HTTPS, coloca un certificado y su
llave en `cert.pem` y `key.pem`, o define `TLS_CERT_FILE` y `TLS_KEY_FILE`, y
reinicia. El certificado debe incluir en `subjectAltName` los nombres o IP por
los que accederán los clientes.

Cámara, micrófono, service workers y Web Push necesitan un contexto seguro;
en un móvil que entra por IP, eso significa HTTPS. Un certificado autofirmado
requiere aceptar o instalar su confianza en cada dispositivo.

Con certificados disponibles, se recomienda:

```dotenv
FORCE_TLS=true
```

Sin certificados, ese ajuste queda degradado: el servidor permite HTTP local,
pero bloquea registro e inicio de sesión desde otras máquinas hasta instalarlos
o elegir explícitamente `FORCE_TLS=false`. HTTP abierto debe limitarse a una red
de confianza. La generación de certificados y las consecuencias de HSTS se explican
en [docs/INSTALACION.md](docs/INSTALACION.md#5-https-y-red).

## Credencial del propietario y recuperación

La llave maestra se deriva con scrypt de `DB_USER` + `DB_PASSWORD`; no se guarda
como una llave independiente. Esta credencial no es la contraseña de una cuenta
de chat.

```bash
npm run owner -- show
npm run owner -- check
npm run owner -- unlock-check
npm run owner -- credential --user NUEVO --password NUEVA
npm run owner -- rotate
npm run owner -- export-kit --out /ruta/segura
npm run owner -- reset --yes
```

- `credential` re-cifra el contenido; `rotate` conserva la credencial y cambia la
  sal. No edites la credencial a mano para migrar una base.
- Detén el servidor para `init`, `credential`, `rotate`, `export-kit` y `reset`.
- `reset --yes` borra las bases: haz un respaldo verificable antes.
- Pasar `--password` puede exponer el secreto en el historial del shell y en
  `/proc`; evita incluir secretos reales en comandos compartidos o registros.
- Conserva juntos, cifrados y fuera del servidor, la credencial y las bases.
  `export-kit` crea un kit de recuperación con ambos.

## Respaldos

```bash
npm run backup
npm run backup -- /ruta/destino-vacio
```

El destino predeterminado es `backups/zlapy-backup-<fecha-hora>/`. El comando usa
la API de respaldo de SQLite, por lo que puede ejecutarse con el servidor activo
y WAL habilitado. Copia las bases configuradas y `.env` como `credencial.env`;
no sobrescribe un destino que ya contenga archivos. Si usas `DB_PASSWORD_FILE`,
ese archivo externo debe respaldarse por separado.

Los directorios de respaldo se crean con `0700` y los archivos con `0600`. En cada
arranque se endurecen `data/`, `.env`, las bases y **recursivamente** `backups/`:
directorios `0700`, archivos `0600`, sin seguir enlaces simbólicos. Es un ajuste de
permisos de mejor esfuerzo en sistemas que lo permitan.

Para restaurar, detén el servidor, repón las dos bases y la misma credencial,
retira los WAL/SHM antiguos y comprueba `/healthz`. El procedimiento completo está
en [docs/INSTALACION.md](docs/INSTALACION.md#6-respaldos-y-restauración).

## Operación y comandos

| Comando | Función |
| --- | --- |
| `npm start` | Preflight de dependencias y servidor supervisado |
| `node server.js` | Arranque directo para depurar, sin reinicio automático |
| `npm run deps` | Comprueba e instala dependencias ausentes o dañadas |
| `npm run rebuild:sqlite` | Compila el binario nativo de `better-sqlite3` |
| `npm test` | Ejecuta todas las pruebas |
| `npm run backup` | Crea un respaldo consistente |
| `npm run owner -- <comando>` | Gestiona credencial, integridad y recuperación |
| `npm run tunnel` | Inicia Cloudflare Tunnel con la configuración local |
| `npm run termux` | Instala toolchain, compila SQLite y arranca en Termux |

El supervisor vigila `/healthz` y los latidos IPC, aplica backoff y cierra el hijo
de forma ordenada. El código 78 exige corregir la credencial; el 79 activa la
instalación de dependencias. Los errores globales se registran también en
`data/log/errors.log`.

El túnel requiere `cloudflared`, `zty.yml` y el token **solo en `.env`**; nunca lo
pongas en `zty.yml`. Consulta la configuración y las precauciones de exposición en
[docs/INSTALACION.md](docs/INSTALACION.md#7-cloudflare-tunnel).

## Pruebas

```bash
npm test
```

Equivale a:

```bash
node --test --require ./test/bootstrap.js "test/**/*.test.js"
```

Las pruebas usan puertos libres y directorios temporales, sin utilizar los datos
de la instalación. CI ejecuta Node 22, `npm ci`, `npm audit --audit-level=high` y
`npm test`.

## Estructura y documentación

```text
server.js          entrada del servidor
src/               backend por dominios
public/            cliente web y PWA
ops/               instalación, supervisor, credenciales y mantenimiento
test/              pruebas unitarias y de integración
data/              bases y logs; no se versiona
backups/           respaldos; no se versiona
docs/              referencias técnicas
```

| Documento | Contenido |
| --- | --- |
| [Instalación y operación](docs/INSTALACION.md) | Plataformas, servicios, TLS, túnel, restauración y diagnóstico |
| [Arquitectura](docs/ARQUITECTURA.md) | Componentes y flujo de peticiones |
| [Criptografía](docs/CRIPTOGRAFIA.md) | Llaves, formatos y límites del modelo de seguridad |
| [Esquema de BD](docs/ESQUEMA-BD.md) | Tablas, índices y reglas de borrado |
| [API](docs/API.md) | Rutas HTTP y protocolo WebSocket |
| [Mapa de archivos](docs/FICHEROS.md) | Organización del código |

## Diagnóstico rápido

| Síntoma | Acción |
| --- | --- |
| Puerto ocupado | Detén la otra instancia o usa otro `PORT` |
| Falla `better-sqlite3` | Instala el toolchain y ejecuta `npm run rebuild:sqlite` |
| Salida 78 | Restaura la credencial que corresponde a la base |
| Cámara o push no funcionan | Usa HTTPS y concede los permisos del navegador |
| Reinicios repetidos | Ejecuta `node server.js` para ver el error de arranque |
| Error de hora en el cliente | Activa la hora automática y recarga |

Más causas y soluciones: [docs/INSTALACION.md](docs/INSTALACION.md#9-diagnóstico).

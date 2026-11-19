# Criptografía de Zlapy

Esta guía describe los mecanismos que el código actual usa, sus límites de
confianza y las operaciones de recuperación. Los módulos de `src/crypto/` son la
referencia final.

## 1. Modelo de confianza

Zlapy cifra contenido **en el servidor y en reposo**. El servidor deriva la llave
maestra, guarda las auth keys de las cuentas cifradas con ella y puede descifrar
los datos que sirve. Por tanto:

- Una copia de la base sin la credencial del propietario no revela el contenido.
- Quien obtiene la credencial y las bases puede descifrar ese contenido.
- Un proceso servidor comprometido tiene acceso a las claves que usa en RAM.
- No debe describirse como cifrado extremo a extremo frente al propio servidor.

El canal de aplicación protege cuerpos HTTP y frames WebSocket frente a escucha
pasiva. No sustituye a HTTPS: sin autenticación del servidor, un atacante activo
puede sustituir la clave pública de transporte. Las cookies y otras cabeceras
tampoco quedan dentro del sobre HTTP.

## 2. Credencial del propietario y llave maestra

### Derivación

La credencial se compone de `DB_USER` y `DB_PASSWORD` en `.env`. Como alternativa
para la contraseña se admite `DB_PASSWORD_FILE`. El material es:

```text
DB_USER || NUL || DB_PASSWORD
```

De él se derivan 32 bytes con scrypt (`N=32768`, `r=8`, `p=1`) y una sal única de
instalación. No hay una llave maestra independiente escrita en `.env`.

En una instalación nueva se genera una credencial aleatoria con permisos 0600.
El archivo `.env` no se versiona. Al arrancar solo se añaden variables ausentes
desde `.env.example`; no se sustituyen valores existentes.

### Comprobaciones de arranque

La tabla `meta` conserva los parámetros no secretos necesarios:

- `owner_user`, `kdf_salt` y `kdf_params`.
- `keycheck`: texto conocido cifrado para comprobar la credencial.
- `key_id`: huella de la instalación.
- `integrity_manifest`: HMAC que ata esos metadatos a la credencial y la base.

Una credencial incorrecta, un manifiesto manipulado o un formato incompatible
detiene el arranque en lugar de descifrar mal o sobrescribir datos. Cambiar la
credencial mientras el proceso está vivo provoca un reinicio controlado.

### Operaciones

Usa `npm run owner` y sus subcomandos documentados para comprobar la credencial,
cambiarla, rotar la sal o exportar un kit de recuperación. Las operaciones que
modifican bases exigen el servidor detenido y un candado de mantenimiento.

Cambiar la credencial exige recifrar todo su dominio: auth keys, material de
grupos, campos, blobs, VAPID y metadatos. No basta con editar `.env`.

## 3. Jerarquía de claves

| Clave | Origen y uso |
| --- | --- |
| Llave maestra | scrypt de la credencial del propietario; raíz de confianza del servidor. |
| Subclaves HKDF | Separan reposo, sesiones, rid, transporte y otros roles para no reutilizar la raíz directamente. |
| `auth_key` de cuenta | 256 bytes del CSPRNG; cifra contenido PCE3/PCE3A de esa cuenta. Se almacena cifrada con la llave maestra y AAD de usuario. |
| Claves de firma | Ed25519 derivado por HKDF de la auth_key y el id de cuenta. |
| Clave de transporte | Par X25519 del servidor derivado de la maestra; cada cliente aporta una clave efímera. |
| VAPID | Par P-256 para Web Push; la parte privada se guarda cifrada en `meta`. |

`authKeyId` son los primeros 64 bits del resumen SHA-1 de la auth_key
(`digest().subarray(0, 8)`), representados por 16 caracteres hex. Se usa como
identificador de enrutamiento, no como mecanismo de confidencialidad.

Las cachés de auth keys y firmas están acotadas a 500 entradas. Los contadores
MTProto tienen otro LRU de 500 entradas: al expulsar, el contador interno `seq`
de esa auth_key se vuelca en SQLite. Un high-water mark global evita repetir
`msg_id`; cada sesión recupera su propio `seq` y emite `seq_no = seq * 2 + 1`.

## 4. Sobres vigentes

### PCE1v2: cifrado en reposo con la llave maestra

`PCE1v2:` usa AES-256-GCM con una subclave HKDF dedicada a reposo, IV aleatorio
de 12 bytes y etiqueta de autenticación. Su AAD incluye el dominio del formato y,
cuando corresponde, un contexto adicional.

Se usa para auth keys, blobs, VAPID, material de grupos y campos de infraestructura.

`PCE1:` es el formato anterior, con AES-256-GCM y la llave maestra directa. Se
conserva lectura de valores heredados; las escrituras nuevas usan PCE1v2.

### PCE3 y PCE3A: contenido por cuenta

PCE3 implementa el armazón MTProto 2.0 usado por el proyecto:

- `auth_key_id` externo para seleccionar la clave.
- `msg_key` calculado con SHA-256 sobre la auth_key y el plaintext.
- Derivación de `aes_key`/`aes_iv` y cifrado AES-256-IGE.
- Cabecera con salt, `session_id`, `msg_id`, `seq_no` y longitud.
- Padding aleatorio de 12 a 1024 bytes y alineación de bloques.

Al descifrar se validan identificador, longitudes, `msg_key`, sesión, paridad,
padding y contexto antes de aceptar el cuerpo.

PCE3A es PCE3 con un contexto dentro de los datos autenticados. Ata el sobre a su
pieza: perfil/campo/cuenta, mensaje/chat/autor, historia/fecha, resumen/par,
llamada/id, etc. Un sobre copiado a otro campo o cuenta no es válido allí.

PCE2 no forma parte del flujo actual de lectura/escritura; no deben generarse
nuevos datos con ese prefijo.

### Contextos de infraestructura

Los contextos de `src/crypto/aad.js` evitan mover sobres entre usuarios, grupos,
blobs o filas de `meta`. `src/crypto/field-crypto.js` añade AAD de columna a campos
como apariencia, stickers, listas de privacidad, nombres de grupos, invitaciones,
llamadas, endpoints push y reacciones.

Las lecturas antiguas pueden probar compatibilidad sin contexto; al reescribir,
el valor queda atado a su contexto actual.

## 5. Mensajes, resúmenes y grupos

El contenido del mensaje se serializa y se cifra con la auth_key del autor. La
firma Ed25519 cubre el contexto y los campos relevantes: ids, chat, tiempo, autor,
destino, tipo, texto, adjuntos, galería, cita, menciones e invitación.

`messages.signature` y `messages.signing_public_key` permiten verificar lo
guardado. La clave pública almacenada debe coincidir con la derivada de la
auth_key vigente del autor; una firma de otra semilla no se acepta.

Resúmenes, perfiles, notas, historias y llamadas usan la auth_key de su propietario
y su propio contexto. El material criptográfico de grupos se guarda en
`groups.keys_cipher` bajo la llave maestra y AAD del grupo.

El servidor participa en estas operaciones y puede descifrar el contenido que
almacena; las firmas aportan integridad, no confidencialidad frente a él.

## 6. Rotación y borrado de auth keys

Regenerar una auth_key recifra el contenido de la cuenta en una sola transacción.
La clave nueva se usa para las nuevas escrituras y firmas; el historial compatible
se conserva.

La limpieza RAM sigue el resultado transaccional:

- Tras confirmar, se olvida la sesión MTProto de la clave retirada.
- Si hay rollback, se restaura la clave anterior en caché y se poda cualquier
  contador de la clave nueva descartada.
- Al borrar una cuenta, la sesión se poda solo después de confirmar el borrado.

El LRU limita memoria. El volcado SQLite conserva la progresión independiente
de cada sesión al expulsarla y el high-water global de `msg_id` evita repetir
o retroceder identificadores durante el mismo proceso.

## 7. Canal HTTP

El servidor publica su clave X25519 en `/config`. El cliente genera una clave
efímera y ambos derivan 64 bytes con X25519 + HKDF-SHA256: 32 para ChaCha20 y 32
para HMAC-SHA256.

Las cabeceras principales son:

- `X-Zlapy-Enc: x25519-chacha20-hmac-v1`.
- `X-Zlapy-Ephemeral`: clave pública efímera.
- `X-Zlapy-Nonce`: nonce aleatorio.
- `X-Zlapy-Time`: marca temporal, con tolerancia limitada de reloj.

El HMAC autentica AAD, nonce y ciphertext. El AAD liga método, ruta, tiempo y, en
la respuesta, estado HTTP. Los nonces se registran solo después de validar el MAC
y la memoria anti-replay está acotada.

Un sobre inválido, movido de ruta, caducado o reenviado se rechaza. Si el servidor
no ofrece clave existe compatibilidad en claro, con el aviso correspondiente.

**HTTPS sigue siendo la protección recomendada.** El sobre propio no autentica al
servidor ni cifra las cabeceras. Con HTTP desde otra máquina, las sesiones emitidas
tienen una duración más corta que por un canal protegido.

## 8. Canal WebSocket

El cliente envía `{type:"enc", ephemeral}` con su clave efímera. Se deriva una
clave específica para WebSocket y los frames posteriores viajan como `z1:`.

Cliente→servidor y servidor→cliente usan contadores y etiquetas independientes
(`zlapyC2S`/`zlapyS2C`), por lo que no comparten nonce. Dirección y contador forman
parte del AAD. Un frame con MAC inválido se descarta sin aceptar su JSON.

Los clientes antiguos pueden continuar sin el saludo, en claro; esa compatibilidad
no ofrece las garantías anteriores.

## 9. Contraseñas y sesiones

Las contraseñas de cuentas se prehashean con SHA-256 para evitar el límite de 72
bytes de bcrypt y después usan bcrypt coste 10. El trabajo pesado se delega a un
worker para no bloquear el servidor.

Las sesiones son JWT HS256 con emisor, caducidad, `jti` y algoritmo fijado. La
clave de firma deriva de la maestra y el token viaja en cookie `HttpOnly` con
`SameSite=Lax`; `Secure` depende del canal/configuración TLS.

No existe tabla de sesiones. Cada token lleva un checksum SHA-256 del estado
`id | username | password_hash | rid`. El servidor lo recalcula en cada petición.
Cambiar contraseña, identidad o rid invalida tokens anteriores; las marcas
`password_changed_at`, `logged_out_at` e `iat` añaden defensa temporal.

El logout ordinario limpia el navegador y no cierra otros dispositivos.

## 10. Datos que permanecen visibles

Cifrar todo impediría indexar y paginar. Permanecen en claro los metadatos
necesarios para operar, entre ellos:

- UUID, usernames y relaciones de contactos/grupos.
- Tiempos, tipos de mensaje, hashes, estados de edición y políticas.
- Índices y claves primarias necesarios para consultas y autorización.
- Hashes de contraseñas bcrypt, que no son texto plano pero sí material sensible.

`calls.peer_hash` es un índice ciego HMAC para localizar llamadas por nombre sin
descifrar toda la tabla. La miniatura pública usada por Web Push está en claro y
se sirve mediante un token no adivinable que rota al sustituirla.

## 11. Respaldos y recuperación

`npm run backup` copia ambas bases con la API de SQLite y guarda la credencial
como `credencial.env`. Sin las bases y esa credencial no hay recuperación del
contenido.

- Directorios de respaldo: 0700.
- Ficheros de respaldo y credencial: 0600.
- El arranque endurece recursivamente `backups/` sin seguir symlinks.
- No se suben `.env`, `data/`, `backups/`, `zty.yml` ni claves TLS al repositorio.

`zty.yml` contiene configuración del túnel, no el token de Cloudflare. El token
vive solo en `.env` y el lanzador evita exponerlo en argumentos o logs.

Guarda el kit de recuperación fuera del equipo y prueba la restauración con el
servidor detenido. Una copia sin credencial es inservible; una credencial sin las
bases no recupera mensajes.

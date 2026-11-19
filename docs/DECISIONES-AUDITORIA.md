# Decisiones vigentes y falsos positivos de auditoría

Registro breve para no reabrir comportamientos deliberados o ya corregidos.
El código es la referencia final; no se conserva cronología ni explotación.

## 1. HTTP, autenticación y exposición de información

### `/auth/session` no es un oráculo anónimo

Sin sesión principal válida, `GET /auth/session` responde siempre
`200 { authenticated: false }` con UUID existentes o inexistentes en cookies
`zlapy_account_*`. No devuelve `gone`, `accountId` ni estados vinculados,
y tampoco borra selectivamente esas cookies: un `Set-Cookie` distinto sería
el mismo oráculo. Solo puede limpiarse la cookie principal inválida.
`linked` y `alive` se exponen únicamente en la rama autenticada.

### Registro y login

Se conserva el `409` de registro para username ocupado: el cliente distingue
la colisión y `UNIQUE COLLATE NOCASE` es la barrera final. La enumeración
masiva se frena con límites por IP del socket y de servicio. El login usa el
mismo `401` y texto exista o no la cuenta, con retardos por cuenta y frenos
por IP que no bloquean globalmente a terceros.

### Errores 400, 500 y 503

Una excepción inesperada produce `500` con JSON genérico; el detalle va al log.
El `400` se reserva a `statusCode = 400`, `status = 400` o
`code = 'BAD_REQUEST'`, sin filtrar el mensaje interno de la excepción.
La misma clasificación cubre fallos síncronos y rechazos async de GET y POST.
`AuthKeyUnreadableError` conserva un `503` específico: la auth_key existe,
pero la llave maestra actual no puede descifrarla; no es un error de entrada.

### Origen, proxy e IP

Los POST comprueban `Origin` y `sec-fetch-site`; el WebSocket valida origen en
el upgrade. Los limitadores usan la IP del socket, no `X-Forwarded-*` para
atribuir identidad. `X-Forwarded-Proto: https` solo se acepta desde loopback,
el modelo del túnel/proxy local; confiar en cualquier cliente abriría bypasses.

### CSP con contenido inline

`script-src` y `style-src` aún admiten `'unsafe-inline'` porque el cliente
conserva scripts y manejadores inline. Retirarlo exige externalizarlos y
revisar nonce/hashes, service worker y recursos `blob:` con pruebas de
navegador. La saneación y el escape siguen siendo necesarios con o sin CSP.

## 2. Sesiones, cifrado y datos persistentes

### Tokens sin tabla de sesiones

Las sesiones son JWT HS256 sin tabla ni caché. La revocación por cuenta usa
`user_rid`, el checksum de id/username/password/rid y las marcas temporales.
El logout ordinario es local al navegador; los cambios de identidad o
credenciales invalidan tokens anteriores. Renombrar reemite la cookie propia
porque el username forma parte del checksum.

Restaurar índices de `sessions`, caducar una caché de sesiones o recortar un
máximo de filas por cuenta son propuestas sin objeto en este modelo.

### Metadatos necesarios para consultas

No se cifran con IV aleatorio `users.username`, tiempos y políticas, ni los
metadatos `messages.chat/ts/kind/hash/once/edited`. La paginación con
`idx_messages_chat_ts`, los resúmenes y la deduplicación dependen de ellos.
Ocultarlos requiere rediseñar identidad, índices y paginación, no aplicar un
cifrado que rompa consultas u obligue a descifrar todo el historial.

### Claves y firma

`messages.signing_public_key` se conserva aunque pueda derivarse de la
auth_key actual: tras una rotación permite verificar mensajes antiguos no
migrados; quitarla podría marcar contenido válido como adulterado.

La regeneración de auth_key recifra el material de la cuenta en una sola
transacción. La clave anterior solo se olvida tras confirmar; en rollback se
restaura su caché y se poda la clave nueva. El borrado de cuenta aplica la
misma regla: primero confirma y después limpia.

Los contadores MTProto en RAM tienen un LRU de 500 entradas. Al expulsar se
vuelca en SQLite el contador interno `seq` de esa auth_key; al volver, el
`seq_no` emitido (`seq * 2 + 1`) continúa en pasos de 2 sin compartirse con
otras sesiones. Un
high-water global de `msg_id` evita repeticiones. El volcado se vacía al
reiniciar el proceso y se borra al rotar o eliminar la clave.

## 3. SQLite y adjuntos

### Durabilidad y espera ante bloqueos

Las dos bases usan WAL con `synchronous = FULL`: se elige durabilidad de
commits confirmados ante una caída del SO, con mayor coste que `NORMAL`.
Ambas aplican `busy_timeout = 15000` ms por defecto
(`SQLITE_BUSY_TIMEOUT_MS`), para esperar contención transitoria de escritura.

### Borrado entre dos bases

Las bases principal y de blobs no comparten una transacción atómica. Los
borrados llaman a `pruneBlobHashes`; además, cada 6 horas un barrido retira
huérfanos en tandas de 200. La referencia manda al autorizar: un blob aún no
podado físicamente no se vuelve descargable por estar presente.

La poda respeta también stickers, avatares, fondos, imágenes de grupo y la
imagen de respaldo, no solo `blob_access`. `INSERT OR IGNORE` deduplica por
hash de forma idempotente; no es una fuga ni duplica contenido.

## 4. Recursos externos y operación

### Timeouts acotados

Web Push usa `AbortSignal.timeout(5000)` y Giphy `AbortSignal.timeout(8000)`.
La señal cubre también la lectura del cuerpo. Un upstream colgado termina en
un fallo acotado, no en una petición o cadena de avisos retenida siempre.

### Respaldos y permisos recursivos

`npm run backup` copia ambas bases con la API de SQLite y `.env` como
`credencial.env`, imprescindible para descifrar. Crea directorios 0700 y
archivos 0600. Al arrancar, el endurecimiento recorre recursivamente todo
`backups/`: directorios 0700 y archivos 0600, además de `data/`, bases y `.env`.
No sigue symlinks, para no cambiar permisos fuera del árbol; los fallos de
chmod se avisan y se tratan como best-effort.

### Token de Cloudflare

`CLOUDFLARE_TUNNEL_TOKEN` vive únicamente en `.env`. `zty.yml` y su plantilla
contienen UUID/hostname, protocolo e ingress, pero no token. El lanzador usa
`--token-file` con archivo 0600 en directorio temporal 0700; en cloudflared
antiguo, `TUNNEL_TOKEN` por entorno. Nunca lo pone en argv, retira la variable
original antes del hijo y redacta el token de la salida.

El hallazgo de un secreto en `zty.yml` es falso en el estado actual: no hay
token en ese archivo ni en `zty.yml.example`.

### Suscripciones push inválidas

Se eliminan suscripciones con 404/410 y el 403 que indica credenciales VAPID
distintas de las usadas al crearlas; otro 403 no implica baja automática.
El cliente se vuelve a suscribir si `applicationServerKey` difiere de la clave
vigente, evitando suscripciones zombi tras cambiar las claves del servidor.

## 5. Falsos positivos que no deben reabrirse

| Propuesta | Comprobación vigente |
| --- | --- |
| «El UUID existe porque `/auth/session` devuelve `gone` o limpia su cookie» | La rama anónima es uniforme en cuerpo y `Set-Cookie`; no clasifica cookies vinculadas. |
| «Faltan índices, caducidad de caché o tope de filas en `sessions`» | No existe esa tabla ni esa caché; valen JWT, rid y checksum. |
| «El token del túnel está en `zty.yml`» | Ni el archivo actual ni la plantilla lo contienen; el lanzador solo lo toma de `.env` y evita argv/logs. |
| «Toda excepción debe devolver 400» | Solo errores marcados son 400; las inesperadas son 500 genérico y las auth_keys ilegibles, 503. |
| «No hay defensa CSRF/origen en POST o WebSocket» | Router y upgrade validan origen; POST también rechaza `sec-fetch-site: cross-site`. |
| «`/story` confía en `data.from` del cliente» | El router lo sustituye por el actor autenticado antes de ejecutar la ruta. |
| «Cada reenvío de un blob lo duplica» | La PK por hash e `INSERT OR IGNORE` son idempotentes; la cuota global cambia solo al insertar. |
| «Un adjunto físicamente presente siempre es público» | La descarga exige autorización; autorización y poda física son mecanismos separados. |

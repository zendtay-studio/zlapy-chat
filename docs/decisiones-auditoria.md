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

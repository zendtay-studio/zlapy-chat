/**
 * Zlapy: servidor de mensajeria con base de datos SQLite.
 *
 * Punto de entrada del proceso: comprueba que el formato de cifrado de la
 * base sea compatible, carga las cuentas, los grupos y las historias en
 * memoria y arranca los servidores HTTP y WebSocket.
 */

/* La lógica vive en `src/`, separada por dominios:
 *
 *   src/config.js          configuracion (fichero .env y valores por defecto)
 *   src/state.js           estado compartido en memoria
 *   src/db/                apertura de la base, sentencias, transacciones, esquema
 *   src/crypto/            llave maestra, cifrado en reposo, cifrado en la nube
 *   src/shared/            validaciones y utilidades puras
 *   src/users/             cuentas, perfiles y privacidad
 *   src/chat/              mensajes, resumenes, adjuntos y menciones
 *   src/groups/            grupos y sus claves
 *   src/stories/           historias
 *   src/profile/           perfil, notas y ajustes de la cuenta
 *   src/contacts/          contactos y bloqueos
 *   src/calls/             llamadas
 *   src/push/              notificaciones push
 *   src/auth/              sesiones y rutas de autenticacion
 *   src/realtime/          WebSocket y envio a los clientes
 *   src/http/              router, respuestas y servidores
 *
 * Los scripts de operacion (supervisor, tunel, respaldos, llave maestra y
 * migracion) viven en `ops/`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA, DB_PATH, BLOB_DB_PATH, ROOT } = require('./src/config.js');

const { Stmt } = require('./src/db/statements.js');
const { db } = require('./src/db/database.js');

/* Fail-fast de la credencial del propietario.
 *
 * La llave maestra se DERIVA de la credencial (DB_USER + DB_PASSWORD): sin
 * ella, o con una credencial que no abre esta base, no hay llave y no hay
 * servidor. Se comprueba ANTES de cargar nada para no dejar ni un solo
 * byte escrito con una llave que no corresponde a los datos.
 *
 * Código de salida 78 (EX_CONFIG): no es un fallo de ejecución, es una
 * configuración inválida. El supervisor lo trata como "no arranques en
 * bucle": hace falta intervención del operador. */
let masterKey = null;
let auditAuthKeys = null;
let ownerCredential = null;
try {
    ({ masterKey, auditAuthKeys, ownerCredential } = require('./src/crypto/setup.js'));
} catch (error) {
    console.error('');
    console.error('[crypto] No se pudo desbloquear la base con la credencial del propietario:');
    console.error(`  ${error && error.message ? error.message : error}`);
    console.error('');
    console.error('  Qué hacer:');
    console.error('    · Base nueva:  npm run owner -- init --user NOMBRE');
    console.error('    · Base con datos: la credencial es la que hay en el .env (DB_USER + DB_PASSWORD).');
    console.error('    · Credencial perdida: sin ella los datos son ilegibles (restáurala del kit de recuperación).');
    console.error('');
    process.exit(78);
}

const { loadFromDb } = require('./src/users/store.js');
const { backfillUserRids, backfillCallPeerHashes } = require('./src/db/schema.js');

/* El manifiesto de integridad del ENLACE credencial ↔ base (sal, keycheck,
   usuario, key_id): si alguien manipuló esas filas con el servidor parado,
   el keycheck puede seguir pasando pero el manifiesto no cuadra. Es la
   barrera contra re-vincular la base a otra credencial. */
const { checkIntegrityManifest } = require('./src/crypto/owner-key.js');
const manifiestoArranque = checkIntegrityManifest(masterKey.export());
if (!manifiestoArranque.ok) {
    console.error('');
    console.error('[crypto] El manifiesto de integridad no cuadra: el enlace entre la credencial y esta base');
    console.error('  (meta: sal, keycheck, usuario, key_id) fue modificado o corrompido.');
    console.error('  Comprueba con `npm run owner -- check` y, si no abre, restaura la base y el .env');
    console.error('  del kit de recuperación.');
    console.error('');
    process.exit(78);
}

if (ownerCredential && ownerCredential.nuevo)
    console.log(`[crypto] Instalación nueva: credencial de propietario inicializada a partir del .env ` +
        `(${ownerCredential.credential.user}). Sin ella esta base es inservible.`);

/* Permisos del almacenamiento: sin este endurecimiento, la carpeta de datos
   nacía 0755 y las bases SQLite 0644 (la auditoría SECOA-D-001/E-001 las
   midió así), es decir, LECTURAS por cualquier usuario local del equipo.
   El código de operación documentaba 0700 («dueño y grupo»: véase
   ops/backup.js) pero nada lo aplicaba. Best-effort: si el chmod no es
   posible (otro usuario, sistema sin permisos POSIX), se sigue en marcha
   avisando, porque un fallo duro aquí dejaría sin servicio. */
try {
    fs.chmodSync(DATA, 0o700);
    for (const dbPath of [DB_PATH, BLOB_DB_PATH])
        if (fs.existsSync(dbPath)) fs.chmodSync(dbPath, 0o600);
    // El .env lleva la llave maestra: nunca más legible que para su dueño.
    const envPath = path.join(ROOT, '.env');
    if (fs.existsSync(envPath)) fs.chmodSync(envPath, 0o600);
} catch (error) {
    console.warn('[perms] no se pudieron ajustar los permisos del directorio de datos:', error.message);
}

// La base declara la version del cifrado de sus datos. Si no encaja con la de
// este servidor no se arranca: los datos serian ilegibles.
const cryptoVersion = Stmt.getMeta.get('crypto_version')?.value;
if (cryptoVersion !== '2') {
    const hasStoredMessages = !!db.prepare('SELECT 1 FROM messages LIMIT 1').get();
    if (hasStoredMessages || cryptoVersion)
        throw new Error('Database crypto version is incompatible with this server. ' +
            'Restaura desde un respaldo de backups/ o arranca con una base nueva.');
    Stmt.setMeta.run('crypto_version', '2');
}

/* La versión del FORMATO POR FILA es otra: los mensajes v3 llevan
   crypto_version = 3 (y rowToMessage exige PCE3/crypto_version=3). En una
   base de la versión anterior la columna nació con DEFAULT 2:
   `CREATE TABLE IF NOT EXISTS` no toca la tabla existente, las filas
   antiguas se quedan en 2 y —sin esta guarda— el servidor arrancaba igual
   mientras TODAS las páginas de historial descartaban esos mensajes en
   silencio ([crypto] Versión no soportada). Mejor no arrancar con un
   mensaje claro que servir historiales invisibles. */
const incompatibleRow = db.prepare('SELECT id, crypto_version FROM messages WHERE crypto_version <> 3 LIMIT 1').get();
if (incompatibleRow)
    throw new Error(`Mensajes con una versión de cifrado incompatible (id=${incompatibleRow.id}, crypto_version=${incompatibleRow.crypto_version}). ` +
        'Este servidor solo lee PCE3/crypto_version=3. Restaura la base desde un respaldo de backups/ o arranca con una base nueva.');

// Carga las cuentas, los grupos y las historias en memoria.
const { seedMediaFallback } = require('./src/chat/media.js');
console.log(`[blobs] Imagen de respaldo lista (${seedMediaFallback()}).`);

/* Migración v10: las cuentas de bases anteriores reciben su `rid` AHORA, con
   la llave maestra ya en RAM (applySchema no puede hacerlo: corre mientras la
   base se abre, antes de que exista la llave). Idempotente. */
try {
    const creados = backfillUserRids(db);
    if (creados) console.log(`[db] user_rid: ${creados} cuenta(s) recibieron su rid de revocación.`);
} catch (error) {
    console.error('');
    console.error('[db] No se pudo completar la migración de user_rid (revocación de sesiones v10):');
    console.error(`  ${error && error.message ? error.message : error}`);
    console.error('  Las cuentas sin rid no aceptan ningún token: arréglalo antes de continuar.');
    console.error('');
    process.exit(78);
}

/* Migración v11: `calls.peer_hash` (índice a ciegas del par) para las filas
   de bases anteriores. Igual que el rid: necesita la llave maestra, así que
   corre aquí y no dentro de applySchema. Idempotente. */
try {
    const conHash = backfillCallPeerHashes(db);
    if (conHash) console.log(`[db] calls.peer_hash: ${conHash} fila(s) recibieron su índice de par.`);
} catch (error) {
    // No es letal: las filas sin hash siguen encontrándose por comparación
    // lenta (purga por cuenta). Avisar para que se vea.
    console.error(`[db] aviso: no se pudo completar el backfill de calls.peer_hash: ${error && error.message ? error.message : error}`);
}

loadFromDb();

// Genera el paquete bbot si hace falta y registra sus WebP en la biblioteca.
const { seedDefaultBbotStickers } = require('./src/stickers/default-pack.js');
console.log(`[stickers] Paquete bbot listo (${seedDefaultBbotStickers(db)} caras).`);

/* Auditoría de arranque: ¿la llave maestra de este proceso descifra las
   auth_key que hay en la base? Si NO descifra NINGUNA, la llave del `.env`
   no es la que cifró los datos: el servidor no debe ni servir ni escribir
   (cada escritura dejaría material que ni la nueva ni la vieja llave
   pueden leer). Si solo fallan algunas, es una desincronización parcial
   (p. ej. una cuenta creada por un proceso con la llave anterior): el
   servicio sigue, pero avisando por el nombre de las cuentas afectadas. */
const informeLlaves = auditAuthKeys();
if (informeLlaves.total > 0 && informeLlaves.ilegibles.length === informeLlaves.total) {
    throw new Error(`Ninguna de las ${informeLlaves.total} auth_key de la base se descifra con la llave maestra de este proceso: ` +
        'el .env no tiene la llave que cifró los datos. Restaura la llave del respaldo (o repárala con `npm run repair -- --apply`).');
}
if (informeLlaves.ilegibles.length > 0) {
    const cuentas = informeLlaves.ilegibles.map(fila => fila.username).join(', ');
    console.warn(`[crypto] ATENCIÓN: ${informeLlaves.ilegibles.length} de ${informeLlaves.total} auth_key no se descifran con la llave actual ` +
        `(${cuentas}). Sus perfiles no se pueden guardar y su contenido no se puede leer. ` +
        'Repáralas con `npm run repair -- --apply` (la llave anterior del respaldo es lo único que recupera su contenido).');
}

/* La credencial se cargó al arrancar. Si alguien la cambia con el servidor
   en marcha (la migración re-cifra las bases, pero el proceso vivo sigue
   escribiendo con la llave que tiene en memoria), el resultado es una base
   con dos llaves: las filas viejas quedan ilegibles y las nuevas se cifran
   con la que ya no está en el `.env`. Es exactamente la desincronización que
   costó una auth_key en esta instalación.
   El vigilante relee el `.env`; si la credencial cambia, el proceso sale con
   código 75 (EX_TEMPFAIL) y el supervisor lo reinicia ya con la credencial
   nueva. */
const { watchCredentialFile } = require('./src/crypto/master-key.js');
/* La referencia del vigilante es la del FICHERO al arrancar (no la del
   entorno): véase src/crypto/master-key.js. */
watchCredentialFile();

// Al cargarlo, `src/http/servers.js` crea los servidores y empieza a escuchar.
require('./src/http/servers.js');

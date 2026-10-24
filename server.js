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
const { loadFromDb } = require('./src/users/store.js');

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

// Carga las cuentas, los grupos y las historias en memoria.
loadFromDb();

// Al cargarlo, `src/http/servers.js` crea los servidores y empieza a escuchar.
require('./src/http/servers.js');

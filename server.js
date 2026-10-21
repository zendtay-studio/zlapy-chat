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

const { Stmt } = require('./src/db/statements.js');
const { db } = require('./src/db/database.js');
const { loadFromDb } = require('./src/users/store.js');

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

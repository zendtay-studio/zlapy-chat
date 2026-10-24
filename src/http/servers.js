/**
 * Arranque de los servidores y cierre ordenado.
 *
 * Levanta el dispatcher HTTP/HTTPS (con TLS opcional), enruta el WebSocket
 * por el mismo puerto y, al recibir SIGTERM o SIGINT, cierra los sockets de
 * los clientes para dejar el puerto libre de inmediato.
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

const { CONFIG, PORT, ROOT, TLS_CERT_FILE, TLS_KEY_FILE, tlsState } = require('../config.js');
const { db, blobDb } = require('../db/database.js');
const { users } = require('../state.js');
const { handler } = require('./router.js');
const { wsUpgrade } = require('../realtime/websocket.js');


// Arranque de servidores
// Los certificados viven por defecto en la raíz del proyecto (cert.pem/key.pem).
const useTls = fs.existsSync(TLS_CERT_FILE) && fs.existsSync(TLS_KEY_FILE);

/* Sin certificados no hay HTTPS al que redirigir: forzar TLS dejaría el
   servicio inaccesible, así que el forzado se desactiva solo (sobre
   tlsState, que es mutable: CONFIG está congelada). El usuario puede
   recuperarlo con FORCE_TLS=true cuando instale los certificados.
   En ese repliegue el arranque sigue vivo (una instalación nueva sin
   cert.pem/key.pem no debe morir), pero queda marcado:
   `tlsState.degradedNoCert` hace que el ROUTER rechace los inicios de
   sesión/registro desde fuera del propio equipo: entregar cookies de sesión
   de larga vida por HTTP en claro a la red local (WiFi) es justo el riesgo
   que FORCE_TLS quería cerrar (SECOA-B-001/C-004). Los clientes por loopback
   (la misma máquina, un proxy TLS local o las pruebas) siguen operando. */
if (tlsState.forceTls && !useTls) {
    tlsState.forceTls = false;
    tlsState.degradedNoCert = true;
    console.warn('[tls] FORCE_TLS desactivado: no hay cert.pem/key.pem. El tráfico (y la cookie de sesión) viajará sin cifrar. '
        + 'Los accesos no locales NO podrán iniciar sesión hasta instalar cert.pem/key.pem (o arrancar con FORCE_TLS=false si asumes HTTP en claro).');
}
/* Interfaz de escucha: 'loopback' restringe a la propia máquina (proxy
   inverso local); 'auto' y '0.0.0.0' mantienen el acceso por red. */
const bindHost = CONFIG.bindHost === 'loopback' ? '127.0.0.1' : '0.0.0.0';
/* Tiempo máximo sin enviar nada antes de cortar la conexión. */
const SOCKET_IDLE_TIMEOUT_MS = 60 * 1000;

const httpSrv = http.createServer(handler);
const httpsSrv = useTls ? require('https').createServer({ cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) }, handler) : null;

httpSrv.on('upgrade', wsUpgrade);
if (httpsSrv) httpsSrv.on('upgrade', wsUpgrade);

// SO_REUSEADDR permite reenganchar el puerto justo tras un reinicio: sin él,
// el socket previo en TIME_WAIT provoca EADDRINUSE y el proceso muere.
const dispatcher = net.createServer({ allowHalfOpen: false }, sock => {
    /* Timeout de inactividad: un socket que se conecta y no envía nada se quedaba
       abierto indefinidamente (los timeouts de Node solo se aplican a sockets ya
       delegados al servidor HTTP). Con una conexión vacía por socket, abrir
       muchos era la forma más barata de agotar los descriptores. */
    sock.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => { try { sock.destroy(); } catch { } });
    sock.once('readable', () => {
        sock.setTimeout(0);   // a partir de aquí manda el timeout del servidor
        const first = sock.read(1);
        if (!first) return;
        sock.unshift(first);
        const isTls = useTls && first[0] === 0x16;
        (isTls ? httpsSrv : httpSrv).emit('connection', sock);
    });
    sock.on('error', () => { });
});

dispatcher.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`\n❌ Puerto ${PORT} ocupado. Usa PORT=3001 npm start\n`);
    else console.error(e);
    process.exit(1);
});

// Reenganchar el puerto sin esperar a que expire TIME_WAIT (reinicios del
// supervisor y recargas en caliente). En Node esto equivale a SO_REUSEADDR.
dispatcher.listen({ port: PORT, host: bindHost, exclusive: false }, () => {
    const nets = require('os').networkInterfaces();
    const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.log(`\n✅ Zlapy (SQLite) en el puerto ${PORT}`);
    /* Con el forzado de TLS activo solo se anuncian las URL cifradas: ofrecer
       la de HTTP invitaría a usar una vía que el servidor va a redirigir (y en
       la que, si FORCE_TLS estuviera apagado, la cookie viajaría sin proteger). */
    if (!tlsState.forceTls) {
        console.log(`\n   Esta PC:   http://localhost:${PORT}`);
        ips.forEach(ip => console.log(`   Tu red:    http://${ip}:${PORT}`));
    }
    if (useTls) {
        console.log(`\n   HTTPS:`);
        console.log(`               https://localhost:${PORT}`);
        ips.forEach(ip => console.log(`               https://${ip}:${PORT}`));
    } else {
        console.warn('\n   ⚠️  Sin certificados (cert.pem/key.pem): no hay HTTPS.');
        console.warn('   ⚠️  El tráfico y la cookie de sesión viajan SIN CIFRAR. Úsalo solo en una red de confianza.\n');
    }
    console.log('');
});

// Shutdown limpio (checkpoint WAL)
let shuttingDown = false;
const orderlyShutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal}: cerrando de forma ordenada…`);
    const hardExit = setTimeout(() => process.exit(0), 5000).unref();
    // Cierra sockets de clientes y deja de aceptar conexiones nuevas.
    try {
        for (const u of users.values()) {
            for (const s of (u.sockets ? [...u.sockets] : [])) { try { s.destroy(); } catch { } }
            for (const s of [...u.sockets]) { try { s.destroy(); } catch { } }
        }
    } catch { }
    try { dispatcher.close(); } catch { }
    try { httpSrv.close(); } catch { }
    try { if (httpsSrv) httpsSrv.close(); } catch { }
    // Forzar el cierre de conexiones vivas (keep-alive): si no, close() espera
    // a que el cliente suelte el socket y el puerto queda ocupado.
    try { httpSrv.closeAllConnections?.(); } catch { }
    try { if (httpsSrv) httpsSrv.closeAllConnections?.(); } catch { }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); blobDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { }
    try { db.close(); blobDb.close(); } catch { }
    clearTimeout(hardExit);
    process.exit(0);
};
process.on('SIGTERM', () => orderlyShutdown('SIGTERM'));
process.on('SIGINT', () => orderlyShutdown('SIGINT'));
// Red de seguridad: registrar y morir con las bases consistentes.
process.on('uncaughtException', err => {
    console.error('[fatal] uncaughtException:', err);
    try { db.pragma('wal_checkpoint(TRUNCATE)'); blobDb.pragma('wal_checkpoint(TRUNCATE)'); } catch { }
    try { db.close(); blobDb.close(); } catch { }
    process.exit(1);
});
process.on('unhandledRejection', err => {
    // Solo registrar: una promesa rechazada no debe tumbar el servidor.
    console.error('[warn] unhandledRejection:', err);
});

module.exports = {
    httpSrv,
    httpsSrv,
    dispatcher,
    orderlyShutdown
};

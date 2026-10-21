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

const { PORT, ROOT } = require('../config.js');
const { db, blobDb } = require('../db/database.js');
const { users } = require('../state.js');
const { handler } = require('./router.js');
const { wsUpgrade } = require('../realtime/websocket.js');


// Arranque de servidores
// Los certificados viven en la raiz del proyecto (cert.pem / key.pem).
const certPath = path.join(ROOT, 'cert.pem'), keyPath = path.join(ROOT, 'key.pem');
const useTls = fs.existsSync(certPath) && fs.existsSync(keyPath);

const httpSrv = http.createServer(handler);
const httpsSrv = useTls ? require('https').createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, handler) : null;

httpSrv.on('upgrade', wsUpgrade);
if (httpsSrv) httpsSrv.on('upgrade', wsUpgrade);

// SO_REUSEADDR permite reenganchar el puerto justo tras un reinicio: sin él,
// el socket previo en TIME_WAIT provoca EADDRINUSE y el proceso muere.
const dispatcher = net.createServer({ allowHalfOpen: false }, sock => {
    sock.once('readable', () => {
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
dispatcher.listen({ port: PORT, host: '0.0.0.0', exclusive: false }, () => {
    const nets = require('os').networkInterfaces();
    const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.log(`\n✅ Zlapy (SQLite) en el puerto ${PORT}`);
    console.log(`\n   Esta PC:   http://localhost:${PORT}`);
    ips.forEach(ip => console.log(`   Tu red:    http://${ip}:${PORT}`));
    if (useTls) {
        console.log(`\n   HTTPS:`);
        console.log(`               https://localhost:${PORT}`);
        ips.forEach(ip => console.log(`               https://${ip}:${PORT}`));
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

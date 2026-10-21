/**
 * Cifrado de los frames WebSocket.
 *
 * El WebSocket es el canal por el que viajan los mensajes en tiempo real, así
 * que también se cifra. El cliente abre la conexión y envía un saludo en claro
 * con su clave pública efímera; de ahí ambos derivan la clave de la conexión y
 * a partir de ese momento cada frame es un texto `z1:<base64>`.
 *
 * Los contadores de nonce son independientes por dirección, de modo que la
 * misma clave se puede usar en ambos sentidos sin repetir nonce: cliente →
 * servidor usa la etiqueta `zlapyC2S` y servidor → cliente `zlapyS2C`.
 *
 * Un cliente que no envía el saludo sigue hablando en claro: la conexión no
 * se rompe y las versiones anteriores de la aplicación siguen funcionando.
 */
'use strict';

const { open, seal, sessionFromEphemeral } = require('../crypto/transport.js');

const WS_PREFIX = 'z1:';
const WS_INFO = 'zlapy-transport-v1/ws';
const WS_TAG_C2S = 'zlapyC2S';
const WS_TAG_S2C = 'zlapyS2C';
const MAX_COUNTER = 0xffffffff;

/* Nonce de 12 bytes: contador de 32 bits + etiqueta de dirección. */
function wsNonce(counter, tag) {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32LE(counter >>> 0, 0);
    nonce.write(tag, 4, 'utf8');
    return nonce;
}

const wsAad = (direction, counter) => `zlapy-transport-v1|WS|${direction}|${counter}`;

/* Procesa el saludo del cliente: deriva la clave y deja la conexión cifrada. */
function acceptHandshake(socket, ephemeralB64) {
    let ephemeral;
    try { ephemeral = Buffer.from(String(ephemeralB64 || ''), 'base64'); }
    catch { return false; }
    if (ephemeral.length !== 32) return false;
    socket.zlapy = { key: sessionFromEphemeral(ephemeral, WS_INFO), out: 0, in: 0 };
    return true;
}

/* Descifra un frame del cliente. Devuelve el objeto JSON o null si el frame
 * no es válido (se descarta sin cerrar la conexión). */
function openFrame(socket, text) {
    const session = socket.zlapy;
    if (!session || typeof text !== 'string' || !text.startsWith(WS_PREFIX)) return null;
    if (session.in >= MAX_COUNTER) return null;
    const counter = session.in++;
    const sealed = Buffer.from(text.slice(WS_PREFIX.length), 'base64');
    const plain = open(session.key, wsNonce(counter, WS_TAG_C2S), sealed, wsAad('C2S', counter));
    if (!plain) return null;
    try { return JSON.parse(plain.toString('utf8')); } catch { return null; }
}

/* Cifra un frame del servidor. Devuelve el texto listo para el socket o null
 * si la conexión todavía no tiene sesión (se envía en claro). */
function sealFrame(socket, json) {
    const session = socket.zlapy;
    if (!session || session.out >= MAX_COUNTER) return null;
    const counter = session.out++;
    const sealed = seal(session.key, wsNonce(counter, WS_TAG_S2C), Buffer.from(json, 'utf8'), wsAad('S2C', counter));
    return WS_PREFIX + sealed.toString('base64');
}

module.exports = {
    WS_PREFIX,
    WS_INFO,
    acceptHandshake,
    openFrame,
    sealFrame,
    wsNonce,
    wsAad,
};

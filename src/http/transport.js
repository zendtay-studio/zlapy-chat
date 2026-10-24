/**
 * Sobre cifrado en las peticiones y respuestas HTTP.
 *
 * Conecta el cifrado de transporte con el ciclo de la petición: detecta las
 * cabeceras del sobre, descifra el cuerpo antes de que el enrutador lo
 * interprete y, si la petición venía cifrada, envuelve la respuesta para
 * devolverla cifrada con la misma clave de sesión.
 *
 * Cabeceras de la petición:
 *
 *   X-Zlapy-Enc:       versión del sobre
 *   X-Zlapy-Ephemeral: clave pública efímera del cliente (base64)
 *   X-Zlapy-Nonce:     nonce (base64)
 *   X-Zlapy-Time:      marca de tiempo en milisegundos
 *
 * Cabeceras de la respuesta cifrada:
 *
 *   X-Zlapy-Enc:        versión del sobre
 *   X-Zlapy-Resp-Nonce: nonce de la respuesta (base64)
 */
'use strict';

const crypto = require('crypto');
const { MAX_CLOCK_SKEW_MS, TRANSPORT_ALGO, decryptEnvelope, responseAad, seal } = require('../crypto/transport.js');

const ENC_HEADER = 'x-zlapy-enc';
const EPHEMERAL_HEADER = 'x-zlapy-ephemeral';
const NONCE_HEADER = 'x-zlapy-nonce';
const TIME_HEADER = 'x-zlapy-time';

/* ¿La petición trae un sobre cifrado? */
const isEncrypted = req => Boolean(req.headers[ENC_HEADER]);

/* Anti-replay del sobre HTTP.
 * El sobre ata método, ruta y hora (AAD ±60 s), pero sin recordar los nonces
 * ya usados un observador podía reenviar la MISMA petición cifrada y repetir
 * el efecto (un mensaje duplicado, un contacto solicitado dos veces). El canal
 * WebSocket ya se protegía con un contador monótono; aquí se hace con la
 * memoria de nonces durante la ventana de validez del sobre. */
const usedNonces = new Map();   // nonce -> caduca en
const NONCE_MEMORY_MS = MAX_CLOCK_SKEW_MS + 30_000;
/* Tope DURO de memoria: los nonces no usados no caducan hasta la ventana (90 s),
   así que un flood de solicitudes cifradas podía guardar cientos de miles de
   entradas (varios MB) y una purga que recorría el mapa entero. Tope + evict
   del más viejo (el que está más cerca de caducar). */
const NONCE_MAX_ENTRIES = 8192;
/* ¿Nonce ya visto? Registra el nonce nuevo (con caducidad a la ventana) y
   da el resultado. SOLO se llama tras haber abierto el sobre con éxito:
   si el registro sucediera antes de validar el MAC, un flood de copias
   descartables llenaría el mapa con basura y expulsaría el nonce legítimo
   recién reenviado (replay por desalojo FIFO). Registrando tras la
   validación, solo un sobre VÁLIDO ocupa plaza — y para fabricar sobres
   válidos hacen falta las claves de sesión legítimas. */
function nonceUsado(nonce) {
    const ahora = Date.now();
    const caduca = usedNonces.get(nonce);
    if (caduca && caduca > ahora) return true;
    usedNonces.set(nonce, ahora + NONCE_MEMORY_MS);
    if (usedNonces.size > NONCE_MAX_ENTRIES / 2) {
        for (const [key, expira] of usedNonces) if (expira <= ahora) usedNonces.delete(key);
    }
    while (usedNonces.size > NONCE_MAX_ENTRIES) {
        const oldest = usedNonces.keys().next().value;
        usedNonces.delete(oldest);
    }
    return false;
}

/* Descifra el cuerpo de una petición.
 * Devuelve { data, session } o { error } con el motivo del rechazo. */
function openRequest(req, url, rawBody) {
    if (req.headers[ENC_HEADER] !== TRANSPORT_ALGO) return { error: 'Versión de cifrado no soportada.' };
    const time = Number(req.headers[TIME_HEADER]);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > MAX_CLOCK_SKEW_MS)
        return { error: 'Marca de tiempo fuera de rango.' };
    const ephemeral = Buffer.from(String(req.headers[EPHEMERAL_HEADER] || ''), 'base64');
    const nonce = Buffer.from(String(req.headers[NONCE_HEADER] || ''), 'base64');
    /* El nonce identifica al sobre: reenviarlo es la definición de replay.
       El cliente legítimo SIEMPRE manda 12 bytes, así que el vacío ya no pasa:
       sin exigirlo, un sobre sin nonce eludía el registro por completo. */
    if (nonce.length === 0 || nonce.length > 32)
        return { error: 'Sobre inválido.' };
    const opened = decryptEnvelope({
        method: req.method,
        path: url.pathname,
        time,
        ephemeral,
        nonce,
        ciphertext: rawBody
    });
    if (!opened) return { error: 'No se pudo descifrar el sobre.' };
    /* El nonce se registra SOLO cuando el sobre era legítimo (MAC verificado):
       registrar antes dejaba el mapa expulsable por flood de basura. */
    if (nonceUsado(nonce.toString('base64')))
        return { error: 'Sobre ya utilizado.' };
    let data;
    try { data = JSON.parse(opened.plaintext.toString('utf8')); }
    catch { return { error: 'Cuerpo JSON inválido.' }; }
    if (!data || typeof data !== 'object') return { error: 'El cuerpo debe ser un objeto JSON.' };
    return { data, session: { key: opened.key, method: req.method, path: url.pathname, time } };
}

/* Envuelve la respuesta para cifrarla con la clave de la petición.
 * Se intercepta `writeHead` para anunciar el sobre y `end` para cifrar el
 * cuerpo; el resto del enrutador sigue escribiendo JSON con normalidad. */
function sealResponse(res, session) {
    const originalWriteHead = res.writeHead;
    const originalEnd = res.end;
    let nonce = null;

    /* Cabeceras del sobre, sin la longitud original (cambia al cifrar). */
    const withEnvelope = headers => {
        const out = {};
        for (const [name, value] of Object.entries(headers || {})) {
            if (name.toLowerCase() === 'content-length') continue;
            out[name] = value;
        }
        out['X-Zlapy-Enc'] = TRANSPORT_ALGO;
        out['X-Zlapy-Resp-Nonce'] = nonce.toString('base64');
        out['Content-Type'] = 'application/octet-stream';
        return out;
    };

    res.writeHead = function (statusCode, reasonOrHeaders, maybeHeaders) {
        if (!nonce) nonce = crypto.randomBytes(12);
        if (typeof reasonOrHeaders === 'string')
            return originalWriteHead.call(this, statusCode, reasonOrHeaders, withEnvelope(maybeHeaders));
        return originalWriteHead.call(this, statusCode, withEnvelope(reasonOrHeaders));
    };

    res.end = function (chunk, encoding, callback) {
        if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
        if (!nonce) {
            nonce = crypto.randomBytes(12);
            this.setHeader('X-Zlapy-Enc', TRANSPORT_ALGO);
            this.setHeader('X-Zlapy-Resp-Nonce', nonce.toString('base64'));
            this.setHeader('Content-Type', 'application/octet-stream');
            this.removeHeader('Content-Length');
        }
        const body = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk === undefined || chunk === null ? '' : String(chunk), encoding || 'utf8');
        const sealed = seal(session.key, nonce, body, responseAad(session.method, session.path, session.time, this.statusCode || 200));
        return originalEnd.call(this, sealed, callback);
    };
}

module.exports = {
    isEncrypted,
    openRequest,
    sealResponse,
    nonceUsado,
    NONCE_MEMORY_MS,
};

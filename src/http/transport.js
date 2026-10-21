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

/* Descifra el cuerpo de una petición.
 * Devuelve { data, session } o { error } con el motivo del rechazo. */
function openRequest(req, url, rawBody) {
    if (req.headers[ENC_HEADER] !== TRANSPORT_ALGO) return { error: 'Versión de cifrado no soportada.' };
    const time = Number(req.headers[TIME_HEADER]);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > MAX_CLOCK_SKEW_MS)
        return { error: 'Marca de tiempo fuera de rango.' };
    const ephemeral = Buffer.from(String(req.headers[EPHEMERAL_HEADER] || ''), 'base64');
    const nonce = Buffer.from(String(req.headers[NONCE_HEADER] || ''), 'base64');
    const opened = decryptEnvelope({
        method: req.method,
        path: url.pathname,
        time,
        ephemeral,
        nonce,
        ciphertext: rawBody
    });
    if (!opened) return { error: 'No se pudo descifrar el sobre.' };
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
};

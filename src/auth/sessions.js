/**
 * Sesiones stateless («lazy»).
 *
 * El servidor GENERA el token pero NO lo guarda: la cookie lleva un JWT
 * firmado (HS256, secreto derivado de la llave maestra) y cada petición lo
 * verifica contra la firma, la caducidad y el CHECKSUM del estado vigente
 * de la cuenta (`src/auth/rid.js`): si el `rid` de `user_rid` rotó, el
 * checksum ya no cuadra y el token muere. No hay tabla `sessions` ni caché
 * de sesiones: el checksum más la firma bastan para autorizar la petición.
 *
 * La cookie de cuenta permite tener varias cuentas abiertas en el mismo
 * navegador: cada cookie lleva SU PROPIO token.
 *
 * Revocación: rotar el `rid` (contraseña nueva, cambio de cuenta)
 * invalida de golpe TODOS los tokens de esa cuenta. Al no haber almacén no
 * se puede revocar un solo token: la revocación es por cuenta. El logout,
 * en cambio, es LOCAL: limpia las cookies del navegador y sus sockets sin
 * tocar el rid, para no matar las sesiones de otros dispositivos. El
 * checksum
 * firma el estado de la cuenta (id, usuario, hash de contraseña y rid), de
 * modo que un cambio de contraseña descuadra la sesión incluso si la
 * rotación del rid fallase.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { CONFIG, tlsState } = require('../config.js');
const { Stmt } = require('../db/statements.js');
const { users } = require('../state.js');
const { loadUserFromRow } = require('../users/store.js');
const { computeChecksum, generateRid } = require('./rid.js');

/* Vida del token: la misma que tenía la sesión (30 días por defecto). El
   TTL es la red de seguridad para un token filtado que nunca se rote: con
   rid + checksum la sesión no caduca por sí sola (la revocación es el
   evento), pero un token robado sin rotar moriría igualmente a los 30
   días. */
const TOKEN_TTL_MS = CONFIG.authSessionTtlMs;
const TOKEN_ISSUER = 'zlapy-session';
const ttlEnSegundos = ms => Math.max(60, Math.floor(ms / 1000));

/* ¿El canal por el que llega esta petición puede estar siendo escuchado?
   Dos casos quedan fuera: conexión cifrada (TLS directo o proxy de
   confianza en loopback que declara HTTPS) y loopback puro (el tráfico no
   cruza la red). Todo lo demás —HTTP en claro desde otra máquina— es el
   caso del token copiado del Set-Cookie/Cookie legible en la WiFi. */
function openChannel(req) {
    if (requestEncrypted(req)) return false;
    return !isLoopbackPeer(req);
}

/* Vida del token que se emite para esta petición: completa en canal
   protegido y CORTA (AUTH_PLAIN_SESSION_TTL_MS, 8 h por defecto) en el
   abierto, de modo que el token capturado en la red valga poco aunque la
   revocación por rid no llegue a tiempo. El sobre cifrado NO salva esto:
   cifra cuerpos, no cabeceras, y la cookie viaja en la cabecera. */
function ttlForRequest(req) {
    return openChannel(req) ? CONFIG.authPlainSessionTtlMs : TOKEN_TTL_MS;
}

/* Secreto de firma estable: se DERIVA de la llave maestra (HKDF-SHA256 con
   dominio propio), igual que el resto de material criptográfico de la
   instalación. La maestra nace de la credencial del propietario, así que el
   secreto sobrevive a reinicios sin estar guardado en ninguna parte (ni en
   el .env) y cambia si cambia la credencial: una base robada con sus tokens
   sigue inútil sin ella. */
const TOKEN_SECRET = (() => {
    const { masterKey } = require('../crypto/setup.js');
    return Buffer.from(crypto.hkdfSync('sha256', masterKey.export(), Buffer.alloc(0), Buffer.from('zlapy/session-token/v1', 'utf8'), 32));
})();

/* Crea un token para la cuenta con el checksum de su estado vigente.
   HS256 FIJADO en la firma; en la verificación se PINA la lista de
   algoritmos admitidos (solo HS256): sin pinarla, un token manipulado
   podría pedir `alg: none` o confundir claves — la vuln clásica de las
   librerías JWT mal usadas. La vida va por llamada: completa por defecto
   y corta cuando el canal está abierto (ttlForRequest). */
function newSession(user, ttlMs = TOKEN_TTL_MS) {
    /* `jti` aleatorio: sin él, dos tokens del mismo usuario firmados dentro
       del mismo segundo serían IDÉNTICOS (el payload es determinista y el
       iat/exp de JWT tienen precisión de segundos). La cookie principal y la
       de cuenta vinculada se emiten en la misma respuesta: si compartieran
       token, el cambio de cuenta mataría la sesión principal. */
    /* `nbf` con 30 s de margen: rechaza tokens emitidos "en el futuro" por
       un reloj adelantado sin morir por skew de reloj entre servidores. */
    return jwt.sign({
        sub: user.id,
        iss: TOKEN_ISSUER,
        nbf: Math.floor(Date.now() / 1000) - 30,
        jti: crypto.randomBytes(8).toString('base64url'),
        checksum: computeChecksum(user)
    }, TOKEN_SECRET, { algorithm: 'HS256', expiresIn: ttlEnSegundos(ttlMs) });
}

/* Verifica firma y caducidad SIN tocar la base: devuelve el payload
   normalizado o null. NO comprueba que la cuenta exista ni que el checksum
   siga vigente (eso lo hace sessionFromToken, que necesita la cuenta). */
function decodeToken(token) {
    try {
        const payload = jwt.verify(String(token || ''), TOKEN_SECRET, { algorithms: ['HS256'], clockTolerance: 30 });
        if (!payload || typeof payload !== 'object') return null;
        if (typeof payload.sub !== 'string' || !payload.sub ||
            typeof payload.checksum !== 'string' || !payload.checksum ||
            typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
        return {
            userId: payload.sub,
            checksum: payload.checksum,
            issuedAt: Number.isInteger(payload.iat) ? payload.iat : null,
            expiresAt: payload.exp * 1000
        };
    } catch { return null; } // firma inválida, token expirado o formato roto
}

/* Comparación en tiempo constante: el checksum viaja en el token, así que
   un atacante puede proponer valores; la comparación no debe revelar por
   el tiempo cuántos bytes acertó. */
const checksumCoincide = (a, b) => {
    const ba = Buffer.from(String(a), 'utf8'), bb = Buffer.from(String(b), 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/* ¿El token se emitió ANTES de este instante? Se compara a granularidad de
   SEGUNDO (iat de JWT ya es en segundos; las marcas de la base van en ms):
   comparar en ms hacía que un token emitido en el mismo segundo del cambio
   pareciera anterior a él y quedabas fuera hasta emitir otro. */
const emitidoAntes = (issuedAtSec, msTimestamp) =>
    Number.isInteger(issuedAtSec) && Number.isFinite(msTimestamp) && msTimestamp > 0 &&
    Math.floor(msTimestamp / 1000) > issuedAtSec;

/* Resuelve la cuenta del token: firma y caducidad válidas, la cuenta existe
   y el checksum del token sigue CUADRANDO con el estado vigente. Un token
   emitido antes de una rotación del rid devuelve null AUNQUE la firma sea
   buena: es la revocación (por cuenta, sin almacén). */
function sessionFromToken(token) {
    const data = decodeToken(token);
    if (!data) return null;
    let acc = users.get(data.userId);
    if (!acc) {
        const row = Stmt.getUserById.get(data.userId);
        if (row) acc = loadUserFromRow(row);
    }
    if (!acc || !acc.rid) return null;
    if (!checksumCoincide(computeChecksum(acc), data.checksum)) return null;
    /* Defensa en profundidad: aunque la rotación del rid fallase (hueco de
       caché, escritura perdida), un token emitido antes del último cambio de
       contraseña o logout de la cuenta se rechaza igual. */
    if (emitidoAntes(data.issuedAt, acc.passwordChangedAt) || emitidoAntes(data.issuedAt, acc.loggedOutAt)) return null;
    return acc;
}

/* Cookie → token → cuenta. */
function sessionUser(req) {
    return sessionFromToken(sessionCookie(req));
}

/* Versión para cookies de cuentas vinculadas (nombre de cookie arbitrario). */
function sessionUserFromCookie(req, name) {
    return sessionFromToken(cookieValue(req, name));
}

function cookieValue(req, name) {
    const raw = req.headers.cookie || '';
    const prefix = name + '=';
    const entry = raw.split(';').map(v => v.trim()).find(v => v.startsWith(prefix));
    if (!entry) return '';
    try { return decodeURIComponent(entry.slice(prefix.length)); } catch { return ''; }
}
const sessionCookie = (req, name = 'chatlocal_session') => cookieValue(req, name);
const accountCookieName = userId => 'chatlocal_account_' + userId;
/* Cookies de cuentas vinculadas presentes en este navegador (add-account). */
function accountCookies(req) {
    const raw = req.headers.cookie || '';
    const out = [];
    for (const part of raw.split(';')) {
        const entry = part.trim();
        const eq = entry.indexOf('=');
        if (eq <= 0) continue;
        const name = entry.slice(0, eq);
        if (!name.startsWith('chatlocal_account_')) continue;
        let value = '';
        try { value = decodeURIComponent(entry.slice(eq + 1)); } catch { value = entry.slice(eq + 1); }
        if (value) out.push([name, value]);
    }
    return out;
}
function appendCookie(res, value) {
    const current = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', current ? [...(Array.isArray(current) ? current : [current]), value] : value);
}
/* ¿El último salto de la petición llegó cifrado?
 *
 * Dos casos: conexión TLS directa (`req.socket.encrypted`) o proxy de
 * confianza que termina TLS y reenvía en claro declarándolo con
 * `X-Forwarded-Proto`. La cabecera **solo** se acepta desde loopback, que es
 * el despliegue documentado (el túnel de Cloudflare corre en la misma
 * máquina): si se confiase en ella desde cualquier origen, un cliente podría
 * hacerse pasar por HTTPS.
 *
 * OJO: `CONFIG.forceTls` NO entra aquí. Es la propia condición la que decide
 * si hay que redirigir, así que darla por cumplida haría que la redirección
 * nunca se produjera. */
function requestEncrypted(req) {
    if (req.socket && req.socket.encrypted) return true;
    return req.headers['x-forwarded-proto'] === 'https' && isLoopbackPeer(req);
}
/* ¿La cookie debe marcarse como `Secure`?
   Sí si la conexión va cifrada, y también con FORCE_TLS activo: en ese modo
   toda petición en claro se redirige a HTTPS, así que la cookie solo puede
   acabar en una conexión cifrada. Se lee de tlsState (el valor EFECTIVO):
   si el repliegue sin certificados lo bajó, la cookie no se marca Secure
   sobre HTTP o el navegador la rechazaría. */
function cookieSecure(req) {
    return requestEncrypted(req) || tlsState.forceTls;
}
/* Par local (loopback IPv4/IPv6): quien habla con el servidor desde la propia
   máquina, es decir el túnel o un proxy inverso local. */
function isLoopbackPeer(req) {
    const address = req && req.socket && req.socket.remoteAddress;
    if (typeof address !== 'string' || !address) return false;
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('::ffff:127.');
}
function setSessionCookie(res, req, token, ttlMs = TOKEN_TTL_MS) {
    const secure = cookieSecure(req);
    appendCookie(res, `chatlocal_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlEnSegundos(ttlMs)}${secure ? '; Secure' : ''}`);
}
function setAccountSessionCookie(res, req, userId, token, ttlMs = TOKEN_TTL_MS) {
    const secure = cookieSecure(req);
    appendCookie(res, `${accountCookieName(userId)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlEnSegundos(ttlMs)}${secure ? '; Secure' : ''}`);
}
function clearCookie(res, req, name) {
    const secure = cookieSecure(req);
    appendCookie(res, `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}
const clearSessionCookie = (res, req) => clearCookie(res, req, 'chatlocal_session');

/* Rota el `rid` de la cuenta: todos los tokens emitidos antes dejan de
   validar (el checksum descuadra), incluidos los de otros dispositivos.
   Lo llaman el cambio de contraseña y el cambio de cuenta — NO el logout,
   que es local a un navegador. Además actualiza las marcas de tiempo que
   usa la segunda defensa (iat vs. último cambio de contraseña). La RAM
   queda al día para que el siguiente token emitido lleve el checksum
   nuevo. Devuelve el rid. */
function rotateRid(user) {
    const now = Date.now();
    const rid = generateRid(user.id);
    Stmt.upsertRid.run(user.id, rid, now, now);
    user.rid = rid;
    user.passwordChangedAt = now;
    user.loggedOutAt = now;
    return rid;
}

function createSession(user, req, res) {
    /* Un solo TTL para las DOS cookies de esta respuesta: principal y de
       cuenta vinculada nacen juntas y caducan juntas. */
    const ttl = ttlForRequest(req);
    setSessionCookie(res, req, newSession(user, ttl), ttl);
    /* La cuenta queda además "conectada" en este navegador, pero con un
       token PROPIO (no el mismo que la principal): así el cambio de cuenta
       puede re-emitir la cookie de la cuenta vinculada sin matar la
       principal, y se puede volver a ella sin volver a iniciar sesión. */
    setAccountSessionCookie(res, req, user.id, newSession(user, ttl), ttl);
    return { id: user.id, username: user.username };
}
function createLinkedAccountSession(user, req, res) {
    const ttl = ttlForRequest(req);
    setAccountSessionCookie(res, req, user.id, newSession(user, ttl), ttl);
    return { id: user.id, username: user.username };
}
/* Comprobación de origen: el host del header Origin debe coincidir con el
   que sirve la petición. Es la primera barrera contra el CSRF y también
   evita que otro sitio abra el WebSocket.
   Sin Origin la petición sigue admitida: los navegadores siempre lo mandan en
   las peticiones cross-site (y son las que interesan) y en las same-site de
   origen propio; los clientes sin navegador ya tienen el token. */
function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
/* El hash de las contraseñas de cuenta vive en `src/auth/password.js`
   (bcrypt en un worker aparte). Aquí ya no se derivan contraseñas: solo se
   gestionan los tokens firmados y sus cookies. */

module.exports = {
    TOKEN_ISSUER,
    TOKEN_TTL_MS,
    decodeToken,
    sessionFromToken,
    sessionUser,
    sessionUserFromCookie,
    cookieValue,
    sessionCookie,
    accountCookieName,
    accountCookies,
    appendCookie,
    rotateRid,
    setSessionCookie,
    setAccountSessionCookie,
    clearCookie,
    clearSessionCookie,
    createSession,
    createLinkedAccountSession,
    openChannel,
    ttlForRequest,
    originAllowed,
    isLoopbackPeer,
    requestEncrypted,
    cookieSecure
};

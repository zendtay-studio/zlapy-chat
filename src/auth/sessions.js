/**
 * Sesiones y cookies.
 *
 * Las sesiones viven en RAM (con respaldo en SQLite) y se identifican por un
 * token opaco de 32 bytes que viaja en una cookie HttpOnly. La cookie de
 * cuenta permite tener varias cuentas abiertas en el mismo navegador.
 */
'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const https = require('https');
const { Stmt } = require('../db/statements.js');
const { push } = require('../realtime/notify.js');
const { AUTH_SESSION_TTL, sessionCache, users } = require('../state.js');
const { loadUserFromRow } = require('../users/store.js');

// Auth (sessions en RAM + SQLite)
const hashSessionToken = t => crypto.createHash('sha256').update(t).digest('hex');
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
function getSessionFromCache(hash) {
    let s = sessionCache.get(hash);
    if (s && s.expiresAt > Date.now()) return s;
    if (s) sessionCache.delete(hash);
    const row = Stmt.getSession.get(hash);
    if (!row || row.expires_at <= Date.now()) return null;
    s = { userId: row.user_id, expiresAt: row.expires_at };
    sessionCache.set(hash, s);
    return s;
}
function sessionUser(req) {
    const token = sessionCookie(req);
    if (!token) return null;
    const hash = hashSessionToken(token);
    const s = getSessionFromCache(hash);
    if (!s) return null;
    const acc = users.get(s.userId);
    if (acc) return acc;
    // La cuenta no está en RAM: puede existir en la base (se recarga) o haber
    // sido borrada (la sesión queda huérfana y se elimina).
    const row = Stmt.getUserById.get(s.userId);
    if (row) return loadUserFromRow(row);
    sessionCache.delete(hash);
    try { Stmt.deleteSession.run(hash); } catch { }
    return null;
}
function setSessionCookie(res, req, token) {
    const secure = !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    appendCookie(res, `chatlocal_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(AUTH_SESSION_TTL / 1000)}${secure ? '; Secure' : ''}`);
}
function setAccountSessionCookie(res, req, userId, token) {
    const secure = !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    appendCookie(res, `${accountCookieName(userId)}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(AUTH_SESSION_TTL / 1000)}${secure ? '; Secure' : ''}`);
}
function clearCookie(res, req, name) {
    const secure = !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    appendCookie(res, `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}
const clearSessionCookie = (res, req) => clearCookie(res, req, 'chatlocal_session');
function createSession(user, req, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = hashSessionToken(token);
    const expiresAt = Date.now() + AUTH_SESSION_TTL;
    Stmt.insertSession.run(hash, user.id, expiresAt);
    sessionCache.set(hash, { userId: user.id, expiresAt });
    setSessionCookie(res, req, token);
    setAccountSessionCookie(res, req, user.id, token);
    return { id: user.id, username: user.username };
}
function createLinkedAccountSession(user, req, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = hashSessionToken(token);
    const expiresAt = Date.now() + AUTH_SESSION_TTL;
    Stmt.insertSession.run(hash, user.id, expiresAt);
    sessionCache.set(hash, { userId: user.id, expiresAt });
    setAccountSessionCookie(res, req, user.id, token);
    return { id: user.id, username: user.username };
}
/* Comprobación de origen: el host del header Origin debe coincidir con el
   que sirve la petición. Es la primera barrera contra el CSRF y también
   evita que otro sitio abra el WebSocket. */
function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
/* scrypt con N=16384, r=8 y p=1: coste suficiente para frenar la fuerza bruta
   sin latencias notables; el límite de memoria evita que una llamada con
   parámetros desmedidos deje la máquina sin recursos. */
async function passwordDigest(password, salt) {
    return (await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
}
/* Comparación en tiempo constante: el hash se compara byte a byte sin que el
   tiempo que tarda dependa de dónde difieren, para no abrir la puerta a un
   ataque por temporización. */
const safeEqualHex = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b) || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};


module.exports = {
    hashSessionToken,
    cookieValue,
    sessionCookie,
    accountCookieName,
    accountCookies,
    appendCookie,
    getSessionFromCache,
    sessionUser,
    setSessionCookie,
    setAccountSessionCookie,
    clearCookie,
    clearSessionCookie,
    createSession,
    createLinkedAccountSession,
    originAllowed,
    passwordDigest,
    safeEqualHex,
};

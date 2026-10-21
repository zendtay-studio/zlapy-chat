/**
 * Rutas de autenticación.
 *
 * Registro, login, alta y baja de cuentas vinculadas, cambio de cuenta y
 * logout. Cada petición autenticada llega con `req.authUser` ya resuelto por
 * la capa de sesiones; aquí se aplican los frenos de fuerza bruta por cuenta
 * e IP y se gestionan las cookies de sesión y de cuenta.
 */
'use strict';

const crypto = require('crypto');
const { accountCookieName, accountCookies, clearCookie, clearSessionCookie, createLinkedAccountSession, createSession, getSessionFromCache, hashSessionToken, passwordDigest, safeEqualHex, sessionCookie, sessionUser, setAccountSessionCookie } = require('./sessions.js');
const { Stmt } = require('../db/statements.js');
const { loginAttempts, registerAttempts } = require('../http/rate-limit.js');
const { json } = require('../http/responses.js');
const { broadcastUsersAround } = require('../realtime/notify.js');
const { clientIp, validUsername } = require('../shared/validation.js');
const { blockedSet, notesMap, profiles, sessionCache, usernameIndex, users } = require('../state.js');
const { normPriv } = require('../users/privacy.js');
const { accountByName, loadUserFromRow, saveUserToDb } = require('../users/store.js');

function getAuthSession(req, res, url, data, actor) {
    const token = sessionCookie(req);
    const user = sessionUser(req);
    if (user) {
    setAccountSessionCookie(res, req, user.id, sessionCookie(req));
    return json(res, 200, { authenticated: true, user: { id: user.id, username: user.username } });
    }
    // Sin sesión viva: si alguna cookie de cuenta guardada apunta a una
    // cuenta borrada, se avisa y se limpia, para que el cliente la olvide.
    let goneId = '';
    for (const part of String(req.headers.cookie || '').split(';')) {
    const name = part.split('=')[0].trim();
    if (!name.startsWith('chatlocal_account_')) continue;
    const accountId = name.slice('chatlocal_account_'.length);
    if (Stmt.getUserById.get(accountId)) continue;
    goneId = goneId || accountId;
    clearCookie(res, req, name);
    }
    if (token) clearSessionCookie(res, req);
    return json(res, 200, goneId
    ? { authenticated: false, gone: true, accountId: goneId }
    : { authenticated: false });
}

function getKey(req, res, url, data, actor) {
    // Solo se sirve la clave pública de la cuenta propia: el cliente usa
    // POST /key para su propio par, y entregar la clave de otra cuenta a
    // cualquier sesión autenticada expondría material criptográfico ajeno.
    const target = url.searchParams.get('username') || '';
    if (target && target.toLowerCase() !== req.authUser.username.toLowerCase())
    return json(res, 404, { error: 'No disponible.' });
    const u = req.authUser;
    return json(res, 200, { username: u.username, pubKey: u.publicKey || null });
}

function postKey(req, res, url, data, actor) {
    const user = req.authUser;
    if (!data.pubKey || typeof data.pubKey !== 'object') return json(res, 400, { error: 'clave inválida' });
    user.publicKey = data.pubKey; saveUserToDb(user);
    return json(res, 200, { ok: true });
}

async function postAuthRegister(req, res, url, data, actor) {
    // El registro ejecuta scrypt por petición: sin cota es un
    // DoS de CPU y una fábrica de cuentas basura.
    const regIp = clientIp(req);
    const regCurrent = registerAttempts.get(regIp);
    if (regCurrent && regCurrent.until > Date.now() && regCurrent.count >= 15)
        return json(res, 429, { error: 'Demasiados registros desde esta red. Prueba más tarde.' });
    const regEntry = regCurrent && regCurrent.until > Date.now()
        ? regCurrent
        : { count: 0, until: Date.now() + 60 * 60 * 1000 };
    regEntry.count++;
    registerAttempts.set(regIp, regEntry);
    if (typeof data.username === 'string') data.username = data.username.trim().toLowerCase();
    if (!validUsername(data.username) || typeof data.password !== 'string' || data.password.length < 8 || data.password.length > 128)
        return json(res, 400, { error: 'Invalid username or password.' });
    if (accountByName(data.username)) return json(res, 409, { error: 'Username is already taken.' });
    try {
        const id = crypto.randomUUID();
        const passwordSalt = crypto.randomBytes(16).toString('hex');
        const passwordHash = await passwordDigest(data.password, passwordSalt);
        // Segunda comprobación tras el hash, por si dos registros compiten.
        if (accountByName(data.username)) return json(res, 409, { error: 'Username is already taken.' });
        const user = {
            id, username: data.username, passwordHash, passwordSalt,
            publicKey: null, groupSeen: {}, stickers: [], contacts: [],
            addPolicy: 'request', sockets: new Set(), online: false, lastSeen: null,
            createdAt: Date.now()
        };
        // Índice limpio: cualquier entrada previa del mismo nombre
        // se reemplaza por la cuenta nueva. La nota también se
        // borra, para que la cuenta nueva no herede la anterior.
        usernameIndex.delete(data.username);
        delete notesMap[data.username];
        users.set(id, user);
        usernameIndex.set(data.username, id);
        profiles[user.username] = { username: user.username, name: user.username, avatar: '', desc: '', note: '', privacy: normPriv(null) };
        blockedSet.set(user.username, new Set());
        saveUserToDb(user);
        const publicUser = createSession(user, req, res);
        broadcastUsersAround(user.id);
        return json(res, 201, { ok: true, user: publicUser });
    } catch (e) {
        console.error('[register]', e);
        return json(res, 500, { error: 'No se pudo crear la cuenta.' });
    }
}

async function postAuthLogin(req, res, url, data, actor) {
    const ip = clientIp(req);
    const name = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
    // Límite por CUENTA objetivo: detrás del túnel todas las
    // conexiones comparten IP, así que un tope solo por IP
    // bloquearía el login de todo el mundo. El tope por IP existe
    // pero es mucho más suave (30).
    // El bloqueo por cuenta se guarda POR CUENTA E IP: con la IP
    // en la clave, el bloqueo alcanza a quien falla desde esa
    // misma IP y no a la víctima. El 429 se devuelve antes de
    // comprobar la contraseña, así que con el contador agotado
    // ni un acierto pasa.
    const acct = loginAttempts.get('acct:' + name + '@' + ip);
    const byIp = loginAttempts.get('ip:' + ip);
    if ((acct && acct.until > Date.now() && acct.count >= 8) ||
        (byIp && byIp.until > Date.now() && byIp.count >= 30))
        return json(res, 429, { error: 'Too many login attempts.' });
    const user = name ? accountByName(name) : null;
    let valid = false;
    if (user && typeof data.password === 'string' && data.password.length <= 128)
        valid = safeEqualHex(user.passwordHash, await passwordDigest(data.password, user.passwordSalt));
    else await passwordDigest('invalid-password', '00'.repeat(16));
    if (!valid) {
        for (const key of ['acct:' + name + '@' + ip, 'ip:' + ip]) {
            const current = loginAttempts.get(key);
            const entry = current && current.until > Date.now() ? current : { count: 0, until: Date.now() + 10 * 60 * 1000 };
            entry.count++;
            loginAttempts.set(key, entry);
        }
        return json(res, 401, { error: 'Invalid username or password.' });
    }
    loginAttempts.delete('acct:' + name + '@' + ip);
    loginAttempts.delete('acct:' + name);
    return json(res, 200, { ok: true, user: createSession(user, req, res) });
}

async function postAuthAddAccount(req, res, url, data, actor) {
    if (!req.authUser) return json(res, 401, { error: 'authentication required' });
    const ip = clientIp(req);
    const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
    // Freno de fuerza bruta: se consultan los contadores por cuenta
    // e IP antes de validar la contraseña (umbrales 8 y 30). La
    // cuenta se cuenta junto a la IP para que un atacante no
    // pueda bloquear a la víctima desde otra red.
    const acct = loginAttempts.get('acct:' + username + '@' + ip);
    const byIp = loginAttempts.get('ip:' + ip);
    if ((acct && acct.until > Date.now() && acct.count >= 8) ||
        (byIp && byIp.until > Date.now() && byIp.count >= 30))
        return json(res, 429, { error: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.' });
    const user = validUsername(username) ? accountByName(username) : null;
    const password = typeof data.password === 'string' ? data.password : '';
    const valid = user && password.length <= 128
        ? safeEqualHex(user.passwordHash, await passwordDigest(password, user.passwordSalt))
        : (await passwordDigest('invalid-password', '00'.repeat(16)), false);
    if (!valid) {
        for (const key of ['acct:' + username + '@' + ip, 'ip:' + ip]) {
            const current = loginAttempts.get(key);
            const entry = current && current.until > Date.now() ? current : { count: 0, until: Date.now() + 10 * 60 * 1000 };
            entry.count++;
            loginAttempts.set(key, entry);
        }
        return json(res, 401, { error: 'Usuario o contraseña incorrectos.' });
    }
    loginAttempts.delete('acct:' + username + '@' + ip);
    loginAttempts.delete('acct:' + username);
    return json(res, 200, { ok: true, user: createLinkedAccountSession(user, req, res) });
}

function postAuthSwitch(req, res, url, data, actor) {
    const accountIdV = typeof data.accountId === 'string' ? data.accountId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountIdV))
        return json(res, 400, { error: 'Cuenta inválida.' });
    const token = sessionCookie(req, accountCookieName(accountIdV));
    const hash = token ? hashSessionToken(token) : '';
    const s = token ? getSessionFromCache(hash) : null;
    if (!s || s.userId !== accountIdV) {
        clearCookie(res, req, accountCookieName(accountIdV));
        return json(res, 401, { error: 'Sesión no disponible.', gone: true });
    }
    let user = users.get(accountIdV);
    if (!user) {
        const row = Stmt.getUserById.get(accountIdV);
        if (row) user = loadUserFromRow(row);
    }
    if (!user) {
        // La cuenta no está en la base: se limpia la sesión y su cookie.
        sessionCache.delete(hash);
        try { Stmt.deleteSession.run(hash); } catch { }
        clearCookie(res, req, accountCookieName(accountIdV));
        return json(res, 401, { error: 'Cuenta no disponible.', gone: true });
    }
    // Al cambiar de cuenta se ROTA el token: la sesión principal
    // pasa a ser una sesión nueva, distinta de la cookie de la
    // cuenta vinculada.
    try { Stmt.deleteSession.run(hash); } catch { }
    sessionCache.delete(hash);
    const switched = createSession(user, req, res);
    return json(res, 200, { ok: true, user: switched });
}

function postAuthAccountRemove(req, res, url, data, actor) {
    const accountIdV = typeof data.accountId === 'string' ? data.accountId : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountIdV))
        return json(res, 400, { error: 'Cuenta inválida.' });
    if (req.authUser.id === accountIdV)
        return json(res, 400, { error: 'No puedes quitar la cuenta que estás usando.' });
    const token = sessionCookie(req, accountCookieName(accountIdV));
    if (token) {
        const hash = hashSessionToken(token);
        const s = sessionCache.get(hash);
        if (!s || s.userId === accountIdV) {
            sessionCache.delete(hash);
            Stmt.deleteSession.run(hash);
            const user = users.get(accountIdV);
            if (user) for (const s of [...user.sockets]) if (s.authToken === token) { try { s.destroy(); } catch { } }
        }
    }
    clearCookie(res, req, accountCookieName(accountIdV));
    return json(res, 200, { ok: true });
}

function postAuthLogout(req, res, url, data, actor) {
    const token = sessionCookie(req);
    const hash = token ? hashSessionToken(token) : '';
    const s = hash ? sessionCache.get(hash) : null;
    if (hash) { sessionCache.delete(hash); Stmt.deleteSession.run(hash); }
    const user = s && users.get(s.userId);
    if (user) for (const sk of [...user.sockets]) if (sk.authToken === token) { try { sk.destroy(); } catch { } }
    clearSessionCookie(res, req);
    if (s) clearCookie(res, req, accountCookieName(s.userId));
    // Cerrar sesión revoca TODAS las cuentas abiertas en este
    // navegador, incluidas las cuentas vinculadas (add-account):
    // sus sesiones se borran y sus cookies se limpian.
    for (const [name, value] of accountCookies(req)) {
        if (s && name === accountCookieName(s.userId)) continue;
        const h = hashSessionToken(value);
        const linked = getSessionFromCache(h);
        sessionCache.delete(h);
        try { Stmt.deleteSession.run(h); } catch { }
        const u = linked && users.get(linked.userId);
        if (u) for (const sk of [...u.sockets]) if (sk.authToken === value) { try { sk.destroy(); } catch { } }
        clearCookie(res, req, name);
    }
    return json(res, 200, { ok: true });
}


module.exports = {
    getAuthSession,
    getKey,
    postKey,
    postAuthRegister,
    postAuthLogin,
    postAuthAddAccount,
    postAuthSwitch,
    postAuthAccountRemove,
    postAuthLogout,
};

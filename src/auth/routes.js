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

/* Umbrales de los frenos de fuerza bruta.
 *
 * El contador por CUENTA e IP mide retardo progresivo, NO bloqueo: tras unos
 * fallos cada intento espera el doble que el anterior (con tope). Un atacante
 * pierde toda la ventaja de la fuerza bruta (no puede probar contraseñas a
 * ritmo) y, sobre todo, **no puede dejar a la víctima sin poder entrar**: su
 * acceso legítimo solo tarda unos segundos más y el contador se borra en
 * cuanto acierta. Es la diferencia con un 429 por cubo, que tras el túnel (todo
 * sale de la misma IP) habría permitido bloquear a terceros a voluntad.
 *
 * El contador por IP también existen, pero SOLO para la IP que falla: rota
 * nombres o direcciones de cuenta y el freno te sigue. Antes había un
 * enfriamiento GLOBAL que devolvía 429 a TODOS los usuarios (300 fallos desde
 * cualquier origen cerraban el acceso del servicio entero un minuto): con eso
 * un atacante dejaba sin login a usuarios legítimos (DoS de disponibilidad).
 * Ahora el 429 siempre es por IP. */
const LOGIN_DELAY_FROM = 4;
const LOGIN_DELAY_MAX_MS = 10 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/* Caduca el freno por IP: cientos de fallos en una ventana son fuerza bruta,
 * nunca uso legítimo (un usuario se equivoca dos o tres veces). */
const LOGIN_IP_LIMIT = 120;
const LOGIN_IP_COOLDOWN_MS = 60 * 1000;
/* Retardo que corresponde a un número de fallos: 500 ms, 1 s, 2 s, 4 s… hasta
   el tope. Nunca bloquea: solo frena. */
const loginDelayMs = fails => Math.min(LOGIN_DELAY_MAX_MS, 500 * Math.pow(2, Math.max(0, fails - LOGIN_DELAY_FROM)));

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
    // DoS de CPU y una fábrica de cuentas basura. El contador usa la IP del
    // socket (no una cabecera) y se complementa con uno global, para que rotar
    // direcciones no sirva de nada.
    const regIp = clientIp(req);
    const regNow = Date.now();
    const regGlobal = registerAttempts.get('global:registros');
    if (regGlobal && regGlobal.until > regNow)
        return json(res, 429, { error: 'Demasiados registros. Prueba más tarde.' });
    const regCurrent = registerAttempts.get(regIp);
    if (regCurrent && regCurrent.until > regNow && regCurrent.count >= 15)
        return json(res, 429, { error: 'Demasiados registros desde esta red. Prueba más tarde.' });
    const regEntry = regCurrent && regCurrent.until > regNow
        ? regCurrent
        : { count: 0, until: Date.now() + 60 * 60 * 1000 };
    regEntry.count++;
    registerAttempts.set(regIp, regEntry);
    /* Contador global de registros: 60 por hora en todo el servicio. Cruza ese
       umbral solo una fuerza bruta o una fábrica de cuentas, nunca el uso
       normal de una instancia doméstica. */
    const g0 = regGlobal && regGlobal.count !== undefined ? regGlobal : { count: 0, until: 0 };
    g0.count++;
    if (g0.count >= 60) {
        g0.until = regNow + 15 * 60 * 1000;
        g0.count = 30;
        console.warn('[register] 60 registros en una hora: enfriamiento de 15 minutos.');
    }
    registerAttempts.set('global:registros', g0);
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
    /* Contadores de fallos, en dos niveles:
       · por CUENTA e IP → retardo progresivo (nunca bloqueo), ver las
         constantes de arriba.
       · por IP → circuit breaker que devuelve 429 SOLO a esa dirección,
         para frenar a quien rota nombres de cuenta. Cada intento de login
         cuesta un scrypt completo: sin tope por IP, miles de peticiones
         desde una sola máquina martillean la CPU del proceso compartido.
       La IP es siempre la del socket (nunca una cabecera), así que no se puede
       falsear para girar entre cubos. */
    const acct = loginAttempts.get('acct:' + name + '@' + ip);
    const ipBox = loginAttempts.get('brk:' + ip);
    const now = Date.now();
    if (ipBox && ipBox.cooldown > now) {
        res.setHeader('Retry-After', String(Math.ceil((ipBox.cooldown - now) / 1000)));
        return json(res, 429, { error: 'Demasiados intentos fallidos desde esta red. Espera un minuto.' });
    }
    const user = name ? accountByName(name) : null;
    let valid = false;
    if (user && typeof data.password === 'string' && data.password.length <= 128)
        valid = safeEqualHex(user.passwordHash, await passwordDigest(data.password, user.passwordSalt));
    else await passwordDigest('invalid-password', '00'.repeat(16));
    if (!valid) {
        // Se registra el fallo y se FRENA el siguiente intento de este cubo.
        const entry = acct && acct.until > now ? acct : { count: 0, until: now + LOGIN_WINDOW_MS };
        entry.count++;
        loginAttempts.set('acct:' + name + '@' + ip, entry);
        const brk = ipBox && ipBox.until > now ? ipBox : { count: 0, until: now + LOGIN_WINDOW_MS, cooldown: 0 };
        brk.count++;
        if (brk.count >= LOGIN_IP_LIMIT) {
            brk.cooldown = now + LOGIN_IP_COOLDOWN_MS;
            brk.count = 0;
            console.warn(`[auth] ${LOGIN_IP_LIMIT} intentos de acceso fallidos desde ${ip}: enfriamiento de ${LOGIN_IP_COOLDOWN_MS / 1000}s SOLO para esa dirección.`);
        }
        loginAttempts.set('brk:' + ip, brk);
        await new Promise(resolve => setTimeout(resolve, loginDelayMs(entry.count)));
        return json(res, 401, { error: 'Invalid username or password.' });
    }
    // Acierto: el cubo de esa cuenta e IP se limpia, el acceso legítimo vuelve
    // a ser inmediato (también el de la víctima tras los fallos de un atacante).
    loginAttempts.delete('acct:' + name + '@' + ip);
    const espera = acct && acct.count >= LOGIN_DELAY_FROM ? loginDelayMs(acct.count) : 0;
    if (espera > 0) await new Promise(resolve => setTimeout(resolve, espera));
    return json(res, 200, { ok: true, user: createSession(user, req, res) });
}

async function postAuthAddAccount(req, res, url, data, actor) {
    if (!req.authUser) return json(res, 401, { error: 'authentication required' });
    const ip = clientIp(req);
    const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
    /* Mismos frenos que el acceso: contador por cuenta e IP con retardo
       progresivo (nunca bloqueo) más el circuit breaker por IP. */
    const acct = loginAttempts.get('acct:' + username + '@' + ip);
    const ipBox = loginAttempts.get('brk:' + ip);
    const now = Date.now();
    if (ipBox && ipBox.cooldown > now) {
        res.setHeader('Retry-After', String(Math.ceil((ipBox.cooldown - now) / 1000)));
        return json(res, 429, { error: 'Demasiados intentos desde esta red. Espera un minuto e inténtalo de nuevo.' });
    }
    const user = validUsername(username) ? accountByName(username) : null;
    const password = typeof data.password === 'string' ? data.password : '';
    const valid = user && password.length <= 128
        ? safeEqualHex(user.passwordHash, await passwordDigest(password, user.passwordSalt))
        : (await passwordDigest('invalid-password', '00'.repeat(16)), false);
    if (!valid) {
        const entry = acct && acct.until > now ? acct : { count: 0, until: now + LOGIN_WINDOW_MS };
        entry.count++;
        loginAttempts.set('acct:' + username + '@' + ip, entry);
        const brk = ipBox && ipBox.until > now ? ipBox : { count: 0, until: now + LOGIN_WINDOW_MS, cooldown: 0 };
        brk.count++;
        if (brk.count >= LOGIN_IP_LIMIT) {
            brk.cooldown = now + LOGIN_IP_COOLDOWN_MS;
            brk.count = 0;
            console.warn(`[auth] ${LOGIN_IP_LIMIT} intentos fallidos desde ${ip} (enlazar cuentas): enfriamiento de ${LOGIN_IP_COOLDOWN_MS / 1000}s SOLO para esa dirección.`);
        }
        loginAttempts.set('brk:' + ip, brk);
        await new Promise(resolve => setTimeout(resolve, loginDelayMs(entry.count)));
        return json(res, 401, { error: 'Usuario o contraseña incorrectos.' });
    }
    loginAttempts.delete('acct:' + username + '@' + ip);
    const espera = acct && acct.count >= LOGIN_DELAY_FROM ? loginDelayMs(acct.count) : 0;
    if (espera > 0) await new Promise(resolve => setTimeout(resolve, espera));
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
    /* También se revoca la sesión SALIENTE (la cookie principal de la cuenta
       que se abandona). Sin esto, el token anterior seguía siendo válido
       30 días: quien lo hubiera copiado (una cookie filtrada, otro navegador)
       mantenía el acceso a la cuenta que el usuario creía haber cerrado. */
    const outgoing = req.authUser;
    if (outgoing && outgoing.id !== user.id) {
        for (const [tokenHash, session] of sessionCache) {
            if (session.userId === outgoing.id) {
                sessionCache.delete(tokenHash);
                try { Stmt.deleteSession.run(tokenHash); } catch { }
            }
        }
        for (const sk of [...(outgoing.sockets || [])]) { try { sk.destroy(); } catch { } }
    }
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

// Tokens de sesión stateless («lazy», v10).
//
// El servidor GENERA el token (JWT HS256, secreto derivado de la llave
// maestra) pero NO lo guarda: no hay tabla `sessions` ni caché. La cookie
// lleva el token y cada petición verifica firma + caducidad + el CHECKSUM
// del estado vigente de la cuenta (id | usuario | hash de contraseña | rid,
// src/auth/rid.js). Rotar el rid de `user_rid` (cambio de contraseña,
// cambio de cuenta) descuadra el checksum y revoca de golpe TODOS los
// tokens de la cuenta, también los de otros dispositivos. El logout NO
// rota: es local al navegador (limpia sus cookies y sus sockets).
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, stop, api, register, sessionCookieFrom } = require('../helpers.js');

const b64json = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/* Jar de cookies: cada Set-Cookie reemplaza a la anterior. */
function jarFrom(setCookie) {
    const jar = {};
    for (const part of String(setCookie || '').split(/,(?=[^;,=]+=)/)) {
        const pair = part.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        jar[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
    }
    return jar;
}
const cookieHeader = jar => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

/* Petición con un jar completo de cookies (main + cuentas vinculadas). */
async function fetchWithCookies(base, pathname, jar, body) {
    const response = await fetch(base + pathname, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: base,
            'Sec-Fetch-Site': 'same-origin',
            Cookie: cookieHeader(jar)
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    Object.assign(jar, jarFrom(response.headers.get('set-cookie')));
    return { status: response.status, json: await response.json().catch(() => ({})) };
}

/* ¿Esta cookie de sesión sigue autenticando? */
const authenticated = async (base, cookie) => {
    const r = await api(base, 'GET', '/auth/session', null, cookie);
    return !!r.json.authenticated;
};

/* Lee el rid y las marcas de revocación directamente de la base. */
function ridRow(dbPath, username) {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.prepare(`SELECT r.rid, r.password_changed_at, r.logged_out_at
            FROM user_rid r JOIN users u ON u.id = r.user_id WHERE u.username = ?`).get(username);
    } finally { db.close(); }
}

test('el token es un JWT HS256 firmado con checksum y no deja ninguna fila de sesión', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-jwt-'));
    const srv = await startServer({ dataDir });
    try {
        const ana = await register(srv.base, 'ana');
        assert.ok(ana.cookie.includes('.'), 'la cookie lleva un token con partes');
        const [headB64, payloadB64] = ana.cookie.split('.');
        const head = b64json(headB64);
        const payload = b64json(payloadB64);
        assert.equal(head.alg, 'HS256', 'el algoritmo declarado es HS256');
        assert.equal(typeof payload.sub, 'string', 'el token nombra la cuenta');
        assert.equal(typeof payload.checksum, 'string', 'el token lleva el checksum del estado de la cuenta');
        assert.ok(/^[0-9a-f]{64}$/.test(payload.checksum), 'el checksum es SHA-256 en hexadecimal');
        assert.ok(!('ver' in payload), 'ya no viaja ninguna versión de autenticación en el token');
        assert.ok(payload.exp > Date.now() / 1000, 'el token lleva caducidad futura');
        assert.ok(jtiUnico(payload), 'el token lleva jti propio');

        const session = await api(srv.base, 'GET', '/auth/session', null, ana.cookie);
        assert.equal(session.json.authenticated, true, 'el token autentica sin almacén');
    } finally { await stop(srv); }

    // Sin servidor: la base no guarda sesiones; la cuenta tiene su rid.
    const db = new Database(path.join(dataDir, 'zlapy.db'), { readonly: true });
    try {
        assert.equal(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='sessions'").get().c, 0,
            'no existe la tabla sessions');
        assert.equal(db.prepare("SELECT COUNT(*) AS c FROM user_rid").get().c, 1, 'cada cuenta tiene su fila de rid');
    } finally { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

/* Dos tokens seguidos no pueden ser idénticos (iat/exp tienen precisión de
   segundos: sin jti, la cookie principal y la vinculada lo compartirían). */
function jtiUnico(payload) {
    return typeof payload.jti === 'string' && payload.jti.length >= 8;
}

test('un token manipulado o inventado no autentica', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const [head, payload, sig] = ana.cookie.split('.');

        // Payload retocado (checksum inventado, misma firma): debe caer.
        const falsificado = [head, Buffer.from(JSON.stringify({ ...b64json(payload), checksum: 'f'.repeat(64) })).toString('base64url'), sig].join('.');
        assert.equal(await authenticated(srv.base, falsificado), false, 'un payload retocado no vale');

        // Basura con forma de JWT.
        assert.equal(await authenticated(srv.base, 'aaa.bbb.ccc'), false);
        assert.equal(await authenticated(srv.base, ''), false);
        assert.equal(await authenticated(srv.base, 'null'), false);

        // El token auténtico sigue sirviendo.
        assert.equal(await authenticated(srv.base, ana.cookie), true);
    } finally { await stop(srv); }
});

test('el checksum ata el token al estado: un rid distinto en la base lo invalida', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-checksum-'));
    const srv = await startServer({ dataDir });
    let ana;
    try {
        ana = await register(srv.base, 'ana');
        assert.equal(await authenticated(srv.base, ana.cookie), true, 'el token arranca válido');
    } finally { await stop(srv); }

    // Rotación del rid hecha DIRECTAMENTE en la base (sin pasar por el
    // servidor): al reiniciar, la RAM se rehidrata con el rid nuevo y el
    // checksum del token ya no describe el estado vigente.
    const db = new Database(path.join(dataDir, 'zlapy.db'));
    db.prepare('UPDATE user_rid SET rid = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)')
        .run('rid-rotado-a-mano', 'ana');
    db.close();

    const srv2 = await startServer({ dataDir });
    try {
        assert.equal(await authenticated(srv2.base, ana.cookie), false,
            'con el rid cambiado el checksum descuadra y el token muere');
        // Y la cuenta sigue pudiendo emitir tokens nuevos con el estado actual.
        const relogin = await api(srv2.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
        assert.equal(relogin.status, 200, 'la cuenta sigue operativa con su rid nuevo');
    } finally { await stop(srv2); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('cambiar la contraseña rota el rid: TODOS los tokens de la cuenta mueren', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        // Un "segundo dispositivo": otro login legítimo con su propio token.
        const otro = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
        const cookieOtro = sessionCookieFrom(otro.setCookie);
        assert.equal(await authenticated(srv.base, cookieOtro), true, 'el segundo token funciona al inicio');

        // Cambio de contraseña (exige la actual): responde con cookies nuevas.
        const cambio = await api(srv.base, 'POST', '/account/profile',
            { username: 'ana', currentPassword: 'pruebachat1', password: 'clavenueva123' }, ana.cookie);
        assert.equal(cambio.status, 200, 'la contraseña cambia');
        const cookieNueva = sessionCookieFrom(cambio.setCookie);
        assert.ok(cookieNueva && cookieNueva !== ana.cookie, 'la respuesta trae token nuevo');

        assert.equal(await authenticated(srv.base, ana.cookie), false,
            'el token ANTERIOR ya no vale');
        assert.equal(await authenticated(srv.base, cookieOtro), false,
            'el token del otro dispositivo tampoco (revocación por cuenta)');
        assert.equal(await authenticated(srv.base, cookieNueva), true,
            'el token emitido tras el cambio sigue dentro');

        // Y con la contraseña nueva se puede volver a entrar.
        const relogin = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'clavenueva123' });
        assert.equal(relogin.status, 200);
    } finally { await stop(srv); }
});

test('logout NO rota el rid: es local al navegador y no mata otras sesiones', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const otro = await api(srv.base, 'POST', '/auth/login', { username: 'ana', password: 'pruebachat1' });
        const cookieOtro = sessionCookieFrom(otro.setCookie);

        const salida = await api(srv.base, 'POST', '/auth/logout', {}, ana.cookie);
        assert.equal(salida.status, 200);

        /* El logout limpia las cookies de ESTE navegador, pero el token no
           se revoca en el servidor: otro dispositivo no puede morir por un
           cierre de sesión ajeno (el rid no rota y el checksum sigue
           cuadrando). La revocación global es el cambio de contraseña. */
        assert.equal(await authenticated(srv.base, ana.cookie), true,
            'el token con el que se cerró sesión sigue validando (solo se borra la cookie)');
        assert.equal(await authenticated(srv.base, cookieOtro), true,
            'los demás dispositivos conservan la sesión');
    } finally { await stop(srv); }
});

test('V-10: cambiar de cuenta revoca los tokens de la cuenta abandonada', async () => {
    const srv = await startServer();
    try {
        const anaRes = await api(srv.base, 'POST', '/auth/register', { username: 'ana', password: 'pruebachat1' });
        const betoRes = await api(srv.base, 'POST', '/auth/register', { username: 'beto', password: 'pruebachat1' });
        const anaId = anaRes.json.user.id;
        const betoId = betoRes.json.user.id;
        const jarA = jarFrom(anaRes.setCookie);
        const jarB = jarFrom(betoRes.setCookie);

        const jar = {
            chatlocal_session: jarA.chatlocal_session,
            [`chatlocal_account_${anaId}`]: jarA[`chatlocal_account_${anaId}`],
            [`chatlocal_account_${betoId}`]: jarB[`chatlocal_account_${betoId}`]
        };
        const tokenAnaOriginal = jar.chatlocal_session;

        // Cambio a beto: rota el rid de ana.
        const ida = await fetchWithCookies(srv.base, '/auth/switch', jar, { accountId: betoId });
        assert.equal(ida.status, 200, 'el cambio funciona');
        assert.equal(ida.json.user.id, betoId);

        // El token principal ORIGINAL de ana ya no vale (V-10).
        assert.equal(await authenticated(srv.base, tokenAnaOriginal), false,
            'el token saliente queda revocado');

        // Ana sigue conectada en este navegador: su cookie de cuenta fue
        // re-emitida con el rid ya rotado, así que se puede VOLVER sin
        // contraseña.
        assert.notEqual(jar[`chatlocal_account_${anaId}`], jarA[`chatlocal_account_${anaId}`],
            'la cookie de la cuenta abandonada se renueva');
        const vuelta = await fetchWithCookies(srv.base, '/auth/switch', jar, { accountId: anaId });
        assert.equal(vuelta.status, 200, 'volver a la cuenta abandonada funciona sin contraseña');
        assert.equal(vuelta.json.user.id, anaId);
    } finally { await stop(srv); }
});

test('el token sobrevive al reinicio (secreto estable) y también al logout', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-token-'));
    const dbPath = path.join(dataDir, 'zlapy.db');
    const srv1 = await startServer({ dataDir });
    let ana;
    let ridAntes;
    try {
        ana = await register(srv1.base, 'ana');
        ridAntes = ridRow(dbPath, 'ana').rid;
        assert.ok(ridAntes, 'la cuenta nace con rid');
    } finally { await stop(srv1); }

    // El token sin rotar sigue valiendo tras el reinicio: el secreto se
    // recalcula igual desde la llave maestra.
    const srv2 = await startServer({ dataDir });
    try {
        assert.equal(await authenticated(srv2.base, ana.cookie), true,
            'un token sin rotar sigue válido tras reiniciar');
        assert.equal(ridRow(dbPath, 'ana').rid, ridAntes, 'el rid no cambia solo por reiniciar');

        // Logout: NO rota el rid (es local al navegador).
        assert.equal((await api(srv2.base, 'POST', '/auth/logout', {}, ana.cookie)).status, 200);
    } finally { await stop(srv2); }

    const despues = ridRow(dbPath, 'ana');
    assert.equal(despues.rid, ridAntes, 'el rid no cambia al cerrar sesión');
    assert.equal(despues.logged_out_at, 0, 'no queda marca de logout (el logout no rota)');

    const srv3 = await startServer({ dataDir });
    try {
        assert.equal(await authenticated(srv3.base, ana.cookie), true,
            'tras reiniciar, el token sigue válido: el logout no lo revocó');
    } finally {
        await stop(srv3);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

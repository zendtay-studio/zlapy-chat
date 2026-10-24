// Regresión del cambio de cuenta entre cuentas conectadas ("Cuentas
// conectadas" de Ajustes ▸ Cuenta).
//
// El servidor antes respondía `gone: true` (cuenta eliminada) tanto si la
// cuenta no estaba en la base COMO si la cookie de la cuenta vinculada había
// caducado o el navegador la había perdido. El cliente quitaba la cuenta de
// la lista en ambos casos: una cuenta perfectamente válida se perdía por una
// cookie caducada, y además la fila seguía en pantalla (el mensaje decía
// "se quitó de la lista" pero no se quitaba).
//
// Ahora se distinguen:
//   · gone   -> la cuenta no existe en el servidor: se quita de la lista.
//   · relogin -> la cuenta existe pero su sesión caducó: se pide la contraseña
//                otra vez y se reintenta el cambio, sin quitar nada.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { startServer, stop, api, register, sessionCookieFrom } = require('./helpers.js');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

/* Jar de cookies del navegador: cada Set-Cookie reemplaza a la anterior. */
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

async function switchAccount(srv, jar, accountId) {
    const response = await fetch(`${srv.base}/auth/switch`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: srv.base,
            'Sec-Fetch-Site': 'same-origin',
            Cookie: cookieHeader(jar)
        },
        body: JSON.stringify({ accountId })
    });
    Object.assign(jar, jarFrom(response.headers.get('set-cookie')));
    return { status: response.status, json: await response.json().catch(() => ({})) };
}

test('cambiar de cuenta y volver funciona sin pedir contraseña', async () => {
    const srv = await startServer();
    try {
        const anaRes = await api(srv.base, 'POST', '/auth/register', { username: 'ana', password: 'pruebachat1' });
        const betoRes = await api(srv.base, 'POST', '/auth/register', { username: 'beto', password: 'pruebachat1' });
        const anaId = anaRes.json.user.id;
        const betoId = betoRes.json.user.id;
        const anaJar = jarFrom(anaRes.setCookie);
        const betoJar = jarFrom(betoRes.setCookie);
        const cookieAna = `chatlocal_account_${anaId}`;
        const cookieBeto = `chatlocal_account_${betoId}`;

        // La cookie de cuenta lleva su PROPIA sesión: si compartiera token con
        // la principal, el cambio de cuenta mataría la cuenta conectada.
        assert.ok(anaJar[cookieAna], 'al iniciar sesión se abre la cookie de cuenta');
        assert.notEqual(anaJar[cookieAna], anaJar.chatlocal_session,
            'la cookie de cuenta usa una sesión distinta de la principal');

        // El navegador guarda las dos cuentas conectadas.
        const jar = {
            chatlocal_session: anaJar.chatlocal_session,
            [cookieAna]: anaJar[cookieAna],
            [cookieBeto]: betoJar[cookieBeto]
        };

        const ida = await switchAccount(srv, jar, betoId);
        assert.equal(ida.status, 200, 'cambiar a la otra cuenta funciona');
        assert.equal(ida.json.user.id, betoId);

        // La cuenta abandonada recibe una sesión vinculada nueva: sigue en la
        // lista y se puede volver a ella sin contraseña.
        assert.ok(jar[cookieAna], 'la cuenta abandonada conserva su cookie de cuenta');
        assert.notEqual(jar[cookieAna], anaJar[cookieAna], 'su sesión vinculada se renueva');

        const vuelta = await switchAccount(srv, jar, anaId);
        assert.equal(vuelta.status, 200, 'volver a la cuenta anterior también funciona, sin contraseña');
        assert.equal(vuelta.json.user.id, anaId);

        // Y otra vez hacia la otra, sin pedir nada.
        const otra = await switchAccount(srv, jar, betoId);
        assert.equal(otra.status, 200, 'el cambio de cuenta es repetible');
    } finally { await stop(srv); }
});

test('al registrar se guarda el nombre visible de la cuenta', async () => {
    const srv = await startServer();
    try {
        const alta = await api(srv.base, 'POST', '/auth/register',
            { username: 'connombre', password: 'pruebachat1', name: 'Ana Ruiz' });
        assert.equal(alta.status, 201);
        const cookie = sessionCookieFrom(alta.setCookie);
        const perfil = await api(srv.base, 'GET', '/profile?username=connombre&me=connombre', null, cookie);
        assert.equal(perfil.json.name, 'Ana Ruiz', 'el nombre visible se guarda en el perfil');

        // La foto no cabe en /auth/register: se guarda después, con la sesión
        // de la cuenta ya creada.
        const foto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const subida = await api(srv.base, 'POST', '/profile', { username: 'connombre', avatar: foto }, cookie);
        assert.equal(subida.status, 200, 'la foto de perfil se guarda tras el alta');
        const conFoto = await api(srv.base, 'GET', '/profile?username=connombre&me=connombre', null, cookie);
        assert.equal(conFoto.json.avatar, foto, 'la foto queda en el perfil');

        // Un nombre demasiado largo se rechaza.
        const largo = await api(srv.base, 'POST', '/auth/register',
            { username: 'nombrelargo', password: 'pruebachat1', name: 'x'.repeat(65) });
        assert.equal(largo.status, 400, 'el nombre admite como mucho 64 caracteres');
    } finally { await stop(srv); }
});

test('cambiar a una cuenta existente sin su cookie pide volver a iniciar sesión', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        await register(srv.base, 'beto');
        const add = await api(srv.base, 'POST', '/auth/add-account', { username: 'beto', password: 'pruebachat1' }, ana.cookie);
        assert.equal(add.status, 200, 'la cuenta se enlaza');
        const betoId = add.json.user.id;

        // Cambio de cuenta SIN la cookie de la cuenta enlazada (caducada o
        // perdida): la cuenta sigue existiendo, así que NO debe marcarse como
        // eliminada.
        const cambio = await api(srv.base, 'POST', '/auth/switch', { accountId: betoId }, ana.cookie);
        assert.equal(cambio.status, 401);
        assert.equal(cambio.json.relogin, true, 'debe pedir volver a iniciar sesión');
        assert.notEqual(cambio.json.gone, true, 'no debe marcarse como eliminada');

        // Con la cookie de la cuenta enlazada, el cambio sí funciona.
        const cuentaCookie = new RegExp(`chatlocal_account_${betoId}=([^;]+)`).exec(add.setCookie || '');
        assert.ok(cuentaCookie, 'add-account debe devolver la cookie de la cuenta');
        const ok = await fetch(`${srv.base}/auth/switch`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: srv.base,
                'Sec-Fetch-Site': 'same-origin',
                Cookie: `chatlocal_session=${encodeURIComponent(ana.cookie)}; chatlocal_account_${betoId}=${encodeURIComponent(decodeURIComponent(cuentaCookie[1]))}`
            },
            body: JSON.stringify({ accountId: betoId })
        });
        assert.equal(ok.status, 200, 'con la cookie, el cambio de cuenta funciona');
    } finally { await stop(srv); }
});

test('cambiar a una cuenta que no existe en el servidor la marca como eliminada', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        // Identificador con forma válida pero que no está en la base.
        const fantasma = '11111111-1111-4111-8111-111111111111';
        const cambio = await api(srv.base, 'POST', '/auth/switch', { accountId: fantasma }, ana.cookie);
        assert.equal(cambio.status, 401);
        assert.equal(cambio.json.gone, true, 'una cuenta inexistente sí se marca como eliminada');
        assert.notEqual(cambio.json.relogin, true, 'no debe pedir volver a iniciar sesión');
    } finally { await stop(srv); }
});

test('sin sesión vigente /auth/switch no revela si una cuenta existe', async () => {
    const srv = await startServer();
    try {
        await register(srv.base, 'ana');
        const existente = '22222222-2222-4222-8222-222222222222';
        // Sin ninguna cookie: la respuesta NO distingue "existe" de "no existe"
        // (si lo hiciera, la ruta pública sería un oráculo de enumeración).
        const cambio = await api(srv.base, 'POST', '/auth/switch', { accountId: existente });
        assert.equal(cambio.status, 401);
        assert.equal(cambio.json.gone, undefined, 'no debe marcar cuentas como eliminadas sin sesión');
        assert.equal(cambio.json.relogin, undefined, 'no debe pedir re-autenticación sin sesión');
    } finally { await stop(srv); }
});

test('re-autenticar exige que las credenciales sean de la cuenta seleccionada', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const beto = await register(srv.base, 'beto');
        // Credenciales correctas, pero de OTRA cuenta que la seleccionada.
        const falsa = await api(srv.base, 'POST', '/auth/add-account',
            { username: 'beto', password: 'pruebachat1', expectedAccountId: ana.json.user.id }, ana.cookie);
        assert.equal(falsa.status, 409, 'no debe enlazar una cuenta distinta a la esperada');
        assert.match(falsa.json.error || '', /no son de la cuenta seleccionada/i);

        // Si la cuenta esperada es la correcta, funciona.
        const buena = await api(srv.base, 'POST', '/auth/add-account',
            { username: 'beto', password: 'pruebachat1', expectedAccountId: beto.json.user.id }, ana.cookie);
        assert.equal(buena.status, 200, 'con la cuenta correcta sí se enlaza');
    } finally { await stop(srv); }
});

test('el cliente distingue gone de relogin y refresca la lista de cuentas', () => {
    const bloque = CLIENT.slice(CLIENT.indexOf('async function switchLinkedAccount'));
    const fin = bloque.indexOf('function fitWidth');
    const cuerpo = fin > 0 ? bloque.slice(0, fin) : bloque;

    assert.match(cuerpo, /if \(result\.gone\)/, 'debe tratar el caso gone');
    assert.match(cuerpo, /if \(result\.relogin\)/, 'debe tratar el caso relogin');
    assert.match(cuerpo, /forgetAccount\(accountId\);[\s\S]*quitarFilaCuenta\(accountId\);[\s\S]*paintSettings\(\);/,
        'al quitar una cuenta inexistente debe quitarse la fila y refrescar la lista');

    // La rama relogin NO quita la cuenta de la lista: la cuenta sigue viva.
    const ramaRelogin = cuerpo.slice(cuerpo.indexOf('if (result.relogin)'));
    assert.doesNotMatch(ramaRelogin, /forgetAccount/, 'la rama relogin no quita la cuenta de la lista');
    // Y NO pide la contraseña: el cambio de cuenta es silencioso.
    assert.doesNotMatch(ramaRelogin, /prompt\(|askAccountFields|password/i,
        'la rama relogin no debe pedir la contraseña');
    assert.match(ramaRelogin, /Agregar cuenta/, 'debe explicar cómo volver a conectar la cuenta');

    // Ya no existe el re-autenticador con contraseña.
    assert.doesNotMatch(CLIENT, /async function reloginLinkedAccount/,
        'el cliente ya no re-autentica con contraseña');

    // Un doble clic no puede abrir dos cambios en curso.
    assert.match(cuerpo, /cambiosDeCuentaEnCurso\.has\(accountId\)/, 'debe evitar cambios duplicados en curso');
    assert.match(cuerpo, /finally\s*\{\s*cambiosDeCuentaEnCurso\.delete\(accountId\);/, 'debe liberar el bloqueo al terminar');
});

test('el compositor vuelve a ser escribible si el envío de la nota de voz falla', () => {
    /* El envío de un audio va por XHR (barra de progreso). Si la respuesta no
       se puede leer, el cliente cree que falló: el compositor se quedaba en
       modo "preview" y el campo de texto desaparecía, sin forma de escribir. */
    const bloque = CLIENT.slice(CLIENT.indexOf('async function sendPreview'));
    const fin = bloque.indexOf('\n            let seMode');
    const cuerpo = fin > 0 ? bloque.slice(0, fin) : bloque;
    assert.ok(cuerpo.length > 0, 'debe existir sendPreview');

    // Ambos caminos de fallo (respuesta no válida y envío rechazado) devuelven
    // el compositor a su estado normal.
    const ramas = cuerpo.split('if (!sent)');
    assert.ok(ramas.length >= 2, 'debe comprobar el caso de envío no aceptado');
    assert.match(ramas[1], /discardPreview\(\);/, 'si el envío no se acepta, el compositor se restaura');
    assert.match(cuerpo.slice(cuerpo.indexOf('catch (e)')), /discardPreview\(\);/,
        'si el envío lanza un error, el compositor se restaura');
});

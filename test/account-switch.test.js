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
const { startServer, stop, api, register } = require('./helpers.js');

const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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
    const fin = bloque.indexOf('async function reloginLinkedAccount');
    const cuerpo = fin > 0 ? bloque.slice(0, fin) : bloque;

    assert.match(cuerpo, /if \(result\.gone\)/, 'debe tratar el caso gone');
    assert.match(cuerpo, /if \(result\.relogin\)/, 'debe tratar el caso relogin');
    assert.match(cuerpo, /forgetAccount\(accountId\);[\s\S]*quitarFilaCuenta\(accountId\);[\s\S]*paintSettings\(\);/,
        'al quitar una cuenta inexistente debe quitarse la fila y refrescar la lista');

    // La rama relogin NO quita la cuenta de la lista: la cuenta sigue viva.
    const ramaRelogin = cuerpo.slice(cuerpo.indexOf('if (result.relogin)'));
    assert.doesNotMatch(ramaRelogin, /forgetAccount/, 'la rama relogin no quita la cuenta de la lista');

    // Al re-autenticar, solo se quita si el servidor confirma que ya no existe.
    const re = CLIENT.slice(CLIENT.indexOf('async function reloginLinkedAccount'));
    const cuerpoRe = re.slice(0, re.indexOf('\n            }', re.indexOf('async function reloginLinkedAccount')));
    assert.match(cuerpoRe, /\/auth\/add-account/, 'debe volver a enlazar la cuenta con su contraseña');
    assert.match(cuerpoRe, /expectedAccountId: accountId/, 'debe exigir que las credenciales sean de esa cuenta');
    assert.match(cuerpoRe, /altaResult\.user\.id !== accountId/, 'debe comprobar que la cuenta devuelta es la esperada');
    assert.match(cuerpoRe, /\/auth\/switch/, 'debe reintentar el cambio de cuenta');
    const ramaGone = cuerpoRe.slice(cuerpoRe.indexOf('if (cambioResult.gone)'));
    assert.match(ramaGone, /forgetAccount\(accountId\)/,
        'si tras volver a autenticarse la cuenta ya no existe, se quita de la lista');

    // Un doble clic no puede abrir dos diálogos de re-autenticación.
    assert.match(cuerpo, /cambiosDeCuentaEnCurso\.has\(accountId\)/, 'debe evitar cambios duplicados en curso');
    assert.match(cuerpo, /finally\s*\{\s*cambiosDeCuentaEnCurso\.delete\(accountId\);/, 'debe liberar el bloqueo al terminar');
});

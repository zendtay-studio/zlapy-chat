// Privacidad de /auth/session: sin una sesión válida, las cookies de cuentas
// vinculadas no deben revelar si un UUID existe ni mediante el cuerpo ni
// mediante la limpieza selectiva de cookies.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, stop, register } = require('../helpers.js');

async function consultaConCuenta(base, accountId) {
    const response = await fetch(base + '/auth/session', {
        headers: { Cookie: `zlapy_account_${accountId}=sesion-invalida` }
    });
    return {
        json: await response.json(),
        setCookie: response.headers.get('set-cookie') || ''
    };
}

test('/auth/session anónimo responde igual para UUID existente e inexistente', async () => {
    const srv = await startServer();
    try {
        const ana = await register(srv.base, 'ana');
        const existente = ana.json.user.id;
        const inexistente = '11111111-1111-4111-8111-111111111111';

        const conCuenta = await consultaConCuenta(srv.base, existente);
        const sinCuenta = await consultaConCuenta(srv.base, inexistente);

        assert.deepEqual(conCuenta.json, { authenticated: false });
        assert.deepEqual(sinCuenta.json, conCuenta.json,
            'gone/accountId no deben delatar la existencia de la cuenta');
        assert.doesNotMatch(conCuenta.setCookie, new RegExp(`zlapy_account_${existente}`));
        assert.doesNotMatch(sinCuenta.setCookie, new RegExp(`zlapy_account_${inexistente}`),
            'borrar solo la cookie inexistente también era un oráculo');
    } finally { await stop(srv); }
});

test('el cliente no conserva una rama muerta basada en el oráculo eliminado', () => {
    const cliente = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    assert.doesNotMatch(cliente, /session\.gone|session\.accountId/,
        'las cuentas locales se gestionan sin inferir existencia desde una respuesta anónima');
});

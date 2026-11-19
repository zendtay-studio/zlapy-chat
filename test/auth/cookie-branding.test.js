// Contrato estricto de cookies: solo zlapy_session y zlapy_account_<uuid>.
// Los nombres antiguos chatlocal_* no se aceptan ni como fallback.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api } = require('../helpers.js');

function valorCookie(setCookie, nombre) {
    const match = new RegExp(`(?:^|,\\s*)${nombre}=([^;]+)`).exec(setCookie || '');
    return match ? decodeURIComponent(match[1]) : '';
}

async function peticion(base, path, cookie, options = {}) {
    return fetch(base + path, {
        method: options.method || 'GET',
        headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.method === 'POST' ? {
                Origin: base,
                'Sec-Fetch-Site': 'same-origin',
                'Content-Type': 'application/json'
            } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
}

test('el servidor emite zlapy_* y rechaza chatlocal_*', async () => {
    const srv = await startServer();
    try {
        const alta = await api(srv.base, 'POST', '/auth/register', {
            username: 'marca', password: 'pruebachat1'
        });
        assert.equal(alta.status, 201);
        const accountId = alta.json.user.id;
        const session = valorCookie(alta.setCookie, 'zlapy_session');
        const account = valorCookie(alta.setCookie, `zlapy_account_${accountId}`);
        assert.ok(session, 'debe emitir zlapy_session');
        assert.ok(account, 'debe emitir zlapy_account_<uuid>');
        assert.doesNotMatch(alta.setCookie, /chatlocal_/);

        const conSesionNueva = await peticion(srv.base, '/users', `zlapy_session=${encodeURIComponent(session)}`);
        assert.equal(conSesionNueva.status, 200, 'zlapy_session autentica');
        const conSesionVieja = await peticion(srv.base, '/users', `chatlocal_session=${encodeURIComponent(session)}`);
        assert.equal(conSesionVieja.status, 401, 'chatlocal_session no se acepta aunque el JWT sea válido');

        const cambioNuevo = await peticion(srv.base, '/auth/switch',
            `zlapy_session=${encodeURIComponent(session)}; zlapy_account_${accountId}=${encodeURIComponent(account)}`,
            { method: 'POST', body: { accountId } });
        assert.equal(cambioNuevo.status, 200, 'zlapy_account_<uuid> permite cambiar la cuenta vinculada');

        const cambioViejo = await peticion(srv.base, '/auth/switch',
            `zlapy_session=${encodeURIComponent(session)}; chatlocal_account_${accountId}=${encodeURIComponent(account)}`,
            { method: 'POST', body: { accountId } });
        assert.equal(cambioViejo.status, 401, 'chatlocal_account_<uuid> no se acepta como fallback');
    } finally { await stop(srv); }
});

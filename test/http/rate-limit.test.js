// Cotas de frecuencia por ruta:
//  - base para TODAS las rutas de API (antes no había ninguna en los públicos
//    ni en las lecturas autenticadas);
//  - autenticación, más estricta que el resto (60/min frente a 300/min);
//  - todos los valores configurables desde .env;
//  - /healthz EXENTO: el supervisor lo sondea cada segundo y un 429 lo
//    reiniciaría estando sano.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startServer, stop, api, register } = require('../helpers.js');

const get = (base, ruta, cookie) => fetch(base + ruta, {
    headers: cookie ? { Cookie: `chatlocal_session=${encodeURIComponent(cookie)}` } : {}
});
const logout = base => api(base, 'POST', '/auth/logout', {});

test('la cota base pública cubre /config (429 al superar 300 peticiones)', async () => {
    const srv = await startServer();
    try {
        /* El sondeo de arranque del servidor de pruebas también consume una
           petición de la misma cota, así que el corte puede llegar una antes. */
        let permitidas = 0;
        for (let i = 0; i < 300; i++) {
            const r = await get(srv.base, '/config');
            if (r.status === 200) { permitidas++; continue; }
            assert.equal(r.status, 429, `la petición ${i + 1} debía pasar o cortar en 429`);
            break;
        }
        assert.ok(permitidas >= 299, `se esperaban al menos 299 permitidas, hubo ${permitidas}`);
        const r = await get(srv.base, '/config');
        assert.equal(r.status, 429, 'ya no pasa: la cota base pública existe');
    } finally { await stop(srv); }
});

test('la cota base autenticada cubre las lecturas y se configura desde .env', async () => {
    const srv = await startServer({ env: { RATE_LIMIT_API_PER_MINUTE: '5' } });
    try {
        const ana = await register(srv.base, 'rlapi1');
        for (let i = 0; i < 5; i++)
            assert.equal((await get(srv.base, '/config', ana.cookie)).status, 200);
        const r = await get(srv.base, '/config', ana.cookie);
        assert.equal(r.status, 429, 'con 5/min configurado, la sexta petición no pasa');
        // Y sigue valiendo para una lectura autenticada de verdad.
        const contactos = await api(srv.base, 'GET', '/contacts', null, ana.cookie);
        assert.equal(contactos.status, 429);
    } finally { await stop(srv); }
});

test('autenticación tiene una cota más estricta que el resto', async () => {
    const srv = await startServer();
    try {
        // 60 cierres de sesión: la ruta de auth se corta en la 61.
        for (let i = 0; i < 60; i++)
            assert.equal((await logout(srv.base)).status, 200, `logout ${i + 1}`);
        const cortada = await logout(srv.base);
        assert.equal(cortada.status, 429, 'la ruta de auth se corta antes');

        // …pero la base pública aguanta mucho más: 61 peticiones aún pasan.
        const config = await get(srv.base, '/config');
        assert.equal(config.status, 200, 'la base pública es más permisiva que auth');
    } finally { await stop(srv); }
});

test('la cota de autenticación también se configura desde .env', async () => {
    const srv = await startServer({ env: { RATE_LIMIT_AUTH_PER_MINUTE: '3' } });
    try {
        for (let i = 0; i < 3; i++) assert.equal((await logout(srv.base)).status, 200);
        assert.equal((await logout(srv.base)).status, 429);
        // Y la base pública, que es más permisiva, no se ha visto afectada.
        assert.equal((await get(srv.base, '/config')).status, 200);
    } finally { await stop(srv); }
});

test('/healthz NUNCA se limita (el supervisor lo sondea cada segundo)', async () => {
    /* Con la cota pública en 2 peticiones por minuto, /config se corta en
       seguida pero /healthz sigue respondiendo 200 siempre: un 429 aquí
       haría que el supervisor reiniciara un servicio sano. */
    const srv = await startServer({ env: { RATE_LIMIT_PUBLIC_PER_MINUTE: '2' } });
    try {
        for (let i = 0; i < 25; i++) {
            const r = await get(srv.base, '/healthz');
            assert.equal(r.status, 200, `/healthz debe responder siempre (petición ${i + 1})`);
        }
        // Mientras tanto, una ruta pública normal sí se corta al superar su cota.
        let cortada = 0;
        for (let i = 0; i < 5; i++) {
            const config = await get(srv.base, '/config');
            if (config.status === 429) { cortada++; break; }
        }
        assert.equal(cortada, 1, 'la cota pública sigue existiendo en las demás rutas');
    } finally { await stop(srv); }
});
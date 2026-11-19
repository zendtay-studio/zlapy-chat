// El proxy de GIPHY debe acotar tanto la conexión como la lectura upstream.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchGiphy } = require('../../src/stickers/routes.js');

test('fetchGiphy cancela el upstream a los 8 s', async t => {
    const fetchReal = globalThis.fetch;
    const timeoutReal = AbortSignal.timeout;
    let timeoutMs = 0;
    let signalRecibida = null;
    t.after(() => {
        globalThis.fetch = fetchReal;
        AbortSignal.timeout = timeoutReal;
    });

    AbortSignal.timeout = ms => {
        timeoutMs = ms;
        const controller = new AbortController();
        // AbortSignal.timeout usa timers unref; este timer con ref evita que
        // el runner termine antes de la cancelación simulada.
        setTimeout(() => controller.abort(new Error('timeout de prueba')), 10);
        return controller.signal;
    };
    globalThis.fetch = (url, options) => {
        signalRecibida = options.signal;
        if (!signalRecibida)
            return Promise.resolve({ ok: true, text: async () => '{}' });
        return new Promise((resolve, reject) => {
            signalRecibida.addEventListener('abort', () => reject(signalRecibida.reason), { once: true });
        });
    };

    assert.equal(typeof fetchGiphy, 'function', 'el proxy expone su cliente HTTP acotado para probarlo');
    await assert.rejects(fetchGiphy('https://api.giphy.com/v1/gifs/trending', new URLSearchParams({ api_key: 'prueba' })));
    assert.equal(timeoutMs, 8000);
    assert.ok(signalRecibida instanceof AbortSignal);
});

// Un servicio push que no contesta no puede retener para siempre el envío.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { pushTo } = require('../../src/push/vapid.js');

function suscripcionValida() {
    const gen = crypto.createECDH('prime256v1');
    gen.generateKeys();
    return {
        endpoint: 'https://fcm.googleapis.com/fcm/send/token-lento',
        keys: {
            p256dh: gen.getPublicKey().toString('base64'),
            auth: crypto.randomBytes(16).toString('base64')
        }
    };
}

test('pushTo usa un AbortSignal de 5 s y termina si el upstream cuelga', async t => {
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
        // La prueba no espera cinco segundos. Un temporizador con ref mantiene
        // vivo el runner hasta recorrer el camino real de cancelación (los
        // timers de AbortSignal.timeout son unref).
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('timeout de prueba')), 10);
        return controller.signal;
    };
    globalThis.fetch = (url, options) => {
        signalRecibida = options.signal;
        if (!signalRecibida)
            return Promise.resolve({ status: 201, text: async () => '' });
        return new Promise((resolve, reject) => {
            signalRecibida.addEventListener('abort', () => reject(signalRecibida.reason), { once: true });
        });
    };

    const resultado = await pushTo(suscripcionValida(), { title: 'prueba' });
    assert.equal(timeoutMs, 5000);
    assert.ok(signalRecibida instanceof AbortSignal, 'fetch debe recibir la señal');
    assert.equal(resultado.status, 0, 'el timeout se convierte en fallo acotado, no en espera infinita');
});

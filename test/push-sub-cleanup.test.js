// Limpieza de suscripciones push muertas.
//
// El servicio de push (FCM/Mozilla) rechaza para siempre una suscripción
// creada con OTRA clave VAPID (403 «the VAPID credentials … do not
// correspond», p. ej. la clave del servidor se regeneró al restaurar la
// base). Esa suscripción zombi no produce ningún aviso con la app cerrada,
// así que `notifyUser` la elimina (como ya hacía con 404/410) y el
// dispositivo re-suscribe con la clave actual. Un 403 sin palabras de
// credenciales/autorización NO se considera muerte de la suscripción: podría
// ser una denegación puntual del servicio y la suscripción puede servir
// todavía.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { db } = require('../src/db/database.js');
const { Stmt } = require('../src/db/statements.js');
const { pushSubs, users, usernameIndex } = require('../src/state.js');
const { notifyUser } = require('../src/push/vapid.js');

/* Suscripción con la forma que exige el cifrado de push web: punto P-256
   sin comprimir (65 B) y auth de 16 B. */
function subDeFormaValida(endpoint) {
    const gen = crypto.createECDH('prime256v1'); gen.generateKeys();
    return {
        endpoint,
        keys: { p256dh: gen.getPublicKey().toString('base64'), auth: crypto.randomBytes(16).toString('base64') }
    };
}

const FCM_MISMATCH = 'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.\n';
let realFetch = globalThis.fetch;

/* Deja en RAM y en base exactamente una suscripción para 'ana'. */
function ponSub(endpoint) {
    const sub = subDeFormaValida(endpoint);
    Stmt.insertPushSub.run('u-ana', sub.endpoint, '{"dum":"la columna data no se lee al limpiar"}');
    pushSubs.set('u-ana', [sub]);
    return sub;
}
const filasEnBase = () => db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?').get('u-ana').n;

test.beforeEach(() => {
    users.set('u-ana', { id: 'u-ana', username: 'ana' });
    usernameIndex.set('ana', 'u-ana');
    pushSubs.delete('u-ana');
    db.prepare('DELETE FROM push_subs WHERE user_id = ?').run('u-ana');
    /* push_subs.user_id es clave ajena a users: la cuenta de prueba existe
       en la tabla aunque el test no pase por el registro HTTP. */
    db.prepare('INSERT OR IGNORE INTO users (id, username, password_hash, password_salt) VALUES (?, ?, ?, ?)')
        .run('u-ana', 'ana', 'x', 'y');
});

test.afterEach(() => { globalThis.fetch = realFetch; });

test('un 403 por credenciales VAPID ajenas elimina la suscripción zombi', async () => {
    const sub = ponSub('https://fcm.googleapis.com/fcm/send/token-viejo');
    globalThis.fetch = async () => ({ status: 403, text: async () => FCM_MISMATCH });

    const results = await notifyUser('ana', { title: 'x' });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 403);
    assert.match(results[0].error || '', /do not correspond/);
    assert.equal(filasEnBase(), 0, 'la fila se borró de la base');
    assert.equal((pushSubs.get('u-ana') || []).length, 0, 'la suscripción salió de RAM');
    assert.ok(!((pushSubs.get('u-ana') || []).some(s => s.endpoint === sub.endpoint)));
});

test('un 403 ajeno a las credenciales NO elimina la suscripción', async () => {
    ponSub('https://fcm.googleapis.com/fcm/send/token-cuota');
    globalThis.fetch = async () => ({ status: 403, text: async () => 'rejected by policy: quota exceeded' });

    const results = await notifyUser('ana', { title: 'x' });
    assert.equal(results[0].status, 403);
    assert.equal(filasEnBase(), 1, 'la fila sigue en la base');
    assert.equal((pushSubs.get('u-ana') || []).length, 1, 'la suscripción sigue en RAM');
});

test('un 410 sigue eliminando la suscripción (ya des-suscrita o expirada)', async () => {
    ponSub('https://fcm.googleapis.com/fcm/send/token-expirado');
    globalThis.fetch = async () => ({ status: 410, text: async () => 'push subscription has unsubscribed or expired.\n' });

    const results = await notifyUser('ana', { title: 'x' });
    assert.equal(results[0].status, 410);
    assert.equal(filasEnBase(), 0);
    assert.equal((pushSubs.get('u-ana') || []).length, 0);
});

test('un envío aceptado (201) conserva la suscripción', async () => {
    ponSub('https://fcm.googleapis.com/fcm/send/token-activo');
    globalThis.fetch = async () => ({ status: 201, text: async () => '' });

    const results = await notifyUser('ana', { title: 'x' });
    assert.equal(results[0].status, 201);
    assert.equal(filasEnBase(), 1);
    assert.equal((pushSubs.get('u-ana') || []).length, 1);
});

test('una suscripción con endpoint fuera de la allowlist no sale del servidor', async () => {
    ponSub('https://atacante.ejemplo/fcm/send/roba');
    globalThis.fetch = async () => { assert.fail('no debió hacer ninguna petición HTTP'); return { status: 500, text: async () => '' }; };

    const results = await notifyUser('ana', { title: 'x' });
    assert.equal(results[0].status, 0, 'pushTo devuelve error local sin red');
    assert.equal(filasEnBase(), 1, 'no se borra por un error local: no es muerte de la suscripción');
});

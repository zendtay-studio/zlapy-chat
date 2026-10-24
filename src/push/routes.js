/**
 * Rutas de notificaciones push.
 *
 * Alta y baja de suscripciones de dispositivos (con las claves cifradas en
 * reposo) y envío de una notificación de prueba a la cuenta autenticada.
 */
'use strict';

const { decryptForUser, encryptForUser } = require('../crypto/setup.js');
const { db } = require('../db/database.js');
const { Stmt } = require('../db/statements.js');
const { json } = require('../http/responses.js');
const { notifyUser } = require('./vapid.js');
const { push } = require('../realtime/notify.js');
const { validPushEndpoint } = require('../shared/validation.js');
const { pushSubs } = require('../state.js');
const { parseJsonSafe } = require('../users/helpers.js');

/* Una suscripción se normaliza a sus campos reales: endpoint + las dos claves
   que exige el cifrado de push web (p256dh de 65 bytes y auth de 16 bytes).
   Sin este filtro, el campo `data` aceptaba ~32 MB arbitrarios por petición
   (se cifraban, se escribían, se leían y se descifraban: DoS barato con una
   sola cuenta) y `pushTo` fallaría siempre con claves malformadas. */
function normalizePushSub(sub) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return null;
    const keys = sub.keys && typeof sub.keys === 'object' && !Array.isArray(sub.keys) ? sub.keys : null;
    if (!keys) return null;
    if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
    const p256dh = Buffer.from(keys.p256dh, 'base64');
    const auth = Buffer.from(keys.auth, 'base64');
    // Clave pública del cliente: punto P-256 sin comprimir; auth: 16 bytes.
    if (p256dh.length !== 65 || auth.length !== 16) return null;
    const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
    if (!endpoint) return null;
    return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function postPushSubscribe(req, res, url, data, actor) {
    const id = req.authUser.id;
    // Anti-SSRF: el servidor solo hace POST a servicios de push
    // conocidos, nunca a hosts arbitrarios de la LAN.
    if (data.sub && data.sub.endpoint && !validPushEndpoint(data.sub.endpoint))
        return json(res, 400, { error: 'Endpoint de push no permitido.' });
    if (data.sub && data.sub.endpoint) {
        const sub = normalizePushSub(data.sub);
        if (!sub) return json(res, 400, { error: 'Suscripción de push inválida.' });
        // Las claves de push (p256dh/auth) se guardan cifradas en reposo.
        Stmt.insertPushSub.run(id, sub.endpoint, encryptForUser(id, JSON.stringify(sub)));
        Stmt.trimPushSubs.run(id, id);
        const rows = db.prepare('SELECT data FROM push_subs WHERE user_id = ?').all(id);
        pushSubs.set(id, rows.map(r => parseJsonSafe(decryptForUser(id, r.data) || '')).filter(Boolean));
    }
    return json(res, 200, { ok: true });
}

function postPushUnsubscribe(req, res, url, data, actor) {
    Stmt.deletePushSub.run(req.authUser.id, data.endpoint);
    const rows = db.prepare('SELECT data FROM push_subs WHERE user_id = ?').all(req.authUser.id);
    pushSubs.set(req.authUser.id, rows.map(r => parseJsonSafe(decryptForUser(req.authUser.id, r.data) || '')).filter(Boolean));
    return json(res, 200, { ok: true });
}

async function postPushTest(req, res, url, data, actor) {
    const results = await notifyUser(actor, { title: 'Prueba push', body: 'Aviso del servidor', tag: 'test-' + Date.now(), renotify: true, url: '/' });
    const sent = results.filter(r => r.status >= 200 && r.status < 300).length;
    return json(res, 200, { ok: sent > 0, sent, total: results.length });
}


module.exports = {
    postPushSubscribe,
    postPushUnsubscribe,
    postPushTest,
};

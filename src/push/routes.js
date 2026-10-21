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

function postPushSubscribe(req, res, url, data, actor) {
    const id = req.authUser.id;
    // Anti-SSRF: el servidor solo hace POST a servicios de push
    // conocidos, nunca a hosts arbitrarios de la LAN.
    if (data.sub && data.sub.endpoint && !validPushEndpoint(data.sub.endpoint))
        return json(res, 400, { error: 'Endpoint de push no permitido.' });
    if (data.sub && data.sub.endpoint) {
        // Las claves de push (p256dh/auth) se guardan cifradas en reposo.
    Stmt.insertPushSub.run(id, data.sub.endpoint, encryptForUser(id, JSON.stringify(data.sub)));
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

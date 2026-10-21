/**
 * Rutas HTTP de llamadas.
 *
 * Devuelve el registro de llamadas de la cuenta y permite registrar el
 * cierre de una llamada. El registro vive en store.js y se filtra por
 * privacidad: las llamadas con interlocutores bloqueados no se listan.
 */
'use strict';

const { updateCall } = require('./store.js');
const { json } = require('../http/responses.js');
const { callFiles } = require('../state.js');
const { accountsBlocked } = require('../users/privacy.js');

function getCalls(req, res, url, data, actor) {
    const calls = (callFiles.get(req.authUser.username) || []).filter(c => !c.peer || !accountsBlocked(req.authUser.username, c.peer));
    return json(res, 200, { calls });
}

function postCallLog(req, res, url, data, actor) {
    if (data.callId) updateCall(data.username, data.callId, { state: data.state || 'ended', duration: data.duration || 0 });
    // Coherente con GET /calls: sin llamadas de bloqueados.
    const calls = (callFiles.get(data.username) || []).filter(c => !c.peer || !accountsBlocked(req.authUser.username, c.peer));
    return json(res, 200, { ok: true, calls });
}


module.exports = {
    getCalls,
    postCallLog,
};

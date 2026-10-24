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

const CALL_LOG_STATES = new Set(['ended', 'missed', 'rejected', 'cancelled', 'busy', 'blocked', 'denied', 'active', 'calling']);

function postCallLog(req, res, url, data, actor) {
    /* Solo el registro PROPIO: el username del cuerpo ya no puede abrirse
       (era posible sobrescribir llamadas de cualquier cuenta con un POST
       autenticado nel propio endpoint). */
    const username = req.authUser.username;
    if (typeof data.username === 'string' && data.username !== username)
        return json(res, 403, { error: 'Solo puedes registrar tus propias llamadas.' });
    if (data.callId && typeof data.callId === 'string' && data.callId.length <= 128) {
        const state = CALL_LOG_STATES.has(data.state) ? data.state : 'ended';
        // Duración plausiblemente (24 h max): números absurdos no se persisten.
        const maxMs = 24 * 60 * 60 * 1000;
        const duration = Number.isFinite(data.duration) && data.duration > 0 ? Math.min(Math.floor(data.duration), maxMs) : 0;
        updateCall(username, data.callId, { state, duration });
    }
    // Coherente con GET /calls: sin llamadas de bloqueados.
    const calls = (callFiles.get(username) || []).filter(c => !c.peer || !accountsBlocked(username, c.peer));
    return json(res, 200, { ok: true, calls });
}


module.exports = {
    getCalls,
    postCallLog,
};

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
const { accountsBlocked, publicName } = require('../users/privacy.js');

/* El registro guarda el nombre canónico del par (también como índice
   cifrado); al cliente le viaja el alias opaco si esa cuenta oculta su
   @usuario. */
function callsForViewer(username, actor) {
    return (callFiles.get(username) || [])
        .filter(c => !c.peer || !accountsBlocked(username, c.peer))
        .map(c => (c && c.peer ? { ...c, peer: publicName(c.peer, actor) } : c));
}

function getCalls(req, res, url, data, actor) {
    return json(res, 200, { calls: callsForViewer(req.authUser.username, actor) });
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
    return json(res, 200, { ok: true, calls: callsForViewer(username, actor) });
}


module.exports = {
    getCalls,
    postCallLog,
};

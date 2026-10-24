/**
 * Llamadas.
 *
 * Mantiene el registro de llamadas de cada cuenta (en memoria y cifrado en
 * la base) junto con el estado de cada llamada. `endUserCalls` cierra las
 * llamadas vivas de un usuario al irse, para que la contraparte no se quede
 * con una llamada colgada.
 */
'use strict';

const crypto = require('crypto');
const { encryptForUser } = require('../crypto/setup.js');
const { Stmt } = require('../db/statements.js');
const { push, pushName } = require('../realtime/notify.js');
const { callFiles, pendingOffers } = require('../state.js');
const { byName } = require('../users/helpers.js');

// Llamadas
function addCall(username, entry) {
    const list = callFiles.get(username) || [];
    list.push({ id: entry.id || crypto.randomUUID(), ts: Date.now(), ...entry });
    callFiles.set(username, list.slice(-100));
    const user = byName(username);
    if (user) {
        // El registro de llamadas se guarda cifrado en reposo.
        Stmt.insertCall.run(list[list.length - 1].id, user.id, entry.peer || null, list[list.length - 1].ts, encryptForUser(user.id, JSON.stringify(list[list.length - 1])));
        Stmt.trimCalls.run(user.id, user.id, 100);
    }
    return list[list.length - 1];
}
function updateCall(username, id, patch) {
    const list = callFiles.get(username) || [];
    // La lista ya es de este usuario: updateCall/hasCall filtran por
    // propietario.
    const c = list.find(x => x.id === id);
    if (c) Object.assign(c, patch);
    callFiles.set(username, list);
    const user = byName(username);
    if (user && c) Stmt.updateCallData.run(encryptForUser(user.id, JSON.stringify(c)), id, user.id);
    return c;
}
const hasCall = (username, peer, id) =>
    typeof id === 'string' && !!(callFiles.get(username) || []).find(c => c.id === id && c.peer === peer);

/* ¿Ya hay una oferta de llamada VIVA de este usuario hacia ese par? Sin
   deduplicación, un frame `call-offer` repetido (con callId aleatorios)
   insertaba llamadas, reescribía el registro y lanzaba pushes sin cota:
   saturación de SQLite y amplificación hacia el servicio de push. */
const hasPendingCall = (username, peer) =>
    !!username && !!peer && !!(callFiles.get(username) || []).find(c => c && c.state === 'calling' && c.peer === peer);

/* Al cerrarse la ÚLTIMA conexión de un usuario, sus llamadas vivas se cierran
   y se avisa a la contraparte: si un participante se desconecta a mitad de
   llamada, el otro no debe quedarse con la llamada "colgada" para siempre. */
const CALL_TERMINAL_STATES = new Set(['ended', 'missed', 'rejected', 'cancelled', 'busy', 'blocked', 'denied']);
function endUserCalls(username) {
    // Ofertas pendientes ENVIADAS por él: en su lado no queda nadie que las
    // conteste.
    for (const [key, o] of [...pendingOffers]) if (o.from === username) pendingOffers.delete(key);
    for (const c of (callFiles.get(username) || [])) {
        if (!c || CALL_TERMINAL_STATES.has(c.state)) continue;
        updateCall(username, c.id, { state: 'ended' });
        if (c.peer) {
            updateCall(c.peer, c.id, { state: 'ended' });
            pushName(c.peer, { type: 'call-ended', from: username, callId: c.id });
        }
    }
}


module.exports = {
    addCall,
    updateCall,
    hasCall,
    hasPendingCall,
    CALL_TERMINAL_STATES,
    endUserCalls,
};

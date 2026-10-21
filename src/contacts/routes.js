/**
 * Rutas de contactos.
 *
 * Solicitudes de contacto (enviar, aceptar, rechazar, cancelar), lista de
 * contactos y bloqueo entre cuentas. La privacidad de cada cuenta decide qué
 * datos de los contactos puede ver quien mira su lista.
 */
'use strict';

const { Stmt } = require('../db/statements.js');
const { json } = require('../http/responses.js');
const { notifyUser } = require('../push/vapid.js');
const { broadcastUsersAround, connectContacts, push, pushName, pushStories, removeContacts, updateContactRequests } = require('../realtime/notify.js');
const { validAvatar } = require('../shared/validation.js');
const { blockedSet, pendingOffers, profiles, users } = require('../state.js');
const { byName } = require('../users/helpers.js');
const { isBlockedBy, permite, permiteDescripcion } = require('../users/privacy.js');
const { saveUserToDb } = require('../users/store.js');

function getContactsRequests(req, res, url, data, actor) {
    const requests = [];
    for (const r of Stmt.listContactRequestsTo.all(req.authUser.id)) {
    const sender = users.get(r.from_id);
    if (!sender) continue;
    const profile = profiles[sender.username] || {};
    // Quien bloquea a la cuenta ve solo el nombre de usuario: ni el
    // avatar ni la descripción se incluyen en la respuesta.
    const canSeeAvatar = permite(profile, 'foto', req.authUser.username);
    const canSeeDescription = permiteDescripcion(profile, req.authUser.username);
    requests.push({
    id: sender.id, username: sender.username, sentAt: r.ts,
    name: isBlockedBy(profile, req.authUser.username) ? sender.username : (profile.name || sender.username),
    avatar: canSeeAvatar ? (validAvatar(profile.avatar) ? profile.avatar : '') : '',
    description: canSeeDescription ? profile.desc || '' : ''
    });
    }
    return json(res, 200, { requests });
}

function getContactsRequestsSent(req, res, url, data, actor) {
    const requests = [];
    for (const r of Stmt.listContactRequestsFrom.all(req.authUser.id)) {
    const target = users.get(r.to_id);
    if (!target) continue;
    const profile = profiles[target.username] || {};
    requests.push({
    username: target.username,
    name: isBlockedBy(profile, req.authUser.username) ? target.username : (profile.name || target.username),
    sentAt: r.ts
    });
    }
    return json(res, 200, { requests });
}

function postContacts(req, res, url, data, actor) {
    const target = byName(typeof data.username === 'string' ? data.username.trim() : '');
    if (!target) return json(res, 404, { error: 'No account found.' });
    if (target.id === req.authUser.id) return json(res, 400, { error: 'No puedes agregarte.' });
    if (req.authUser.contacts.includes(target.id)) return json(res, 200, { ok: true, status: 'contact' });
    if (isBlockedBy(profiles[target.username], actor) || isBlockedBy(profiles[actor], target.username))
        return json(res, 403, { error: 'Bloqueo activo.' });
    if (target.contacts.includes(req.authUser.id)) {
        connectContacts(req.authUser, target);
        return json(res, 200, { ok: true, status: 'contact' });
    }
    // La política del destino decide el resultado: con 'nobody' no
    // acepta, con 'all' se conecta al instante y con 'request'
    // (por defecto) hace falta que acepte.
    if (target.addPolicy === 'nobody') return json(res, 403, { error: 'No acepta contactos.' });
    if (target.addPolicy === 'all') {
        connectContacts(req.authUser, target);
        return json(res, 200, { ok: true, status: 'contact' });
    }
    Stmt.insertContactRequest.run(req.authUser.id, target.id, Date.now());
    updateContactRequests(target);
    updateContactRequests(req.authUser);
    notifyUser(target.username, { title: 'Nueva solicitud', body: 'Alguien quiere agregarte', tag: 'creq-' + req.authUser.id, renotify: true, url: '/' });
    return json(res, 200, { ok: true, status: 'request' });
}

function postContactsRemove(req, res, url, data, actor) {
    const target = byName(typeof data.username === 'string' ? data.username.trim() : '');
    if (!target || target.id === req.authUser.id || !req.authUser.contacts.includes(target.id))
        return json(res, 404, { error: 'No disponible.' });
    removeContacts(req.authUser, target);
    pushStories();
    return json(res, 200, { ok: true });
}

function postContactsCancel(req, res, url, data, actor) {
    const target = byName(typeof data.username === 'string' ? data.username.trim() : '');
    if (!target || target.id === req.authUser.id) return json(res, 404, { error: 'No disponible.' });
    Stmt.deleteContactRequest.run(req.authUser.id, target.id);
    updateContactRequests(req.authUser);
    updateContactRequests(target);
    return json(res, 200, { ok: true });
}

function postContactsRespond(req, res, url, data, actor) {
    const requester = byName(typeof data.username === 'string' ? data.username : '');
    if (!requester || requester.id === req.authUser.id) return json(res, 404, { error: 'No disponible.' });
    const row = Stmt.listContactRequestsTo.all(req.authUser.id).find(r => r.from_id === requester.id);
    if (!row) return json(res, 404, { error: 'No disponible.' });
    if (data.accept !== true && data.accept !== false) return json(res, 400, { error: 'Indica aceptar.' });
    if (data.accept) {
        if (isBlockedBy(profiles[req.authUser.username], requester.username) ||
            isBlockedBy(profiles[requester.username], req.authUser.username))
            return json(res, 403, { error: 'Bloqueo activo.' });
        connectContacts(req.authUser, requester);
    } else {
        Stmt.deleteContactRequest.run(requester.id, req.authUser.id);
        updateContactRequests(req.authUser);
        updateContactRequests(requester);
    }
    if (data.accept) push(requester, { type: 'contact-request-accepted', username: req.authUser.username });
    return json(res, 200, { ok: true, accepted: data.accept, username: requester.username });
}

function postBlock(req, res, url, data, actor) {
    const target = byName(typeof data.target === 'string' ? data.target.trim() : '');
    if (!target || target.id === req.authUser.id) return json(res, 404, { error: 'No disponible.' });
    const set = blockedSet.get(actor) || new Set();
    const wasBlocked = set.has(target.username);
    if (wasBlocked) {
        set.delete(target.username);
        Stmt.deleteBlocked.run(req.authUser.id, target.id);
    } else {
        // Bloquear rompe el contacto, cancela las solicitudes
        // pendientes en ambos sentidos y descarta las ofertas de
        // chat que estaban en curso.
        set.add(target.username);
        Stmt.insertBlocked.run(req.authUser.id, target.id);
        removeContacts(req.authUser, target);
        Stmt.deleteContactRequest.run(req.authUser.id, target.id);
        Stmt.deleteContactRequest.run(target.id, req.authUser.id);
        for (const [key, o] of pendingOffers) {
            if ((o.from === actor && o.to === target.username) || (o.from === target.username && o.to === actor)) pendingOffers.delete(key);
        }
    }
    blockedSet.set(actor, set);
    profiles[actor] = profiles[actor] || { username: actor };
    profiles[actor].blocked = [...set];
    saveUserToDb(req.authUser);
    push(req.authUser, { type: 'profile', username: actor });
    broadcastUsersAround(req.authUser.id);
    pushStories();
    pushName(target.username, { type: 'blocked-change', by: actor, blocked: !wasBlocked });
    return json(res, 200, { ok: true, blocked: !wasBlocked });
}


module.exports = {
    getContactsRequests,
    getContactsRequestsSent,
    postContacts,
    postContactsRemove,
    postContactsCancel,
    postContactsRespond,
    postBlock,
};

/**
 * Rutas HTTP de grupos.
 *
 * Listar los grupos de la cuenta, descubrir los grupos públicos, ver las
 * solicitudes de entrada y crear un grupo nuevo. El contenido del grupo
 * (miembros, políticas, invitaciones) vive en store.js; aquí solo se valida
 * lo que llega y se responde.
 */
'use strict';

const crypto = require('crypto');
const { Stmt } = require('../db/statements.js');
const { groupPolicies, groupSummaryFor, normalizeGroup, pub, readGroup, writeGroupMeta, writeGroupSummary } = require('./store.js');
const { json } = require('../http/responses.js');
const { push, pushName } = require('../realtime/notify.js');
const { validAvatar } = require('../shared/validation.js');
const { profiles } = require('../state.js');
const { byName, uniq } = require('../users/helpers.js');
const { isContact } = require('../users/privacy.js');

function getGroupsRequests(req, res, url, data, actor) {
    const requests = [];
    for (const r of Stmt.listUserJoinRequests.all(req.authUser.id)) {
    const g = readGroup(r.gid);
    if (!g || g.memberIds.includes(req.authUser.id)) continue;
    const req0 = g.joinRequests.find(x => x.userId === req.authUser.id);
    if (req0) requests.push({
    id: g.id, name: g.name, description: g.description,
    avatar: g.avatar || '', visibility: g.visibility, sentAt: req0.ts
    });
    }
    return json(res, 200, { requests });
}

function getGroups(req, res, url, data, actor) {
    const myGids = Stmt.listUserGroups.all(req.authUser.id);
    const list = [];
    for (const r of myGids) {
    const g = readGroup(r.gid);
    if (!g) continue;
    const pubG = { ...pub(g) };
    if (g.admins.some(name => byName(name)?.id === req.authUser.id))
    pubG.joinRequests = g.joinRequests;
    else delete pubG.joinRequests;
    delete pubG.inviteCode;
    const summary = groupSummaryFor(req.authUser.id, g.id);
    pubG.last = summary.last;
    pubG.unread = summary.unread;
    list.push(pubG);
    }
    return json(res, 200, list);
}

function getGroupsDiscover(req, res, url, data, actor) {
    const list = [];
    for (const r of Stmt.listPublicGroups.all()) {
    const g = readGroup(r.id);
    if (!g || g.memberIds.includes(req.authUser.id)) continue;
    list.push({
    id: g.id, name: g.name, description: g.description,
    avatar: g.avatar || '', members: g.members.length,
    joinPolicy: g.joinPolicy,
    requested: g.joinRequests.some(x => x.userId === req.authUser.id)
    });
    }
    return json(res, 200, { groups: list });
}

function postGroups(req, res, url, data, actor) {
    const { name, members, description, avatar, visibility, joinPolicy, writePolicy, addPolicy, editPolicy, mentionAllPolicy, contentPolicy, id: requestedId } = data;
    if (typeof name !== 'string' || !name.trim() || name.length > 40) return json(res, 400, { error: 'Nombre inválido.' });
    if (Array.isArray(members) && members.some(m => !byName(m) || !isContact(profiles[req.authUser.username], m)))
        return json(res, 403, { error: 'Solo contactos.' });
    const nextContentPolicy = Object.fromEntries(Object.keys(groupPolicies).map(k => [k, 'all']));
    if (contentPolicy && typeof contentPolicy === 'object' && !Array.isArray(contentPolicy)) {
        for (const [kind, policy] of Object.entries(contentPolicy)) {
            if (!groupPolicies[kind] || !groupPolicies[kind].includes(policy)) return json(res, 400, { error: 'Política inválida.' });
            nextContentPolicy[kind] = policy;
        }
    }
    const requestedGroupId = typeof requestedId === 'string' ? requestedId.trim() : '';
    const id = requestedGroupId && /^[a-zA-Z0-9_-]{2,80}$/.test(requestedGroupId) ? requestedGroupId
        : 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (readGroup(id)) return json(res, 409, { error: 'ID en uso.' });
    const uniqMembers = uniq([actor, ...(Array.isArray(members) ? members.filter(m => byName(m)) : [])]);
    const memberIds = uniqMembers.map(m => byName(m)?.id).filter(Boolean);
    const g = normalizeGroup({
        id, cryptoId: crypto.randomUUID(), name: name.trim(), description: typeof description === 'string' ? description.slice(0, 500).trim() : '',
        avatar: validAvatar(avatar) ? avatar : '',
        members: uniqMembers, memberIds, admins: [actor], ownerId: req.authUser.id,
        visibility: ['public', 'private'].includes(visibility) ? visibility : 'private',
        joinPolicy: ['open', 'request', 'closed'].includes(joinPolicy) ? joinPolicy : 'request',
        writePolicy: ['all', 'admins'].includes(writePolicy) ? writePolicy : 'all',
        addPolicy: ['all', 'admins'].includes(addPolicy) ? addPolicy : 'admins',
        editPolicy: ['all', 'admins'].includes(editPolicy) ? editPolicy : 'admins',
        contentPolicy: nextContentPolicy,
        mentionAllPolicy: ['all', 'admins'].includes(mentionAllPolicy) ? mentionAllPolicy : 'admins',
        joinRequests: [], createdAt: Date.now()
    });
    writeGroupMeta(g);
    for (const uuid of memberIds) writeGroupSummary(uuid, id, { gid: id, unread: 0, last: null });
    for (const m of uniqMembers) pushName(m, { type: 'group', group: pub(g) });
    return json(res, 200, pub(g));
}


module.exports = {
    getGroupsRequests,
    getGroups,
    getGroupsDiscover,
    postGroups,
};

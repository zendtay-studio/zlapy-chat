/**
 * Menciones y renombrados.
 *
 * `withMentions` resuelve los usuarios mencionados en un mensaje, y
 * `propagateUsernameChange` reescribe el nombre de usuario en todo el estado
 * (perfiles, bloqueos, historias, grupos, resúmenes y llamadas) cuando una
 * cuenta cambia de nombre.
 */
'use strict';

const { renamePeerInSummaries } = require('./summaries.js');
const { db } = require('../db/database.js');
const { Stmt } = require('../db/statements.js');
const { readGroup, writeGroupMeta } = require('../groups/store.js');
const { broadcastUsers } = require('../realtime/notify.js');
const { blockedSet, callFiles, groupPubCache, notesMap, profiles, stories, usernameIndex, users } = require('../state.js');
const { saveUserToDb } = require('../users/store.js');


// Menciones
function withMentions(message) {
    if (!message || typeof message !== 'object') return message;
    const mentions = Array.isArray(message.mentions) ? message.mentions.filter(id => typeof id === 'string') : [];
    if (!mentions.length) return { ...message, mentions: [] };
    const labels = message.mentionLabels && typeof message.mentionLabels === 'object' ? message.mentionLabels : {};
    return {
        ...message, mentions, mentionLabels: labels,
        mentionUsers: mentions.map(id => { const u = users.get(id); return u ? { id, username: u.username } : null; }).filter(Boolean)
    };
}

// Renombrado de usuario
function propagateUsernameChange(previous, next) {
    if (!previous || !next || previous === next) return;
    const uuid = usernameIndex.get(previous);
    if (!uuid) return;
    const account = users.get(uuid);
    if (!account) return;

    account.username = next;
    profiles[next] = profiles[previous] || { username: next, name: next, avatar: '', desc: '', note: '' };
    delete profiles[previous];
    profiles[next].username = next;
    usernameIndex.delete(previous);
    usernameIndex.set(next, uuid);
    if (notesMap[previous]) { notesMap[next] = notesMap[previous]; delete notesMap[previous]; }

    saveUserToDb(account);

    const prevBlocked = blockedSet.get(previous);
    blockedSet.delete(previous);
    if (prevBlocked) blockedSet.set(next, prevBlocked);

    for (const p of Object.values(profiles)) {
        if (Array.isArray(p.blocked)) p.blocked = p.blocked.map(n => n === previous ? next : n);
        if (p.privacy) for (const rule of Object.values(p.privacy))
            if (rule && Array.isArray(rule.users)) rule.users = rule.users.map(n => n === previous ? next : n);
    }

    for (const story of stories) {
        if (story.from === previous) story.from = next;
    }
    // El historial de llamadas guarda el NOMBRE del par: hay que mantenerlo
    // al día para que el borrado por cuenta lo encuentre tras un renombre.
    Stmt.renameCallsPeer.run(next, previous);

    if (callFiles.has(previous)) {
        const calls = callFiles.get(previous);
        for (const c of calls) if (c.peer === previous) c.peer = next;
        callFiles.delete(previous);
        callFiles.set(next, calls);
    }

    for (const r of Stmt.listGroupsOfUser.all(uuid)) {
        const g = readGroup(r.gid);
        if (g) { writeGroupMeta(g); }
    }
    groupPubCache.clear();
    for (const ownerUuid of db.prepare('SELECT owner FROM contacts WHERE contact = ?').all(uuid)) {
        renamePeerInSummaries(ownerUuid.owner, uuid, next);
    }
    renamePeerInSummaries(uuid, uuid, next);
    broadcastUsers();
}

module.exports = {
    withMentions,
    propagateUsernameChange,
};

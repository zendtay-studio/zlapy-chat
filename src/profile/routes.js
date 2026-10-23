/**
 * Rutas de perfil y cuenta.
 *
 * Sirven el perfil de una cuenta con la privacidad aplicada, la edición del
 * propio perfil y de sus ajustes, la regeneración de la clave de cifrado y
 * el borrado de la cuenta.
 */
'use strict';

const crypto = require('crypto');
const { accountCookieName, clearCookie, clearSessionCookie, createSession, passwordDigest, safeEqualHex } = require('../auth/sessions.js');
const { propagateUsernameChange } = require('../chat/mentions.js');
const { decryptForUser, messageCrypto } = require('../crypto/setup.js');
const { Stmt } = require('../db/statements.js');
const { pruneBlobHashes, tx } = require('../db/transactions.js');
const { groupLastEntry, invalidateGroupPubCache, lastGroupMessage, pub, readGroup, readGroupSummary, writeGroupSummary } = require('../groups/store.js');
const { rejectRateLimited } = require('../http/helpers.js');
const { profileLimiter } = require('../http/rate-limit.js');
const { json } = require('../http/responses.js');
const { broadcastUsers, push, pushName, pushStories } = require('../realtime/notify.js');
const { normalizeChatAppearanceSettings } = require('../shared/appearance.js');
const { MESSAGE_LIMITS, characterCount } = require('../shared/limits.js');
const { NOTE_TTL, validAvatar, validUsername } = require('../shared/validation.js');
const { blockedSet, callFiles, groupCache, notesMap, profiles, sessionCache, usernameIndex, users } = require('../state.js');
const { accountId, byName, freshNote, usernameTakenInDb } = require('../users/helpers.js');
const { accountsBlocked, isBlockedBy, isContact, normPriv, permite, permiteDescripcion, privacyFor } = require('../users/privacy.js');
const { accountByName, purgeUserFromMemory, regenerateAuthKey, saveChatSettings, saveUserToDb } = require('../users/store.js');

function getAccountChatSettings(req, res, url, data, actor) {
    return json(res, 200, { settings: profiles[req.authUser.username]?.chatAppearance || null });
}

function getProfile(req, res, url, data, actor) {
    const requested = url.searchParams.get('username') || '';
    // Resolver por nombre sin distinguir capitalización (igual que el resto de
    // las rutas) y caer al índice directo para los perfiles sin cuenta.
    const acc = byName(requested);
    const p = (acc ? profiles[acc.username] : undefined) || profiles[requested];
    if (!p) return json(res, 200, { username: requested });
    const meQ = req.authUser.username;
    const owner = profiles[p.username];
    const blockedByOwner = isBlockedBy(owner, meQ);
    const profileId = accountId(p.username);
    const out = {
    username: p.username,
    signingPublicKey: messageCrypto.getSigningPublicKey(profileId)
    };
    // Identificador de la clave de cifrado del usuario (auth_key_id de
    // MTProto): dos dispositivos pueden compararlo para saber que
    // comparten la misma clave de nube.
    const authRow = Stmt.getAuthKey.get(profileId);
    out.encryptionKeyId = authRow ? authRow.key_id : null;
    // El identificador interno (UUID) solo se entrega a la propia cuenta y
    // a los contactos: publicarlo a cualquier sesión autenticada
    // convertiría la ruta en un oráculo de enumeración de cuentas.
    if (meQ === p.username || (isContact(owner, meQ) && !accountsBlocked(meQ, p.username)))
    out.id = profileId;
    if (!blockedByOwner || meQ === p.username) out.name = p.name;
    const perms = {
    verFoto: !!permite(owner, 'foto', meQ),
    verNota: !!permite(owner, 'nota', meQ),
    verDescripcion: !!permiteDescripcion(owner, meQ),
    verHistorias: !!permite(owner, 'historias', meQ),
    llamar: !!permite(owner, 'llamadas', meQ),
    escribir: !!permite(owner, 'mensajes', meQ),
    compartir: !!permite(owner, 'compartir', meQ)
    };
    out.permisos = perms;
    if (meQ === p.username || (isContact(owner, meQ) && !accountsBlocked(meQ, p.username))) {
    const presence = byName(p.username);
    if (presence) { out.online = !!presence.online; out.lastSeen = presence.lastSeen || null; }
    }
    if (perms.verNota) {
    out.note = freshNote(p.username);
    if (p.noteTs && out.note) out.noteTs = p.noteTs;
    }
    if (meQ === p.username) {
    out.blocked = p.blocked || [];
    out.privacy = privacyFor(p);
    out.privacy.agregarme = { mode: req.authUser.addPolicy || 'request', users: [] };
    if (!out.note) { out.note = p.note || ''; out.noteTs = p.noteTs || 0; }
    }
    // La ruta de LECTURA también sanea el avatar: un valor con HTML no
    // debe llegar crudo al cliente.
    if (perms.verFoto) out.avatar = validAvatar(p.avatar) ? p.avatar : '';
    if (perms.verDescripcion) out.desc = p.desc;
    if (blockedByOwner && meQ !== p.username) out.blockedBy = true;
    return json(res, 200, out);
}

function getNotes(req, res, url, data, actor) {
    const n = notesMap[req.authUser.username];
    if (n && n.ts && Date.now() - n.ts >= NOTE_TTL) return json(res, 200, { data: null, expired: true });
    return json(res, 200, { data: n || null });
}

async function postAccountProfile(req, res, url, data, actor) {
    // Cambiar la identidad o la contraseña exige siempre la
    // contraseña actual: una sesión viva —dispositivo prestado o
    // pestaña abierta— no basta para renombrar la cuenta.
    if (typeof data.currentPassword !== 'string' || data.currentPassword.length > 128)
        return json(res, 400, { error: 'Contraseña actual requerida.' });
    if (!safeEqualHex(req.authUser.passwordHash, await passwordDigest(data.currentPassword, req.authUser.passwordSalt)))
        return json(res, 403, { error: 'Contraseña incorrecta.' });
    if (typeof data.username === 'string' && data.username !== actor && !validUsername(data.username))
        return json(res, 400, { error: 'Usuario inválido.' });
    if (typeof data.password === 'string' && (data.password.length < 8 || data.password.length > 128))
        return json(res, 400, { error: 'Contraseña 8-128.' });
    let nextPasswordSalt = '', nextPasswordHash = '';
    if (typeof data.password === 'string') {
        nextPasswordSalt = crypto.randomBytes(16).toString('hex');
        nextPasswordHash = await passwordDigest(data.password, nextPasswordSalt);
    }
    if (typeof data.username === 'string' && data.username !== actor) {
        const existing = byName(data.username);
        if ((existing && existing.id !== req.authUser.id) || usernameTakenInDb(data.username, req.authUser.id))
            return json(res, 409, { error: 'Usuario ocupado.' });
    }
    if (nextPasswordHash) {
        req.authUser.passwordSalt = nextPasswordSalt;
        req.authUser.passwordHash = nextPasswordHash;
        Stmt.deleteSessionsByUser.run(req.authUser.id);
        for (const [h, s] of sessionCache) if (s.userId === req.authUser.id) sessionCache.delete(h);
        for (const sk of [...req.authUser.sockets]) { try { sk.destroy(); } catch { } }
        createSession(req.authUser, req, res);
    }
    let renamedFrom = '';
    let renameSnapshot = null;
    try {
        if (typeof data.username === 'string' && data.username !== actor) {
            renamedFrom = actor;
            // Snapshot del estado previo para restaurar RAM y BD si
            // la mutación falla a medias (un rollback inverso
            // podría fallar y dejar ambos con nombres distintos).
            renameSnapshot = {
                username: actor,
                profile: profiles[actor],
                note: notesMap[actor],
                blocked: blockedSet.get(actor),
                calls: callFiles.get(actor)
            };
            propagateUsernameChange(actor, data.username); // ya persiste la cuenta
        } else {
            saveUserToDb(req.authUser);
        }
    } catch (error) {
        // Si la persistencia falla, se restaura el nombre anterior
        // en RAM y en la base desde el snapshot.
        if (renamedFrom && renameSnapshot) {
            try {
                const acc = req.authUser;
                const snap = renameSnapshot;
                usernameIndex.delete(acc.username);
                usernameIndex.set(snap.username, acc.id);
                delete profiles[acc.username];
                delete notesMap[acc.username];
                profiles[snap.username] = snap.profile || { username: snap.username, name: snap.username };
                if (snap.note) notesMap[snap.username] = snap.note;
                if (snap.blocked) { blockedSet.delete(acc.username); blockedSet.set(snap.username, snap.blocked); }
                if (snap.calls) { callFiles.delete(acc.username); callFiles.set(snap.username, snap.calls); }
                acc.username = snap.username;
                Stmt.updateUser.run(snap.username, acc.passwordHash || '', acc.passwordSalt || '',
                    ['all', 'request', 'nobody'].includes(acc.addPolicy) ? acc.addPolicy : 'request',
                    acc.lastSeen || null, acc.id);
            } catch (rollbackError) { console.error('[rename] rollback fallido:', rollbackError); }
        }
        console.error('[profile] No se pudo guardar el perfil:', error);
        return json(res, 409, { error: 'No se pudo guardar el perfil. Elige otro nombre de usuario.' });
    }
    broadcastUsers();
    return json(res, 200, { ok: true, user: { id: req.authUser.id, username: req.authUser.username } });
}

function postAccountChatSettings(req, res, url, data, actor) {
    const appearance = normalizeChatAppearanceSettings(
        data.settings,
        profiles[actor].chatAppearance || {}
    );
    if (!appearance) return json(res, 400, { error: 'Ajustes inválidos o foto de fondo no válida.' });
    profiles[actor].chatAppearance = appearance;
    try {
        saveChatSettings(req.authUser);
    } catch (error) {
        console.error('[appearance] No se pudo guardar el ajuste:', error);
        return json(res, 409, { error: 'No se pudieron guardar los ajustes.' });
    }
    return json(res, 200, { ok: true });
}

async function postAccountRegenerateKey(req, res, url, data, actor) {
    // Regenerar la clave de cifrado del usuario (equivalente a
    // auth.resetAuthorizations de MTProto). El contenido se
    // re-cifra con la clave nueva para no perder el historial, y
    // la clave de firma tambien se rehace.
    // EXIGE CONTRASEÑA: con solo la cookie de sesión, un XSS o una cookie
    // robada bastaban para dejar el historial de la víctima inaccesible. Es la
    // misma regla que borrar la cuenta o cambiar el nombre.
    if (rejectRateLimited(res, profileLimiter, req.authUser.id, 5, 'regeneraciones de clave por minuto')) return;
    if (typeof data.password !== 'string' || !data.password || data.password.length > 128)
        return json(res, 400, { error: 'Confirma tu contraseña para regenerar la clave.' });
    const account = accountByName(req.authUser.username);
    if (!account || !safeEqualHex(account.passwordHash, await passwordDigest(data.password, account.passwordSalt)))
        return json(res, 401, { error: 'Contraseña incorrecta.' });
    let result;
    try {
        result = regenerateAuthKey(req.authUser.id);
    } catch (error) {
        console.error('[regenerate-key] Fallo al re-cifrar el contenido:', error);
        return json(res, 500, { error: 'No se pudo regenerar la clave. Inténtalo de nuevo.' });
    }
    return json(res, 200, { ok: true, keyId: result.keyId, reencrypted: result.reencrypted });
}

async function postAccountDelete(req, res, url, data, actor) {
    const who = req.authUser.username;
    const deletedId = req.authUser.id;
    if (!who) return json(res, 400, { error: 'Cuenta no valida.' });
    // Borrar la cuenta es IRREVERSIBLE (mensajes, grupos e
    // historiales compartidos): se exige la contraseña actual, de
    // modo que ni un XSS en la sesión de la víctima (ni una cookie
    // robada) basten para borrar su cuenta.
    if (typeof data.password !== 'string' || !data.password || data.password.length > 128)
        return json(res, 400, { error: 'Indica tu contraseña para confirmar.' });
    const account = accountByName(who);
    if (!account || !safeEqualHex(account.passwordHash, await passwordDigest(data.password, account.passwordSalt)))
        return json(res, 401, { error: 'Contraseña incorrecta.' });
    // 1) Sesiones y cookies: la cuenta deja de estar disponible al instante.
    for (const sk of [...req.authUser.sockets]) { try { sk.destroy(); } catch { } }
    for (const [h, s] of sessionCache) if (s.userId === deletedId) sessionCache.delete(h);
    clearSessionCookie(res, req);
    clearCookie(res, req, accountCookieName(deletedId));
    // 2) Grupos donde estaba (para reconstruirlos y avisar al resto).
    const touchedGroups = [...groupCache.values()]
        .filter(g => (g.memberIds || []).includes(deletedId) || (g.members || []).includes(who))
        .map(g => g.id);
    // 3) Borrado en cascada: una sola transacción, todo o nada.
    const removed = tx.deleteAccount(deletedId, who);
    pruneBlobHashes(removed.hashes || []);
    for (const gid of [...(removed.groupsRemoved || []), ...(removed.groupsTouched || [])]) { groupCache.delete(gid); invalidateGroupPubCache(gid); }
    // 4) Fuera de la RAM (usuarios, perfiles, resúmenes, colas…).
    purgeUserFromMemory(deletedId, who);
    // 5) Grupos supervivientes: se releen de la base (miembros y
    //    administradores ya actualizados) y se avisa a cada miembro.
    for (const gid of removed.groupsTouched || []) {
        const g = readGroup(gid);
        if (!g) continue;
        const last = groupLastEntry(lastGroupMessage(gid));
        for (const id2 of g.memberIds || []) {
            const summary = readGroupSummary(id2, gid);
            if (summary) writeGroupSummary(id2, gid, { gid, unread: summary.unread, last: last || summary.last });
        }
        for (const member of g.members || []) pushName(member, { type: 'group', group: pub(g) });
    }
    // 6) Los demás ven desaparecer la conversación y los contactos.
    for (const u of users.values()) {
        u.contacts = u.contacts.filter(id2 => id2 !== deletedId);
        push(u, { type: 'chatDelete', peer: who });
    }
    broadcastUsers(); pushStories();
    return json(res, 200, { ok: true, deleted: who });
}

function postProfile(req, res, url, data, actor) {
    if (data.username !== actor) return json(res, 403, { error: 'Solo puedes editar tu propio perfil.' });
    // Escribir el perfil tiene los mismos límites que enviar
    // mensajes: sin cota, un nombre o una nota de varios MB se
    // guardarían en la base y se devolverían en cada visita.
    if (rejectRateLimited(res, profileLimiter, req.authUser.id, 10, 'guardados de perfil por minuto')) return;
    /* Guarda contra el doble cifrado: si el cliente nos devuelve un texto que
       YA viene cifrado (porque el servidor se lo pintó así), volverlo a
       cifrar destruiría el texto original para siempre. En ese caso se
       conserva el valor real que ya tenía el perfil.
       Se comprueba ANTES que los límites de longitud: el texto cifrado es
       más largo que el original, así que si se validara primero el servidor
       lo rechazaría con un 400 y el cliente no podría guardar su perfil. */
    const cifradoDeVuelta = value => {
        if (typeof value !== 'string' || !value.startsWith('PCE')) return false;
        try {
            const plain = decryptForUser(req.authUser.id, value);
            return typeof plain === 'string' && plain.length > 0;
        } catch (error) { return false; }
    };
    const yaCifrado = {};
    for (const key of ['name', 'note', 'desc'])
        if (Object.prototype.hasOwnProperty.call(data, key) && cifradoDeVuelta(data[key])) yaCifrado[key] = true;
    if (!yaCifrado.desc && Object.prototype.hasOwnProperty.call(data, 'desc') &&
        (typeof data.desc !== 'string' || characterCount(data.desc, MESSAGE_LIMITS.profileDescriptionCharacters) > MESSAGE_LIMITS.profileDescriptionCharacters))
        return json(res, 400, { error: `La descripción admite hasta ${MESSAGE_LIMITS.profileDescriptionCharacters} caracteres.` });
    if (!yaCifrado.name && Object.prototype.hasOwnProperty.call(data, 'name') &&
        (typeof data.name !== 'string' || characterCount(data.name, 64) > 64))
        return json(res, 400, { error: 'El nombre admite hasta 64 caracteres.' });
    if (!yaCifrado.note && Object.prototype.hasOwnProperty.call(data, 'note') &&
        (typeof data.note !== 'string' || characterCount(data.note, 500) > 500))
        return json(res, 400, { error: 'La nota admite hasta 500 caracteres.' });
    if (Object.prototype.hasOwnProperty.call(data, 'avatar') && data.avatar !== '' && !validAvatar(data.avatar))
        return json(res, 400, { error: 'Avatar inválido: debe ser una imagen (data:image/... o el SVG propio).' });
    // La apariencia del chat se normaliza igual que en la pantalla
    // de ajustes: se descarta lo que no pase la validación de la
    // aplicación.
    let appearance = null;
    if (Object.prototype.hasOwnProperty.call(data, 'chatAppearance')) {
        const prevAppearance = (profiles[data.username] || {}).chatAppearance || {};
        appearance = normalizeChatAppearanceSettings(data.chatAppearance, prevAppearance);
        if (!appearance) return json(res, 400, { error: 'Apariencia inválida.' });
    }
    const privacyInput = data.privacy && typeof data.privacy === 'object' ? { ...data.privacy } : null;
    if (privacyInput && Object.prototype.hasOwnProperty.call(privacyInput, 'agregarme')) {
        const mode = privacyInput.agregarme && privacyInput.agregarme.mode;
        if (!['all', 'request', 'nobody'].includes(mode)) return json(res, 400, { error: 'Opción inválida.' });
        req.authUser.addPolicy = mode;
        delete privacyInput.agregarme;
    }
    const prev = profiles[data.username] || {};
    // Solo se guardan los campos conocidos: el resto de lo que
    // envíe el cliente (id, rol, políticas internas…) se ignora.
    const patch = {};
    for (const key of ['name', 'note', 'desc', 'avatar', 'chatAppearance'])
        if (Object.prototype.hasOwnProperty.call(data, key)) patch[key] = data[key];
    /* Guarda contra el doble cifrado: si el cliente nos devuelve un texto que
       YA viene cifrado (porque el servidor se lo pintó así), volverlo a
       cifrar destruiría el texto original para siempre. En ese caso se
       conserva el valor real que ya tenía el perfil. */
    for (const key of ['name', 'note', 'desc']) {
        if (yaCifrado[key]) {
            console.error(`[perfil] Se ignoró ${key}: el cliente devolvió texto cifrado.`);
            delete patch[key];
        }
    }
    if (appearance) patch.chatAppearance = appearance;
    if (privacyInput) patch.privacy = privacyInput;
    if (patch.avatar === '') delete patch.avatar;
    profiles[data.username] = { ...prev, ...patch };
    if (data.privacy) profiles[data.username].privacy = normPriv(data.privacy);
    if (typeof patch.note === 'string') {
        if (patch.note.trim() === '') profiles[data.username].noteTs = 0;
        else if (patch.note !== prev.note) profiles[data.username].noteTs = Date.now();
        else if (!prev.noteTs) profiles[data.username].noteTs = Date.now();
        // Una sola fuente de verdad: la nota se guarda también en
        // notesMap para que el perfil y /notes no se desincronicen.
        notesMap[data.username] = {
            ...(notesMap[data.username] || {}),
            text: patch.note,
            bg: (notesMap[data.username] && notesMap[data.username].bg) || '',
            ts: profiles[data.username].noteTs || Date.now()
        };
    }
    saveUserToDb(req.authUser);
    for (const u of users.values()) push(u, { type: 'profile', username: data.username });
    return json(res, 200, { ok: true });
}

function postNotes(req, res, url, data, actor) {
    // La nota es siempre la de la propia cuenta (nunca la de otro).
    const account = req.authUser;
    if (data.data === undefined || data.data === null || data.data === '') {
        delete notesMap[account.username];
        const p = profiles[account.username];
        if (p) { p.note = ''; p.noteTs = 0; }
    } else {
        if (typeof data.data !== 'object' || Array.isArray(data.data))
            return json(res, 400, { error: 'Nota inválida.' });
        const note = { ...data.data, ts: Date.now() };
        if (typeof note.text === 'string') note.text = note.text.slice(0, 500);
        if (JSON.stringify(note).length > 4096)
            return json(res, 400, { error: 'Nota demasiado grande.' });
        notesMap[account.username] = note;
        // El perfil y la nota son la misma fuente de verdad.
        const p = profiles[account.username];
        if (p) { p.note = typeof note.text === 'string' ? note.text : (p.note || ''); p.noteTs = note.ts; }
    }
    saveUserToDb(account);
    return json(res, 200, { ok: true });
}


module.exports = {
    getAccountChatSettings,
    getProfile,
    getNotes,
    postAccountProfile,
    postAccountChatSettings,
    postAccountRegenerateKey,
    postAccountDelete,
    postProfile,
    postNotes,
};

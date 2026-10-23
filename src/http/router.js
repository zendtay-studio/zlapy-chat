/**
 * Enrutador HTTP.
 *
 * Resuelve cada petición a la ruta que le corresponde y mantiene el orden de
 * comprobaciones: primero las rutas públicas, después la sesión, y por último
 * las mutaciones, que exigen origen válido.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { getAuthSession, getKey, postAuthAccountRemove, postAuthAddAccount, postAuthLogin, postAuthLogout, postAuthRegister, postAuthSwitch, postKey } = require('../auth/routes.js');
const { originAllowed, requestEncrypted, sessionUser } = require('../auth/sessions.js');
const { getCalls, postCallLog } = require('../calls/routes.js');
const { blobAvailableTo, blobHashOk, blobQuotaOk, invalidateBlobQuota, storeBlob } = require('../chat/media.js');
const { rejectRateLimited } = require('../http/helpers.js');
const { groupCreateLimiter } = require('../http/rate-limit.js');
const { withMentions } = require('../chat/mentions.js');
const { deleteMessageById, filterForViewer, readMessagePage, resolveReply, rowToMessage, updateStoredMessage } = require('../chat/messages.js');
const { getChatsSummary, getChatPreferences, getHave, getRoute2197, postChatDelete, postChatPreferences, postMessages, postMsgDelete, postMsgEdit, postPollVote, postReceipt, postSeen, postSend } = require('../chat/routes.js');
const { decorateForClient } = require('../chat/summaries.js');
const { CONFIG, PUBLIC } = require('../config.js');
const { getContactsRequests, getContactsRequestsSent, postBlock, postContacts, postContactsCancel, postContactsRemove, postContactsRespond } = require('../contacts/routes.js');
const { Stmt } = require('../db/statements.js');
const { pruneBlobHashes, removeBlobAccess, tx } = require('../db/transactions.js');
const { getGroups, getGroupsDiscover, getGroupsRequests, postGroups } = require('../groups/routes.js');
const { deleteGroupSummary, groupBrief, groupLastEntry, groupPolicies, groupSummaryFor, initializeGroupSummary, invalidateGroupPubCache, lastGroupMessage, pub, readGroup, updateGroupMessageSummaries, writeGroupMeta, writeGroupSummary } = require('../groups/store.js');
const { mimeMap, rejectRateLimitedMessage, safeDecodeSegment } = require('./helpers.js');
const { cspFor, json, securityHeaders } = require('./responses.js');
const { isEncrypted, openRequest, sealResponse } = require('./transport.js');
const { getConfig, getHealthz } = require('../meta/routes.js');
const { getNotes, getProfile, postAccountChatSettings, postAccountDelete, postAccountProfile, postAccountRegenerateKey, postNotes, postProfile } = require('../profile/routes.js');
const { postPushSubscribe, postPushTest, postPushUnsubscribe } = require('../push/routes.js');
const { VAPID, notifyUser } = require('../push/vapid.js');
const { push, pushName, pushRawName, userList } = require('../realtime/notify.js');
const { createDefaultAvatarSvg, createDefaultGroupAvatarSvg } = require('../shared/avatar.js');
const { storeGallery, validateGallery } = require('../shared/gallery.js');
const { MESSAGE_LIMITS, characterCount } = require('../shared/limits.js');
const { resolvePublicFile } = require('../shared/static-path.js');
const { normalizeContactData, normalizePollData } = require('../shared/types.js');
const { clampStr, validAvatar, validMessageId, validMime, validStickerData } = require('../shared/validation.js');
const { groupCache, profiles, stories, users } = require('../state.js');
const { getGiphySearch, getStickers, postStickers } = require('../stickers/routes.js');
const { getStories, postStory, postStoryLike } = require('../stories/routes.js');
const { byName } = require('../users/helpers.js');
const { isContact } = require('../users/privacy.js');

const handleRequest = (req, res) => {
    let url;
    let actor = '';
    let data = null;
    try { url = new URL(req.url, 'http://x'); }
    catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('bad request'); }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    // Forzado de TLS: con FORCE_TLS activo y certificados disponibles, toda
    // petición en claro se redirige a HTTPS antes de tocar nada (ni siquiera
    // las rutas públicas), de modo que las credenciales y la cookie de sesión
    // nunca viajen sin cifrar. `requestEncrypted` ya cubre el caso del proxy
    // de confianza que termina TLS, así que no se entra en bucle.
    if (CONFIG.forceTls && !requestEncrypted(req) && url.pathname !== '/healthz') {
        const host = req.headers.host;
        if (host) {
            res.writeHead(301, {
                'Location': `https://${host}${req.url}`,
                'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
                ...securityHeaders
            });
            return res.end();
        }
    }
    // CSP por petición (el host propio forma parte de connect-src) y HSTS
    // siempre que la conexión sea (o vaya a ser) cifrada.
    res.setHeader('Content-Security-Policy', cspFor(req.headers.host));
    if (requestEncrypted(req))
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.method === 'GET' && url.pathname === '/config')
        return getConfig(req, res, url, data, actor);

    // Health check público y sin datos: comprueba que ambas bases respondan.
    if (req.method === 'GET' && url.pathname === '/healthz') return getHealthz(req, res, url, data, actor);

    const avatarMatch = req.method === 'GET' && url.pathname.match(/^\/avatar\/([a-z0-9_.-]{3,36})\.svg$/i);
    if (avatarMatch) {
        const identifier = safeDecodeSegment(avatarMatch[1]);
        if (!identifier) return json(res, 404, { error: 'avatar not found' });
        // El avatar exige sesión: sin ella no se pueden enumerar usuarios.
        if (!sessionUser(req)) return json(res, 401, { error: 'authentication required' });
        const byId = /^[0-9a-f-]{36}$/i.test(identifier);
        const user = byId ? users.get(identifier.toLowerCase()) : byName(identifier.toLowerCase());
        // Un grupo sin foto usa su identificador interno para generar un
        // avatar propio (con otro diseño que el de las personas).
        if (!user && identifier.startsWith('g_')) {
            const group = readGroup(identifier);
            if (!group) return json(res, 404, { error: 'avatar not found' });
            res.writeHead(200, {
                'Content-Type': 'image/svg+xml; charset=utf-8',
                'Cache-Control': 'private, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff',
                ...securityHeaders
            });
            return res.end(createDefaultGroupAvatarSvg(group.id));
        }
        if (!user) return json(res, 404, { error: 'avatar not found' });
        res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': byId ? 'private, max-age=31536000, immutable' : 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            ...securityHeaders
        });
        return res.end(createDefaultAvatarSvg(user.id));
    }

    if (req.method === 'GET' && url.pathname === '/auth/session') return getAuthSession(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/push/vapid') return json(res, 200, { publicKey: VAPID.publicKey });

    const publicPage = req.method === 'GET' && (url.pathname === '/config' || url.pathname === '/' || ['.html', '.js', '.css', '.svg', '.png', '.webmanifest', '.json'].includes(path.extname(url.pathname).toLowerCase()));
    const publicAuthPost = req.method === 'POST' && ['/auth/register', '/auth/login', '/auth/logout', '/auth/switch'].includes(url.pathname);
    const authUser = sessionUser(req);
    if (!authUser && !publicPage && !publicAuthPost) return json(res, 401, { error: 'authentication required' });
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (req.method === 'POST' && (!originAllowed(req) || req.headers['sec-fetch-site'] === 'cross-site'))
        return json(res, 403, { error: 'cross-origin request rejected' });
    req.authUser = authUser;
    actor = authUser ? authUser.username : '';

    // GET
    // Proxy de stickers: la clave de GIPHY se queda en el servidor.
    if (req.method === 'GET' && url.pathname === '/giphy/search') return getGiphySearch(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname.startsWith('/blob/')) return getRoute2197(req, res, url, data, actor);
    if (req.method === 'GET' && (url.pathname === '/users' || url.pathname === '/contacts'))
        return json(res, 200, { users: userList(req.authUser.id) });

    if (req.method === 'GET' && url.pathname === '/contacts/requests') return getContactsRequests(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/contacts/requests/sent') return getContactsRequestsSent(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/groups/requests') return getGroupsRequests(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/have') return getHave(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/chats/summary') return getChatsSummary(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/stories') return getStories(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/key') return getKey(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/groups') return getGroups(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/groups/discover') return getGroupsDiscover(req, res, url, data, actor);
    let gmGet = url.pathname.match(/^\/groups\/([^/]+)$/);
    if (gmGet && req.method === 'GET') {
        const gid = safeDecodeSegment(gmGet[1]);
        if (gid === null) return json(res, 400, { error: 'id inválido' });
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(gid)) return json(res, 400, { error: 'id inválido' });
        const g = readGroup(gid);
        if (!g || !g.memberIds.includes(req.authUser.id)) return json(res, 404, { error: 'no existe' });
        const full = pub(g, req.authUser.id);
        if (url.searchParams.get('light') === '1') {
            full.brief = groupBrief(g.id);
            full.seenTs = (req.authUser.groupSeen || {})[g.id] || 0;
            full.unread = groupSummaryFor(req.authUser.id, g.id).unread;
        } else {
            const page = readMessagePage('group:' + g.id, { limit: 100 });
            full.messages = filterForViewer(page.messages, req.authUser.id, 'group:' + g.id).map(m => withMentions(decorateForClient(m)));
            full.more = page.more;
        }
        return json(res, 200, full);
    }
    let gmMsgs = url.pathname.match(/^\/groups\/([^/]+)\/messages$/);
    if (gmMsgs && req.method === 'GET') {
        const gid = safeDecodeSegment(gmMsgs[1]);
        if (gid === null) return json(res, 400, { messages: [], more: false });
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(gid)) return json(res, 400, { messages: [], more: false });
        const g = readGroup(gid);
        if (!g || !g.memberIds.includes(req.authUser.id)) return json(res, 404, { messages: [], more: false });
        const page = readMessagePage('group:' + gid, {
            beforeId: url.searchParams.get('beforeId') || undefined,
            limit: Number(url.searchParams.get('limit')) || 30
        });
        const visible = filterForViewer(page.messages, req.authUser.id, 'group:' + gid);
        return json(res, 200, { messages: visible.map(m => withMentions(decorateForClient(m))), more: page.more });
    }
    if (req.method === 'GET' && url.pathname === '/calls') return getCalls(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/stickers')
        return getStickers(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/chat/preferences')
        return getChatPreferences(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/account/chat-settings')
        return json(res, 200, { settings: profiles[req.authUser.username]?.chatAppearance || null });
    if (req.method === 'GET' && url.pathname === '/profile') return getProfile(req, res, url, data, actor);
    if (req.method === 'GET' && url.pathname === '/notes') return getNotes(req, res, url, data, actor);

    // POST
    if (req.method === 'POST') {
        const chunks = [];
        let bytes = 0;
        let oversized = false;
        // Límite de cuerpo por ruta: las rutas de autenticación solo llevan
        // usuario y contraseña, así que no tienen por qué aceptar 32 MB (ni
        // pagar el coste de parsearlos).
        const SMALL_BODY_ROUTES = new Set(['/auth/register', '/auth/login', '/auth/add-account', '/auth/switch', '/auth/logout', '/auth/account/remove']);
        const bodyLimit = SMALL_BODY_ROUTES.has(url.pathname) ? 8 * 1024 : CONFIG.maxHttpBodyBytes;
        if (Number(req.headers['content-length']) > bodyLimit) {
            json(res, 413, { error: 'Contenido demasiado grande.' });
            req.resume();
            return;
        }
        req.on('data', c => {
            bytes += c.length;
            if (bytes > bodyLimit) {
                oversized = true;
                chunks.length = 0;
                return;
            }
            if (!oversized) chunks.push(c);
        });
        req.on('end', async () => {
            try {
            if (oversized) return json(res, 413, { error: 'Contenido demasiado grande.' });
            const rawBody = Buffer.concat(chunks);
            let data;
            if (isEncrypted(req)) {
                // El cuerpo llega cifrado: se descifra antes de interpretarlo y
                // la respuesta se devuelve cifrada con la misma clave.
                const opened = openRequest(req, url, rawBody);
                if (opened.error) return json(res, 400, { error: opened.error });
                data = opened.data;
                sealResponse(res, opened.session);
            } else {
                /* Un POST sin cuerpo es una petición vacía, no un error: se
                   interpreta como {}. Antes el JSON.parse('') devolvía 400 antes
                   de ejecutar la ruta, y un logout sin cuerpo dejaba la sesión
                   abierta con un mensaje que no decía nada. */
                const text = rawBody.toString('utf8');
                if (!text.trim()) data = {};
                else {
                    try { data = JSON.parse(text); } catch { return json(res, 400, { error: 'Cuerpo JSON inválido.' }); }
                    if (!data || typeof data !== 'object') return json(res, 400, { error: 'El cuerpo debe ser un objeto JSON.' });
                }
            }

    if (url.pathname === '/key') return postKey(req, res, url, data, actor);

            if (/^\/groups\/[^/]+\/groupkey$/.test(url.pathname)) {
                const gid = safeDecodeSegment(url.pathname.split('/')[2]);
                if (gid === null) return json(res, 400, { error: 'id inválido' });
                if (!/^[a-zA-Z0-9_-]{1,80}$/.test(gid)) return json(res, 400, { error: 'id inválido' });
                const g = readGroup(gid);
                if (!g) return json(res, 404, { error: 'no existe' });
                if (!g.memberIds.includes(req.authUser.id)) return json(res, 403, { error: 'no eres miembro' });
                const recipients = Array.isArray(data.recipients) ? data.recipients : [];
                if (!g.keyboxes) g.keyboxes = [];
                for (const box of recipients) {
                    if (!box || typeof box.recipient !== 'string' || !g.members.includes(box.recipient)) continue;
                    if (typeof box.iv !== 'string' || box.iv.length > 512 || typeof box.ct !== 'string' || box.ct.length > 16384) continue;
                    // El autor del keybox es siempre quien lo sube: un miembro
                    // no puede firmar keyboxes a nombre de otro.
                    box.by = req.authUser.username;
                    const idx = g.keyboxes.findIndex(b => b.recipient === box.recipient);
                    // Un miembro solo puede escribir SU propio slot; los
                    // admins pueden reescribir cualquiera.
                    const actorIsAdmin = g.admins.some(name => byName(name)?.id === req.authUser.id);
                    if (idx >= 0 && g.keyboxes[idx].by !== box.by && !actorIsAdmin) continue;
                    const entry = { recipient: box.recipient, by: box.by, iv: box.iv, ct: box.ct, ts: Date.now() };
                    if (idx >= 0) g.keyboxes[idx] = entry; else g.keyboxes.push(entry);
                }
                writeGroupMeta(g);
                return json(res, 200, { ok: true });
            }

    // ---- Auth ----
    if (url.pathname === '/auth/register') return postAuthRegister(req, res, url, data, actor);
    if (url.pathname === '/auth/login') return postAuthLogin(req, res, url, data, actor);
    if (url.pathname === '/auth/add-account') return postAuthAddAccount(req, res, url, data, actor);
    if (url.pathname === '/auth/switch') return postAuthSwitch(req, res, url, data, actor);
    if (url.pathname === '/auth/account/remove') return postAuthAccountRemove(req, res, url, data, actor);
    if (url.pathname === '/auth/logout') return postAuthLogout(req, res, url, data, actor);

    if (!req.authUser) return json(res, 401, { error: 'authentication required' });
    if (url.pathname === '/account/profile' && typeof data.username === 'string')
        data.username = data.username.trim().toLowerCase();
    if (url.pathname === '/profile' || url.pathname === '/notes' || url.pathname.startsWith('/push/') ||
        url.pathname === '/call/log' || url.pathname === '/account/delete' || url.pathname === '/stickers')
        data.username = actor;
    if (['/send', '/receipt', '/chat/delete', '/block', '/messages'].includes(url.pathname)) data.from = actor;
    if (['/story', '/story/delete', '/story/edit'].includes(url.pathname)) data.from = actor;
    if (url.pathname === '/story/view' || url.pathname === '/story/like') data.viewer = actor;

    // ---- Stickers ----
    if (url.pathname === '/stickers') return postStickers(req, res, url, data, actor);

    if (url.pathname === '/chat/preferences') return postChatPreferences(req, res, url, data, actor);

    if (url.pathname === '/poll/vote') return postPollVote(req, res, url, data, actor);

    // ---- Contacts ----
    if (url.pathname === '/contacts') return postContacts(req, res, url, data, actor);
    if (url.pathname === '/contacts/remove') return postContactsRemove(req, res, url, data, actor);
    if (url.pathname === '/contacts/cancel') return postContactsCancel(req, res, url, data, actor);
    if (url.pathname === '/contacts/respond') return postContactsRespond(req, res, url, data, actor);

    // ---- Account ----
    if (url.pathname === '/account/profile') return postAccountProfile(req, res, url, data, actor);
    if (url.pathname === '/account/chat-settings') return postAccountChatSettings(req, res, url, data, actor);
    if (url.pathname === '/account/regenerate-key') { await postAccountRegenerateKey(req, res, url, data, actor); return; }
    if (url.pathname === '/account/delete') return postAccountDelete(req, res, url, data, actor);



    // ---- Push ----
    if (url.pathname === '/push/subscribe') return postPushSubscribe(req, res, url, data, actor);
    if (url.pathname === '/push/unsubscribe') return postPushUnsubscribe(req, res, url, data, actor);
    if (url.pathname === '/push/test') return postPushTest(req, res, url, data, actor);

    // ---- Profile ----
    if (url.pathname === '/profile') return postProfile(req, res, url, data, actor);

    // ---- /send (DM) ----
    if (url.pathname === '/send') return postSend(req, res, url, data, actor);

    // ---- Seen ----
    if (url.pathname === '/seen') return postSeen(req, res, url, data, actor);

    // ---- Stories ----
    if (url.pathname === '/story') return postStory(req, res, url, data, actor);
    if (url.pathname === '/story/like' || url.pathname === '/story/view' || url.pathname === '/story/edit' || url.pathname === '/story/delete') return postStoryLike(req, res, url, data, actor);
    if (url.pathname === '/notes') return postNotes(req, res, url, data, actor);

    // ---- Receipts ----
    if (url.pathname === '/receipt') return postReceipt(req, res, url, data, actor);
    if (url.pathname === '/msg/delete') return postMsgDelete(req, res, url, data, actor);
    if (url.pathname === '/msg/edit') return postMsgEdit(req, res, url, data, actor);
    if (url.pathname === '/chat/delete') return postChatDelete(req, res, url, data, actor);
    if (url.pathname === '/block') return postBlock(req, res, url, data, actor);

    // ---- Groups: create ----
    if (url.pathname === '/groups' && req.method === 'POST') {
        if (rejectRateLimited(res, groupCreateLimiter, req.authUser.id, 10, 'grupos creados por minuto')) return;
        return postGroups(req, res, url, data, actor);
    }

    // ---- Groups: actions ----
            let gm = url.pathname.match(/^\/groups\/([^/]+)$/);
            if (gm && req.method === 'POST') {
                const id = safeDecodeSegment(gm[1]);
                if (id === null) return json(res, 400, { error: 'id inválido' });
                if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) return json(res, 400, { error: 'id inválido' });
                const g = readGroup(id);
                if (!g) return json(res, 404, { error: 'no existe' });
                const isAdmin = g.admins.some(name => byName(name)?.id === req.authUser.id);
                const isMember = g.memberIds.includes(req.authUser.id);
                const notifyGroup = type => { for (const username of g.members) pushName(username, { type, group: pub(g) }); };

                if (data.join === true && !isMember) {
                    const invited = typeof data.inviteCode === 'string' && data.inviteCode === g.inviteCode;
                    if (g.visibility !== 'public' && !invited) return json(res, 404, { error: 'No disponible.' });
                    if (g.joinPolicy === 'closed') return json(res, 403, { error: 'Cerrado.' });
                    if (g.joinPolicy === 'request') {
                        if (!g.joinRequests.some(r => r.userId === req.authUser.id)) {
                            g.joinRequests.push({ userId: req.authUser.id, username: actor, ts: Date.now() });
                            writeGroupMeta(g);
                        }
                        for (const admin of g.admins) {
                            pushName(admin, { type: 'group-request', groupId: id });
                            void notifyUser(admin, { title: 'Solicitud para unirse a ' + g.name, body: 'Alguien quiere unirse', tag: 'greq-' + id, url: '/' });
                        }
                        return json(res, 200, { ok: true, requested: true });
                    }
                    g.members.push(actor); g.memberIds.push(req.authUser.id);
                    writeGroupMeta(g);
                    initializeGroupSummary(req.authUser.id, id);
                    notifyGroup('group');
                    return json(res, 200, pub(g));
                }
                if (data.cancelJoin === true && !isMember) {
                    if (!g.joinRequests.some(r => r.userId === req.authUser.id)) return json(res, 404, { error: 'No disponible.' });
                    g.joinRequests = g.joinRequests.filter(r => r.userId !== req.authUser.id);
                    writeGroupMeta(g);
                    return json(res, 200, { ok: true });
                }
                if (!isMember) return json(res, 404, { error: 'no existe' });

                if (typeof data.seenMessage === 'string') {
                    const row = Stmt.getMessage.get(data.seenMessage);
                    if (!row || row.chat !== 'group:' + id) return json(res, 404, { error: 'No existe.' });
                    const m = rowToMessage(row);
                    if (!m || !m.once || m.fromId === req.authUser.id) return json(res, 403, { error: 'No abrible.' });
                    m.kind = 'seen'; m.data = ''; m.hash = ''; m.gallery = [];
                    m.once = false;
                    updateStoredMessage(m, row);
                    pruneBlobHashes(removeBlobAccess('message_id = ?', m.id)); invalidateBlobQuota(req.authUser.id);
                    for (const username of g.members) pushName(username, {
                        type: 'group-message-seen', groupId: id, messageId: data.seenMessage,
                        signature: m.signature, signingPublicKey: m.signingPublicKey,
                        signatureValid: m.signatureValid
                    });
                    return json(res, 200, { ok: true });
                }

                if (data.message) {
                    if (typeof data.message !== 'object' || Array.isArray(data.message)) return json(res, 400, { error: 'Mensaje inválido.' });
                    const source = data.message;
                    const kind = typeof source.kind === 'string' ? source.kind : '';
                    if (!Object.prototype.hasOwnProperty.call(groupPolicies, kind)) return json(res, 400, { error: 'Tipo inválido.' });
                    const policy = kind === 'text' ? g.writePolicy : g.contentPolicy[kind];
                    if (policy === 'off') return json(res, 403, { error: 'Desactivado.' });
                    if (!isAdmin && (g.writePolicy === 'admins' || policy === 'admins')) return json(res, 403, { error: 'Solo admins.' });
                    if (typeof source.data !== 'string' || source.data.length > CONFIG.maxMessageDataChars) return json(res, 400, { error: 'Contenido inválido.' });
                    if (kind === 'text' && characterCount(source.data, MESSAGE_LIMITS.groupMessageCharacters) > MESSAGE_LIMITS.groupMessageCharacters)
                        return json(res, 400, { error: `Los mensajes de grupo admiten hasta ${MESSAGE_LIMITS.groupMessageCharacters} caracteres.` });
                    if (rejectRateLimitedMessage(res, req.authUser.id)) return;
                    /* Validar sin escribir: los blobs se guardan al final, cuando
                       el mensaje ya está aceptado (antes una galería rechazada
                       dejaba adjuntos huérfanos ocupando disco). */
                    const gallery = source.gallery === undefined ? [] : validateGallery(req.authUser, source.gallery, blobAvailableTo);
                    if (source.gallery !== undefined && (!gallery || kind !== 'image')) return json(res, 400, { error: 'Galería inválida.' });
                    if (['image', 'video', 'audio', 'file'].includes(kind) && !source.hash && !gallery.length) return json(res, 400, { error: 'Falta hash.' });
                    if (kind === 'sticker' && !validStickerData(source.data)) return json(res, 400, { error: 'Sticker inválido.' });
                    if (kind === 'contact') {
                        const contact = normalizeContactData(source.data, byName);
                        if (!contact) return json(res, 400, { error: 'Contacto inválido.' });
                        source.data = JSON.stringify(contact);
                    } else if (kind === 'poll') {
                        const poll = normalizePollData(source.data);
                        if (!poll) return json(res, 400, { error: 'Encuesta inválida.' });
                        source.data = JSON.stringify(poll);
                    }
                    let mentions = [], mentionLabels = {};
                    if (kind === 'text') {
                        const mentioned = new Set();
                        const allMatch = /(^|\s)@(all|todos)\b/i.test(source.data);
                        if (allMatch) {
                            if (g.mentionAllPolicy === 'admins' && !isAdmin) return json(res, 403, { error: 'Solo admins.' });
                            for (const u of g.members) {
                                if (u === actor) continue;
                                const id2 = byName(u)?.id;
                                if (id2) { mentioned.add(id2); mentionLabels[id2] = u; }
                            }
                        } else {
                            for (const match of source.data.matchAll(/@([a-zA-Z0-9_.-]{3,24})/g)) {
                                const u = match[1].toLowerCase();
                                const member = g.members.find(c => c.toLowerCase() === u);
                                const id2 = member && byName(member)?.id;
                                if (id2) { mentioned.add(id2); mentionLabels[id2] = member; }
                            }
                        }
                        mentioned.delete(req.authUser.id);
                        mentions = [...mentioned];
                    }
                    let messageData = gallery.length ? '' : source.data;
                    let pendingHash = typeof source.hash === 'string' ? source.hash.toLowerCase() : '';
                    if (pendingHash) {
                        if (!blobHashOk(pendingHash)) return json(res, 400, { error: 'Hash inválido.' });
                        // Referenciar un adjunto ya existente exige tener acceso a él.
                        if (!messageData && !blobAvailableTo(req.authUser, pendingHash)) return json(res, 400, { error: 'Archivo no disponible.' });
                    }
                    /* Cuota de almacenamiento y, solo entonces, la escritura. */
                    const bytesNuevos = (messageData && pendingHash ? Buffer.byteLength(messageData) : 0) +
                        gallery.reduce((total, item) => total + (item.data ? Buffer.byteLength(item.data) : 0), 0);
                    if (bytesNuevos > 0 && !blobQuotaOk(req.authUser.id, bytesNuevos))
                        return json(res, 413, { error: 'Has alcanzado el límite de almacenamiento de adjuntos.' });
                    if (pendingHash && messageData && !storeBlob(pendingHash, messageData))
                        return json(res, 400, { error: 'Archivo inválido.' });
                    if (gallery.length && !storeGallery(gallery, storeBlob))
                        return json(res, 400, { error: 'Galería inválida.' });
                    if (pendingHash) { source.hash = pendingHash; messageData = ''; }
                    const msg = {
                        id: validMessageId(source.id) ? source.id : crypto.randomUUID(),
                        fromId: req.authUser.id,
                        kind, data: messageData, hash: typeof source.hash === 'string' ? source.hash.toLowerCase() : '', gallery,
                        once: !!source.once,
                        name: kind === 'image' ? '' : clampStr(source.name, 180),
                        mime: validMime(source.mime) ? source.mime.slice(0, 120) : '',
                        caption: typeof source.caption === 'string' ? source.caption.slice(0, 2000) : '',
                        reply: resolveReply(source.reply, 'group:' + id),
                        ts: Date.now(), mentions, mentionLabels,
                        enc: typeof source.enc === 'string' && (source.enc === 'e2' || source.enc === 'g2') ? source.enc : ''
                    };
                    tx.sendMessage(msg, 'group:' + id, g.cryptoId);
                    // Mensaje nuevo = la conversación reaparece.
                    Stmt.deleteChatDeletion.run('group:' + id, req.authUser.id);
                    updateGroupMessageSummaries(g, msg, req.authUser.id);
                    const decorated = withMentions(decorateForClient(msg));
                    // Serializar UNA vez; el push web solo se envía a
                    // miembros desconectados (los conectados ya lo recibieron
                    // por WebSocket y no necesitan doble notificación).
                    const rawGroupMessage = JSON.stringify({ type: 'group-message', groupId: id, message: decorated });
                    for (const m of g.members) {
                        pushRawName(m, rawGroupMessage);
                        if (m !== actor) {
                            const memberAcc = byName(m);
                            if (memberAcc && !memberAcc.online)
                                void notifyUser(m, { title: 'Nuevo mensaje · ' + g.name, body: kind === 'text' ? String(msg.data).slice(0, 120) : 'Mensaje nuevo', tag: 'grp-' + id, url: '/' });
                        }
                    }
                    return json(res, 200, { ok: true, message: decorated });
                }
                if (data.addMember) {
                    if (g.addPolicy !== 'all' && !isAdmin) return json(res, 403, { error: 'Solo admins.' });
                    const newMember = byName(data.addMember);
                    if (!newMember) return json(res, 404, { error: 'No existe.' });
                    if (!isContact(profiles[req.authUser.username], newMember.username)) return json(res, 403, { error: 'Solo contactos.' });
                    if (!g.members.includes(newMember.username)) {
                        g.members.push(newMember.username); g.memberIds.push(newMember.id);
                        writeGroupMeta(g);
                        initializeGroupSummary(newMember.id, id);
                        notifyGroup('group');
                    }
                    return json(res, 200, pub(g));
                }
                const removeMember = data.removeMember || data.removed;
                if (removeMember) {
                    if (!isAdmin) return json(res, 403, { error: 'Solo admins.' });
                    const removed = byName(removeMember);
                    if (!removed || removed.id === req.authUser.id) return json(res, 400, { error: 'Usa salir.' });
                    g.members = g.members.filter(x => x !== removeMember);
                    g.admins = g.admins.filter(x => x !== removeMember);
                    g.memberIds = g.memberIds.filter(id2 => id2 !== removed.id);
                    // Si el expulsado era el PROPIETARIO del grupo, la
                    // propiedad pasa a un admin: si no, seguía siendo dueño
                    // (y podía borrarlo) aunque ya no fuese miembro.
                    if (g.ownerId === removed.id)
                        g.ownerId = (g.admins[0] && byName(g.admins[0])?.id) || '';
                    writeGroupMeta(g);
                    deleteGroupSummary(removed.id, id);
                    notifyGroup('group');
                    pushName(removeMember, { type: 'group-left', groupId: id });
                    return json(res, 200, pub(g));
                }
                if (data.leave === true) {
                    g.members = g.members.filter(u => u !== actor);
                    g.admins = g.admins.filter(u => u !== actor);
                    g.memberIds = g.memberIds.filter(id2 => id2 !== req.authUser.id);
                    if (!g.admins.length && g.members.length) g.admins = [g.members[0]];
                    if (g.members.length) writeGroupMeta(g);
                    else {
                        pruneBlobHashes(tx.deleteGroup(id));
                        groupCache.delete(id);
                        invalidateGroupPubCache(id);
                    }
                    deleteGroupSummary(req.authUser.id, id);
                    for (const u of g.members) pushName(u, { type: 'group', group: pub(g) });
                    push(req.authUser, { type: 'group-left', groupId: id });
                    return json(res, 200, pub(g));
                }
                if (typeof data.seenTs === 'number' && isFinite(data.seenTs) && data.seenTs >= 0) {
                    const account = req.authUser;
                    account.groupSeen = account.groupSeen || {};
                    const previous = account.groupSeen[id] || 0;
                    if (data.seenTs > previous) {
                        account.groupSeen[id] = data.seenTs;
                        // Upsert directo del "visto": no reescribe las tablas
                        // de la cuenta entera.
                        if (Stmt.groupExists.get(id)) Stmt.upsertGroupSeen.run(account.id, id, data.seenTs);
                    }
                    const summary = groupSummaryFor(account.id, id);
                    summary.unread = 0;
                    writeGroupSummary(account.id, id, summary);
                    return json(res, 200, { ok: true, seenTs: account.groupSeen[id] || 0 });
                }
                if (data.deleteGroup === true) {
                    if (!isAdmin) return json(res, 403, { error: 'Solo admins.' });
                    for (const uuid of g.memberIds) deleteGroupSummary(uuid, id);
                    pruneBlobHashes(tx.deleteGroup(id));
                    groupCache.delete(id);
                    invalidateGroupPubCache(id);
                    for (const member of g.members) {
                        const account = byName(member);
                        if (account && account.groupSeen && account.groupSeen[id] != null) {
                            delete account.groupSeen[id];
                            Stmt.deleteGroupSeen.run(account.id, id); // un solo DELETE
                        }
                    }
                    for (const u of g.members) pushName(u, { type: 'group-left', groupId: id });
                    return json(res, 200, { ok: true, deleted: true });
                }
                if (data.approveJoin || data.rejectJoin) {
                    if (!isAdmin) return json(res, 403, { error: 'Solo admins.' });
                    const requested = byName(data.approveJoin || data.rejectJoin);
                    if (!requested || !g.joinRequests.some(r => r.userId === requested.id)) return json(res, 404, { error: 'No disponible.' });
                    g.joinRequests = g.joinRequests.filter(r => r.userId !== requested.id);
                    if (data.approveJoin) { g.members.push(requested.username); g.memberIds.push(requested.id); }
                    else pushName(requested.username, { type: 'group-request-rejected', groupId: id });
                    writeGroupMeta(g);
                    if (data.approveJoin) initializeGroupSummary(requested.id, id);
                    notifyGroup('group');
                    if (data.approveJoin) pushName(requested.username, { type: 'group', group: pub(g) });
                    return json(res, 200, pub(g));
                }
                if (data.deleteMessage) {
                    const row = Stmt.getMessage.get(data.deleteMessage);
                    if (!row || row.chat !== 'group:' + id) return json(res, 404, { error: 'No existe.' });
                    const m = rowToMessage(row);
                    if (!m) return json(res, 404, { error: 'No existe.' });
                    if (m.fromId !== req.authUser.id && !isAdmin) return json(res, 403, { error: 'Sin permiso.' });
                    deleteMessageById(data.deleteMessage);
                    const last = groupLastEntry(lastGroupMessage(id));
                    for (const uuid of g.memberIds) {
                        const summary = groupSummaryFor(uuid, id);
                        if (summary.last && summary.last.id === data.deleteMessage) summary.last = last;
                        writeGroupSummary(uuid, id, summary);
                    }
                    for (const u of g.members) pushName(u, { type: 'group-message-delete', groupId: id, messageId: data.deleteMessage });
                    return json(res, 200, { ok: true });
                }
                if (data.approveAdmin || data.removeAdmin) {
                    if (!isAdmin) return json(res, 403, { error: 'Solo admins.' });
                    const target = byName(data.approveAdmin || data.removeAdmin);
                    if (!target || !g.members.includes(target.username)) return json(res, 404, { error: 'No está en el grupo.' });
                    if (data.approveAdmin && !g.admins.includes(target.username)) g.admins.push(target.username);
                    if (data.removeAdmin) {
                        if (target.id === req.authUser.id) return json(res, 400, { error: 'No puedes quitarte tu propio rol.' });
                        g.admins = g.admins.filter(u => u !== target.username);
                    }
                    writeGroupMeta(g); notifyGroup('group');
                    return json(res, 200, pub(g));
                }
                const settingsKeys = ['rename', 'description', 'avatar', 'visibility', 'joinPolicy', 'writePolicy', 'addPolicy', 'editPolicy', 'mentionAllPolicy', 'contentPolicy'];
                if (settingsKeys.some(k => Object.prototype.hasOwnProperty.call(data, k))) {
                    if (!isAdmin && g.editPolicy !== 'all') return json(res, 403, { error: 'Solo admins.' });
                    if (Object.prototype.hasOwnProperty.call(data, 'rename')) {
                        if (typeof data.rename !== 'string' || !data.rename.trim() || data.rename.length > 40) return json(res, 400, { error: 'Nombre inválido.' });
                        g.name = data.rename.trim();
                    }
                    if (Object.prototype.hasOwnProperty.call(data, 'description')) {
                        if (typeof data.description !== 'string' || data.description.length > 500) return json(res, 400, { error: 'Descripción inválida.' });
                        g.description = data.description.trim();
                    }
                    if (Object.prototype.hasOwnProperty.call(data, 'avatar')) {
                        if (!validAvatar(data.avatar)) return json(res, 400, { error: 'Avatar inválido.' });
                        g.avatar = data.avatar;
                    }
                    for (const [key, values] of Object.entries({
                        visibility: ['public', 'private'], joinPolicy: ['open', 'request', 'closed'],
                        writePolicy: ['all', 'admins'], addPolicy: ['all', 'admins'],
                        editPolicy: ['all', 'admins'], mentionAllPolicy: ['all', 'admins']
                    })) {
                        if (Object.prototype.hasOwnProperty.call(data, key)) {
                            if (!values.includes(data[key])) return json(res, 400, { error: key + ' inválido.' });
                            g[key] = data[key];
                        }
                    }
                    if (Object.prototype.hasOwnProperty.call(data, 'contentPolicy')) {
                        if (!data.contentPolicy || typeof data.contentPolicy !== 'object' || Array.isArray(data.contentPolicy) ||
                            Object.entries(data.contentPolicy).some(([kind, policy]) => !groupPolicies[kind] || !groupPolicies[kind].includes(policy)))
                            return json(res, 400, { error: 'contentPolicy inválido.' });
                        g.contentPolicy = { ...g.contentPolicy, ...data.contentPolicy };
                    }
                    writeGroupMeta(g); notifyGroup('group');
                    return json(res, 200, pub(g));
                }
                return json(res, 400, { error: 'Acción no reconocida.' });
            }

    // ---- /messages (paginado) ----
    if (url.pathname === '/messages') return postMessages(req, res, url, data, actor);

    // ---- /call/log ----
    if (url.pathname === '/call/log') return postCallLog(req, res, url, data, actor);

            json(res, 404, { error: 'Ruta no encontrada.' });
                    } catch (error) {
                console.error('[http] Error no controlado:', error);
                if (!res.headersSent) json(res, 500, { error: 'Error interno del servidor.' });
                else res.end();
            }
});
        return;
    }

    // ---- static ----
    const fp = resolvePublicFile(PUBLIC, req.url);
    if (!fp) { res.writeHead(404); return res.end('not found'); }
    const mime = mimeMap[path.extname(fp).toLowerCase()] || 'application/octet-stream';
    const mutableAsset = ['.html', '.js', '.css', '.webmanifest'].includes(path.extname(fp).toLowerCase());
    res.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        ...(mutableAsset ? { 'Cache-Control': 'no-store, max-age=0' } : {}),
        ...securityHeaders
    });
    const stream = fs.createReadStream(fp);
    stream.on('error', error => {
        if (error.code !== 'ENOENT') console.error('[static] Failed to read public asset:', error);
        if (!res.headersSent) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('not found'); }
        else res.destroy();
    });
    stream.pipe(res);
};

// Red de seguridad: ningún error síncrono del handler debe tumbar el proceso.
const handler = (req, res) => {
    try {
        handleRequest(req, res);
    } catch (err) {
        console.error('[http] error no controlado:', err);
        try {
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end('{"error":"bad request"}');
            } else res.end();
        } catch { try { res.destroy(); } catch { } }
    }
};

module.exports = {
    handleRequest,
    handler
};

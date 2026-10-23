/**
 * Rutas HTTP de historias.
 *
 * Publicar, listar y consultar historias. Cada historia se guarda cifrada
 * con la clave de su autor y se reparte solo a los usuarios a los que la
 * privacidad de ese autor les permite verla.
 */
'use strict';

const { blobAvailableTo, blobHashOk, blobQuotaOk, invalidateBlobQuota, storeBlob } = require('../chat/media.js');
const { encryptForUser } = require('../crypto/setup.js');
const { db } = require('../db/database.js');
const { Stmt } = require('../db/statements.js');
const { pruneBlobHashes, removeBlobAccess } = require('../db/transactions.js');
const { rejectRateLimited } = require('../http/helpers.js');
const { storyLimiter, storyViewLimiter } = require('../http/rate-limit.js');
const { json } = require('../http/responses.js');
const { liveStories, push, pushStories, storyForViewer } = require('../realtime/notify.js');
const { MESSAGE_LIMITS, characterCount } = require('../shared/limits.js');
const { validMime, validStoryMedia } = require('../shared/validation.js');
const { profiles, stories, setStories } = require('../state.js');
const { accountId, byName } = require('../users/helpers.js');
const { permite } = require('../users/privacy.js');

function getStories(req, res, url, data, actor) {
    const viewer = req.authUser.username;
    const list = liveStories().filter(s => permite(profiles[s.from], 'historias', viewer));
    return json(res, 200, { stories: list.map(s => storyForViewer(s, viewer)) });
}

function postStory(req, res, url, data, actor) {
    // Publicar una historia tiene el mismo fan-out que un mensaje
    // (se copia en RAM y en la base para toda la instancia), así
    // que se limita por cuenta.
    if (rejectRateLimited(res, storyLimiter, req.authUser.id, 15, 'historias por minuto')) return;
    // El fondo de la historia es un color CSS: se valida aquí como
    // en /story/edit, para que no se pueda inyectar url(...) en el
    // cliente de cada víctima.
    if (data.bg !== undefined && data.bg !== '' && (typeof data.bg !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.bg)))
        return json(res, 400, { error: 'Color inválido.' });
    const s = {
        from: data.from, kind: data.kind, text: data.text || '', bg: data.bg || '#f07a6b',
        mime: validMime(data.mime) ? data.mime.slice(0, 120) : '', data: data.hash ? '' : data.data || '',
        hash: typeof data.hash === 'string' ? data.hash.toLowerCase() : '',
        ts: Date.now(), enc: typeof data.enc === 'string' && data.enc === 'e2' ? 'e2' : '',
        keys: Array.isArray(data.keys) ? data.keys.filter(k => k && typeof k.to === 'string' && typeof k.iv === 'string' && k.iv.length <= 512 && typeof k.ct === 'string' && k.ct.length <= 16384).slice(-200) : [],
        viewers: [], likes: []
    };
    if (typeof s.text !== 'string' || characterCount(s.text, MESSAGE_LIMITS.storyCharacters) > MESSAGE_LIMITS.storyCharacters)
        return json(res, 400, { error: `Las historias admiten hasta ${MESSAGE_LIMITS.storyCharacters} caracteres de texto.` });
    if (!validStoryMedia(s.data))
        return json(res, 400, { error: 'Historia inválida: el medio debe ir como hash o como data-URL de imagen/vídeo/audio.' });
    if (data.hash && !blobHashOk(s.hash)) return json(res, 400, { error: 'Hash inválido.' });
    if (s.hash && !data.data && !blobAvailableTo(req.authUser, s.hash)) return json(res, 400, { error: 'Archivo no disponible.' });
    /* Cuota antes de escribir, y escritura solo cuando la historia ya está
       aceptada: así un rechazo (límite de frecuencia, fondo inválido) no deja
       un adjunto huérfano en disco. */
    const bytesHistoria = s.data ? Buffer.byteLength(s.data) : 0;
    if (bytesHistoria > 0 && !blobQuotaOk(req.authUser.id, bytesHistoria))
        return json(res, 413, { error: 'Has alcanzado el límite de almacenamiento de adjuntos.' });
    if (s.hash && data.data && !storeBlob(s.hash, data.data)) return json(res, 400, { error: 'Archivo inválido.' });
    const fromUser = byName(s.from);
    if (fromUser) {
        const storyId = `story:${fromUser.id}:${s.ts}`;
        const replacedHashes = db.transaction(() => {
            const hashes = removeBlobAccess('message_id = ?', storyId);
            Stmt.insertStory.run(fromUser.id, s.ts, encryptForUser(fromUser.id, JSON.stringify({
                kind: s.kind, text: s.text, bg: s.bg, mime: s.mime, data: s.data,
                enc: s.enc, keys: s.keys, viewers: [], likes: []
            })), s.hash || null);
            if (s.hash) Stmt.insertBlobAccessStory.run(s.hash.toLowerCase(), storyId, 'story', fromUser.id);
            return hashes;
        })();
        pruneBlobHashes(replacedHashes); invalidateBlobQuota(req.authUser.id);
    }
    stories.push(s);
    pushStories();
    return json(res, 200, { ok: true });
}

function postStoryLike(req, res, url, data, actor) {
    /* Ver o marcar "me gusta" consulta la fila completa de la historia y, si
       cambia algo, la reescribe entera. Con historias grandes eso es caro, así
       que lleva su propio freno por cuenta. */
    if (!storyViewLimiter.consume(req.authUser.id).allowed)
        return softFail ? json(res, 200, { ok: false }) : json(res, 429, { error: 'Demasiadas consultas de historias. Espera un momento.' });
    const row = Stmt.getStory.get(accountId(data.from), data.ts);
    // Respuesta uniforme en like/view: el 404 distinguiría "no
    // existe" de "no me la dejan ver" y serviría de oráculo de
    // existencia de historias ajenas.
    const softFail = url.pathname === '/story/like' || url.pathname === '/story/view';
    if (!row && url.pathname !== '/story/delete')
        return softFail ? json(res, 200, { ok: false }) : json(res, 404, { ok: false });
    const inMemory = stories.find(s => s.from === data.from && s.ts === data.ts);
    if (url.pathname === '/story/delete') {
        setStories(stories.filter(s => !(s.from === data.from && s.ts === data.ts)));
        const storyUser = accountId(data.from);
        const storyId = `story:${storyUser}:${data.ts}`;
        const removedHashes = db.transaction(() => {
            const hashes = removeBlobAccess("kind = 'story' AND story_user = ? AND message_id = ?", storyUser, storyId);
            Stmt.deleteStory.run(storyUser, data.ts);
            return hashes;
        })();
        pruneBlobHashes(removedHashes); invalidateBlobQuota(req.authUser.id);
        pushStories();
        return json(res, 200, { ok: true });
    }
    if (!inMemory) return softFail ? json(res, 200, { ok: false }) : json(res, 404, { ok: false });
    if (url.pathname === '/story/like') {
        if (!data.viewer || data.viewer === inMemory.from || !permite(profiles[inMemory.from], 'historias', data.viewer)) return json(res, 200, { ok: false });
        inMemory.likes = inMemory.likes || [];
        const i = inMemory.likes.indexOf(data.viewer);
        const liked = i < 0;
        if (liked) inMemory.likes.push(data.viewer); else inMemory.likes.splice(i, 1);
        // Techo: likes/viewers se reescriben enteros por evento.
        if (inMemory.likes.length > 1000) inMemory.likes = inMemory.likes.slice(-1000);
        Stmt.updateStoryData.run(encryptForUser(accountId(inMemory.from), JSON.stringify({
            kind: inMemory.kind, text: inMemory.text, bg: inMemory.bg, mime: inMemory.mime,
            data: inMemory.data, enc: inMemory.enc, keys: inMemory.keys,
            viewers: inMemory.viewers, likes: inMemory.likes
        })), accountId(inMemory.from), inMemory.ts);
        pushStories();
        return json(res, 200, { ok: true, liked, count: inMemory.likes.length });
    }
    if (url.pathname === '/story/view') {
        if (data.viewer && data.viewer !== inMemory.from && permite(profiles[inMemory.from], 'historias', data.viewer)) {
            inMemory.viewers = inMemory.viewers || [];
            if (!inMemory.viewers.includes(data.viewer)) {
                inMemory.viewers.push(data.viewer);
                // Techo de viewers.
                if (inMemory.viewers.length > 1000) inMemory.viewers = inMemory.viewers.slice(-1000);
                Stmt.updateStoryData.run(encryptForUser(accountId(inMemory.from), JSON.stringify({
                    kind: inMemory.kind, text: inMemory.text, bg: inMemory.bg, mime: inMemory.mime,
                    data: inMemory.data, enc: inMemory.enc, keys: inMemory.keys,
                    viewers: inMemory.viewers, likes: inMemory.likes
                })), accountId(inMemory.from), inMemory.ts);
                pushStories();
            }
        }
        return json(res, 200, { ok: true });
    }
    if (url.pathname === '/story/edit') {
        if (inMemory.kind !== 'text') return json(res, 404, { error: 'No es texto.' });
        if (typeof data.text !== 'string' || characterCount(data.text, MESSAGE_LIMITS.storyCharacters) > MESSAGE_LIMITS.storyCharacters)
            return json(res, 400, { error: `Las historias admiten hasta ${MESSAGE_LIMITS.storyCharacters} caracteres.` });
        if (data.bg !== undefined && (typeof data.bg !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.bg))) return json(res, 400, { error: 'Color inválido.' });
        inMemory.text = data.text;
        if (data.bg !== undefined) inMemory.bg = data.bg;
        inMemory.edited = true;
        Stmt.updateStoryData.run(encryptForUser(accountId(inMemory.from), JSON.stringify({
            kind: inMemory.kind, text: inMemory.text, bg: inMemory.bg, mime: inMemory.mime,
            data: inMemory.data, enc: inMemory.enc, keys: inMemory.keys,
            viewers: inMemory.viewers, likes: inMemory.likes
        })), accountId(inMemory.from), inMemory.ts);
        pushStories();
        return json(res, 200, { ok: true });
    }
}

module.exports = {
    getStories,
    postStory,
    postStoryLike,
};

/**
 * Rutas HTTP de stickers.
 *
 * Proxy de búsqueda de stickers en Giphy y gestión de los stickers favoritos
 * de la cuenta. El proxy consume la clave del operador, así que exige sesión
 * y tiene límite por cuenta; los favoritos se validan antes de guardarse.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const { sessionUser } = require('../auth/sessions.js');
const { GIPHY_API_KEY } = require('../config.js');
const { blobAvailableTo, blobQuotaOk, invalidateBlobQuota, readBlob, storeBlob } = require('../chat/media.js');
const { rejectRateLimited } = require('../http/helpers.js');
const { giphyLimiter, stickerCreateLimiter } = require('../http/rate-limit.js');
const { json, securityHeaders } = require('../http/responses.js');
const { localStickerHash, validStickerData } = require('../shared/validation.js');
const { uniq } = require('../users/helpers.js');
const { saveStickers } = require('../users/store.js');
const { Stmt } = require('../db/statements.js');

const MAX_STICKER_BYTES = 8 * 1024 * 1024;
const STICKER_DATA_RE = /^data:(image\/(?:webp|gif));base64,([a-z0-9+/]+={0,2})$/i;

function stickerDimensions(mime, bytes) {
    if (mime === 'image/gif') {
        if (bytes.length < 20 || !/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) ||
            bytes[bytes.length - 1] !== 0x3b || bytes.indexOf(0x2c, 10) < 0) return null;
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > bytes.length - start) return null;
        if (type === 'VP8X' && size >= 10) {
            return {
                width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16),
                height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16)
            };
        }
        if (type === 'VP8 ' && size >= 10 && bytes[start + 3] === 0x9d &&
            bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
            return {
                width: bytes.readUInt16LE(start + 6) & 0x3fff,
                height: bytes.readUInt16LE(start + 8) & 0x3fff
            };
        }
        if (type === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
            return {
                width: 1 + (((bytes[start + 2] & 0x3f) << 8) | bytes[start + 1]),
                height: 1 + (((bytes[start + 4] & 0x0f) << 10) |
                    (bytes[start + 3] << 2) | ((bytes[start + 2] & 0xc0) >> 6))
            };
        }
        offset = start + size + (size & 1);
    }
    return null;
}

function parseStickerUpload(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > (MAX_STICKER_BYTES * 4 / 3) + 64) return null;
    const match = STICKER_DATA_RE.exec(dataUrl);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > MAX_STICKER_BYTES || bytes.toString('base64') !== match[2]) return null;
    const dimensions = stickerDimensions(mime, bytes);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1 ||
        dimensions.width !== dimensions.height || dimensions.width > 512) return null;
    return { mime, bytes };
}

function stickerTags(value) {
    if (!Array.isArray(value) || value.length > 8) return null;
    const tags = [];
    for (const item of value) {
        if (typeof item !== 'string') return null;
        const tag = item.trim().normalize('NFC').replace(/^#/, '').toLowerCase();
        if (!/^[\p{L}\p{N}_-]{1,24}$/u.test(tag)) return null;
        if (!tags.includes(tag)) tags.push(tag);
    }
    return tags;
}

function getStickerDiscover(req, res, url) {
    if (rejectRateLimited(res, giphyLimiter, req.authUser.id, 30, 'búsquedas de stickers por minuto')) return;
    const limitParam = url.searchParams.get('limit') || '24';
    const offsetParam = url.searchParams.get('offset') || '0';
    if (!/^\d{1,3}$/.test(limitParam) || !/^\d{1,6}$/.test(offsetParam))
        return json(res, 400, { error: 'Paginación inválida.' });
    const limit = Math.min(48, Math.max(1, Number(limitParam)));
    const offset = Number(offsetParam);
    if (offset > 100000) return json(res, 400, { error: 'Paginación inválida.' });
    const rawTags = url.searchParams.get('tags');
    let tags = [];
    if (rawTags) {
        tags = stickerTags(rawTags.split(','));
        if (!tags || !tags.length) return json(res, 400, { error: 'Etiquetas inválidas.' });
    }
    const defaultStickers = Stmt.listDefaultStickers.all()
        .map(row => ({ ...row, tags: row.tags.split(',') }))
        .filter(row => !tags.length || tags.every(tag => row.tags.includes(tag)));
    const defaultPage = defaultStickers.slice(offset, offset + limit + 1);
    const publicOffset = Math.max(0, offset - defaultStickers.length);
    const publicLimit = Math.max(0, limit + 1 - defaultPage.length);
    const publicRows = publicLimit === 0 ? [] : tags.length
        ? Stmt.searchPublicStickersByTags.all(JSON.stringify(tags), tags.length, publicLimit, publicOffset)
        : Stmt.listPublicStickers.all(publicLimit, publicOffset);
    const rows = [...defaultPage, ...publicRows];
    const hasMore = rows.length > limit;
    const stickers = rows.slice(0, limit).map(row => ({
        sticker: row.sticker || `/stickers/blob/${row.hash}`,
        tags: Array.isArray(row.tags) ? row.tags : row.tags ? row.tags.split(',') : [],
        createdAt: row.created_at || 0,
        ...(row.expression ? { expression: row.expression, label: row.label } : {})
    }));
    return json(res, 200, { stickers, hasMore });
}

async function getGiphySearch(req, res, url, data, actor) {
    // Este proxy usa la GIPHY_API_KEY del operador: exige sesión y tiene
    // límite por cuenta, para que cualquiera en la red no consuma la
    // cuota del operador.
    const giphyUser = sessionUser(req);
    if (!giphyUser) return json(res, 401, { error: 'authentication required' });
    if (rejectRateLimited(res, giphyLimiter, giphyUser.id, 30, 'búsquedas de stickers por minuto')) return;
    if (!GIPHY_API_KEY) return json(res, 503, { error: 'Strickers de Giphy no configurados.' });
    const offset = url.searchParams.get('offset');
    const limit = url.searchParams.get('limit');
    const query = url.searchParams.get('q');
    if (query !== null && query.length > 100) return json(res, 400, { error: 'Búsqueda demasiado larga.' });
    const params = new URLSearchParams({ api_key: GIPHY_API_KEY, rating: 'pg' });
    if (offset !== null && /^\d{1,4}$/.test(offset)) params.set('offset', offset);
    if (limit !== null && /^\d{1,3}$/.test(limit)) params.set('limit', limit);
    if (query) params.set('q', query);
    const endpoint = query ? 'https://api.giphy.com/v1/gifs/search' : 'https://api.giphy.com/v1/gifs/trending';
    (async () => {
    try {
    const upstream = await fetch(`${endpoint}?${params}`);
    const body = await upstream.text();
    res.writeHead(upstream.ok ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders });
    res.end(body);
    } catch { json(res, 502, { error: 'Giphy no disponible.' }); }
    })();
    return;
}

function getStickers(req, res, url, data, actor) {
    return json(res, 200, { stickers: req.authUser.stickers || [] });
}

function getStickerBlob(req, res, url) {
    const match = url.pathname.match(/^\/stickers\/blob\/([a-f0-9]{64})$/i);
    if (!match) return json(res, 404, {});
    const hash = match[1].toLowerCase();
    if (!blobAvailableTo(req.authUser, hash)) return json(res, 404, {});
    const dataUrl = readBlob(hash);
    const parsed = parseStickerUpload(dataUrl);
    if (!parsed) return json(res, 404, {});
    res.writeHead(200, {
        'Content-Type': parsed.mime,
        'Content-Length': parsed.bytes.length,
        'Cache-Control': 'private, no-store',
        'ETag': '"' + hash + '"',
        ...securityHeaders
    });
    return res.end(parsed.bytes);
}

function postCreateSticker(req, res, url, data) {
    if (rejectRateLimited(res, stickerCreateLimiter, req.authUser.id, 10, 'stickers creados por minuto')) return;
    const parsed = parseStickerUpload(data.data);
    if (!parsed) return json(res, 400, { error: 'El stricker debe ser WebP o GIF, cuadrado de hasta 512 × 512 y no superar 8 MB.' });
    const hash = crypto.createHash('sha256').update(parsed.bytes).digest('hex');
    if (typeof data.hash === 'string' && data.hash.toLowerCase() !== hash)
        return json(res, 400, { error: 'El hash del stricker no coincide con su contenido.' });
    const publish = data.publish === true;
    const tags = publish ? stickerTags(data.tags) : [];
    if (publish && (!tags || !tags.length))
        return json(res, 400, { error: 'Añade al menos una etiqueta para publicar en Zlapy.' });
    const exists = !!Stmt.hasBlob.get(hash);
    const alreadyCounted = blobAvailableTo(req.authUser, hash);
    if (!alreadyCounted && !blobQuotaOk(req.authUser.id, Buffer.byteLength(data.data)))
        return json(res, 413, { error: 'Has alcanzado el límite de almacenamiento de adjuntos.' });
    if (!storeBlob(hash, data.data)) return json(res, 400, { error: 'No se pudo validar el stricker.' });
    if (!exists) invalidateBlobQuota(req.authUser.id);

    const sticker = `/stickers/blob/${hash}`;
    req.authUser.stickers = uniq([...(req.authUser.stickers || []), sticker]).slice(-30);
    saveStickers(req.authUser);
    let published = false;
    if (publish) {
        const inserted = Stmt.insertPublicSticker.run(hash, req.authUser.id, Date.now()).changes > 0;
        for (const tag of tags) Stmt.insertPublicStickerTag.run(hash, tag);
        published = inserted || !!Stmt.getPublicSticker.get(hash);
    }
    return json(res, 201, { ok: true, hash, sticker, stickers: req.authUser.stickers, published });
}

function postStickers(req, res, url, data, actor) {
    if (!Array.isArray(data.stickers)) return json(res, 400, { error: 'stickers must be an array' });
    // Un solo validador: evita guardar valores con comillas que
    // cualquier sink futuro sin escapar podría inyectar.
    const favorites = uniq(data.stickers.filter(v => validStickerData(v) &&
        (!localStickerHash(v) || blobAvailableTo(req.authUser, localStickerHash(v))))).slice(-30);
    req.authUser.stickers = favorites; saveStickers(req.authUser);
    return json(res, 200, { ok: true, stickers: favorites });
}


module.exports = {
    getGiphySearch,
    getStickerDiscover,
    getStickers,
    getStickerBlob,
    postCreateSticker,
    postStickers,
};

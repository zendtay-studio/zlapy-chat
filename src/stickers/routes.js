/**
 * Rutas HTTP de stickers.
 *
 * Proxy de búsqueda de stickers en Giphy y gestión de los stickers favoritos
 * de la cuenta. El proxy consume la clave del operador, así que exige sesión
 * y tiene límite por cuenta; los favoritos se validan antes de guardarse.
 */
'use strict';

const https = require('https');
const { sessionUser } = require('../auth/sessions.js');
const { GIPHY_API_KEY } = require('../config.js');
const { rejectRateLimited } = require('../http/helpers.js');
const { giphyLimiter } = require('../http/rate-limit.js');
const { json, securityHeaders } = require('../http/responses.js');
const { validStickerData } = require('../shared/validation.js');
const { uniq } = require('../users/helpers.js');
const { saveStickers } = require('../users/store.js');

async function getGiphySearch(req, res, url, data, actor) {
    // Este proxy usa la GIPHY_API_KEY del operador: exige sesión y tiene
    // límite por cuenta, para que cualquiera en la red no consuma la
    // cuota del operador.
    const giphyUser = sessionUser(req);
    if (!giphyUser) return json(res, 401, { error: 'authentication required' });
    if (rejectRateLimited(res, giphyLimiter, giphyUser.id, 30, 'búsquedas de stickers por minuto')) return;
    if (!GIPHY_API_KEY) return json(res, 503, { error: 'Stickers no configurados.' });
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

function postStickers(req, res, url, data, actor) {
    if (!Array.isArray(data.stickers)) return json(res, 400, { error: 'stickers must be an array' });
    // Un solo validador: evita guardar valores con comillas que
    // cualquier sink futuro sin escapar podría inyectar.
    const favorites = uniq(data.stickers.filter(v => validStickerData(v))).slice(-30);
    req.authUser.stickers = favorites; saveStickers(req.authUser);
    return json(res, 200, { ok: true, stickers: favorites });
}


module.exports = {
    getGiphySearch,
    getStickers,
    postStickers,
};

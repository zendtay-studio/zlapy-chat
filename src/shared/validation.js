/**
 * Validación de entradas.
 *
 * Centraliza las comprobaciones de los datos que llegan del cliente: nombres
 * de usuario, avatares y medios, stickers, MIME, identificadores de mensaje
 * y endpoints de push (con allowlist de hosts, contra SSRF).
 */
'use strict';

const https = require('https');
const { CONFIG } = require('../config.js');

const USERNAME_RE = /^[a-z0-9_.-]{3,24}$/;
// Nombres reservados: registrar "__proto__" permitiría contaminar los mapas
// profiles/notesMap y leer o pisar datos de otras cuentas.
const RESERVED_USERNAMES = new Set(['__proto__', 'constructor', 'prototype']);
const validUsername = v => typeof v === 'string' && USERNAME_RE.test(v) && !RESERVED_USERNAMES.has(v);

/* ---- Validación de contenido multimedia ----
 * Avatares, historias y stickers terminan interpolados en el HTML del cliente,
 * así que el servidor solo acepta lo que sabe renderizar: data-URLs de medios
 * base64, el SVG propio (/avatar/...) y URLs https de sticker con charset
 * restringido. Nada de HTML/JS crudo.
 */
const DATA_URL_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/;
const DATA_URL_MEDIA_RE = /^data:(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(mpeg|mp3|mp4|ogg|wav|webm));base64,[A-Za-z0-9+/=]+$/;
const validAvatar = v => typeof v === 'string' && v.length <= 2_000_000 &&
    (v === '' || DATA_URL_IMAGE_RE.test(v) || /^\/avatar\/[a-z0-9_.-]{3,36}\.svg$/i.test(v));
const validStoryMedia = v => typeof v === 'string' && v.length <= CONFIG.maxGalleryEncodedChars && (v === '' || DATA_URL_MEDIA_RE.test(v));
/* ---- Stickers: allowlist de hosts ----
   Un sticker remoto lo elige el remitente: sin lista de hosts, el navegador de
   la víctima haría una petición a un host arbitrario (fuga de IP/UA y
   confirmación de que estaba en línea). Solo se admiten los CDN de GIPHY. */
const STICKER_ALLOWED_HOSTS = /^(?:media\d*\.giphy\.com|i\.giphy\.com)$/i;
const validStickerData = v => {
    if (typeof v !== 'string' || v.length > 2048) return false;
    if (!/^https:\/\/[a-zA-Z0-9.-]+\/[^\s"'<>\\]*$/i.test(v)) return false;
    let url;
    try { url = new URL(v); } catch { return false; }
    return STICKER_ALLOWED_HOSTS.test(url.hostname);
};
// Tipos MIME con parámetros (audio/webm;codecs=opus) pero sin comillas
// ni ángulos; los sinks del cliente ya escapan, esto es higiene de servidor.
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]+(;\s*[a-z0-9.=-]+\s*)?$/i;
const validMime = v => typeof v === 'string' && v.length <= 120 && MIME_RE.test(v);
const validMessageId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const clampStr = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';

/* ---- Allowlist de endpoints push (anti-SSRF) ---- */
const PUSH_ALLOWED_HOSTS = new Set([
    'fcm.googleapis.com',                    // Chrome/Android
    'updates.push.services.mozilla.com',    // Firefox
    'web.push.apple.com',                   // Safari
    'push.samsungmax.com'                    // Samsung
]);
const validPushEndpoint = raw => {
    if (typeof raw !== 'string' || !raw || raw.length > 2048) return false;
    let endpoint;
    try { endpoint = new URL(raw); } catch { return false; }
    if (endpoint.protocol !== 'https:') return false;
    // Normalizar el punto final (FQDN absoluta) antes de comparar.
    const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
    return PUSH_ALLOWED_HOSTS.has(host) ||
        host.endsWith('.notify.windows.com') ||  // Windows/Edge
        host.endsWith('.push.apple.com');
};

/* IP real del cliente: tras el túnel todo llega desde loopback, y solo en ese
 * caso se confía en la cabecera que añade el propio proxy (CF-Connecting-IP).
 * Un cliente de la LAN no puede falsearla porque no llega por 127.0.0.1. */
const clientIp = req => {
    const remote = req.socket.remoteAddress || 'unknown';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (isLoopback && typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip'])
        return req.headers['cf-connecting-ip'];
    return remote;
};
const NOTE_TTL = CONFIG.noteTtlMs;

module.exports = {
    USERNAME_RE,
    RESERVED_USERNAMES,
    validUsername,
    DATA_URL_IMAGE_RE,
    DATA_URL_MEDIA_RE,
    validAvatar,
    validStoryMedia,
    STICKER_ALLOWED_HOSTS,
    validStickerData,
    MIME_RE,
    validMime,
    validMessageId,
    clampStr,
    PUSH_ALLOWED_HOSTS,
    validPushEndpoint,
    clientIp,
    NOTE_TTL,
};

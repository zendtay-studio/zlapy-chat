/**
 * Notificaciones push.
 *
 * Genera y guarda la clave VAPID, firma las notificaciones con ella y las
 * entrega cifradas a los servicios de push de cada dispositivo suscrito.
 */
'use strict';

const crypto = require('crypto');
const { decryptAtRest, encryptAtRest } = require('../crypto/setup.js');
const { decField, encField } = require('../crypto/field-crypto.js');
const { Stmt } = require('../db/statements.js');
const { push } = require('../realtime/notify.js');
const { validPushEndpoint } = require('../shared/validation.js');
const { profiles, pushSubs } = require('../state.js');
const { accountId, parseJsonSafe } = require('../users/helpers.js');

// Push web
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uDec = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const vapidRecord = Stmt.getMeta.get('vapid');
// La clave privada VAPID se guarda cifrada en reposo: quien la obtenga
// podría firmar notificaciones push falsas para todos los dispositivos
// suscritos.
let VAPID = vapidRecord ? parseJsonSafe(decryptAtRest(vapidRecord.value) || '') : null;
if (!VAPID) {
    const gen = crypto.createECDH('prime256v1'); gen.generateKeys();
    const pubKey = gen.getPublicKey(), prv = gen.getPrivateKey();
    VAPID = { publicKey: b64u(pubKey), jwk: { kty: 'EC', crv: 'P-256', x: b64u(pubKey.slice(1, 33)), y: b64u(pubKey.slice(33, 65)), d: b64u(prv) } };
    Stmt.setMeta.run('vapid', encryptAtRest(JSON.stringify(VAPID)));
} else if (vapidRecord.value && !vapidRecord.value.startsWith('PCE1:') && !vapidRecord.value.startsWith('PCE1v2:')) {
    // Un registro sin cifrar se re-cifra al vuelo, sin migración previa
    // (PCE1v2 es el sobre actual; PCE1 el heredado: ambos cuentan como
    // ya cifrados, y re-cifrar un sobre cifrado crearía el fallo de
    // cifrado doble en la clave VAPID).
    Stmt.setMeta.run('vapid', encryptAtRest(JSON.stringify(VAPID)));
}
const hkdfExtract = (salt, ikm) => crypto.createHmac('sha256', salt).update(ikm).digest();
function hkdfExpand(prk, info, len) {
    const out = []; let prev = Buffer.alloc(0), i = 0;
    while (Buffer.concat(out).length < len) { i++; prev = crypto.createHmac('sha256', prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest(); out.push(prev); }
    return Buffer.concat(out).slice(0, len);
}
function vapidAuth(endpoint) {
    const aud = new URL(endpoint).origin;
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: 'mailto:admin@localhost' }));
    const key = crypto.createPrivateKey({ key: VAPID.jwk, format: 'jwk' });
    const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${VAPID.publicKey}`;
}
/* Registro de los últimos envíos push (éxitos incluidos): sin él, un
   «aceptado por el servicio (201)» y un «ni se intentó» eran
   indistinguibles desde Ajustes. Consultable desde /push/test (campo
   recent). */
const pushLog = [];
const PUSH_LOG_MAX = 200;
function logPushSend(username, sub, result, ms) {
    let host = '';
    try { host = new URL(sub.endpoint).host; } catch { host = '(endpoint inválido)'; }
    pushLog.push({ ts: Date.now(), user: username, host, status: result.status, error: result.error || '', ms });
    console.info('[push] %s → %s %s%s (%d ms)', username, host, result.status, result.error ? ' · ' + String(result.error).slice(0, 120) : '', ms);
    if (pushLog.length > PUSH_LOG_MAX) pushLog.shift();
}
const recentPushLog = () => pushLog.slice(-20).reverse();

async function pushTo(sub, payloadObj) {
    try {
        if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('incompleta');
        // Defensa en profundidad: aunque exista una suscripción vieja con un
        // endpoint arbitrario, desde aquí no se envía nada fuera de la
        // allowlist (protege también frente a DNS rebinding).
        if (!validPushEndpoint(sub.endpoint)) throw new Error('endpoint no permitido');
        const payload = Buffer.from(JSON.stringify(payloadObj));
        const salt = crypto.randomBytes(16);
        const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
        const receiverPublicKey = b64uDec(sub.keys.p256dh);
        const senderPublicKey = ecdh.getPublicKey();
        const shared = ecdh.computeSecret(receiverPublicKey);
        const authPrk = hkdfExtract(b64uDec(sub.keys.auth), shared);
        const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublicKey, senderPublicKey]);
        const ikm = hkdfExpand(authPrk, keyInfo, 32);
        const prk = hkdfExtract(salt, ikm);
        const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
        const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0'), 12);
        const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
        const record = Buffer.concat([Buffer.from([2]), payload]);
        const encrypted = Buffer.concat([c.update(record), c.final(), c.getAuthTag()]);
        const header = Buffer.alloc(21);
        salt.copy(header, 0);
        header.writeUInt32BE(4096, 16);
        header[20] = senderPublicKey.length;
        const body = Buffer.concat([header, senderPublicKey, encrypted]);
        const r = await fetch(sub.endpoint, {
            method: 'POST',
            /* TTL 3600: si el dispositivo duerme o queda offline, el push
               service guarda el mensaje en cola SOLO hasta que expira el TTL
               y después lo descarta sin avisar a nadie. Con 300 (5 min) un
               móvil dormido más de eso perdía el aviso aunque el envío
               hubiera salido aceptado con 201. */
            headers: { 'TTL': '3600', 'Content-Encoding': 'aes128gcm', 'Urgency': 'high', 'Authorization': vapidAuth(sub.endpoint), 'Content-Type': 'application/octet-stream' },
            body
        });
        const responseBody = r.ok ? '' : (await r.text()).slice(0, 300);
        return { status: r.status, error: responseBody || undefined };
    } catch (e) { return { status: 0, error: e && e.message ? e.message : String(e) }; }
}

/**
 * Busca la fila de una suscripción por su endpoint.
 *
 * El endpoint (URL con el token del push) va cifrado y el cifrado no es
 * determinista, así que no se puede consultar por SQL: se recorre las
 * suscripciones de la cuenta, se descifran y se comparan.
 *
 * @param {string} userId
 * @param {string} endpoint
 * @returns {{rowid: number, endpoint: string, data: string}|null}
 */
function findPushSubRow(userId, endpoint) {
    if (!userId || typeof endpoint !== 'string' || !endpoint) return null;
    for (const row of Stmt.listPushSubsByUser.all(userId))
        if (decField('push_subs.endpoint', row.endpoint) === endpoint) return row;
    return null;
}

async function notifyUser(username, payload) {
    const id = accountId(username);
    const subs = pushSubs.get(id) || [];
    if (!subs.length) return [];
    const results = [];
    for (const sub of [...subs]) {
        const t0 = Date.now();
        const result = await pushTo(sub, payload);
        logPushSend(username, sub, result, Date.now() - t0);
        results.push(result);
        /* 404/410: la suscripción ya no existe (des-suscrita o expirada).
           403 «the VAPID credentials … do not correspond»: la suscripción se
           creó con OTRA clave VAPID (la del servidor cambió, p. ej. al
           restaurar la base) y el servicio la rechazará SIEMPRE: los avisos
           no llegarían nunca con la app cerrada y la zombi quedaría
           silenciosa para siempre. Se elimina para que el dispositivo
           re-suscriba con la clave actual (el cliente detecta el
           desajuste de clave al arrancar y re-suscribe solo). */
        const rechazoClave = result.status === 403 && /vapid|credential|authoriz/i.test(result.error || '');
        if (result.status === 404 || result.status === 410 || rechazoClave) {
            const row = findPushSubRow(id, sub.endpoint);
            if (row) Stmt.deletePushSubByRowid.run(row.rowid);
            pushSubs.set(id, (pushSubs.get(id) || []).filter(s => s.endpoint !== sub.endpoint));
            if (rechazoClave)
                console.warn(`[push] suscripción eliminada (${sub.endpoint.slice(0, 48)}…): el servicio de push la rechaza porque fue creada con otra clave VAPID; el dispositivo re-suscribirá con la clave actual al cargar la app o activar el interruptor`);
        }
    }
    // Las notificaciones que no llegan no deben ser invisibles.
    const failed = results.filter(r => !r.status || r.status >= 400);
    if (failed.length)
        console.warn(`[push] ${failed.length}/${results.length} notificaciones fallidas para ${username}: ${failed[0].error || failed[0].status}`);
    return results;
}
const pushNameOf = u => (profiles[u] && profiles[u].name) || u;

/* URL del icono (foto de perfil) para las notificaciones. El servicio de
   push descarga la imagen SIN cookies de sesión, así que no puede usar la
   ruta normal: esta variante es pública (identicon por usuario, sin
   presencia ni datos) y el backend la sirve con caché corta. */
const avatarPushUrl = username => '/avatar/push/' + encodeURIComponent(username) + '.svg';

/* Cuerpo de la notificación: el TEXTO del mensaje (o el tipo de adjunto si
   no hay texto). Antes los avisos decían «Tienes un mensaje» y había que
   abrir la app para saber de qué hablaban. */
const PUSH_PREVIEW_KINDS = {
    image: 'Foto',
    video: 'Video',
    audio: 'Nota de voz',
    sticker: 'Stricker',
    contact: 'Contacto',
    poll: 'Encuesta',
    file: 'Archivo',
    'group-invite': 'Invitación a grupo'
};
function pushBody(kind, data, caption) {
    const texto = String(data == null ? '' : data).replace(/\s+/g, ' ').trim();
    if (texto) return texto.slice(0, 140);
    const pie = String(caption == null ? '' : caption).replace(/\s+/g, ' ').trim();
    if (pie) return `${PUSH_PREVIEW_KINDS[kind] || 'Mensaje'}: ${pie.slice(0, 120)}`;
    return PUSH_PREVIEW_KINDS[kind] || 'Mensaje nuevo';
}


module.exports = {
    b64u,
    b64uDec,
    vapidRecord,
    VAPID,
    hkdfExtract,
    hkdfExpand,
    vapidAuth,
    pushTo,
    notifyUser,
    recentPushLog,
    findPushSubRow,
    avatarPushUrl,
    pushBody,
    pushNameOf,
};

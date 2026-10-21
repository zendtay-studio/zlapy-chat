/**
 * Notificaciones push.
 *
 * Genera y guarda la clave VAPID, firma las notificaciones con ella y las
 * entrega cifradas a los servicios de push de cada dispositivo suscrito.
 */
'use strict';

const crypto = require('crypto');
const { decryptAtRest, encryptAtRest } = require('../crypto/setup.js');
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
} else if (vapidRecord.value && !vapidRecord.value.startsWith('PCE1:')) {
    // Un registro sin cifrar se re-cifra al vuelo, sin migración previa.
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
            headers: { 'TTL': '300', 'Content-Encoding': 'aes128gcm', 'Urgency': 'high', 'Authorization': vapidAuth(sub.endpoint), 'Content-Type': 'application/octet-stream' },
            body
        });
        const responseBody = r.ok ? '' : (await r.text()).slice(0, 300);
        return { status: r.status, error: responseBody || undefined };
    } catch (e) { return { status: 0, error: e && e.message ? e.message : String(e) }; }
}

async function notifyUser(username, payload) {
    const id = accountId(username);
    const subs = pushSubs.get(id) || [];
    if (!subs.length) return [];
    const results = [];
    for (const sub of [...subs]) {
        const result = await pushTo(sub, payload);
        results.push(result);
        if (result.status === 404 || result.status === 410) {
            Stmt.deletePushSub.run(id, sub.endpoint);
            pushSubs.set(id, (pushSubs.get(id) || []).filter(s => s.endpoint !== sub.endpoint));
        }
    }
    // Las notificaciones que no llegan no deben ser invisibles.
    const failed = results.filter(r => !r.status || r.status >= 400);
    if (failed.length)
        console.warn(`[push] ${failed.length}/${results.length} notificaciones fallidas para ${username}: ${failed[0].error || failed[0].status}`);
    return results;
}
const pushNameOf = u => (profiles[u] && profiles[u].name) || u;


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
    pushNameOf,
};

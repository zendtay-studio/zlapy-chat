/**
 * Cifrado del canal para el cliente.
 *
 * Implementa, en JavaScript puro, el mismo sobre que usa el servidor
 * (X25519 + HKDF-SHA256 + ChaCha20 con HMAC-SHA256). Va en JS puro a propósito: la
 * WebCrypto del navegador (`crypto.subtle`) solo está disponible en contextos
 * seguros, es decir, con HTTPS o en `localhost`. Como el objetivo es proteger
 * justamente el caso de HTTP plano en la red local, aquí no se puede depender
 * de ella.
 *
 * La implementación se valida contra el `crypto` de Node en las pruebas
 * (test/transport.test.js): lo que cifra el navegador lo descifra el servidor
 * y al revés.
 *
 * Uso:
 *   const sobre = await ZlapyTransport.encrypt('POST', '/send', { texto: 'hola' });
 *   fetch('/send', { method: 'POST', headers: sobre.headers, body: sobre.body });
 */
'use strict';

(function (global) {
    const ALGO = 'x25519-chacha20-hmac-v1';
    const SESSION_INFO = 'zlapy-transport-v1/session';
    const EPHEMERAL_BYTES = 32;
    const NONCE_BYTES = 12;
    const MAC_BYTES = 32;   // HMAC-SHA256

    // SHA-256
    const K256 = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    function sha256(bytes) {
        const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        const len = bytes.length;
        const withPad = new Uint8Array(((len + 9 + 63) >> 6) << 6);
        withPad.set(bytes);
        withPad[len] = 0x80;
        const view = new DataView(withPad.buffer);
        view.setUint32(withPad.length - 8, Math.floor(len / 0x20000000));
        view.setUint32(withPad.length - 4, (len << 3) >>> 0);
        const w = new Uint32Array(64);
        for (let off = 0; off < withPad.length; off += 64) {
            for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
            for (let i = 16; i < 64; i++) {
                const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
                const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
            }
            let [a, b, c, d, e, f, g, hh] = h;
            for (let i = 0; i < 64; i++) {
                const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
                const ch = ((e & f) ^ (~e & g)) >>> 0;
                const t1 = (hh + S1 + ch + K256[i] + w[i]) >>> 0;
                const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
                const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
                const t2 = (S0 + maj) >>> 0;
                hh = g; g = f; f = e; e = (d + t1) >>> 0;
                d = c; c = b; b = a; a = (t1 + t2) >>> 0;
            }
            h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
            h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
        }
        const out = new Uint8Array(32);
        const ov = new DataView(out.buffer);
        for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
        return out;
    }

    function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

    // HMAC-SHA256 y HKDF
    function hmacSha256(key, msg) {
        let k = key;
        if (k.length > 64) k = sha256(k);
        const pad = new Uint8Array(64);
        pad.set(k);
        const inner = new Uint8Array(64 + msg.length);
        const outer = new Uint8Array(64 + 32);
        for (let i = 0; i < 64; i++) {
            inner[i] = pad[i] ^ 0x36;
            outer[i] = pad[i] ^ 0x5c;
        }
        inner.set(msg, 64);
        outer.set(sha256(inner), 64);
        return sha256(outer);
    }

    function hkdf(ikm, salt, info, length) {
        const prk = hmacSha256(salt, ikm);
        const out = new Uint8Array(length);
        let t = new Uint8Array(0);
        let off = 0;
        for (let i = 1; off < length; i++) {
            const input = new Uint8Array(t.length + info.length + 1);
            input.set(t, 0);
            input.set(info, t.length);
            input[input.length - 1] = i;
            t = hmacSha256(prk, input);
            const take = Math.min(t.length, length - off);
            out.set(t.subarray(0, take), off);
            off += take;
        }
        return out;
    }

    // X25519 (RFC 7748)
    const P = (1n << 255n) - 19n;
    const A24 = 121665n;

    function mod(a) { const r = a % P; return r < 0n ? r + P : r; }

    function decodeLittleEndian(bytes, size) {
        let out = 0n;
        for (let i = size - 1; i >= 0; i--) out = (out << 8n) | BigInt(bytes[i]);
        return out;
    }

    function decodeScalar(bytes) {
        const out = new Uint8Array(32);
        out.set(bytes.subarray(0, 32));
        out[0] &= 248;
        out[31] &= 127;
        out[31] |= 64;
        return out;
    }

    function x25519(scalarBytes, uBytes) {
        const k = decodeScalar(scalarBytes);
        const u = decodeLittleEndian(uBytes, 32) % (1n << 255n);
        let x1 = u, x2 = 1n, z2 = 0n, x3 = u, z3 = 1n, swap = 0n;
        const kInt = decodeLittleEndian(k, 32);
        for (let t = 254; t >= 0; t--) {
            const kt = (kInt >> BigInt(t)) & 1n;
            if (swap !== kt) {
                [x2, x3] = [x3, x2];
                [z2, z3] = [z3, z2];
                swap = kt;
            }
            const a = mod(x2 + z2);
            const aa = mod(a * a);
            const b = mod(x2 - z2);
            const bb = mod(b * b);
            const e = mod(aa - bb);
            const c = mod(x3 + z3);
            const d = mod(x3 - z3);
            const da = mod(d * a);
            const cb = mod(c * b);
            const t1 = mod(da + cb);
            x3 = mod(t1 * t1);
            // z3 = x1 * (da - cb)^2
            const dcb = mod(da - cb);
            z3 = mod(x1 * mod(dcb * dcb));
            x2 = mod(aa * bb);
            z2 = mod(e * mod(aa + A24 * e));
        }
        if (swap !== 0n) {
            [x2, x3] = [x3, x2];
            [z2, z3] = [z3, z2];
        }
        const inv = modPow(z2, P - 2n);
        return encodeLittleEndian(mod(x2 * inv), 32);
    }

    function modPow(base, exp) {
        let result = 1n;
        let b = mod(base);
        let e = exp;
        while (e > 0n) {
            if (e & 1n) result = mod(result * b);
            b = mod(b * b);
            e >>= 1n;
        }
        return result;
    }

    function encodeLittleEndian(value, size) {
        const out = new Uint8Array(size);
        let v = value;
        for (let i = 0; i < size; i++) {
            out[i] = Number(v & 0xffn);
            v >>= 8n;
        }
        return out;
    }

    /* Punto base de X25519 (u = 9). */
    const BASE_POINT = new Uint8Array(32);
    BASE_POINT[0] = 9;

    /* Clave pública del cliente a partir de su clave privada. */
    function publicFromPrivate(privateBytes) {
        return x25519(privateBytes, BASE_POINT);
    }

    // ChaCha20 (RFC 8439)
    function chachaQuarterRound(s, a, b, c, d) {
        s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 16);
        s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 12);
        s[a] = (s[a] + s[b]) >>> 0; s[d] = rotl(s[d] ^ s[a], 8);
        s[c] = (s[c] + s[d]) >>> 0; s[b] = rotl(s[b] ^ s[c], 7);
    }

    function rotl(v, n) { return ((v << n) | (v >>> (32 - n))) >>> 0; }

    function chachaBlock(key, counter, nonce) {
        const state = new Uint32Array(16);
        state[0] = 0x61707865; state[1] = 0x3320646e; state[2] = 0x79622d32; state[3] = 0x6b206574;
        for (let i = 0; i < 8; i++) state[4 + i] = readU32(key, i * 4);
        state[12] = counter >>> 0;
        for (let i = 0; i < 3; i++) state[13 + i] = readU32(nonce, i * 4);
        const w = Uint32Array.from(state);
        for (let round = 0; round < 10; round++) {
            chachaQuarterRound(w, 0, 4, 8, 12);
            chachaQuarterRound(w, 1, 5, 9, 13);
            chachaQuarterRound(w, 2, 6, 10, 14);
            chachaQuarterRound(w, 3, 7, 11, 15);
            chachaQuarterRound(w, 0, 5, 10, 15);
            chachaQuarterRound(w, 1, 6, 11, 12);
            chachaQuarterRound(w, 2, 7, 8, 13);
            chachaQuarterRound(w, 3, 4, 9, 14);
        }
        const out = new Uint8Array(64);
        const ov = new DataView(out.buffer);
        // ChaCha20 serializa en little-endian.
        for (let i = 0; i < 16; i++) ov.setUint32(i * 4, (w[i] + state[i]) >>> 0, true);
        return out;
    }

    function readU32(bytes, off) {
        return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    }

    function chacha20(key, counter, nonce, data) {
        const out = new Uint8Array(data.length);
        for (let off = 0; off < data.length; off += 64) {
            const block = chachaBlock(key, counter, nonce);
            counter = (counter + 1) >>> 0;
            const take = Math.min(64, data.length - off);
            for (let i = 0; i < take; i++) out[off + i] = data[off + i] ^ block[i];
        }
        return out;
    }

    /* Cifrado autenticado: ChaCha20 para el cuerpo y HMAC-SHA256 como
     * etiqueta (cifrar-y-luego-autenticar). La clave de sesion son 64 bytes:
     * los 32 primeros para ChaCha20 y los 32 siguientes para el HMAC. */
    function aeadSeal(key, nonce, plaintext, aad) {
        const macKey = key.subarray(32, 64);
        const ciphertext = chacha20(key.subarray(0, 32), 1, nonce, plaintext);
        const mac = hmacSha256(macKey, concat(aad, u64le(aad.length), nonce, ciphertext, u64le(ciphertext.length)));
        return concat(ciphertext, mac);
    }

    function aeadOpen(key, nonce, sealed, aad) {
        if (sealed.length < MAC_BYTES) return null;
        const ciphertext = sealed.subarray(0, sealed.length - MAC_BYTES);
        const mac = sealed.subarray(sealed.length - MAC_BYTES);
        const macKey = key.subarray(32, 64);
        const expected = hmacSha256(macKey, concat(aad, u64le(aad.length), nonce, ciphertext, u64le(ciphertext.length)));
        if (!equalBytes(expected, mac)) return null;
        return chacha20(key.subarray(0, 32), 1, nonce, ciphertext);
    }

    function u64le(n) {
        const out = new Uint8Array(8);
        let v = n;
        for (let i = 0; i < 8; i++) { out[i] = v & 0xff; v = Math.floor(v / 256); }
        return out;
    }

    function equalBytes(a, b) {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    }

    function concat(...parts) {
        let total = 0;
        for (const p of parts) total += p.length;
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { out.set(p, off); off += p.length; }
        return out;
    }

    // Sobre
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    function randomBytes(n) {
        const out = new Uint8Array(n);
        global.crypto.getRandomValues(out);
        return out;
    }

    function toBase64(bytes) {
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return global.btoa(bin);
    }

    function fromBase64(text) {
        const bin = global.atob(text);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function requestAad(method, path, time) {
        return `zlapy-transport-v1|REQ|${method}|${path}|${time}`;
    }

    function responseAad(method, path, time, status) {
        return `zlapy-transport-v1|RSP|${method}|${path}|${time}|${status}`;
    }

    /* Clave de sesión a partir del secreto compartido de X25519. */
    function deriveSessionKey(shared, ephemeralRaw, serverRaw) {
        // 64 bytes: 32 para ChaCha20 y 32 para el HMAC de la etiqueta.
        return hkdf(shared, concat(ephemeralRaw, serverRaw), enc.encode(SESSION_INFO), 64);
    }

    /* Cifra un cuerpo JSON y devuelve cabeceras + cuerpo listo para fetch. */
    function encrypt(method, path, payload, serverPublicB64) {
        const serverRaw = fromBase64(serverPublicB64);
        if (serverRaw.length !== EPHEMERAL_BYTES) throw new Error('Clave pública de transporte inválida.');
        const ephemeralPrivate = randomBytes(32);
        const ephemeralRaw = publicFromPrivate(ephemeralPrivate);
        const shared = x25519(ephemeralPrivate, serverRaw);
        const key = deriveSessionKey(shared, ephemeralRaw, serverRaw);
        const nonce = randomBytes(NONCE_BYTES);
        const time = Date.now();
        const plaintext = enc.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
        const ciphertext = aeadSeal(key, nonce, plaintext, enc.encode(requestAad(method, path, time)));
        return {
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-Zlapy-Enc': ALGO,
                'X-Zlapy-Ephemeral': toBase64(ephemeralRaw),
                'X-Zlapy-Nonce': toBase64(nonce),
                'X-Zlapy-Time': String(time)
            },
            body: ciphertext,
            key, nonce, time, method, path
        };
    }

    /* Descifra una respuesta cifrada. */
    function decryptResponse(sealed, nonceB64, method, path, time, status, key) {
        const nonce = fromBase64(nonceB64);
        const plain = aeadOpen(key, nonce, sealed, enc.encode(responseAad(method, path, time, status)));
        return plain ? dec.decode(plain) : null;
    }

    // WebSocket
    const WS_TAG_C2S = 'zlapyC2S';
    const WS_TAG_S2C = 'zlapyS2C';

    /* Nonce de 12 bytes: contador de 32 bits + etiqueta de dirección. */
    function wsNonce(counter, tag) {
        const nonce = new Uint8Array(12);
        new DataView(nonce.buffer).setUint32(0, counter >>> 0, true);
        nonce.set(enc.encode(tag), 4);
        return nonce;
    }

    /* Clave de la conexión: X25519 con el servidor y HKDF en su dominio. */
    function wsKey(ephemeralPrivate, serverRaw) {
        const ephemeralRaw = publicFromPrivate(ephemeralPrivate);
        const shared = x25519(ephemeralPrivate, serverRaw);
        return { key: hkdf(shared, concat(ephemeralRaw, serverRaw), enc.encode('zlapy-transport-v1/ws'), 64), ephemeralRaw };
    }

    /* Envuelve un frame del cliente (texto JSON → `z1:<base64>`). */
    function wsSeal(key, counter, text) {
        const aad = enc.encode(`zlapy-transport-v1|WS|C2S|${counter}`);
        return 'z1:' + toBase64(aeadSeal(key, wsNonce(counter, WS_TAG_C2S), enc.encode(text), aad));
    }

    /* Abre un frame del servidor; null si no es válido. */
    function wsOpen(key, counter, text) {
        if (typeof text !== 'string' || !text.startsWith('z1:')) return null;
        const aad = enc.encode(`zlapy-transport-v1|WS|S2C|${counter}`);
        const plain = aeadOpen(key, wsNonce(counter, WS_TAG_S2C), fromBase64(text.slice(3)), aad);
        return plain ? dec.decode(plain) : null;
    }

    global.ZlapyTransport = {
        ALGO,
        sha256,
        hmacSha256,
        hkdf,
        x25519,
        publicFromPrivate,
        aeadSeal,
        aeadOpen,
        chacha20,
        encrypt,
        decryptResponse,
        deriveSessionKey,
        requestAad,
        responseAad,
        wsKey,
        wsSeal,
        wsOpen,
        toBase64,
        fromBase64,
        randomBytes,
        BASE_POINT
    };
})(typeof window !== 'undefined' ? window : globalThis);

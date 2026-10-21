/**
 * Cifrado de mensajes y de datos en reposo.
 *
 * Cifra el contenido de los mensajes con AES-256-GCM ligado a su contexto
 * (chat, autor, tipo), firma cada mensaje con Ed25519 y expone el cifrado en
 * reposo con la llave maestra.
 */

const crypto = require('crypto');

const MESSAGE_VERSION = 2;
const MESSAGE_AAD_DOMAIN = 'dp/message-aead/v2';
const SIGNATURE_DOMAIN = 'dp/message-signature/ed25519/v2';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function createMessageCrypto(masterKey, options = {}) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32)
        throw new TypeError('The message crypto master key must be exactly 32 bytes.');
    // Fuente de la semilla de FIRMA: por defecto la llave maestra; con
    // `signingKeyFor` se usa la auth_key del propio usuario (modelo en la nube
    // de MTProto 2.0), de modo que la llave maestra por sí sola no permite
    // derivar las claves de nadie.
    const signingKeyFor = typeof options.signingKeyFor === 'function' ? options.signingKeyFor : null;

    function encryptAtRest(plain) {
        if (typeof plain !== 'string' || plain === '') return plain;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
        const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return `PCE1:${iv.toString('base64')}:${Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')}`;
    }

    function decryptAtRest(blob) {
        if (typeof blob !== 'string' || blob === '') return blob;
        if (!blob.startsWith('PCE1:')) return blob;
        const parts = blob.split(':');
        if (parts.length !== 3) return blob;
        try {
            const iv = Buffer.from(parts[1], 'base64');
            const combined = Buffer.from(parts[2], 'base64');
            if (iv.length !== 12 || combined.length < 16) return null;
            const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
            decipher.setAuthTag(combined.subarray(-16));
            return Buffer.concat([
                decipher.update(combined.subarray(0, -16)),
                decipher.final()
            ]).toString('utf8');
        } catch {
            return null;
        }
    }

    function messageContext(row) {
        const context = {
            version: MESSAGE_VERSION,
            id: row.id,
            chat: row.chat,
            ts: row.ts,
            fromId: row.from_id,
            toId: row.to_id || '',
            kind: row.kind,
            cryptoGroupId: row.crypto_group_id || ''
        };
        if (Object.values(context).some(value => value === undefined || value === null))
            throw new TypeError('Incomplete message context.');
        return context;
    }

    function encryptMessage(plain, row) {
        if (typeof plain !== 'string') throw new TypeError('Message payload must be a string.');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
        cipher.setAAD(Buffer.from(JSON.stringify([MESSAGE_AAD_DOMAIN, messageContext(row)]), 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return `PCE2:${iv.toString('base64')}:${Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')}`;
    }

    function decryptMessage(blob, row) {
        if (typeof blob !== 'string') throw new TypeError('Message ciphertext must be a string.');
        if (blob.startsWith('PCE1:')) return decryptAtRest(blob);
        if (!blob.startsWith('PCE2:')) throw new Error('Unsupported message encryption version.');
        const parts = blob.split(':');
        if (parts.length !== 3) throw new Error('Malformed message ciphertext.');
        const iv = Buffer.from(parts[1], 'base64');
        const combined = Buffer.from(parts[2], 'base64');
        if (iv.length !== 12 || combined.length < 16) throw new Error('Malformed message ciphertext.');
        const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
        decipher.setAAD(Buffer.from(JSON.stringify([MESSAGE_AAD_DOMAIN, messageContext(row)]), 'utf8'));
        decipher.setAuthTag(combined.subarray(-16));
        return Buffer.concat([
            decipher.update(combined.subarray(0, -16)),
            decipher.final()
        ]).toString('utf8');
    }

    // El par de claves Ed25519 deriva de la semilla + el id del usuario: es
    // determinista, así que se cachea (cada firma y cada verificación
    // repetirían HKDF + import de clave: ~0,1-0,2 ms por mensaje, y hasta 200
    // verificaciones por página leída).
    const keyPairCache = new Map();
    const KEY_PAIR_CACHE_MAX = 500;
    const deriveKeyPair = (base, userId) => {
        const seed = Buffer.from(crypto.hkdfSync(
            'sha256',
            base,
            Buffer.from(userId, 'utf8'),
            Buffer.from(SIGNATURE_DOMAIN, 'utf8'),
            32
        ));
        const privateKey = crypto.createPrivateKey({
            key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
            format: 'der',
            type: 'pkcs8'
        });
        const publicKey = crypto.createPublicKey(privateKey);
        return {
            privateKey,
            publicKey,
            publicKeyDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
        };
    };
    // Se aceptan DOS fuentes de semilla: la auth_key del usuario (modelo en la
    // nube de MTProto 2.0) y la llave maestra, para que los mensajes firmados
    // con esta última sigan siendo verificables.
    function keyPairsForUser(userId) {
        if (typeof userId !== 'string' || userId.length < 1)
            throw new TypeError('A sender UID is required for message signing.');
        const cached = keyPairCache.get(userId);
        if (cached) return cached;
        const pairs = [];
        const base = signingKeyFor ? signingKeyFor(userId) : null;
        if (base && Buffer.isBuffer(base) && base.length >= 16) pairs.push(deriveKeyPair(base, userId));
        pairs.push(deriveKeyPair(masterKey, userId));
        if (keyPairCache.size >= KEY_PAIR_CACHE_MAX)
            keyPairCache.delete(keyPairCache.keys().next().value);
        keyPairCache.set(userId, pairs);
        return pairs;
    }
    function keyPairForUser(userId) {
        return keyPairsForUser(userId)[0];
    }

    function messageSignaturePayload(message, row) {
        const context = messageContext(row);
        return JSON.stringify({
            domain: SIGNATURE_DOMAIN,
            context,
            message: {
                name: message.name || '',
                mime: message.mime || '',
                caption: message.caption || '',
                data: message.data || '',
                hash: message.hash || '',
                once: !!message.once,
                edited: !!message.edited,
                gallery: Array.isArray(message.gallery) ? message.gallery : [],
                reply: message.reply || null,
                enc: message.enc || '',
                mentions: Array.isArray(message.mentions) ? message.mentions : [],
                mentionLabels: message.mentionLabels || {},
                invite: message.invite || null
            }
        });
    }

    function signMessage(message, row) {
        const pair = keyPairForUser(row.from_id);
        const signature = crypto.sign(
            null,
            Buffer.from(messageSignaturePayload(message, row), 'utf8'),
            pair.privateKey
        );
        return {
            signature: signature.toString('base64'),
            signingPublicKey: pair.publicKeyDer
        };
    }

    function getSigningPublicKey(userId) {
        return keyPairForUser(userId).publicKeyDer;
    }

    function verifyMessage(message, row, signature, signingPublicKey) {
        // Se prueba con ambas semillas (auth_key y llave maestra).
        for (const pair of keyPairsForUser(row.from_id)) {
            try {
                if (signingPublicKey !== pair.publicKeyDer || typeof signature !== 'string') continue;
                if (crypto.verify(
                    null,
                    Buffer.from(messageSignaturePayload(message, row), 'utf8'),
                    pair.publicKey,
                    Buffer.from(signature, 'base64')
                )) return true;
            } catch { /* siguiente candidata */ }
        }
        return false;
    }

    return {
        encryptAtRest,
        decryptAtRest,
        encryptMessage,
        decryptMessage,
        signMessage,
        verifyMessage,
        getSigningPublicKey,
        // Olvida la clave cacheada de un usuario (por ejemplo, tras regenerar
        // su auth_key).
        forgetSigningKey: userId => keyPairCache.delete(userId)
    };
}

module.exports = { createMessageCrypto };

/**
 * Cifrado de mensajes y de datos en reposo.
 *
 * Firma cada mensaje con Ed25519 y expone el cifrado en reposo con la llave
 * maestra. El CONTENIDO de los mensajes ya no viaja por aquí: se cifra y
 * descifra en mtproto.js con la auth_key del autor (formato PCE3). La
 * compatibilidad con los sobres antiguos (PCE1/PCE2 con la llave maestra) se
 * eliminó al regenerar la base de cero.
 */

const crypto = require('crypto');

const MESSAGE_VERSION = 2;
const SIGNATURE_DOMAIN = 'dp/message-signature/ed25519/v2';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/* Cifrado en reposo v2 (PCE1v2): la clave AES no es la maestra TAL CUAL
 * (regla de higiene: una misma clave no realza dos roles), sino una
 * SUBCLAVE derivationada con HKDF y dominio dedicado. Además, el sobre
 * autentica el dominio como dato autenticado, de modo que un texto cifrado
 * como "reposo-v2" no sirva deslizado como "firma" ni al revés. Los sobres
 * PCE1 v1 (AES con la maestra tal cual, sin AAD) siguen DESCIFRANDO para no
 * obligar a migrar datas instalados; todo lo nuevo se escribe PCE1v2.
 * (La base usa esto para auth_key, perfiles, grupos, blobs y VAPID.) */
const AT_REST_DOMAIN = 'dp/at-rest/aead/v2';
const AT_REST_ENVELOPE = 'PCE1v2:';
const AT_REST_LEGACY = 'PCE1:';

function createMessageCrypto(masterKey, options = {}) {
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32)
        throw new TypeError('The message crypto master key must be exactly 32 bytes.');
    // Fuente de la semilla de FIRMA: por defecto la llave maestra; con
    // `signingKeyFor` se usa la auth_key del propio usuario cuando existe.
    // La maestra queda como semilla de compatibilidad (mensajes firmados
    // antiguos) y como respaldo mientras el usuario no tenga auth_key: la
    // auth_key se guarda cifrada con la maestra, así que esta ES la raíz de
    // confianza completa del sistema.
    const signingKeyFor = typeof options.signingKeyFor === 'function' ? options.signingKeyFor : null;

    // Subclave dedicada al cifrado en reposo: HKDF-Expand con dominio fijo.
    // HKDF es la forma estándar de proyectar la llave maestra a espacios
    // independientes (reposo, firma, etc.) sin exponer la raíz.
    const atRestKey = Buffer.from(crypto.hkdfSync(
        'sha256',
        masterKey,
        Buffer.alloc(0),
        Buffer.from(AT_REST_DOMAIN, 'utf8'),
        32
    ));

    function encryptAtRest(plain, extraAad = null) {
        if (typeof plain !== 'string' || plain === '') return plain;
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', atRestKey, iv);
        // AAD del dominio (+ contexto extra si el llamante tuviera): ata el
        // sobre a su papel, evita encajes cruzados entre formatos.
        cipher.setAAD(extraAad ? Buffer.concat([Buffer.from(AT_REST_DOMAIN, 'utf8'), extraAad]) : Buffer.from(AT_REST_DOMAIN, 'utf8'));
        const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return `${AT_REST_ENVELOPE}${iv.toString('base64')}:${Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')}`;
    }

    function decryptAtRest(blob) {
        if (typeof blob !== 'string' || blob === '') return blob;
        const isV2 = blob.startsWith(AT_REST_ENVELOPE);
        // v1 (legado, AES directo con la maestra) sigue siendo legible.
        if (!isV2 && !blob.startsWith(AT_REST_LEGACY)) return blob;
        const parts = blob.split(':');
        if (parts.length !== 3) return blob;
        try {
            const iv = Buffer.from(parts[1], 'base64');
            const combined = Buffer.from(parts[2], 'base64');
            if (iv.length !== 12 || combined.length < 16) return null;
            const decipher = crypto.createDecipheriv('aes-256-gcm', isV2 ? atRestKey : masterKey, iv);
            if (isV2) decipher.setAAD(Buffer.from(AT_REST_DOMAIN, 'utf8'));
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
    /* UNA sola semilla por usuario: la auth_key si existe (configurada con
       `signingKeyFor`) o la maestra mientras no exista. La lista con SIEMPRE
       el par maestro como segunda clave de firma/verificación se eliminó: era
       una puerta abierta para firmar el contenido de cualquier usuario con la
       llave maestra aunque tuviera auth_key propia. (La base se regeneró de
       cero: no hay mensajes firmados con la maestra que conservar.) */
    function keyPairForUser(userId) {
        if (typeof userId !== 'string' || userId.length < 1)
            throw new TypeError('A sender UID is required for message signing.');
        const cached = keyPairCache.get(userId);
        if (cached) return cached;
        const base = signingKeyFor ? signingKeyFor(userId) : masterKey;
        if (!Buffer.isBuffer(base) || base.length < 16)
            throw new TypeError('No signing seed available for the user.');
        const pair = deriveKeyPair(base, userId);
        if (keyPairCache.size >= KEY_PAIR_CACHE_MAX)
            keyPairCache.delete(keyPairCache.keys().next().value);
        keyPairCache.set(userId, pair);
        return pair;
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
        // UNA sola semilla: la del usuario. La clave maestra ya no es una
        // segunda firma válida para nadie.
        if (typeof signature !== 'string') return false;
        const pair = keyPairForUser(row.from_id);
        if (signingPublicKey !== pair.publicKeyDer) return false;
        try {
            return crypto.verify(
                null,
                Buffer.from(messageSignaturePayload(message, row), 'utf8'),
                pair.publicKey,
                Buffer.from(signature, 'base64')
            );
        } catch { return false; }
    }

    return {
        encryptAtRest,
        decryptAtRest,
        signMessage,
        verifyMessage,
        getSigningPublicKey,
        // Olvida la clave cacheada de un usuario (por ejemplo, tras regenerar
        // su auth_key).
        forgetSigningKey: userId => keyPairCache.delete(userId)
    };
}

module.exports = { createMessageCrypto };

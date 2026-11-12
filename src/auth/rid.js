/**
 * `rid` y checksum de sesión (v10).
 *
 * Cada cuenta tiene un valor aleatorio (`rid`, tabla `user_rid`) que ROTA en
 * todo evento que deba invalidar sesiones (cambio de contraseña, logout,
 * cambio de cuenta). El token no guarda ninguna versión: lleva un `checksum`
 * calculado sobre el estado vigente de la cuenta, y el servidor lo RECALCULA
 * en cada petición. Si el estado cambió (el `rid` entre ellos), el checksum
 * ya no cuadra y el token muere — sin necesidad de guardar el token en
 * ninguna parte.
 *
 * El checksum se calcula con SHA-256 sobre los campos canónicos unidos por
 * `|`. La canonicalización vive AQUI (dentro de computeChecksum) y no en
 * quien arma los datos: así ningún llamante puede olvidarla. Sin normalizar,
 * una fecha metida con `${fecha}` produciría una firma distinta en cada zona
 * horaria, y un cambio de huso invalidaría las sesiones de medio servidor.
 *
 * El `rid` se genera con un secreto derivado de la llave maestra (HKDF,
 * dominio propio): no vive en el .env y cambia si cambia la credencial.
 */
'use strict';

const crypto = require('crypto');

const RID_DOMAIN = 'zlapy/rid/v1';

/* Secreto de generación del rid, derivado de la llave maestra. Requerido de
   forma perezosa: la llave existe antes de abrir la base (server.js sale con
   código 78 si no), pero este módulo se carga también desde tests. */
const ridSecret = () => {
    const { masterKey } = require('../crypto/setup.js');
    return Buffer.from(crypto.hkdfSync('sha256', masterKey.export(), Buffer.alloc(0), Buffer.from(RID_DOMAIN, 'utf8'), 32));
};

/* `rid` aleatorio por cuenta: 16 bytes + 4 caracteres de HMAC(secreto,
   aleatorio+userId). El sufijo no es seguridad (el rid va en la base y se
   compara, no se adivina): detecta valores corruptos o pegados a mano. */
function generateRid(userId) {
    const random = crypto.randomBytes(16).toString('base64url');
    const mac = crypto.createHmac('sha256', ridSecret()).update(random + String(userId)).digest('base64url').slice(0, 4);
    return random + mac;
}

/* Normaliza un campo para que el checksum no dependa de cómo lo represente
   el proceso (Date -> ISO, null/undefined -> 'null', el resto como texto). */
const canonical = value => {
    if (value instanceof Date) return value.toISOString();
    if (value === null || value === undefined) return 'null';
    return String(value);
};

/* Estado que firma la sesión. `password_hash` entra a propósito: aunque la
   rotación del rid falle por cualquier hueco, el simple hecho de cambiar la
   contraseña ya descuadra el checksum de todos los tokens anteriores
   (defensa en profundidad, igual que `password_changed_at`/`iat`). */
function computeChecksum(user) {
    const parts = [user.id, user.username, user.passwordHash, user.rid].map(canonical);
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

module.exports = { generateRid, computeChecksum, canonical };

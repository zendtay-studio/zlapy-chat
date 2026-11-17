/**
 * Cifrado en reposo de campos sueltos.
 *
 * Antes, casi todo el contenido sensible ya viajaba cifrado con la `auth_key`
 * del usuario (PCE3, extremo a extremo). Quedaban huecos: la foto de perfil,
 * el fondo del chat, los nombres de los grupos, el código de invitación, los
 * stickers, las listas de Privacidad… campos que el servidor guardaba tal
 * cual, en texto plano, en el fichero de la base.
 *
 * Aquí se cifra cada campo con la LLAVE MAESTRA usando el mismo sobre del
 * cifrado en reposo (PCE1v2) pero con un AAD propio de la columna: el texto
 * cifrado de "user_profiles.note" no vale como "groups.name" porque el AAD
 * no coincide. Así un texto cifrado no se puede pegar de una columna a otra.
 *
 * El material queda en el dominio de la llave maestra: al cambiar la
 * credencial del propietario, estos campos se re-cifran con la llave nueva
 * (igual que las `auth_key`).
 */
'use strict';

/* AAD de columna: ata el sobre a su papel exacto. */
const aadOf = column => Buffer.from(`field:${column}`, 'utf8');

/* El módulo de cifrado se carga DENTRO de las funciones (no al importar
   este fichero): el motor de re-cifrado (`ops/crypto/reencrypt-master.js`) necesita
   el mapa de columnas de abajo, y no debe arrancar el servidor ni pedir la
   credencial del propietario sólo por leer ese mapa. */
const cryptoSetup = () => require('./setup.js');

/**
 * Cifra un campo para guardarlo.
 *
 * @param {string} column nombre de la columna (p. ej. "groups.name")
 * @param {string} value  valor en claro
 * @returns {string} el sobre cifrado (o el valor vacío tal cual)
 */
function encField(column, value) {
    if (typeof value !== 'string' || value === '') return typeof value === 'string' ? value : '';
    return cryptoSetup().encryptAtRest(value, aadOf(column));
}

/**
 * Descifra un campo.
 *
 * @param {string} column
 * @param {string} value
 * @returns {string} el valor en claro, o '' si el sobre no descifra
 */
function decField(column, value) {
    const plain = decFieldOrNull(column, value);
    return typeof plain === 'string' ? plain : '';
}

/**
 * Descifra un campo distinguiendo "vacío" de "ilegible".
 *
 * Compatibilidad: los campos escritos antes de atar el contexto (AAD propio
 * de columna) se leían solo con el dominio del formato. Se prueba primero CON
 * el contexto y, si no descifra, sin él; al volver a escribir el campo queda
 * atado. `null` significa "no se puede leer" (llave equivocada o valor
 * corrupto), que es lo que distingue al saneador del re-cifrado.
 *
 * @param {string} column
 * @param {string} value
 * @returns {string|null} null si el sobre no descifra con esta llave
 */
function decFieldOrNull(column, value) {
    if (typeof value !== 'string' || value === '') return typeof value === 'string' ? value : null;
    const setup = cryptoSetup();
    const conAad = setup.decryptAtRest(value, aadOf(column));
    if (typeof conAad === 'string') return conAad;
    const legacy = setup.decryptAtRest(value);
    return typeof legacy === 'string' ? legacy : null;
}

/**
 * ¿Este valor es un sobre de campo cifrado?
 *
 * @param {string} value
 * @returns {boolean}
 */
const isFieldEnvelope = value =>
    typeof value === 'string' && value.startsWith('PCE1v2:');

/* Tablas y columnas que se cifran en reposo con la llave maestra.
 *
 * El motor de re-cifrado (ops/crypto/reencrypt-master.js) recorre esta lista para
 * migrar de una credencial a otra, así que es la fuente de verdad del
 * "dominio de la llave maestra" fuera de los sobres genéricos (auth_key,
 * material de grupos, VAPID y blobs).
 */
const FIELD_TABLES = Object.freeze([
    { table: 'user_chat_settings', columns: ['wall', 'sender', 'receiver', 'sender_text', 'receiver_text', 'accent'] },
    { table: 'user_stickers', columns: ['sticker'] },
    { table: 'user_privacy_users', columns: ['target_name'] },
    { table: 'user_muted_peers', columns: ['peer_name'] },
    { table: 'group_join_requests', columns: ['username'] },
    { table: 'groups', columns: ['name', 'description', 'content_policy', 'invite_code'] },
    { table: 'calls', columns: ['peer'] },
    { table: 'push_subs', columns: ['endpoint'] },
    { table: 'message_reactions', columns: ['emoji'] }
]);

module.exports = {
    encField,
    decField,
    decFieldOrNull,
    isFieldEnvelope,
    aadOf,
    FIELD_TABLES
};

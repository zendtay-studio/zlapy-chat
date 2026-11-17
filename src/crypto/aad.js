/**
 * Contextos (AAD) del cifrado en reposo.
 *
 * El sobre en reposo (AES-256-GCM con la llave maestra) llevaba como único
 * AAD el dominio del formato: cualquier fila cifrada con esa llave valía en
 * CUALQUIER otra fila. Quien robara la base podía, por ejemplo, copiar el
 * `keys_cipher` de un grupo sobre el de otro, o una `auth_key` ajena sobre la
 * de una víctima, y el servidor lo descifraría sin notar el cambiazo (el
 * contenido seguiría siendo "válido" para el servidor, aunque no para el
 * usuario legítimo).
 *
 * Aquí se define el contexto de cada pieza: al cifrar se ata el sobre a su
 * papel exacto (identidad, grupo, blob, fila de meta) y al leer ese mismo
 * contexto. Un sobre que no coincide NO descifra.
 *
 * Los valores escritos ANTES de atar el contexto (legado) no llevan este AAD,
 * así que la lectura siempre prueba primero CON el contexto y, si falla,
 * reintenta sin él. La escritura, en cambio, SIEMPRE incluye el contexto: un
 * campo que se toca queda atado en el acto.
 */
'use strict';

const CONTEXT_NAMESPACE = 'zlapy-rest-v1';

const buf = text => Buffer.from(`${CONTEXT_NAMESPACE}|${text}`, 'utf8');

/* Contratos de contexto por pieza. */
const aadAuthKey = userId => buf(`auth_key|${userId}`);
const aadGroupKeys = groupId => buf(`group_keys|${groupId}`);
const aadBlob = hash => buf(`blob|${hash}`);
const aadMeta = key => buf(`meta|${key}`);
const aadReaction = messageId => buf(`reaction|${messageId}`);

/* Contextos del cifrado POR USUARIO (sobre PCE3A, el PCE3 con AAD).
 *
 * Cada pieza de contenido de una cuenta lleva el suyo: el sobre del nombre
 * del perfil no vale como la nota, ni el de una historia como la de otra, ni
 * el resumen de un chat como el del chat de al lado. Así una fila copiada de
 * un sitio a otro (o de una cuenta a otra) queda ilegible en destino, que es
 * justo lo que impide que una fuga de la base permita recomponer el historial
 * completo de un usuario leyendo filas sueltas. */
const ctxProfile = (userId, field) => buf(`perfil|${field}|${userId}`);
const ctxUserKey = userId => buf(`clave|${userId}`);
const ctxUserNote = userId => buf(`nota-usuario|${userId}`);
const ctxStory = (userId, ts) => buf(`historia|${userId}|${ts}`);
const ctxSummary = (owner, peer) => buf(`resumen|${owner}|${peer}`);
const ctxGroupSummary = (owner, gid) => buf(`resumen-grupo|${owner}|${gid}`);
const ctxPushSub = userId => buf(`suscripcion-push|${userId}`);
const ctxCall = (userId, callId) => buf(`llamada|${userId}|${callId}`);
const ctxDeviceKey = userId => buf(`clave-dispositivo|${userId}`);

module.exports = {
    CONTEXT_NAMESPACE,
    aadAuthKey,
    aadGroupKeys,
    aadBlob,
    aadMeta,
    aadReaction,
    ctxProfile,
    ctxUserKey,
    ctxUserNote,
    ctxStory,
    ctxSummary,
    ctxGroupSummary,
    ctxPushSub,
    ctxCall,
    ctxDeviceKey
};
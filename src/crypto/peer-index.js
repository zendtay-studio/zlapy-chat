/**
 * Índice a ciegas (blind index) de nombres de par.
 *
 * Varios campos guardan el nombre de un par CIFRADO en reposo
 * (`calls.peer`, `user_muted_peers.peer_name`), y hay que localizarlos por
 * nombre: al renombrar una cuenta, y al borrarla (purgar las llamadas de
 * otros usuarios que la señalan). Con el texto cifrado es imposible: la
 * única vía era recorrer TODAS las filas y descifrarlas (O(N) por operación,
 * N = llamadas de toda la instalación).
 *
 * Aquí se calcula un HMAC-SHA256 del nombre NORMALIZADO (minúsculas, sin
 * espacios) con una subclave de la llave maestra: columna `peer_hash` +
 * índice → localizar por nombre es O(log n) sin renunciar al cifrado. El
 * HMAC no revela el nombre (función unidireccional), solo igualdad: dos
 * filas del mismo par comparten hash, y nada más se puede deducir.
 *
 * La llave deriva de la LLAVE MAESTRA con dominio propio: cambiar la
 * credencial del propietario (re-derivo de la maestra) no la afecta, y el
 * dominio separa este uso del resto de subclaves.
 */
'use strict';

const crypto = require('crypto');

/* El módulo de cifrado se carga DENTRO de las funciones: la migración de
   esquema (schema.js) importa este fichero, y no debe arrancar el servidor
   criptográfico al importarse (igual que field-crypto.js). */
let subclave = null;
function claveIndice() {
    if (subclave) return subclave;
    // Require perezoso: rompe el ciclo setup.js ↔ (migraciones de esquema).
    const { masterKey } = require('./setup.js');
    subclave = Buffer.from(crypto.hkdfSync(
        'sha256',
        masterKey.export(),
        Buffer.alloc(0),
        Buffer.from('zlapy/calls-peer-index/v1', 'utf8'),
        32
    ));
    return subclave;
}

/* Normaliza como el resto del sistema compara nombres (trim + minúsculas),
   así que un hash sirve para la purga por cuenta y para el renombre. */
const normaliza = nombre => String(nombre || '').trim().toLowerCase();

/* HMAC hex del nombre. Determinista: mismo par → mismo hash (siempre, no
   solo dentro del proceso), para que la columna sobreviva a reinicios. */
function peerHash(nombre) {
    if (typeof nombre !== 'string' || !nombre.trim()) return null;
    return crypto.createHmac('sha256', claveIndice()).update(normaliza(nombre)).digest('hex');
}

module.exports = { peerHash };

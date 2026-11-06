'use strict';
/**
 * Entorno común de los tests.
 *
 * Se carga con `node --require ./test/bootstrap.js` antes de cada fichero de
 * test (el runner de Node lanza cada fichero en su propio proceso).
 *
 * Hace dos cosas:
 *
 *   1. Aparta la base de datos de la instalación real: cada proceso de test
 *      recibe un DATA_DIR temporal propio. Sin esto, un test que arranque el
 *      módulo de cifrado tocaría `data/zlapy.db` (la instalación de verdad).
 *   2. Proporciona una credencial de propietario: la llave maestra se deriva
 *      de DB_USER + DB_PASSWORD, así que sin ellos ningún módulo que toque el
 *      cifrado puede ni arrancar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.DATA_DIR) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-test-env-'));
    process.env.DATA_DIR = dir;
    const limpiar = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } };
    process.on('exit', limpiar);
}
if (!process.env.DB_USER) process.env.DB_USER = 'propietario-prueba';
if (!process.env.DB_PASSWORD) process.env.DB_PASSWORD = 'clave-de-prueba-2026';

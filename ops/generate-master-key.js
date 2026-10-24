/**
 * Generación de la llave maestra.
 *
 * Escribe `CHAT_MASTER_KEY` en el fichero `.env` con el modo de fichero
 * correcto, genera una clave aleatoria de 32 bytes en base64 o vacía la
 * existente. La clave nunca se muestra por pantalla.
 *
 * La llave maestra vive SOLO en el `.env`: no hay fichero aparte
 * (`.zlapymasterkey` quedó eliminado). El servidor genera la clave él mismo
 * en el primer arranque de una instalación nueva (base sin datos) usando la
 * misma función `setEnvValue` de aquí, con escritura atómica.
 *
 * Si el `.env` no existe (instalación nueva) se crea a partir de
 * `.env.example` antes de escribir la clave, para que el comando funcione
 * también en la primera instalación.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeSecretFile, setEnvValue, readEnvValue } = require('./env-writer.js');

// Módulo diminuto de escritura atómica (paso a env-writer para
// compartirlo con el motor de re-cifrado). El CLI, además, es quien decide
// girar la llave CON re-cifrado cuando la base ya tiene datos.

/**
 * Crea el `.env` a partir de `.env.example` si todavía no existe.
 *
 * En una instalación nueva el `.env` no está (no se versiona), así que el
 * comando fallaba con ENOENT. Ahora se crea con los valores por defecto y
 * el usuario puede ajustarlo después.
 *
 * @returns {boolean} true si se creó el fichero.
 */
function ensureEnvFile(envPath) {
    if (fs.existsSync(envPath)) return false;
    const examplePath = path.join(path.dirname(envPath), '.env.example');
    if (!fs.existsSync(examplePath))
        throw new Error(`No existe ${envPath} ni ${examplePath}. Copia .env.example a .env y vuelve a intentarlo.`);
    const contents = fs.readFileSync(examplePath, 'utf8');
    writeSecretFile(envPath, contents);
    console.log(`Se creó ${envPath} a partir de .env.example (instalación nueva).`);
    return true;
}

function generateMasterKey(envPath = path.join(__dirname, '..', '.env'), { force = false, clear = false } = {}) {
    ensureEnvFile(envPath);
    const contents = fs.readFileSync(envPath, 'utf8');
    // `[ \t]*`, no `\s*`: en JS el `\s` cruza saltos de línea y agarra el
    // comentario siguiente como si fuera el valor.
    const match = contents.match(/^[ \t]*CHAT_MASTER_KEY[ \t]*=[ \t]*(.*)$/m);
    if (match === null)
        throw new Error(`Expected exactly one CHAT_MASTER_KEY assignment in ${envPath}.`);
    const currentValue = match[1].trim();
    const unquotedValue = currentValue.replace(/^(["'])(.*)\1$/, '$2').trim();
    if (clear) {
        setEnvValue(envPath, 'CHAT_MASTER_KEY', '');
        return;
    }
    if (unquotedValue && !force) {
        throw new Error('La clave maestra ya está configurada. Para girarla (generando otra y re-cifrando los datos si la base ya tiene contenido), ejecuta: npm run key -- --force (o la forma corta: npm run key -- -f).');
    }

    // El `.env` vive SIEMPRE al lado de `data/` (raíz del proyecto en
    // producción, raíz temporal en las pruebas), así que el directorio de
    // datos se deriva de su padre: una sola regla que sirve a ambos.
    const root = path.dirname(envPath);
    const dataDir = path.join(root, 'data');
    const dbPath = path.join(dataDir, 'zlapy.db');
    const blobPath = path.join(dataDir, 'blob.db');

    if (unquotedValue && force) {
        // Rotación con re-cifrado cuando la base YA tiene material que
        // depende de la maestra. Requiere que el `.env` contenga la llave
        // que descifra esos datos: sin ella no hay punto de partida.
        const { hasMasterDataAtRest, rotateMasterKey } = require('./reencrypt-master.js');
        const { createMessageCrypto } = require('../src/crypto/message-crypto.js');
        if (hasMasterDataAtRest(dbPath, blobPath)) {
            // Buffer.from nunca lanza con formato inválido (se salta los
            // caracteres que no son base64): lo que filtra de verdad es la
            // longitud del resultado.
            const oldKey = Buffer.from(unquotedValue, 'base64');
            if (oldKey.length !== 32) {
                throw new Error('La base de datos ya contiene datos, pero CHAT_MASTER_KEY no codifica una llave válida de 32 bytes. ' +
                    'Restaura en el .env la clave del respaldo antes de intentar girarla.');
            }
            const newKey = crypto.randomBytes(32);
            const stats = rotateMasterKey({
                dbPath, blobPath, envPath, oldKey, newKey, cryptoFactory: createMessageCrypto
            });
            return { rotated: true, ...stats };
        }
        // Sin material dependiente: sustitución clásica de la línea.
    }

    const generatedKey = crypto.randomBytes(32).toString('base64');
    // La clave debe codificar exactamente 32 bytes: se valida antes de
    // escribirla para no dejar un .env con un secreto inservible.
    if (Buffer.from(generatedKey, 'base64').length !== 32) {
        throw new Error('La clave generada no codifica 32 bytes.');
    }
    setEnvValue(envPath, 'CHAT_MASTER_KEY', generatedKey);
    return { rotated: false };
}

if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        const allowedArgs = new Set(['--force', '-f', '--null', '-n']);
        if (args.some(argument => !allowedArgs.has(argument))) {
            throw new Error('Uso: npm run key [-- --force | -f | --null | -n]');
        }
        const force = args.includes('--force') || args.includes('-f');
        const clear = args.includes('--null') || args.includes('-n');
        if (force && clear) throw new Error('No combines la opción para generar con la opción para vaciar.');
        const envPath = path.join(__dirname, '..', '.env');
        const resultado = generateMasterKey(envPath, { force, clear });
        if (clear) {
            console.log('CHAT_MASTER_KEY se vació en .env.');
            console.log('  · Si la base de datos ya tiene cuentas, el servidor NO arrancará hasta que definas una clave (la generación automática sólo ocurre en una instalación nueva).');
            console.log('  · Si la base está vacía, en el siguiente arranque se generará una clave nueva y quedará guardada en este mismo .env.');
        } else {
            if (resultado.rotated) {
                console.log('CHAT_MASTER_KEY girada y TODO el material dependiente re-cifrado con la nueva:');
                console.log(`  · auth_key de usuarios re-envueltas: ${resultado.authKeys}`);
                console.log(`  · material E2E de grupos re-cifrado: ${resultado.groups}`);
                console.log(`  · meta (VAPID) re-cifrada: ${resultado.meta}`);
                console.log(`  · adjuntos en blob.db re-cifrados: ${resultado.blobs}`);
                console.log('La llave nueva está en el .env (no se muestra). Guárdala aparte junto a tus respaldos.');
            } else if (force) {
                console.log('CHAT_MASTER_KEY generada y guardada en .env (la base no tiene material dependiente de la maestra: no había nada que re-cifrar).');
            } else {
                console.log('CHAT_MASTER_KEY generada y guardada en .env. No se muestra la clave.');
            }
        }
    } catch (error) {
        console.error(`No se pudo generar CHAT_MASTER_KEY: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { generateMasterKey, ensureEnvFile, setEnvValue, writeSecretFile };

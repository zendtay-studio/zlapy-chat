/**
 * Generación de la llave maestra.
 *
 * Escribe `CHAT_MASTER_KEY` en el fichero `.env` con el modo de fichero
 * correcto, genera una clave aleatoria de 32 bytes en base64 o vacía la
 * existente. La clave nunca se muestra por pantalla.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Modo con el que debe quedar el fichero que guarda el secreto: sólo el
// propietario puede leerlo. Se fija de forma INCONDICIONAL (no depende del
// umask) porque el fichero contiene la clave maestra de cifrado en reposo.
const SECRET_FILE_MODE = 0o600;
// El directorio que lo contiene tampoco debe ser legible por otros.
const SECRET_DIR_MODE = 0o700;

// Escribe el contenido con el modo correcto: `writeFileSync` sólo aplica
// `mode` al CREAR el fichero (si ya existe conserva el suyo), así que además
// se fuerza con chmod. El directorio padre sólo se crea si falta: si ya
// existe se respeta su modo (aquí suele ser la raíz del proyecto, que no es
// asunto de este script).
function writeSecretFile(filePath, contents) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
    fs.writeFileSync(filePath, contents, { mode: SECRET_FILE_MODE });
    try { fs.chmodSync(filePath, SECRET_FILE_MODE); } catch (e) { /* best-effort */ }
}

function generateMasterKey(envPath = path.join(__dirname, '..', '.env'), { force = false, clear = false } = {}) {
    const contents = fs.readFileSync(envPath, 'utf8');
    const newline = contents.includes('\r\n') ? '\r\n' : '\n';
    const lines = contents.split(/\r?\n/);
    const keyLines = [];

    for (let index = 0; index < lines.length; index++) {
        if (/^\s*CHAT_MASTER_KEY\s*=/.test(lines[index])) keyLines.push(index);
    }
    if (keyLines.length !== 1) {
        throw new Error(`Expected exactly one CHAT_MASTER_KEY assignment in ${envPath}.`);
    }

    const lineIndex = keyLines[0];
    const match = lines[lineIndex].match(/^(\s*CHAT_MASTER_KEY\s*=\s*)(.*)$/);
    const currentValue = match[2].trim();
    const unquotedValue = currentValue.replace(/^(["'])(.*)\1$/, '$2').trim();
    if (clear) {
        lines[lineIndex] = match[1];
        writeSecretFile(envPath, lines.join(newline));
        return;
    }
    if (unquotedValue && !force) {
        throw new Error('La clave maestra ya está configurada. Para generar otra, ejecuta: npm run key -- --force (o la forma corta: npm run key -- -f).');
    }

    const generatedKey = crypto.randomBytes(32).toString('base64');
    // La clave debe codificar exactamente 32 bytes: se valida antes de
    // escribirla para no dejar un .env con un secreto inservible.
    if (Buffer.from(generatedKey, 'base64').length !== 32) {
        throw new Error('La clave generada no codifica 32 bytes.');
    }
    lines[lineIndex] = `${match[1]}${generatedKey}`;
    writeSecretFile(envPath, lines.join(newline));
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
        generateMasterKey(path.join(__dirname, '..', '.env'), { force, clear });
        if (clear) {
            console.log('CHAT_MASTER_KEY se vació en .env. El servidor usará .zlapymasterkey si existe.');
        } else {
            if (force) {
                console.warn('Aviso: se reemplazó la clave anterior. Los datos cifrados con ella podrían quedar inaccesibles.');
            }
            console.log('CHAT_MASTER_KEY generada y guardada en .env. No se muestra la clave.');
        }
    } catch (error) {
        console.error(`No se pudo generar CHAT_MASTER_KEY: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { generateMasterKey };

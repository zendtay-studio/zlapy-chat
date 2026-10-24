/**
 * Escritura de secretos y variables de entorno.
 *
 * Módulo diminuto e independiente (sólo `node:` core): lo usan tanto el
 * generador de llave (`ops/generate-master-key.js`) como el motor de
 * re-cifrado (`ops/reencrypt-master.js`), de modo que ambos compartan
 * EXACTAMENTE las mismas garantías de escritura atómica sin dependencias
 * circulares.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Modo con el que debe quedar el fichero que guarda un secreto: sólo el
// propietario puede leerlo. Se fija de forma INCONDICIONAL (no depende del
// umask) porque estos ficheros contienen la clave maestra de cifrado.
const SECRET_FILE_MODE = 0o600;
// El directorio que los contiene tampoco debe ser legible por otros.
const SECRET_DIR_MODE = 0o700;

/**
 * Escritura ATÓMICA de un fichero secreto: primero el contenido completo en
 * un temporal hermano (creado ya con 0600), y después `rename`, que en
 * POSIX reemplaza al destino de un solo paso. Con un `writeFileSync` a
 * pelo, un corte de luz a mitad de la escritura dejaría el fichero
 * truncado. El directorio padre sólo se crea si falta; si ya existe se
 * respeta su modo.
 */
function writeSecretFile(filePath, contents) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    let fd = null;
    try {
        fd = fs.openSync(tmp, 'w', SECRET_FILE_MODE);
        fs.writeFileSync(fd, contents);
        // flush a disco antes del rename: el rename es atómico, pero el
        // contenido del temporal tiene que haber llegado al dispositivo.
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, filePath);
    } catch (error) {
        try { if (fd !== null) fs.closeSync(fd); } catch { }
        try { fs.unlinkSync(tmp); } catch { }
        throw error;
    }
    // `rename` conserva el modo del temporal, pero por si el fichero ya
    // existía con otro modo (o el FS no respeta openSync con modo), se
    // reafirman los 0600.
    try { fs.chmodSync(filePath, SECRET_FILE_MODE); } catch (e) { /* best-effort */ }
}

/**
 * Fija `NOMBRE=valor` en un fichero de entorno: reemplaza SU línea
 * existente y conserva el resto del fichero (incluido el fin de línea que
 * ya usara). Exige exactamente una asignación de ese nombre: con cero o
 * varias lanza y no toca nada. La escritura es atómica.
 */
function setEnvValue(envPath, name, value) {
    const contents = fs.readFileSync(envPath, 'utf8');
    const newline = contents.includes('\r\n') ? '\r\n' : '\n';
    const lines = contents.split(/\r?\n/);
    // `[ \t]*`, no `\s*`: en JS el `\s` cruza saltos de línea.
    const namePattern = `[ \\t]*${name}[ \\t]*`;
    const matches = [];
    for (let index = 0; index < lines.length; index++) {
        if (new RegExp(`^${namePattern}=`).test(lines[index])) matches.push(index);
    }
    if (matches.length !== 1)
        throw new Error(`Se esperaba exactamente una asignación de ${name} en ${envPath}, hay ${matches.length}.`);
    const lineIndex = matches[0];
    // Dos grupos: el prefijo completo `NOMBRE=` se conserva (match[1]); el
    // valor viejo (match[2]) se descarta en favor del nuevo.
    const match = lines[lineIndex].match(new RegExp(`^(${namePattern}=[ \\t]*)(.*)$`));
    lines[lineIndex] = `${match[1]}${value}`;
    writeSecretFile(envPath, lines.join(newline));
}

/**
 * Lee el VALOR de `NOMBRE=` directamente del fichero, mecánica idéntica a
 * la que usa `src/crypto/master-key.js` para su clave (mismo regex con
 * `[ \t]*`, recorte y quita de comillas). Devuelve cadena — vacía si no
 * está — o null si el fichero no existe. Sirve al CLI para mirar la clave
 * VIGENTE sin cargar la configuración del servidor (qué importaría el
 * módulo de src, con sus efectos de arranque completos).
 */
function readEnvValue(envPath, name) {
    if (!fs.existsSync(envPath)) return null;
    // `[ \t]*`, no `\s*`: en JS el `\s` cruza saltos de línea.
    const match = fs.readFileSync(envPath, 'utf8')
        .match(new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*)$`, 'm'));
    if (match === null) return '';
    return match[1].trim().replace(/^["']|["']$/g, '').trim();
}

module.exports = { writeSecretFile, setEnvValue, readEnvValue, SECRET_FILE_MODE };

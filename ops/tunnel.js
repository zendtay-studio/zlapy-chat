/**
 * Túnel de Cloudflare.
 *
 * Levanta `cloudflared` para exponer Zlapy fuera de la red local, entregando
 * el token por un canal seguro y redactándolo de la salida del proceso.
 */

/* Equivale a:
 *   cloudflared -config zty.yml tunnel run --token-file <fichero temporal 0600>
 *
 * El token vive en .env (CLOUDFLARE_TUNNEL_TOKEN) y la configuración del
 * túnel en zty.yml (copia de zty.yml.example). Ninguno de los dos se sube al
 * repositorio: un token en package.json sería público y permitiría secuestrar
 * el túnel.
 *
 * El token NO viaja en argv: con `--token <secreto>` el secreto quedaría
 * visible en `ps` y en /proc/<pid>/cmdline para cualquier usuario del
 * sistema. Se entrega en un fichero temporal de modo 0600, dentro de un
 * directorio 0700, que se borra al salir; y la salida del proceso se filtra
 * para que el token no pueda aparecer en los logs.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const token = String(process.env.CLOUDFLARE_TUNNEL_TOKEN || '').trim();
if (!token) {
    console.error('Falta CLOUDFLARE_TUNNEL_TOKEN en .env (ver .env.example).');
    console.error('Pégalo ahí con:  CLOUDFLARE_TUNNEL_TOKEN=eyJ...');
    process.exit(1);
}

const configPath = path.join(__dirname, '..', 'zty.yml');
if (!fs.existsSync(configPath)) {
    console.error('No existe zty.yml. Cópialo desde el ejemplo:');
    console.error('  cp zty.yml.example zty.yml');
    process.exit(1);
}

// Canal seguro para el token

// ¿Esta versión de cloudflared acepta `--token-file`? Las instalaciones
// antiguas no lo tienen; en ese caso se usa el canal más seguro disponible
// (el token por el entorno del proceso, que tampoco aparece en argv).
const supportsTokenFile = () => {
    try {
        const result = spawnSync('cloudflared', ['tunnel', 'run', '--help'], {
            encoding: 'utf8',
            timeout: 10000
        });
        const help = `${result.stdout || ''}${result.stderr || ''}`;
        return help.includes('--token-file');
    } catch (e) {
        return false;
    }
};

// Fichero temporal 0600 dentro de un directorio 0700 (mkdtemp ya crea el
// directorio con 0700; se refuerza por si el umask fuese permisivo).
const createTokenFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-tunnel-'));
    try {
        fs.chmodSync(dir, 0o700);
    } catch (e) { /* best-effort */ }
    const file = path.join(dir, 'token');
    // `wx` falla si el fichero ya existe: nunca se sobrescribe nada.
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(file, 0o600);
    return { dir, file };
};

let tokenFile = null;

const cleanupTokenFile = () => {
    if (!tokenFile) return;
    try { fs.rmSync(tokenFile.dir, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
    tokenFile = null;
};

// El fichero se borra siempre: salida del hijo, señal recibida o muerte
// brusca del propio script.
process.on('exit', cleanupTokenFile);

const usingTokenFile = supportsTokenFile();
let args;
let extraEnv = {};

if (usingTokenFile) {
    tokenFile = createTokenFile();
    args = ['-config', configPath, 'tunnel', 'run', '--token-file', tokenFile.file];
} else {
    console.warn(
        'Este cloudflared no admite --token-file; se entrega el token por el entorno ' +
        'del proceso (TUNNEL_TOKEN), que tampoco aparece en argv.'
    );
    args = ['-config', configPath, 'tunnel', 'run'];
    extraEnv = { TUNNEL_TOKEN: token };
}

// El token ya está en la variable local `token`: se retira del entorno para
// que el proceso hijo sólo lo reciba por el canal elegido (fichero 0600 o
// TUNNEL_TOKEN), nunca por herencia.
delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

const child = spawn('cloudflared', args, {
    // stderr y stdout se canalizan para poder redactar el token antes de que
    // llegue a la consola o a un fichero de log.
    stdio: ['inherit', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, extraEnv)
});

// Redactor: si el token apareciera en la salida (no debería), se sustituye
// por una marca antes de escribirla. Los decodificadores por flujo evitan
// partir un carácter multibyte entre dos chunks.
const { StringDecoder } = require('node:string_decoder');
const makeRedactor = () => {
    const decoder = new StringDecoder('utf8');
    return chunk => {
        const text = decoder.write(chunk);
        if (!text) return null;
        return Buffer.from(text.split(token).join('***'), 'utf8');
    };
};
if (child.stdout) {
    const redactOut = makeRedactor();
    child.stdout.on('data', chunk => {
        const out = redactOut(chunk);
        if (out) process.stdout.write(out);
    });
}
if (child.stderr) {
    const redactErr = makeRedactor();
    child.stderr.on('data', chunk => {
        const out = redactErr(chunk);
        if (out) process.stderr.write(out);
    });
}

child.on('error', error => {
    if (error.code === 'ENOENT') {
        console.error('No se encontró `cloudflared` en el PATH.');
        console.error('Instálalo: https://developers.cloudflare.com/cloudflared/install/');
    } else {
        console.error(error.message);
    }
    cleanupTokenFile();
    process.exit(1);
});

child.on('exit', (code, signal) => {
    cleanupTokenFile();
    process.exit(signal ? 1 : (code === null ? 1 : code));
});

// Las señales se propagan al túnel para que no quede huérfano.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        try { child.kill(signal); } catch (e) { /* ya salió */ }
    });
}

#!/usr/bin/env node
/**
 * CLI de la credencial del propietario.
 *
 * La llave maestra del servidor ya no es un valor aleatorio en el `.env`:
 * es el resultado de derivar (scrypt) la credencial `DB_USER` +
 * `DB_PASSWORD`. Este script es la herramienta de operación de esa credencial:
 * crearla, cambiarla, rotarla, verificarla y exportar el kit de recuperación.
 *
 * Comandos:
 *
 *   npm run owner -- init                     crea la credencial de una base nueva
 *   npm run owner -- credential --user U --password P
 *                                           cambia la credencial y re-cifra TODO
 *   npm run owner -- rotate                   re-deriva con sal nueva (misma credencial)
 *   npm run owner -- check                    auditoría de integridad (salida 1 si falla)
 *   npm run owner -- show                     metadatos de la instalación
 *   npm run owner -- unlock-check             ¿la credencial abre esta base? (salida 0/1)
 *   npm run owner -- export-kit --out DIR     copia de recuperación (credencial + bases)
 *   npm run owner -- reset --yes              borra las bases (instalación limpia)
 *
 * El orden importa: el re-cifrado va PRIMERO y el `.env` se escribe AL
 * FINAL. Si el proceso muriera a mitad, el `.env` conserva la credencial
 * vieja y el arranque falla de forma explícita (keycheck inválido) en vez
 * de dejar datos a medias.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { ROOT, DB_PATH, BLOB_DB_PATH } = require('../../src/config.js');
const { SCRYPT_PARAMS, assessPassword, deriveMasterKey } = require('../../src/crypto/kdf.js');
const { createMessageCrypto } = require('../../src/crypto/message-crypto.js');
const owner = require('../../src/crypto/owner-key.js');
const { ensureSchema } = require('../../src/db/schema.js');
const { writeSecretFile, readEnvValue } = require('../config/env-writer.js');
const {
    rotateMasterKey, auditMasterKey, serverIsRunning, hasMasterDataAtRest
} = require('../crypto/reencrypt-master.js');

const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');

/**
 * Rutas de trabajo.
 *
 * Por defecto son las de la instalación (las del `.env` y las bases de
 * `data/`), pero se pueden redirigir con `--env`, `--db` y `--blob-db`:
 * los tests.run en un directorio temporal sin tocar la instalación real.
 *
 * @param {object} args
 * @returns {{envPath: string, dbPath: string, blobPath: string, ejemplo: string}}
 */
function contexto(args) {
    const envPath = args.env ? path.resolve(String(args.env)) : ENV_PATH;
    return {
        envPath,
        dbPath: args.db ? path.resolve(String(args.db)) : DB_PATH,
        blobPath: args['blob-db'] ? path.resolve(String(args['blob-db'])) : BLOB_DB_PATH,
        ejemplo: args.env ? path.join(path.dirname(envPath), '.env.example') : ENV_EXAMPLE_PATH
    };
}

/* ─────────────────────────── Utilidades ─────────────────────────── */

const fail = message => {
    console.error(`\n[owner] ERROR: ${message}\n`);
    process.exit(1);
};

const info = message => console.log(`[owner] ${message}`);

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const actual = argv[i];
        if (!actual.startsWith('--')) { args._.push(actual); continue; }
        const bruto = actual.slice(2);
        const corte = bruto.indexOf('=');
        if (corte !== -1) { args[bruto.slice(0, corte)] = bruto.slice(corte + 1); continue; }
        const siguiente = argv[i + 1];
        if (siguiente !== undefined && !siguiente.startsWith('--')) { args[bruto] = siguiente; i++; }
        else args[bruto] = true;
    }
    return args;
}

/**
 * Pide una contraseña por terminal SIN eco.
 *
 * @param {string} etiqueta
 * @returns {Promise<string>}
 */
function pedirSecreto(etiqueta) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY)
            return reject(new Error('No hay terminal para leer la contraseña: usa --password o DB_PASSWORD.'));
        process.stdout.write(`${etiqueta}: `);
        const entrada = process.stdin;
        let valor = '';
        const wasRaw = entrada.isRaw;
        entrada.setRawMode(true);
        entrada.resume();
        entrada.setEncoding('utf8');
        const alPulsar = caracter => {
            if (caracter === '\r' || caracter === '\n') {
                entrada.setRawMode(wasRaw);
                entrada.pause();
                entrada.removeListener('data', alPulsar);
                process.stdout.write('\n');
                resolve(valor);
                return;
            }
            if (caracter === '') {
                entrada.setRawMode(wasRaw);
                entrada.pause();
                entrada.removeListener('data', alPulsar);
                process.stdout.write('\n');
                resolve('');
                return;
            }
            if (caracter === '') { valor = valor.slice(0, -1); return; }
            if (caracter >= ' ') valor += caracter;
        };
        entrada.on('data', alPulsar);
    });
}

/**
 * Resuelve la contraseña: opción de línea de comandos, variable de entorno
 * o pregunta interactiva.
 *
 * @param {object} args
 * @param {object} [options]
 * @param {boolean} [options.required]
 * @returns {Promise<string>}
 */
async function resolverPassword(args, { required = true } = {}) {
    if (typeof args.password === 'string' && args.password.length > 0) {
        console.error('[owner] AVISO: --password queda en el historial del shell y visible en /proc mientras dure el comando. Prefiere el prompt o DB_PASSWORD del entorno.');
        return args.password;
    }
    if (typeof args.password === 'string' && args.password.length === 0) return '';
    const delEntorno = typeof process.env.DB_PASSWORD === 'string' ? process.env.DB_PASSWORD : '';
    if (delEntorno) return delEntorno;
    if (!required) return '';
    return pedirSecreto('Contraseña del propietario');
}

/** El servidor tiene que estar parado para tocar las bases. */
function exigirServidorParado(ctx) {
    const vivo = serverIsRunning({ dbPath: ctx.dbPath });
    if (vivo.vivo)
        fail(`Hay un servidor de Zlapy en marcha (pid ${vivo.pid}). Deténlo antes de esta operación.`);
}

/**
 * Escribe (o sustituye) una variable en el `.env`.
 *
 * A diferencia de `setEnvValue`, NO exige que la asignación ya exista: si no
 * está, la añade. La escritura es atómica y el fichero queda en 0600.
 *
 * @param {string} envPath
 * @param {string} name
 * @param {string} value
 */
function upsertEnvValue(envPath, name, value) {
    let contenido = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const salto = contenido.includes('\r\n') ? '\r\n' : '\n';
    const patron = new RegExp(`^[ \\t]*${name}[ \\t]*=`, 'm');
    const lineas = contenido.split(/\r?\n/);
    let encontrada = -1;
    for (let i = 0; i < lineas.length; i++)
        if (patron.test(lineas[i])) { encontrada = i; break; }
    if (encontrada !== -1) {
        const prefijo = lineas[encontrada].match(new RegExp(`^([ \\t]*${name}[ \\t]*=[ \\t]*)`))[1];
        lineas[encontrada] = `${prefijo}${value}`;
        contenido = lineas.join(salto);
    } else {
        if (contenido.length > 0 && !contenido.endsWith('\n')) contenido += salto;
        contenido += `${name}=${value}${salto}`;
    }
    writeSecretFile(envPath, contenido);
}

/** Quita una variable del `.env` (si está). */
function removeEnvValue(envPath, name) {
    if (!fs.existsSync(envPath)) return;
    const contenido = fs.readFileSync(envPath, 'utf8');
    const patron = new RegExp(`^[ \\t]*${name}[ \\t]*=.*$`, 'm');
    if (!patron.test(contenido)) return;
    writeSecretFile(envPath, contenido.replace(patron, '').replace(/\n{3,}/g, '\n\n'));
}

/**
 * Valida que la credencial sobreviva al viaje por el `.env`.
 *
 * El fichero lo leen tres parsers (dotenv, `readEnvValue`, el vigilante) y
 * ninguno entiende comillas ni comentarios en línea: una contraseña con `"`,
 * `'`, `#`, salto de línea o espacios en los extremos se guardaría DISTINTA
 * de como se escribió → la base quedaría cifrada con un valor que el `.env`
 * ya no representa. Mejor rechazarla aquí, con un mensaje claro, que dejar
 * una instalación que no abre con ninguna credencial.
 *
 * @param {string} valor
 * @param {string} etiqueta
 * @returns {string} el valor si es guardable
 */
function exigirGuardable(valor, etiqueta) {
    if (typeof valor !== 'string' || !valor)
        fail(`El ${etiqueta} no puede estar vacío.`);
    if (/[\r\n'"`#]/.test(valor) || valor !== valor.trim())
        fail(`El ${etiqueta} lleva caracteres que el .env no guarda bien ` +
            '(comillas, "#", saltos de línea o espacios en los extremos). Usa otro.');
    return valor;
}

/**
 * Escribe la credencial en el `.env`.
 *
 * Si el `.env` apunta a `DB_PASSWORD_FILE`, la contraseña se escribe en ese
 * fichero (0600) y no en el `.env`; si no, va en `DB_PASSWORD`.
 *
 * @param {string} user
 * @param {string} password
 */
function escribirCredencialEnEnv(ctx, user, password) {
    if (!fs.existsSync(ctx.envPath)) {
        if (!fs.existsSync(ctx.ejemplo)) fail('No existe .env ni .env.example: no se puede crear la configuración.');
        writeSecretFile(ctx.envPath, fs.readFileSync(ctx.ejemplo));
    }
    const fichero = readEnvValue(ctx.envPath, 'DB_PASSWORD_FILE');
    upsertEnvValue(ctx.envPath, 'DB_USER', user);
    if (fichero) {
        const destino = path.isAbsolute(fichero) ? fichero : path.join(path.dirname(ctx.envPath), fichero);
        writeSecretFile(destino, `${password}\n`);
        removeEnvValue(ctx.envPath, 'DB_PASSWORD');
        info(`Contraseña escrita en ${destino} (DB_PASSWORD_FILE).`);
    } else {
        upsertEnvValue(ctx.envPath, 'DB_PASSWORD', password);
    }
}

/** Lee la credencial vigente del `.env` (no del entorno del proceso). */
function leerCredencialDelEnv(ctx) {
    const user = readEnvValue(ctx.envPath, 'DB_USER') || '';
    const fichero = readEnvValue(ctx.envPath, 'DB_PASSWORD_FILE');
    if (fichero) {
        const destino = path.isAbsolute(fichero) ? fichero : path.join(path.dirname(ctx.envPath), fichero);
        try {
            const password = fs.readFileSync(destino, 'utf8').replace(/\r?\n$/, '');
            return user && password ? { user, password, source: destino } : null;
        } catch { return null; }
    }
    const password = readEnvValue(ctx.envPath, 'DB_PASSWORD') || '';
    return user && password ? { user, password, source: '.env' } : null;
}

/** Abre la base de datos principal y se asegura de que el esquema exista. */
function abrirBaseConEsquema(ctx) {
    fs.mkdirSync(path.dirname(ctx.dbPath), { recursive: true });
    const db = new Database(ctx.dbPath);
    try { ensureSchema(db); }
    finally { try { db.close(); } catch { } }
    // La base contiene material cifrado y metadatos de la credencial: sólo
    // su dueño debe poder leerla (el servidor lo reafirma en cada arranque).
    try { fs.chmodSync(ctx.dbPath, 0o600); } catch { /* best-effort */ }
}

/**
 * Auditoría completa con la llave dada.
 *
 * @param {Buffer} key
 * @returns {object}
 */
function auditar(ctx, key) {
    const manifiesto = owner.checkIntegrityManifest(key, { dbPath: ctx.dbPath });
    const profundo = auditMasterKey({
        dbPath: ctx.dbPath,
        blobPath: ctx.blobPath,
        cryptoFactory: createMessageCrypto,
        key
    });
    return { manifiesto, profundo };
}

/* ───────────────────────────── Comandos ─────────────────────────── */

async function cmdInit(ctx, args) {
    exigirServidorParado(ctx);
    const user = exigirGuardable(String(args.user || process.env.DB_USER || '').trim(), 'usuario');
    if (!user) fail('Falta el usuario del propietario: `npm run owner -- init --user NOMBRE`.');
    const password = exigirGuardable(await resolverPassword(args), 'contraseña');

    const calidad = assessPassword(password);
    if (calidad.weak && !args.yes) {
        console.error(`\n[owner] AVISO: la contraseña ${calidad.motivo || 'es débil'}.`);
        console.error('[owner] Con --yes se acepta igualmente.');
        fail('Contraseña débil: vuelve a intentarlo con una mejor o usa --yes.');
    }
    if (calidad.weak) info(`Contraseña débil aceptada con --yes (${calidad.motivo}).`);

    if (hasMasterDataAtRest(ctx.dbPath, ctx.blobPath) && !args.force)
        fail('Esta base de datos ya tiene datos: `init` es sólo para bases nuevas. ' +
            'Usa `npm run owner -- reset --yes` para empezar de cero o `credential` para migrar.');

    abrirBaseConEsquema(ctx);

    const salt = crypto.randomBytes(16);
    const key = deriveMasterKey(user, password, salt, SCRYPT_PARAMS);
    owner.writeKeyMaterial(key, { user, salt, params: SCRYPT_PARAMS, dbPath: ctx.dbPath });
    owner.writeIntegrityManifest(key, { dbPath: ctx.dbPath });
    escribirCredencialEnEnv(ctx, user, password);

    // Verificación: la credencial escrita tiene que abrir la base.
    const comprobacion = owner.unlockMasterKey({ credential: { user, password }, dbPath: ctx.dbPath });
    const informe = auditar(ctx, comprobacion.key);
    if (!informe.manifiesto.ok) fail('La credencial se escribió pero el manifiesto de integridad no cuadra.');
    if (!informe.profundo.ok) fail('La credencial se escribió pero hay material ilegible con ella.');

    info(`Credencial de propietario creada para "${user}".`);
    info(`Llave maestra: ${owner.keyId(key)} (scrypt N=${SCRYPT_PARAMS.N}, r=${SCRYPT_PARAMS.r}, p=${SCRYPT_PARAMS.p}).`);
    info(`Guardada en ${ctx.envPath} (0600). Sin DB_USER + DB_PASSWORD esta base es inservible.`);
}

async function cmdCredential(ctx, args) {
    exigirServidorParado(ctx);
    const vigente = leerCredencialDelEnv(ctx);
    if (!vigente)
        fail('No hay credencial vigente en el .env (DB_USER + DB_PASSWORD): no se puede migrar sin la llave actual.');

    let viejo;
    try { viejo = owner.unlockMasterKey({ credential: vigente, dbPath: ctx.dbPath }); }
    catch (error) { fail(`La credencial vigente no abre esta base: ${error.message}`); }

    const nuevoUsuario = exigirGuardable(String(args.user || vigente.user).trim(), 'usuario nuevo');
    let nuevaPassword = typeof args.password === 'string'
        ? args.password
        : (args['misma-clave'] ? vigente.password : await resolverPassword(args));
    nuevaPassword = exigirGuardable(nuevaPassword, 'contraseña nueva');
    if (nuevoUsuario === vigente.user && nuevaPassword === vigente.password)
        fail('La credencial nueva es idéntica a la vigente: no hay nada que migrar. Usa `rotate` para cambiar la sal.');

    const calidad = assessPassword(nuevaPassword);
    if (calidad.weak && !args.yes) {
        console.error(`\n[owner] AVISO: la contraseña nueva ${calidad.motivo || 'es débil'}.`);
        fail('Contraseña débil: usa una mejor o pasa --yes.');
    }

    const salt = crypto.randomBytes(16);
    const nuevaLlave = deriveMasterKey(nuevoUsuario, nuevaPassword, salt, SCRYPT_PARAMS);
    /* Las filas de la credencial (sal, keycheck, manifiesto…) van dentro de
       la MISMA transacción del re-cifrado: tras un corte a mitad, la base abre
       con la credencial NUEVA (y el .env viejo da un fail-fast claro), nunca
       con NINGUNA. */
    const filasCredencial = owner.keyMaterialRows(nuevaLlave, { user: nuevoUsuario, salt, params: SCRYPT_PARAMS });
    const manifiesto = owner.computeIntegrityManifest(nuevaLlave, { rows: filasCredencial });
    const metaRows = [...filasCredencial, [owner.META.manifest, manifiesto]];

    // 1) Re-cifrado de todo el dominio de la llave maestra.
    const cuentas = rotateMasterKey({
        dbPath: ctx.dbPath,
        blobPath: ctx.blobPath,
        oldKey: viejo.key,
        newKey: nuevaLlave,
        cryptoFactory: createMessageCrypto,
        metaRows
    });
    info(`Re-cifrado: ${cuentas.authKeys} auth_key, ${cuentas.groups} grupos, ${cuentas.meta} filas meta, ` +
        `${cuentas.campos} campos y ${cuentas.blobs} adjuntos.`);

    // 2) El `.env` AL FINAL: hasta aquí la credencial vieja sigue en pie.
    escribirCredencialEnEnv(ctx, nuevoUsuario, nuevaPassword);

    // 4) Verificación con la llave nueva.
    const comprobacion = owner.unlockMasterKey({ credential: { user: nuevoUsuario, password: nuevaPassword }, dbPath: ctx.dbPath });
    const informe = auditar(ctx, comprobacion.key);
    if (!informe.manifiesto.ok) fail('Migración hecha, pero el manifiesto de integridad no cuadra con la llave nueva.');
    if (!informe.profundo.ok) fail('Migración hecha, pero hay material que no descifra con la llave nueva.');

    info(`Credencial migrada a "${nuevoUsuario}". Llave maestra: ${owner.keyId(nuevaLlave)}.`);
    info('Arranca el servidor: leerá la credencial nueva y desbloqueará la base.');
}

async function cmdRotate(ctx, args) {
    exigirServidorParado(ctx);
    const vigente = leerCredencialDelEnv(ctx);
    if (!vigente)
        fail('No hay credencial vigente en el .env (DB_USER + DB_PASSWORD).');
    let viejo;
    try { viejo = owner.unlockMasterKey({ credential: vigente, dbPath: ctx.dbPath }); }
    catch (error) { fail(`La credencial vigente no abre esta base: ${error.message}`); }

    const salt = crypto.randomBytes(16);
    const nuevaLlave = deriveMasterKey(vigente.user, vigente.password, salt, SCRYPT_PARAMS);
    const filasCredencial = owner.keyMaterialRows(nuevaLlave, { user: vigente.user, salt, params: SCRYPT_PARAMS });
    const manifiesto = owner.computeIntegrityManifest(nuevaLlave, { rows: filasCredencial });
    const cuentas = rotateMasterKey({
        dbPath: ctx.dbPath,
        blobPath: ctx.blobPath,
        oldKey: viejo.key,
        newKey: nuevaLlave,
        cryptoFactory: createMessageCrypto,
        metaRows: [...filasCredencial, [owner.META.manifest, manifiesto]]
    });

    const comprobacion = owner.unlockMasterKey({ credential: vigente, dbPath: ctx.dbPath });
    const informe = auditar(ctx, comprobacion.key);
    if (!informe.manifiesto.ok || !informe.profundo.ok)
        fail('Rotación hecha, pero la verificación con la llave nueva no cuadra.');
    info(`Sal nueva derivada. Re-cifrado: ${cuentas.authKeys} auth_key, ${cuentas.grupos || cuentas.groups} grupos, ` +
        `${cuentas.campos} campos, ${cuentas.blobs} adjuntos.`);
    info(`La credencial NO cambia (sigue en el .env). Llave maestra: ${owner.keyId(nuevaLlave)}.`);
}

function cmdCheck(ctx) {
    const vigente = leerCredencialDelEnv(ctx);
    if (!vigente) fail('No hay credencial en el .env (DB_USER + DB_PASSWORD).');
    let desbloqueo;
    try { desbloqueo = owner.unlockMasterKey({ credential: vigente, dbPath: ctx.dbPath }); }
    catch (error) { fail(`La credencial no abre esta base: ${error.message}`); }

    const informe = auditar(ctx, desbloqueo.key);
    const profundo = informe.profundo;
    console.log('');
    console.log(`  Usuario del propietario : ${readEnvValue(ctx.envPath, 'DB_USER')}`);
    console.log(`  Llave maestra (key_id)  : ${owner.keyId(desbloqueo.key)}`);
    console.log(`  Manifiesto de integridad : ${informe.manifiesto.ok ? 'OK' : 'NO COINCIDE'}`);
    console.log(`  auth_key legibles       : ${profundo.authKeys.ok} ok, ${profundo.authKeys.ilegibles.length} ilegibles`);
    console.log(`  Grupos legibles         : ${profundo.groups.ok} ok, ${profundo.groups.ilegibles.length} ilegibles`);
    console.log(`  Meta legible            : ${profundo.meta.ok} ok, ${profundo.meta.ilegibles.length} ilegibles`);
    console.log(`  Campos legibles         : ${profundo.campos.ok} ok, ${profundo.campos.ilegibles.length} ilegibles`);
    console.log(`  Adjuntos legibles       : ${profundo.blobs.ok} ok, ${profundo.blobs.ilegibles.length} ilegibles`);
    console.log('');
    if (!informe.manifiesto.ok || !profundo.ok) {
        console.error('[owner] La base NO está íntegra.\n');
        process.exit(1);
    }
    info('La base está íntegra y se abre con la credencial vigente.');
}

function cmdShow(ctx) {
    const filas = owner.readMetaRows(
        [owner.META.user, owner.META.salt, owner.META.params, owner.META.keyId],
        { readOnly: true, dbPath: ctx.dbPath }
    );
    console.log('');
    console.log(`  Usuario del propietario : ${filas[owner.META.user] || '(sin inicializar)'}`);
    console.log(`  Key id                  : ${filas[owner.META.keyId] || '(sin inicializar)'}`);
    console.log(`  Sal (base64)            : ${filas[owner.META.salt] || '(sin inicializar)'}`);
    console.log(`  Parámetros KDF          : ${filas[owner.META.params] || '(sin inicializar)'}`);
    console.log(`  Base de datos           : ${ctx.dbPath}`);
    console.log(`  Base de adjuntos        : ${ctx.blobPath}`);
    console.log('');
}

function cmdUnlockCheck(ctx) {
    const vigente = leerCredencialDelEnv(ctx);
    if (!vigente) { console.error('[owner] No hay credencial en el .env.'); process.exit(1); }
    try {
        owner.unlockMasterKey({ credential: vigente, dbPath: ctx.dbPath });
        console.log('[owner] La credencial abre esta base.');
        process.exit(0);
    } catch (error) {
        console.error(`[owner] La credencial NO abre esta base: ${error.message}`);
        process.exit(1);
    }
}

function cmdExportKit(ctx, args) {
    const destino = path.resolve(String(args.out || path.join(ROOT, 'backups', 'kit-credential')));
    const vigente = leerCredencialDelEnv(ctx);
    if (!vigente) fail('No hay credencial en el .env: sin ella el kit no serviría de nada.');
    /* Copiar una base VIVA (con su WAL) da un kit inconsistente: se exige el
       servidor parado, como en la migración. */
    exigirServidorParado(ctx);
    fs.mkdirSync(destino, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(destino, 0o700); } catch { /* best-effort */ }
    const copiar = (origen, nombre) => {
        if (!fs.existsSync(origen)) return false;
        writeSecretFile(path.join(destino, nombre), fs.readFileSync(origen));
        return true;
    };
    copiar(ctx.envPath, 'credencial.env');
    copiar(ctx.dbPath, path.basename(ctx.dbPath));
    copiar(ctx.blobPath, path.basename(ctx.blobPath));
    for (const sufijo of ['-wal', '-shm']) {
        copiar(ctx.dbPath + sufijo, path.basename(ctx.dbPath) + sufijo);
        copiar(ctx.blobPath + sufijo, path.basename(ctx.blobPath) + sufijo);
    }
    const aviso = [
        'KIT DE RECUPERACIÓN DE ZLAPY',
        '',
        `Generado: ${new Date().toISOString()}`,
        '',
        'Contiene la credencial del propietario (DB_USER + DB_PASSWORD) y las bases',
        'de datos. Sin la credencial las bases son ilegibles: sin las bases la',
        'credencial no sirve de nada. GUARDA LAS DOS COSAS JUNTAS, en un sitio',
        'seguro y con copia fuera de esta máquina.',
        '',
        'Para restaurar: copia credencial.env a la raíz del proyecto (como .env),',
        'y las bases a data/. Después arranca el servidor.',
        ''
    ].join('\n');
    writeSecretFile(path.join(destino, 'LEEME.txt'), aviso);
    info(`Kit de recuperación exportado a ${destino}.`);
    info('Guárdalo fuera de esta máquina: contiene la credencial que abre las bases.');
}

function cmdReset(ctx, args) {
    exigirServidorParado(ctx);
    if (!args.yes) fail('`reset` borra las bases de datos. Añade --yes cuando quieras hacerlo de verdad.');
    const borrados = [];
    for (const base of [ctx.dbPath, ctx.blobPath])
        for (const sufijo of ['', '-wal', '-shm']) {
            const ruta = base + sufijo;
            if (fs.existsSync(ruta)) { fs.rmSync(ruta); borrados.push(ruta); }
        }
    for (const ruta of borrados) info(`Borrado ${ruta}`);
    info('Instalación limpia: ejecuta `npm run owner -- init` para crear la credencial.');
}

/* ─────────────────────────────── Main ───────────────────────────── */

/* Comandos aceptados también con guiones (`--rotate` además de `rotate`):
   escribir el comando como opción es una errata natural y no hay ambigüedad
   posible: ningún comando es a la vez una opción con valor. */
const COMANDOS = ['init', 'credential', 'rotate', 'check', 'show', 'unlock-check', 'export-kit', 'reset'];

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const ctx = contexto(args);
    const comando = args._[0] || COMANDOS.find(c => args[c] === true);
    switch (comando) {
        case 'init': return cmdInit(ctx, args);
        case 'credential': return cmdCredential(ctx, args);
        case 'rotate': return cmdRotate(ctx, args);
        case 'check': return cmdCheck(ctx);
        case 'show': return cmdShow(ctx);
        case 'unlock-check': return cmdUnlockCheck(ctx);
        case 'export-kit': return cmdExportKit(ctx, args);
        case 'reset': return cmdReset(ctx, args);
        default:
            console.log([
                'Uso: npm run owner -- <comando> [opciones]',
                '       (el comando SIN guiones; también vale con ellos: --rotate)',
                '',
                '  init                     crea la credencial de una base nueva',
                '  credential --user U --password P   cambia la credencial y re-cifra todo',
                '  rotate                   re-deriva la llave con sal nueva',
                '  check                    auditoría de integridad (salida 1 si falla)',
                '  show                     metadatos de la instalación',
                '  unlock-check             ¿la credencial abre esta base? (salida 0/1)',
                '  export-kit --out DIR     copia de recuperación (credencial + bases)',
                '  reset --yes              borra las bases (instalación limpia)',
                '',
                'Opciones comunes: --yes (confirmar), --user NOMBRE, --password SECRETO'
            ].join('\n'));
            process.exit(comando ? 1 : 0);
    }
}

main().catch(error => {
    console.error(`\n[owner] ERROR: ${error && error.message ? error.message : error}\n`);
    process.exit(1);
});

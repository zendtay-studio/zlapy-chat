/**
 * Preflight de dependencias del proyecto.
 *
 * Antes de arrancar el supervisor o el servidor se comprueba que TODAS las
 * librerías de `package.json` están instaladas; las que falten se instalan
 * aquí, no en medio del arranque. Sin esto, un `node_modules` incompleto
 * hacía que `server.js` muriera con un `MODULE_NOT_FOUND` críptico y el
 * supervisor entrase en bucle de reinicios hasta abrir el cortacircuito.
 *
 * Camino feliz rápido: se comprueba la presencia de cada paquete por sistema
 * de ficheros (milisegundos, sin lanzar procesos). Si algo falta, se carga
 * de verdad cada librería en un proceso hijo aparte para enumerar con
 * exactitud qué está ausente o roto, y solo entonces se ejecuta npm.
 *
 * Uso:
 *   node ops/install/ensure-deps.js        (comprueba e instala lo que falte)
 *   npm run deps                   (mismo efecto)
 *
 * Códigos de salida: 0 = todo listo · 1 = Node demasiado antiguo ·
 * 3 = no se pudo dejar todo instalado.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
/* La dependencia nativa: su binario .node es lo que históricamente falta
   (plataformas sin prebuild, p. ej. Termux/Android, o npm que bloquea los
   scripts de instalación y deja el paquete sin compilar). */
const NATIVE_DEP = 'better-sqlite3';
const NPM_TIMEOUT_MS = 30 * 60 * 1000;

const pkg = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); }
    catch { return {}; }
})();
const dependencies = Object.keys(pkg.dependencies || {});
/* "engines": { "node": ">=22" } → versión mayor mínima exigida. */
const minNodeMajor = (() => {
    const raw = String((pkg.engines && pkg.engines.node) || '');
    const m = /(\d+)\.\d+/.exec(raw);
    return m ? Number.parseInt(m[1], 10) : 0;
})();

/* ¿Está el paquete en node_modules? Comprobación de ficheros, no de carga:
 * cargar nueve módulos (dos de ellos WASM/nativos) costaría cientos de
 * milisegundos en cada arranque para acabar diciendo lo mismo.
 */
const dirExiste = dep => fs.existsSync(path.join(NODE_MODULES, dep));

/* ¿Está compilado el binario nativo de better-sqlite3? La ruta depende de
 * la plataforma, igual que en ops/install/check-native.js. */
const nativeCheck = () => {
    if (!dirExiste(NATIVE_DEP)) return { ok: false, why: `no está en node_modules` };
    const prebuild = path.join(NODE_MODULES, NATIVE_DEP, 'prebuilds', `${process.platform}-${process.arch}.node`);
    if (fs.existsSync(prebuild)) return { ok: true };
    const buildDir = path.join(NODE_MODULES, NATIVE_DEP, 'build', 'Release');
    if (fs.existsSync(buildDir)) {
        const hit = fs.readdirSync(buildDir).find(f => f.endsWith('.node'));
        if (hit) return { ok: true };
    }
    return { ok: false, why: 'falta el binario nativo (.node): necesita `npm run rebuild:sqlite` (Termux/Android) o reinstalar' };
};

/* Verificación real: un proceso hijo aparte carga cada librería. Un módulo
 * roto (instalado a medias, binario incompatible) aquí se detecta; una
 * dependencia que falla al cargar NO puede dejar inservible este proceso.
 */
function loadCheck(deps) {
    const lines = deps.map(dep => `
        try { require(${JSON.stringify(dep)}); ok.push(${JSON.stringify(dep)}); }
        catch (e) { bad.push([${JSON.stringify(dep)}, (e && e.message) || String(e)]); }`).join('\n');
    const code = `const ok = [], bad = [];${lines}\nprocess.stdout.write(JSON.stringify({ ok, bad }));`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    if (r.error || r.status !== 0) return { ok: [], bad: deps.map(d => [d, r.error ? r.error.message : ` carga falló (status ${r.status})`]) };
    try { return JSON.parse(r.stdout); } catch { return { ok: [], bad: deps.map(d => [d, 'sin respuesta del proceso de verificación']) }; }
}

/**
 * Informe del estado de las dependencias.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.deps] librerías a verificar (por defecto, las del package.json)
 * @param {boolean} [opts.deep] forzar la carga real aunque el fichero esté presente
 * @returns {{ok: boolean, enginesOk: boolean, missing: Array<{name: string, why: string}>}}
 */
function verifyDeps({ deps = dependencies, deep = false } = {}) {
    const enginesOk = minNodeMajor === 0 || process.versions.node.split('.')[0] >= String(minNodeMajor);
    const missing = [];
    for (const dep of deps) {
        if (!dirExiste(dep)) missing.push({ name: dep, why: 'no está en node_modules' });
    }
    const nat = deps.includes(NATIVE_DEP) ? nativeCheck() : { ok: true };
    if (!nat.ok) missing.push({ name: NATIVE_DEP, why: nat.why });
    // Si algo falta (o se pide), la verificación por fichero se sustituye por
    // la carga real: es la única que detecta un paquete a medio instalar.
    if (deep || missing.length) {
        const real = loadCheck(deps);
        missing.length = 0;
        for (const [name, why] of real.bad) missing.push({ name, why });
    }
    return { ok: missing.length === 0, enginesOk, missing };
}

/* Instalador por defecto: npm install de las dependencias del proyecto.
 * Se instala el conjunto completo (no solo lo que falta) porque añadir un
 * paquete suelto con npm puede reescribir el árbol; el coste es el mismo. */
function defaultInstall() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--omit=dev'], {
        cwd: ROOT, stdio: 'inherit', timeout: NPM_TIMEOUT_MS
    });
    return { ok: r.status === 0, error: r.error ? r.error.message : (r.status === 0 ? null : `npm salió con ${r.status}`) };
}

/**
 * Deja el proyecto con todas las dependencias listas.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.deps]
 * @param {function} [opts.verify] inyectable en tests
 * @param {function} [opts.install] inyectable en tests
 * @param {{log?: function, error?: function}} [opts.loggers]
 * @returns {{ok: boolean, installed: boolean, missing: Array<{name: string, why: string}>}}
 * @throws {Error} si tras instalar sigue faltando algo (con el remedio en el mensaje)
 */
function ensureDeps({ deps = dependencies, verify = verifyDeps, install = defaultInstall, loggers = {} } = {}) {
    const log = loggers.log || (() => { });
    const error = loggers.error || (() => { });

    const primero = verify({ deps, deep: false });
    if (primero.enginesOk === false)
        throw new Error(`Node ${process.versions.node} es demasiado antiguo para este proyecto (se exige la rama ${minNodeMajor}.x). Instala Node ${minNodeMajor} o posterior.`);
    if (primero.ok) return { ok: true, installed: false, missing: [] };

    // Lista exacta de lo que falla (incluye los paquetes a medio instalar).
    const detallado = verify({ deps, deep: true });
    if (detallado.enginesOk === false)
        throw new Error(`Node ${process.versions.node} es demasiado antiguo para este proyecto (se exige la rama ${minNodeMajor}.x). Instala Node ${minNodeMajor} o posterior.`);
    if (detallado.ok) return { ok: true, installed: false, missing: [] };

    const nombres = detallado.missing.map(f => f.name).join(', ');
    error(`[deps] faltan dependencias (${nombres}); instalando…`);
    const res = install(detallado.missing.map(f => f.name));
    if (!res.ok)
        throw new Error(`No se pudieron instalar las dependencias (${nombres})${res.error ? ': ' + res.error : ''}. ¿Hay red? Reintenta con \`npm run deps\` o \`npm install\` a mano.`);

    const despues = verify({ deps, deep: true });
    if (!despues.ok) {
        const restan = despues.missing.map(f => `  · ${f.name}: ${f.why}`).join('\n');
        throw new Error(`Instalación terminada, pero algo sigue sin cargar:\n${restan}\nSi es el binario nativo de better-sqlite3, compílalo con \`npm run rebuild:sqlite\`.`);
    }
    log('[deps] dependencias listas.');
    return { ok: true, installed: true, missing: detallado.missing };
}

if (require.main === module) {
    try {
        const r = ensureDeps({
            loggers: { log: m => console.log(m), error: m => console.error(m) }
        });
        const total = dependencies.length;
        console.log(r.installed
            ? `[deps] ${total} dependencias listas (se instalaron: ${r.missing.map(f => f.name).join(', ')}).`
            : `[deps] ${total} dependencias correctas.`);
        process.exit(0);
    } catch (e) {
        console.error(`[deps] ${e && e.message ? e.message : e}`);
        process.exit(3);
    }
}

module.exports = { verifyDeps, ensureDeps, dependencies, minNodeMajor };

/**
 * Comprobación del binario nativo de better-sqlite3.
 *
 * better-sqlite3 es un módulo nativo: necesita un binario `.node` para la
 * plataforma en la que corre. Las versiones 13 publican binarios ya
 * compilados para Linux, macOS y Windows (x64 y arm64), pero no para Android,
 * así que en Termux hay que compilarlo en el dispositivo.
 *
 * Este script se ejecuta como `postinstall`:
 *
 *   1. Si el binario está, no hace nada más.
 *   2. Si falta, intenta compilarlo (`ops/build-sqlite.js`). Esto cubre el
 *      caso de npm 12 o superior, que bloquea por defecto los scripts de
 *      instalación de las dependencias: el binario nunca llega a compilarse y
 *      sin él el servidor no arranca.
 *   3. Si tampoco se puede compilar, explica qué hacer y termina con error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = (() => {
    try { return path.dirname(require.resolve('better-sqlite3/package.json')); }
    catch {
        console.error('\nNo se encuentra better-sqlite3. Instala las dependencias: npm install\n');
        process.exit(1);
    }
})();

/* Nombre de la plataforma tal y como lo nombra node-gyp y los prebuilds. */
const target = (() => {
    const platform = process.platform === 'android' ? 'android' : process.platform;
    const arch = process.arch;
    return `${platform}-${arch}`;
})();

const candidates = [
    path.join(root, 'prebuilds', `${target}.node`),
    path.join(root, 'build', 'Release', 'better_sqlite3.node'),
    path.join(root, 'build', 'Debug', 'better_sqlite3.node')
];

const binary = () => candidates.find(p => fs.existsSync(p));

const found = binary();
if (found) {
    console.log(`better-sqlite3: binario nativo presente (${path.relative(root, found)})`);
    process.exit(0);
}

/* Sin binario: se intenta compilar. Es lo que haría el script de instalación
 * del paquete si npm no lo bloquease (npm >= 12 lo bloquea por defecto). */
console.log(`better-sqlite3: no hay binario nativo para ${target}; se intenta compilar...`);
const build = spawnSync(process.execPath, [path.join(__dirname, 'build-sqlite.js')], { stdio: 'inherit' });
if (build.status === 0 && binary()) {
    console.log(`better-sqlite3: binario nativo listo (${path.relative(root, binary())})`);
    process.exit(0);
}

/* Sin binario y sin compilación posible: se explica qué hacer. */
const android = process.platform === 'android';
console.error([
    '',
    android
        ? 'better-sqlite3 no trae binario para Android: hay que compilarlo en el dispositivo.'
        : `No se encuentra el binario nativo de better-sqlite3 para ${target}.`,
    '',
    '  npm run rebuild:sqlite',
    '',
    android
        ? 'Necesitas las herramientas de compilacion: pkg install python make clang'
        : 'Reinstala las dependencias: npm install',
    ''
].join('\n'));
process.exit(1);

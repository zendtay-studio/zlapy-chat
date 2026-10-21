/**
 * Compila `better-sqlite3` en el sitio.
 *
 * Desde npm 12 los scripts de instalación de las dependencias están
 * bloqueados por defecto (salvo que el paquete esté aprobado con
 * `npm install-scripts approve <pkg>`), y en Android/Termux no existe binario
 * publicado para `android-arm64`: hay que compilarlo en el dispositivo.
 *
 * Este script hace esa compilación con `node-gyp` dentro del propio paquete,
 * sin depender del shell ni de la versión de npm:
 *
 *   npm run rebuild:sqlite
 *
 * Necesitas el toolchain: `pkg install python make clang` (Termux) o
 * `sudo apt install python3 make g++` (Debian/Ubuntu).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = (() => {
    try { return path.dirname(require.resolve('better-sqlite3/package.json')); }
    catch {
        console.error('\nNo se encuentra better-sqlite3. Instala las dependencias: npm install\n');
        process.exit(1);
    }
})();

if (!fs.existsSync(path.join(root, 'binding.gyp'))) {
    console.error([
        '',
        'El paquete better-sqlite3 instalado no trae binding.gyp: no se puede compilar.',
        'Borra node_modules/better-sqlite3 y vuelve a instalar las dependencias.',
        ''
    ].join('\n'));
    process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/* En Android/Termux no hay binario publicado para `android-<arch>`: hay que
 * compilarlo contra las cabeceras de Node que trae el propio Termux
 * ($PREFIX/include/node). Sin `--nodedir`, node-gyp intentaría descargarlas de
 * nodejs.org, donde no existen para Android. */
const args = ['exec', '--', 'node-gyp', 'rebuild', '--release', '--force_build=1'];
if (process.platform === 'android') {
    const prefix = process.env.PREFIX;
    if (prefix) {
        args.push(`--nodedir=${prefix}`);
        console.log(`Android: se compila contra las cabeceras de Node de Termux (${prefix}).`);
    } else {
        console.warn('Aviso: no está definida la variable PREFIX de Termux; puede fallar la compilación.');
    }
}

console.log(`Compilando better-sqlite3 en ${root} ...`);
console.log(`  ${npm} ${args.join(' ')}\n`);

const result = spawnSync(npm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
});

if (result.error) {
    console.error(`No se pudo ejecutar node-gyp: ${result.error.message}`);
    process.exit(1);
}
if (result.status !== 0) {
    console.error([
        '',
        'La compilación falló. Comprueba que tienes el toolchain instalado:',
        '  Termux:   pkg install python make clang',
        '  Debian:   sudo apt install python3 make g++',
        ''
    ].join('\n'));
    process.exit(result.status === null ? 1 : result.status);
}

console.log('better-sqlite3 compilado. Comprueba el binario con: node ops/check-native.js');

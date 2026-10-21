/**
 * Comprobación del binario nativo de better-sqlite3.
 *
 * better-sqlite3 es un módulo nativo: necesita un binario `.node` para la
 * plataforma en la que corre. Las versiones 13 publican binarios ya
 * compilados para Linux, macOS y Windows (x64 y arm64), pero no para Android,
 * así que en Termux hay que compilarlo en el dispositivo.
 *
 * Este script se ejecuta como `postinstall`: si el binario no está, explica
 * cómo obtenerlo. En plataformas sin binario publicado (Android/Termux) el
 * error indica el comando exacto de compilación.
 */
'use strict';

const fs = require('fs');
const path = require('path');

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

const found = candidates.find(p => fs.existsSync(p));

if (found) {
    console.log(`better-sqlite3: binario nativo presente (${path.relative(root, found)})`);
    process.exit(0);
}

/* Sin binario: en Android hay que compilarlo; en el resto de plataformas es
 * raro (falta el prebuild o el paquete se instalo sin scripts). */
if (process.platform === 'android') {
    console.error([
        '',
        'better-sqlite3 no trae binario para Android: hay que compilarlo en el dispositivo.',
        '',
        '  cd node_modules/better-sqlite3',
        '  npm exec -- node-gyp rebuild --release --force_build=1',
        '',
        'Necesitas las herramientas de compilacion: pkg install python make clang',
        ''
    ].join('\n'));
    process.exit(1);
}

console.error([
    '',
    `No se encuentra el binario nativo de better-sqlite3 para ${target}.`,
    'Reinstala las dependencias: npm install',
    'Si sigue faltando, compila en el sitio:',
    '  cd node_modules/better-sqlite3',
    '  npm exec -- node-gyp rebuild --release --force_build=1',
    ''
].join('\n'));
process.exit(1);

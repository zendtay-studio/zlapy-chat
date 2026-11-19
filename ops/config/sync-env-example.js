#!/usr/bin/env node
/*
 * Sincroniza `.env` con `.env.example` SIN sobrescribir nada de lo que ya
 * exista. Solo añade las variables que faltan, con sus comentarios asociados.
 *
 * Se puede usar de dos formas:
 *
 *   const { syncEnvFile } = require('./ops/config/sync-env-example.js');
 *   syncEnvFile('.env', '.env.example');
 *
 *   node ops/config/sync-env-example.js [ruta-env] [ruta-ejemplo]
 *
 * No imprime valores (el archivo puede contener secretos), solo los nombres
 * de las variables añadidas. La escritura usa el mismo temporal 0600 + rename
 * atómico que el resto de operaciones con credenciales.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeSecretFile } = require('./env-writer.js');

/* Solo asignaciones activas: una línea comentada (`#PORT=…`) no cuenta como
 * variable existente. Se admite `export NOMBRE=` y espacios alrededor. */
const ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/;
const assignmentKey = line => {
    const match = ASSIGNMENT_RE.exec(line);
    return match ? match[1] : null;
};

/**
 * Divide la plantilla en bloques: cada variable lleva consigo los comentarios
 * y líneas en blanco que la preceden. Así, al añadir una variable también
 * llega su explicación, no una lista de asignaciones huérfanas.
 */
function blocksOf(text) {
    const blocks = [];
    let pending = [];
    for (const line of text.split(/\r?\n/)) {
        const key = assignmentKey(line);
        if (!key) {
            pending.push(line);
            continue;
        }
        blocks.push({ key, lines: [...pending, line] });
        pending = [];
    }
    return blocks;
}

/**
 * Añade a `envPath` las variables de `examplePath` que aún no existen.
 *
 * @param {string} envPath archivo real, que se conserva salvo por las adiciones
 * @param {string} examplePath plantilla de referencia
 * @returns {{changed: boolean, added: string[], path: string}}
 */
function syncEnvFile(envPath, examplePath) {
    if (!fs.existsSync(examplePath))
        throw new Error(`No existe la plantilla ${examplePath}.`);

    const actual = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const presentes = new Set();
    for (const line of actual.split(/\r?\n/)) {
        const key = assignmentKey(line);
        if (key) presentes.add(key);
    }

    const ejemplo = fs.readFileSync(examplePath, 'utf8');
    const bloques = blocksOf(ejemplo);
    const faltantes = bloques.filter(block => !presentes.has(block.key));
    if (!faltantes.length) return { changed: false, added: [], path: envPath };

    let actualizado = actual;
    const added = [];
    for (const block of faltantes) {
        let lineas = block.lines.slice();
        /* Si el archivo real ya existe, no se repite el preámbulo general de
           la plantilla (licencia, instrucciones…). Los comentarios de sección
           de las demás variables sí se conservan. */
        if (actualizado.trim() && block === bloques[0]) {
            while (lineas.length && !assignmentKey(lineas[0])) lineas.shift();
        }
        const trozo = lineas.join('\n').trim();
        if (!trozo) continue;
        if (actualizado && !actualizado.endsWith('\n')) actualizado += '\n';
        if (actualizado.trim() && !actualizado.endsWith('\n\n')) actualizado += '\n';
        actualizado += trozo + '\n';
        added.push(block.key);
    }

    if (!added.length) return { changed: false, added: [], path: envPath };
    writeSecretFile(envPath, actualizado);
    return { changed: true, added, path: envPath };
}

module.exports = { syncEnvFile, blocksOf, assignmentKey };

if (require.main === module) {
    const ROOT = path.join(__dirname, '..', '..');
    const envPath = path.resolve(process.argv[2] || path.join(ROOT, '.env'));
    const examplePath = path.resolve(process.argv[3] || path.join(ROOT, '.env.example'));
    try {
        const resultado = syncEnvFile(envPath, examplePath);
        if (!resultado.changed) console.log('[env] No falta ninguna variable: el archivo no se tocó.');
        else console.log(`[env] Añadidas ${resultado.added.length} variables: ${resultado.added.join(', ')}`);
    } catch (error) {
        console.error(`[env] ${error.message}`);
        process.exitCode = 1;
    }
}

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXPRESSIONS = [
    'idle', 'content', 'relieved', 'happy', 'joy', 'excited', 'love', 'pleading', 'shy',
    'surprised', 'scared', 'curious', 'confused', 'dizzy', 'thinking', 'focus', 'suspicious',
    'unimpressed', 'smug', 'sly', 'bored', 'exasperated', 'worried', 'guilty', 'sad',
    'disgusted', 'annoyed', 'angry', 'sleepy', 'sleep'
];
const SCALES = [92, 96, 100, 104, 108, 104, 100, 96];
const ANGLES = [-4, -3, -1, 0, 1, 3, 4, 0];
const MAX_BYTES = 8 * 1024 * 1024;
const ASSET_DIRECTORY = path.resolve(__dirname, '../public/stickers/bbot-v3');
const SOURCE_DIRECTORY = path.resolve(__dirname, 'assets/bbot-v3');

function animationFrameCount(bytes) {
    let count = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > bytes.length - start) return 0;
        if (type === 'ANMF') count++;
        offset = start + size + (size & 1);
    }
    return count;
}

function webpHasAlpha(bytes) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > bytes.length - start) return false;
        if (type === 'VP8X' && size >= 1) return (bytes[start] & 0x10) !== 0;
        if (type === 'VP8L' && size >= 5 && bytes[start] === 0x2f)
            return (bytes[start + 4] & 0x10) !== 0;
        offset = start + size + (size & 1);
    }
    return false;
}

function runConvert(args) {
    execFileSync('convert', args, { stdio: 'inherit' });
}

function main() {
    const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-bbot-'));
    try {
        const stagedFiles = [];
        for (const expression of EXPRESSIONS) {
            const source = path.join(SOURCE_DIRECTORY, `${expression}.png`);
            const frames = SCALES.map((scale, index) => {
                const frame = path.join(stagingDirectory, `${expression}-${index}.png`);
                runConvert([
                    source, '-resize', `${scale}%`, '-rotate', String(ANGLES[index]), '-gravity', 'center',
                    '-background', 'none', '-extent', '256x256', `PNG32:${frame}`
                ]);
                return frame;
            });
            const output = path.join(stagingDirectory, `${expression}.webp`);
            const animationArgs = frames.flatMap(frame => ['-delay', '10', frame]);
            runConvert([
                ...animationArgs, '-loop', '0',
                '-define', 'webp:lossless=true', '-define', 'webp:method=6', output
            ]);
            const bytes = fs.readFileSync(output);
            const frameCount = animationFrameCount(bytes);
            const hasAlpha = webpHasAlpha(bytes);
            if (bytes.length > MAX_BYTES ||
                bytes.toString('ascii', 0, 4) !== 'RIFF' ||
                bytes.readUInt32LE(4) !== bytes.length - 8 ||
                bytes.toString('ascii', 8, 12) !== 'WEBP' ||
                !hasAlpha || frameCount !== SCALES.length) {
                throw new Error(`El WebP de "${expression}" no pasó la validación (alpha=${hasAlpha}, fotogramas=${frameCount}, bytes=${bytes.length}).`);
            }
            stagedFiles.push([output, path.join(ASSET_DIRECTORY, `${expression}.webp`)]);
            console.log(`${expression}: ${frameCount} fotogramas, ${bytes.length} bytes`);
        }
        for (const [staged, destination] of stagedFiles)
            fs.renameSync(staged, destination);
    } finally {
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
    }
}

main();

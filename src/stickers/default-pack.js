'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_BBOT_PACK_VERSION = '7s-reactions-v1';
const DEFAULT_BBOT_STICKERS = [
    ['idle', 'Neutral'],
    ['content', 'A gusto'],
    ['relieved', 'Aliviada'],
    ['happy', 'Feliz'],
    ['joy', 'Alegría'],
    ['excited', 'Emocionada'],
    ['love', 'Enamorada'],
    ['pleading', 'Suplicante'],
    ['shy', 'Tímida'],
    ['surprised', 'Sorprendida'],
    ['scared', 'Asustada'],
    ['curious', 'Curiosa'],
    ['confused', 'Confundida'],
    ['dizzy', 'Mareada'],
    ['thinking', 'Pensando'],
    ['focus', 'Concentrada'],
    ['suspicious', 'Sospechosa'],
    ['unimpressed', 'Indiferente'],
    ['smug', 'Engreída'],
    ['sly', 'Astuta'],
    ['bored', 'Aburrida'],
    ['exasperated', 'Exasperada'],
    ['worried', 'Preocupada'],
    ['guilty', 'Culpable'],
    ['sad', 'Triste'],
    ['disgusted', 'Asqueada'],
    ['annoyed', 'Molesta'],
    ['angry', 'Enojada'],
    ['sleepy', 'Soñolienta'],
    ['sleep', 'Dormida']
].map(([expression, label], position) => {
    const spanishTag = label.normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
    return {
        expression,
        label,
        tags: ['bbot', expression, spanishTag].join(','),
        position
    };
});

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

function runGenerator(generatorPath, outputDirectory) {
    execFileSync(process.execPath, [generatorPath, outputDirectory], { stdio: 'inherit' });
}

function seedDefaultBbotStickers(db, assetDirectory = process.env.BBOT_STICKER_PACK_DIR || null) {
    const currentRows = db.prepare('SELECT expression, hash, sticker FROM default_stickers').all();
    const rowsByExpression = new Map(currentRows.map(row => [row.expression, row]));
    const { Stmt } = require('../db/statements.js');
    const storedPackVersion = db.prepare('SELECT value FROM meta WHERE key = ?')
        .get('default_bbot_pack_version')?.value;
    const packIsStored = storedPackVersion === DEFAULT_BBOT_PACK_VERSION &&
        currentRows.length === DEFAULT_BBOT_STICKERS.length &&
        DEFAULT_BBOT_STICKERS.every(({ expression }) => {
            const row = rowsByExpression.get(expression);
            return row && /^[a-f0-9]{64}$/i.test(row.hash) && Stmt.hasBlob.get(row.hash);
        });

    const insert = db.prepare(`INSERT INTO default_stickers
        (expression, hash, label, tags, sticker, position) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(expression) DO UPDATE SET hash = excluded.hash, label = excluded.label,
        tags = excluded.tags, sticker = excluded.sticker, position = excluded.position`);
    const expressions = DEFAULT_BBOT_STICKERS.map(({ expression }) => expression);
    const removeStale = db.prepare(`DELETE FROM default_stickers WHERE expression NOT IN
        (${expressions.map(() => '?').join(',')})`);
    const updatePackVersion = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    const saveCatalog = stickers => {
        const seed = db.transaction(() => {
            for (const sticker of stickers)
                insert.run(sticker.expression, sticker.hash, sticker.label, sticker.tags, sticker.sticker, sticker.position);
            removeStale.run(...expressions);
            updatePackVersion.run('default_bbot_pack_version', DEFAULT_BBOT_PACK_VERSION);
        });
        seed();
    };

    if (packIsStored) {
        saveCatalog(DEFAULT_BBOT_STICKERS.map(sticker => {
            const hash = rowsByExpression.get(sticker.expression).hash.toLowerCase();
            return { ...sticker, hash, sticker: `/stickers/blob/${hash}` };
        }));
        return DEFAULT_BBOT_STICKERS.length;
    }

    const generatorPath = path.resolve(__dirname, '../../ops/scripts/generate-animated-bbot-pack.js');
    let generatedDirectory = null;
    if (!assetDirectory)
        generatedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-bbot-pack-'));
    const packDirectory = assetDirectory || generatedDirectory;
    try {
        if (!assetDirectory) {
            runGenerator(generatorPath, packDirectory);
        }
        const { storeBlob } = require('../chat/media.js');
        const generatedStickers = DEFAULT_BBOT_STICKERS.map(sticker => {
            const filePath = path.join(packDirectory, `${sticker.expression}.webp`);
            const bytes = fs.readFileSync(filePath);
            if (bytes.length < 30 || bytes.length > 8 * 1024 * 1024 ||
                bytes.toString('ascii', 0, 4) !== 'RIFF' ||
                bytes.readUInt32LE(4) !== bytes.length - 8 ||
                bytes.toString('ascii', 8, 12) !== 'WEBP' || !webpHasAlpha(bytes))
                throw new Error(`El sticker bbot "${sticker.expression}" no es un WebP válido o no tiene transparencia.`);
            const hash = crypto.createHash('sha256').update(bytes).digest('hex');
            if (!storeBlob(hash, `data:image/webp;base64,${bytes.toString('base64')}`))
                throw new Error(`No se pudo guardar el sticker bbot "${sticker.expression}" en la biblioteca.`);
            return { ...sticker, hash, sticker: `/stickers/blob/${hash}` };
        });
        saveCatalog(generatedStickers);
        return DEFAULT_BBOT_STICKERS.length;
    } finally {
        if (generatedDirectory)
            fs.rmSync(generatedDirectory, { recursive: true, force: true });
    }
}

module.exports = {
    DEFAULT_BBOT_STICKERS,
    DEFAULT_BBOT_PACK_VERSION,
    seedDefaultBbotStickers
};

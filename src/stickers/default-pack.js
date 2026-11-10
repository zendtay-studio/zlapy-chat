'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
        sticker: `/stickers/bbot-v3/${expression}.webp`,
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

function seedDefaultBbotStickers(db, assetDirectory = path.resolve(__dirname, '../../public/stickers/bbot-v3')) {
    const insert = db.prepare(`INSERT INTO default_stickers
        (expression, hash, label, tags, sticker, position) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(expression) DO UPDATE SET hash = excluded.hash, label = excluded.label,
        tags = excluded.tags, sticker = excluded.sticker, position = excluded.position`);
    const expressions = DEFAULT_BBOT_STICKERS.map(({ expression }) => expression);
    const removeStale = db.prepare(`DELETE FROM default_stickers WHERE expression NOT IN
        (${expressions.map(() => '?').join(',')})`);
    const seed = db.transaction(() => {
        for (const sticker of DEFAULT_BBOT_STICKERS) {
            const filePath = path.join(assetDirectory, `${sticker.expression}.webp`);
            const bytes = fs.readFileSync(filePath);
            if (bytes.length < 30 || bytes.length > 8 * 1024 * 1024 ||
                bytes.toString('ascii', 0, 4) !== 'RIFF' ||
                bytes.readUInt32LE(4) !== bytes.length - 8 ||
                bytes.toString('ascii', 8, 12) !== 'WEBP' || !webpHasAlpha(bytes))
                throw new Error(`El sticker bbot "${sticker.expression}" no es un WebP válido o no tiene transparencia.`);
            const hash = crypto.createHash('sha256').update(bytes).digest('hex');
            insert.run(sticker.expression, hash, sticker.label, sticker.tags, sticker.sticker, sticker.position);
        }
        removeStale.run(...expressions);
    });
    seed();
    return DEFAULT_BBOT_STICKERS.length;
}

module.exports = {
    DEFAULT_BBOT_STICKERS,
    seedDefaultBbotStickers
};

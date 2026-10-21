/**
 * Avatares por defecto.
 *
 * Genera un SVG determinista a partir del identificador de la cuenta (o del
 * grupo) para que cada uno tenga una imagen estable sin necesidad de subir
 * una. Los dos diseños son distintos a propósito: el de persona es un
 * identicon de pixeles y el de grupo es una "inicial geométrica" con forma
 * de escudo, para que se distingan de un vistazo en la lista.
 */

const crypto = require('crypto');

/* Identicon de pixeles (personas). */
function createDefaultAvatarSvg(accountId) {
    const hash = crypto.createHash('sha256').update(accountId).digest();
    const hue = hash.readUInt16BE(10) % 360;
    const saturation = 55 + (hash[12] % 16);
    const lightness = 84 + (hash[13] % 8);
    const background = `hsl(${hue} ${saturation}% ${lightness}%)`;
    const pattern = `hsl(${hue} ${Math.min(100, saturation + 8)}% ${lightness - 12}%)`;
    const cells = [];
    const inset = 1;
    const cellSize = 9.8;
    for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 5; col++) {
            if ((hash[row] >> col) & 1) {
                const y = Number((inset + row * cellSize).toFixed(1));
                const left = Number((inset + col * cellSize).toFixed(1));
                const right = Number((inset + (9 - col) * cellSize).toFixed(1));
                cells.push(`<rect x="${left}" y="${y}" width="${cellSize}" height="${cellSize}"/>`);
                if (col < 5) cells.push(`<rect x="${right}" y="${y}" width="${cellSize}" height="${cellSize}"/>`);
            }
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#171717"/><rect x="${inset}" y="${inset}" width="98" height="98" fill="${background}"/><g fill="${pattern}">${cells.join('')}</g></svg>`;
}

/* Avatar de grupo: escudo con dos tonos y una inicial geométrica derivada
   del UUID interno del grupo. Es un diseño propio, distinto al de las
   personas, para que un grupo sin foto no parezca una foto más. */
function createDefaultGroupAvatarSvg(groupId) {
    const hash = crypto.createHash('sha256').update('group:' + groupId).digest();
    const hue = hash.readUInt16BE(4) % 360;
    const hue2 = (hue + 28 + (hash[5] % 40)) % 360;
    const saturation = 58 + (hash[6] % 18);
    const lightness = 46 + (hash[7] % 12);
    const background = `hsl(${hue} ${saturation}% ${lightness}%)`;
    const shape = `hsl(${hue2} ${saturation}% ${Math.max(24, lightness - 22)}%)`;
    const highlight = `hsl(${hue2} ${Math.min(96, saturation + 16)}% ${Math.min(92, lightness + 34)}%)`;
    // Tres barras de altura variable: la "inicial" geometrica del grupo.
    const bars = [];
    const baseY = 76;
    for (let i = 0; i < 3; i++) {
        const height = 12 + ((hash[8 + i] % 5) * 6);
        const width = 12;
        const x = 26 + i * 17;
        bars.push(`<rect x="${x}" y="${baseY - height}" width="${width}" height="${height}" rx="4"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${background}"/><stop offset="1" stop-color="${shape}"/></linearGradient></defs>
<rect width="100" height="100" fill="#141a1f"/>
<circle cx="50" cy="50" r="50" fill="url(#g)"/>
<g fill="${highlight}">${bars.join('')}</g>
</svg>`;
}

module.exports = { createDefaultAvatarSvg, createDefaultGroupAvatarSvg };

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'public', 'files', 'emoji-test.txt');
const outputDirectory = path.join(root, 'public', 'files', 'emoji');
const indexPath = path.join(outputDirectory, 'index.json');

const groupLabels = {
    'Smileys & Emotion': ['Caras y emociones', '😀'],
    'People & Body': ['Personas y cuerpo', '👋'],
    'Animals & Nature': ['Animales y naturaleza', '🐻'],
    'Food & Drink': ['Comida y bebida', '🍔'],
    'Travel & Places': ['Viajes y lugares', '🚗'],
    Activities: ['Actividades', '⚽'],
    Objects: ['Objetos', '💡'],
    Symbols: ['Símbolos', '❤️'],
    Flags: ['Banderas', '🏳️']
};

const subgroupLabels = {
    'face-smiling': 'Caras sonrientes',
    'face-affection': 'Caras de cariño',
    'face-tongue': 'Caras con lengua',
    'face-hand': 'Caras con mano',
    'face-neutral-skeptical': 'Caras neutrales o escépticas',
    'face-sleepy': 'Caras con sueño',
    'face-unwell': 'Caras enfermas',
    'face-hat': 'Caras con sombrero',
    'face-glasses': 'Caras con gafas',
    'face-concerned': 'Caras preocupadas',
    'face-negative': 'Caras negativas',
    'face-costume': 'Disfraces de caras',
    'cat-face': 'Caras de gato',
    'monkey-face': 'Caras de mono',
    heart: 'Corazones',
    emotion: 'Emociones',
    'hand-fingers-open': 'Manos con dedos abiertos',
    'hand-fingers-partial': 'Manos con dedos parcialmente abiertos',
    'hand-single-finger': 'Gestos con un dedo',
    'hand-fingers-closed': 'Manos con dedos cerrados',
    hands: 'Gestos con las manos',
    'hand-prop': 'Manos con objetos',
    'body-parts': 'Partes del cuerpo',
    person: 'Personas',
    'person-gesture': 'Gestos de personas',
    'person-role': 'Profesiones y roles',
    'person-fantasy': 'Personajes fantásticos',
    'person-activity': 'Actividades de personas',
    'person-sport': 'Deportes',
    'person-resting': 'Personas descansando',
    family: 'Familia',
    'person-symbol': 'Símbolos de personas',
    'animal-mammal': 'Mamíferos',
    'animal-bird': 'Aves',
    'animal-amphibian': 'Anfibios',
    'animal-reptile': 'Reptiles',
    'animal-marine': 'Animales marinos',
    'animal-bug': 'Insectos y otros animales pequeños',
    'plant-flower': 'Flores',
    'plant-other': 'Otras plantas',
    'food-fruit': 'Frutas',
    'food-vegetable': 'Verduras',
    'food-prepared': 'Comida preparada',
    'food-asian': 'Comida asiática',
    'food-sweet': 'Dulces',
    drink: 'Bebidas',
    dishware: 'Vajilla',
    'place-map': 'Mapas',
    'place-geographic': 'Lugares geográficos',
    'place-building': 'Edificios',
    'place-religious': 'Lugares religiosos',
    'place-other': 'Otros lugares',
    'transport-ground': 'Transporte terrestre',
    'transport-water': 'Transporte acuático',
    'transport-air': 'Transporte aéreo',
    hotel: 'Alojamiento',
    time: 'Tiempo',
    'sky & weather': 'Cielo y clima',
    event: 'Eventos',
    'award-medal': 'Medallas y premios',
    sport: 'Deportes',
    game: 'Juegos',
    'arts & crafts': 'Arte y manualidades',
    clothing: 'Ropa',
    sound: 'Sonido',
    music: 'Música',
    'musical-instrument': 'Instrumentos musicales',
    phone: 'Teléfonos',
    computer: 'Informática',
    'light & video': 'Luz y vídeo',
    'book-paper': 'Libros y papel',
    money: 'Dinero',
    mail: 'Correo',
    writing: 'Escritura',
    office: 'Oficina',
    lock: 'Cerraduras',
    tool: 'Herramientas',
    science: 'Ciencia',
    medical: 'Salud y medicina',
    household: 'Hogar',
    'other-object': 'Otros objetos',
    'transport-sign': 'Señales de transporte',
    warning: 'Advertencias',
    arrow: 'Flechas',
    religion: 'Religión',
    zodiac: 'Zodiaco',
    'av-symbol': 'Símbolos audiovisuales',
    gender: 'Género',
    math: 'Matemáticas',
    punctuation: 'Puntuación',
    currency: 'Monedas',
    'other-symbol': 'Otros símbolos',
    keycap: 'Teclas',
    alphanum: 'Símbolos alfanuméricos',
    geometric: 'Figuras geométricas',
    flag: 'Banderas',
    'country-flag': 'Banderas de países',
    'subdivision-flag': 'Banderas regionales'
};

const groups = [];
let currentGroup = null;
let currentSubgroup = null;
const seen = new Set();
const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);

for (const line of lines) {
    let match = line.match(/^# group: (.+)$/);
    if (match) {
        const sourceName = match[1];
        const [label, icon] = groupLabels[sourceName] || [sourceName, '✨'];
        currentGroup = {
            id: sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            sourceName,
            label,
            icon,
            subgroups: []
        };
        groups.push(currentGroup);
        currentSubgroup = null;
        continue;
    }

    match = line.match(/^# subgroup: (.+)$/);
    if (match) {
        if (!currentGroup) throw new Error('El archivo Unicode contiene un subgrupo sin categoría.');
        const sourceName = match[1];
        currentSubgroup = {
            id: sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            sourceName,
            label: subgroupLabels[sourceName] || sourceName.replace(/[-_]/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
            emojis: []
        };
        currentGroup.subgroups.push(currentSubgroup);
        continue;
    }

    match = line.match(/^([0-9A-F ]+)\s*;\s*(fully-qualified)\s+#\s+(\S+)\s+E[\d.]+\s+(.+)$/);
    if (!match) continue;
    if (!currentGroup || !currentSubgroup) throw new Error('Emoji sin categoría o subgrupo en el archivo Unicode.');

    const code = match[1].trim().toLowerCase().replace(/ /g, '-');
    if (seen.has(code)) continue;
    seen.add(code);
    currentSubgroup.emojis.push({
        emoji: match[3],
        code,
        name: match[4]
    });
}

for (const group of groups) {
    group.subgroups = group.subgroups.filter(subgroup => subgroup.emojis.length);
}
const populatedGroups = groups.filter(group => group.subgroups.length);
const emojiCount = populatedGroups.reduce((count, group) =>
    count + group.subgroups.reduce((subtotal, subgroup) => subtotal + subgroup.emojis.length, 0), 0);

if (emojiCount < 1000 || populatedGroups.length < 9) {
    throw new Error(`Catálogo Unicode incompleto: ${emojiCount} emojis en ${populatedGroups.length} categorías.`);
}

fs.mkdirSync(outputDirectory, { recursive: true });
const index = populatedGroups.map(({ id, sourceName, label, icon }) => ({
    id,
    sourceName,
    label,
    icon,
    file: `${id}.json`
}));

for (const group of populatedGroups) {
    fs.writeFileSync(
        path.join(outputDirectory, `${group.id}.json`),
        `${JSON.stringify(group)}\n`,
        'utf8'
    );
}
fs.writeFileSync(indexPath, `${JSON.stringify({
    unicodeVersion: '18.0',
    source: 'emoji-test.txt',
    license: 'https://www.unicode.org/terms_of_use.html',
    groups: index
})}\n`, 'utf8');

console.log(`Generated ${populatedGroups.length} category JSON files and an index for ${emojiCount} emojis in ${populatedGroups.reduce((n, group) => n + group.subgroups.length, 0)} subgroups.`);

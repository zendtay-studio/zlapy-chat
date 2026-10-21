/**
 * Normalización de la apariencia del chat.
 *
 * Valida los campos que el cliente envía (colores, opacidad, desenfoque,
 * tamaño de letra y fondo de pantalla) y devuelve la apariencia completa,
 * conservando del envío anterior lo que no se ha especificado.
 */

const REQUIRED_FIELDS = ['wall', 'opacity', 'blur', 'sender', 'receiver', 'fontSize'];
const COLOR_FIELDS = ['wall', 'sender', 'receiver', 'senderText', 'receiverText'];
const ALLOWED_FIELDS = [...REQUIRED_FIELDS, 'senderText', 'receiverText', 'image', 'autoText'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const WALLPAPER_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_WALLPAPER_LENGTH = 8 * 1024 * 1024;

function normalizeChatAppearanceSettings(settings, previous = {}) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        Object.keys(settings).some(key => !ALLOWED_FIELDS.includes(key)) ||
        REQUIRED_FIELDS.some(key => !Object.prototype.hasOwnProperty.call(settings, key))) return null;

    if (COLOR_FIELDS.some(key => Object.prototype.hasOwnProperty.call(settings, key) &&
        (typeof settings[key] !== 'string' || !COLOR_RE.test(settings[key])))) return null;

    if (!Number.isFinite(settings.opacity) || settings.opacity < 0 || settings.opacity > 80 ||
        !Number.isFinite(settings.blur) || settings.blur < 0 || settings.blur > 20 ||
        !Number.isFinite(settings.fontSize) || settings.fontSize < 12 || settings.fontSize > 22) return null;

    const image = Object.prototype.hasOwnProperty.call(settings, 'image') ? settings.image : (previous.image || '');
    if (typeof image !== 'string' || image.length > MAX_WALLPAPER_LENGTH ||
        (image !== '' && !WALLPAPER_RE.test(image))) return null;

    return {
        autoText: settings.autoText === undefined ? (previous.autoText !== false) : !!settings.autoText,
        wall: settings.wall,
        opacity: settings.opacity,
        blur: settings.blur,
        sender: settings.sender,
        receiver: settings.receiver,
        senderText: settings.senderText || previous.senderText || '#101318',
        receiverText: settings.receiverText || previous.receiverText || '#d5dce2',
        image,
        fontSize: settings.fontSize
    };
}

module.exports = { normalizeChatAppearanceSettings };

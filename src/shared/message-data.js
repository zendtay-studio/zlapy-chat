/**
 * Datos de mensaje.
 *
 * Descifra los campos de texto de un mensaje que llegan en el formato de
 * cifrado en reposo heredado, para que el resto del servidor los lea en
 * claro.
 */

function decryptLegacyMessageFields(message, decryptAtRest) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const output = { ...message };

    for (const field of ['data', 'text', 'name', 'caption']) {
        if (typeof output[field] === 'string') output[field] = decryptAtRest(output[field]);
    }

    if (output.reply && typeof output.reply === 'object' && !Array.isArray(output.reply) &&
        typeof output.reply.preview === 'string') {
        output.reply = { ...output.reply, preview: decryptAtRest(output.reply.preview) };
    }

    return output;
}

module.exports = { decryptLegacyMessageFields };

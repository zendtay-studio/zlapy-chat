/**
 * Tipos de contenido estructurado.
 *
 * Normaliza y valida los datos de encuestas y tarjetas de contacto que
 * viajan dentro de un mensaje, y calcula el cambio de votos de una
 * encuesta.
 */

function normalizePollData(value) {
    let poll;
    try {
        poll = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return null;
    }
    if (!poll || typeof poll !== 'object' || Array.isArray(poll) ||
        typeof poll.question !== 'string' || !poll.question.trim() || poll.question.length > 240 ||
        !Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 8) return null;

    const ids = new Set();
    const options = [];
    for (const option of poll.options) {
        if (!option || typeof option.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(option.id) ||
            ids.has(option.id) || typeof option.text !== 'string' || !option.text.trim() || option.text.length > 100) return null;
        ids.add(option.id);
        options.push({ id: option.id, text: option.text.trim() });
    }
    return {
        question: poll.question.trim(),
        options,
        allowMultiple: poll.allowMultiple === true,
        votes: {}
    };
}

function togglePollVote(votes, userId, optionId, allowMultiple) {
    const nextVotes = { ...(votes && typeof votes === 'object' && !Array.isArray(votes) ? votes : {}) };
    const previous = nextVotes[userId];
    const selected = Array.isArray(previous) ? previous
        : typeof previous === 'string' ? [previous] : [];
    const next = allowMultiple
        ? selected.includes(optionId) ? selected.filter(id => id !== optionId) : [...selected, optionId]
        : selected.includes(optionId) ? [] : [optionId];
    if (next.length) nextVotes[userId] = next;
    else delete nextVotes[userId];
    return nextVotes;
}

function normalizeContactData(value, findContact) {
    let contact;
    try {
        contact = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return null;
    }
    if (!contact || typeof contact !== 'object' || Array.isArray(contact) ||
        typeof contact.username !== 'string' || contact.username.length > 24) return null;
    const account = findContact(contact.username);
    if (!account) return null;
    return { username: account.username };
}

module.exports = { normalizePollData, normalizeContactData, togglePollVote };

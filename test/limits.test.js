const assert = require('node:assert/strict');
const test = require('node:test');

/* Este test comprueba los limites POR DEFECTO (los documentados). Se fijan
   antes de cargar la configuracion porque dotenv NO pisa las variables que ya
   estan en process.env: asi el resultado no depende del `.env` de cada
   maquina (que puede subir, por ejemplo, el limite de la descripcion del
   perfil) y el test sigue siendo determinista. */
process.env.MESSAGE_DIRECT_CHAR_LIMIT = '10000';
process.env.MESSAGE_GROUP_CHAR_LIMIT = '15000';
process.env.STORY_TEXT_CHAR_LIMIT = '140';
process.env.PROFILE_DESCRIPTION_CHAR_LIMIT = '140';
process.env.MESSAGE_RATE_LIMIT = '30';
process.env.MESSAGE_RATE_WINDOW_MS = '60000';

const { MESSAGE_LIMITS, characterCount, createMessageRateLimiter } = require('../src/shared/limits.js');

test('uses separate text limits and counts Unicode code points as characters', () => {
    assert.equal(MESSAGE_LIMITS.directMessageCharacters, 10_000);
    assert.equal(MESSAGE_LIMITS.groupMessageCharacters, 15_000);
    assert.equal(MESSAGE_LIMITS.storyCharacters, 140);
    assert.equal(MESSAGE_LIMITS.profileDescriptionCharacters, 140);
    assert.equal(characterCount('x'.repeat(MESSAGE_LIMITS.directMessageCharacters)), 10_000);
    assert.equal(characterCount('x'.repeat(MESSAGE_LIMITS.groupMessageCharacters)), 15_000);
    assert.equal(characterCount('x'.repeat(MESSAGE_LIMITS.storyCharacters + 1)), 141);
    assert.equal(characterCount('a😀b'), 3);
});

test('the limits follow the environment when it is configured', () => {
    // Con el entorno fijo, el modulo lee esos valores; si el .env los cambia,
    // el limite cambia con el (es lo que se quiere en produccion).
    const { CONFIG } = require('../src/config.js');
    assert.equal(MESSAGE_LIMITS.profileDescriptionCharacters, CONFIG.profileDescriptionCharacters);
    assert.equal(MESSAGE_LIMITS.directMessageCharacters, CONFIG.directMessageCharacters);
    assert.equal(MESSAGE_LIMITS.groupMessageCharacters, CONFIG.groupMessageCharacters);
});

test('allows 30 messages and rejects the 31st within one minute', () => {
    const limiter = createMessageRateLimiter();
    for (let index = 0; index < MESSAGE_LIMITS.messagesPerMinute; index++)
        assert.equal(limiter.consume('account-a').allowed, true);
    assert.equal(limiter.consume('account-a').allowed, false);
});

test('limits sends per account in a sliding one-minute window', () => {
    let now = 1_000;
    const limiter = createMessageRateLimiter(2, 60_000, () => now);

    assert.deepEqual(limiter.consume('account-a'), { allowed: true, retryAfterMs: 0 });
    now += 1_000;
    assert.deepEqual(limiter.consume('account-a'), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(limiter.consume('account-a'), { allowed: false, retryAfterMs: 59_000 });
    assert.deepEqual(limiter.consume('account-b'), { allowed: true, retryAfterMs: 0 });
    now = 61_000;
    assert.deepEqual(limiter.consume('account-a'), { allowed: true, retryAfterMs: 0 });
});

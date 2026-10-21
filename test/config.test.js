const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const dotenv = require('dotenv');
const { DEFAULTS, loadConfig } = require('../src/config.js');

test('.env.example contains a valid configuration and expected defaults', () => {
    const examplePath = path.join(__dirname, '..', '.env.example');
    const env = dotenv.parse(fs.readFileSync(examplePath));
    const config = loadConfig(env);
    assert.equal(config.port, DEFAULTS.PORT);
    assert.equal(config.maxAudioDurationMs, DEFAULTS.MAX_AUDIO_DURATION_MS);
    assert.equal(config.sqliteCacheSizeKb, DEFAULTS.SQLITE_CACHE_SIZE_KB);
});

test('loads validated configurable defaults and supports .env overrides', () => {
    const config = loadConfig({ MESSAGE_RATE_LIMIT: '8', MAX_AUDIO_DURATION_MS: '90000' });
    assert.equal(config.port, DEFAULTS.PORT);
    assert.equal(config.messagesPerMinute, 8);
    assert.equal(config.maxAudioDurationMs, 90_000);
});

test('rejects invalid values and incompatible request size limits', () => {
    assert.throws(() => loadConfig({ PORT: '0' }), /PORT must be between/);
    assert.throws(() => loadConfig({ MESSAGE_RATE_LIMIT: 'many' }), /MESSAGE_RATE_LIMIT must be an integer/);
    assert.throws(() => loadConfig({
        MAX_HTTP_BODY_BYTES: '1024',
        MAX_MESSAGE_DATA_CHARS: '1025'
    }), /MAX_MESSAGE_DATA_CHARS cannot exceed/);
});

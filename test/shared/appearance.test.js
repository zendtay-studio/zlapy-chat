const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeChatAppearanceSettings } = require('../../src/shared/appearance.js');
const { api, register, startServer, stop } = require('../helpers.js');

const base = {
    wall: '#090c0f',
    opacity: 22,
    blur: 0,
    sender: '#f6dce5',
    receiver: '#f5eaf0',
    fontSize: 15
};

test('normalizes chat colors independently and persists the wallpaper in account settings', () => {
    const settings = normalizeChatAppearanceSettings({
        ...base,
        senderText: '#4b2835',
        receiverText: '#4b2835',
        image: 'data:image/jpeg;base64,Zm9v'
    });

    assert.equal(settings.senderText, '#4b2835');
    assert.equal(settings.receiverText, '#4b2835');
    assert.equal(settings.image, 'data:image/jpeg;base64,Zm9v');
});

test('preserves a saved wallpaper unless an explicit replacement or removal is sent', () => {
    const previous = { image: 'data:image/png;base64,b2xk' };
    assert.equal(
        normalizeChatAppearanceSettings(base, previous).image,
        previous.image
    );
    assert.equal(
        normalizeChatAppearanceSettings({ ...base, image: '' }, previous).image,
        ''
    );
    assert.equal(
        normalizeChatAppearanceSettings({ ...base, image: 'data:image/webp;base64,bmV3' }, previous).image,
        'data:image/webp;base64,bmV3'
    );
});

test('rejects invalid colors, fields, dimensions, and wallpaper payloads', () => {
    assert.equal(normalizeChatAppearanceSettings({ ...base, senderText: 'white' }), null);
    assert.equal(normalizeChatAppearanceSettings({ ...base, unknown: true }), null);
    assert.equal(normalizeChatAppearanceSettings({ ...base, fontSize: 23 }), null);
    assert.equal(normalizeChatAppearanceSettings({ ...base, image: 'data:image/svg+xml;base64,PHN2Zz4=' }), null);
    assert.equal(normalizeChatAppearanceSettings({ ...base, image: `data:image/jpeg;base64,${'A'.repeat(8 * 1024 * 1024)}` }), null);
});

test('persists the app accent on the server across a restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zlapy-appearance-restart-'));
    let server = await startServer({ dataDir });
    try {
        const account = await register(server.base, 'appearance');
        assert.equal(account.status, 201);
        const settings = {
            ...base,
            accent: '#00a884',
            senderText: '#4b2835',
            receiverText: '#4b2835',
            autoText: false,
            image: 'data:image/jpeg;base64,Zm9v'
        };
        const saved = await api(server.base, 'POST', '/account/chat-settings', { settings }, account.cookie);
        assert.equal(saved.status, 200);
        const loadedWallpaper = await api(server.base, 'GET', '/account/chat-settings', null, account.cookie);
        assert.equal(loadedWallpaper.json.settings.image, settings.image);
        const removed = await api(server.base, 'POST', '/account/chat-settings', {
            settings: { ...settings, image: '' }
        }, account.cookie);
        assert.equal(removed.status, 200);
        await stop(server);

        server = await startServer({ dataDir });
        const loaded = await api(server.base, 'GET', '/account/chat-settings', null, account.cookie);
        assert.equal(loaded.status, 200);
        assert.equal(loaded.json.settings.accent, settings.accent);
        assert.equal(loaded.json.settings.senderText, settings.senderText);
        assert.equal(loaded.json.settings.receiverText, settings.receiverText);
        assert.equal(loaded.json.settings.image, '');
    } finally {
        await stop(server);
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

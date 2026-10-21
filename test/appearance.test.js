const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeChatAppearanceSettings } = require('../src/shared/appearance.js');

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

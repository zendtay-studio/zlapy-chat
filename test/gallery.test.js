const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { validateGallery } = require('../src/shared/gallery.js');

const user = { id: 'user-1' };
const bytes = Buffer.from('gallery image');
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
const data = `data:image/png;base64,${bytes.toString('base64')}`;

test('validates uploaded gallery entries and bounds their metadata', () => {
    const stored = [];
    const gallery = validateGallery(user, [
        { hash: hash.toUpperCase(), mime: 'image/png', data, width: 14000, height: -1 },
        { hash, mime: 'image/webp', data, width: 640, height: 480 }
    ], () => false, (entryHash, entryData) => {
        stored.push([entryHash, entryData]);
        return entryHash.toLowerCase() === hash && entryData === data;
    });

    assert.deepEqual(gallery, [
        { hash, mime: 'image/png', width: 12000, height: 1 },
        { hash, mime: 'image/webp', width: 640, height: 480 }
    ]);
    assert.equal(stored.length, 2);
});

test('allows existing blobs only when the sender can access them', () => {
    const gallery = [
        { hash, mime: 'image/png' },
        { hash, mime: 'image/jpeg', data: '' }
    ];
    assert.deepEqual(
        validateGallery(user, gallery, (candidate, candidateHash) => candidate === user && candidateHash === hash, () => false),
        [
            { hash, mime: 'image/png', width: 0, height: 0 },
            { hash, mime: 'image/jpeg', width: 0, height: 0 }
        ]
    );
    assert.equal(validateGallery(user, gallery, () => false, () => false), null);
});

test('rejects invalid gallery entries and invalid uploaded blob data', () => {
    const dependencies = [() => true, () => false];
    assert.equal(validateGallery(user, [], ...dependencies), null);
    assert.equal(validateGallery(user, [{ hash, mime: 'image/png' }], ...dependencies), null);
    assert.equal(validateGallery(user, [
        { hash: 'bad-hash', mime: 'image/png', data },
        { hash, mime: 'image/png', data }
    ], ...dependencies), null);
    assert.equal(validateGallery(user, [
        { hash, mime: 'image/svg+xml', data },
        { hash, mime: 'image/png', data }
    ], ...dependencies), null);
    assert.equal(validateGallery(user, [
        { hash, mime: 'image/png', data: {} },
        { hash, mime: 'image/png', data }
    ], ...dependencies), null);
    assert.equal(validateGallery(user, [
        { hash, mime: 'image/png', data: 'invalid' },
        { hash, mime: 'image/png', data }
    ], () => false, () => false), null);
});

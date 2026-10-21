const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { decodeRequestPath, resolvePublicFile } = require('../src/shared/static-path.js');

test('decodes safe static paths and rejects traversal and platform-specific path tricks', () => {
    assert.equal(decodeRequestPath('/stories%2ehtml'), 'stories.html');
    for (const attack of [
        '/../server.js',
        '/%2e%2e/server.js',
        '/%2E%2E/server.js',
        '/%252e%252e%252fserver.js',
        '/..%5cserver.js',
        '/%25252e%25252e%25252fserver.js',
        '/C:/server.js',
        '/CON.txt',
        '/con .html',
        '/secret.',
        '/%00server.js'
    ]) assert.equal(decodeRequestPath(attack), null, attack);
});

test('only resolves existing regular public files under the canonical public root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-static-'));
    const root = path.join(parent, 'public');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'index.html'), 'public');
    fs.writeFileSync(path.join(parent, 'secret.html'), 'private');
    const sibling = path.join(parent, 'public-private');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'secret.html'), 'private');
    try {
        assert.equal(resolvePublicFile(root, '/'), fs.realpathSync(path.join(root, 'index.html')));
        assert.equal(resolvePublicFile(root, '/index.html'), fs.realpathSync(path.join(root, 'index.html')));
        assert.equal(resolvePublicFile(root, '/../secret.html'), null);
        assert.equal(resolvePublicFile(root, '/../public-private/secret.html'), null);
        assert.equal(resolvePublicFile(root, '/server.js'), null);
        assert.equal(resolvePublicFile(root, '/.env'), null);
        const linkPath = path.join(root, 'linked.html');
        try {
            fs.symlinkSync(path.join(parent, 'secret.html'), linkPath);
            assert.equal(resolvePublicFile(root, '/linked.html'), null);
        } catch (error) {
            if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
        }
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

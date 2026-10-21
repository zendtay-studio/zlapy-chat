const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { generateMasterKey } = require('../ops/generate-master-key.js');

test('generates a 32-byte Base64 key in an empty CHAT_MASTER_KEY assignment', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-master-key-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, '# key\r\nCHAT_MASTER_KEY=\r\nPORT=3000\r\n');

    generateMasterKey(envPath);

    const contents = fs.readFileSync(envPath, 'utf8');
    const key = contents.match(/^CHAT_MASTER_KEY=(.+)$/m)[1];
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.match(contents, /^PORT=3000$/m);
    assert.match(contents, /\r\n/);
});

test('does not overwrite an existing key', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-master-key-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const envPath = path.join(directory, '.env');
    const contents = 'CHAT_MASTER_KEY=existing-key\r\n';
    fs.writeFileSync(envPath, contents);

    assert.throws(() => generateMasterKey(envPath), /npm run key -- --force.*npm run key -- -f/);
    assert.equal(fs.readFileSync(envPath, 'utf8'), contents);
});

test('replaces an existing key only when force is enabled', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-master-key-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, 'CHAT_MASTER_KEY=old-key\r\nPORT=3000\r\n');

    generateMasterKey(envPath, { force: true });

    const contents = fs.readFileSync(envPath, 'utf8');
    const key = contents.match(/^CHAT_MASTER_KEY=(.+)$/m)[1];
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.notEqual(key, 'old-key');
    assert.match(contents, /^PORT=3000$/m);
});

test('clears the existing key assignment when clear is enabled', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-master-key-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, '# key\r\nCHAT_MASTER_KEY=existing-key\r\nPORT=3000\r\n');

    generateMasterKey(envPath, { clear: true });

    const contents = fs.readFileSync(envPath, 'utf8');
    assert.match(contents, /^CHAT_MASTER_KEY=$/m);
    assert.match(contents, /^PORT=3000$/m);
    assert.match(contents, /\r\n/);
});

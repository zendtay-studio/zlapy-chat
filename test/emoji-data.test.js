const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public', 'files', 'emoji-test.txt'), 'utf8');
const emojiDirectory = path.join(root, 'public', 'files', 'emoji');
const index = JSON.parse(fs.readFileSync(path.join(emojiDirectory, 'index.json'), 'utf8'));

test('generated category JSON contains all Unicode 18 fully-qualified emojis grouped by subgroup', () => {
    const expected = source.split(/\r?\n/).flatMap(line => {
        const match = line.match(/^([0-9A-F ]+)\s*;\s*fully-qualified\s+#\s+(\S+)\s+E[\d.]+\s+(.+)$/);
        return match ? [{ code: match[1].trim().toLowerCase().replace(/ /g, '-'), emoji: match[2], name: match[3] }] : [];
    });
    assert.equal(index.unicodeVersion, '18.0');
    const groups = index.groups.map(entry => {
        assert.match(entry.file, /^[a-z0-9-]+\.json$/);
        const group = JSON.parse(fs.readFileSync(path.join(emojiDirectory, entry.file), 'utf8'));
        assert.equal(group.id, entry.id);
        return group;
    });
    const actual = groups.flatMap(group => group.subgroups.flatMap(subgroup =>
        subgroup.emojis.map(({ code, emoji, name }) => ({ code, emoji, name }))));

    assert.equal(groups.length, 9);
    assert.ok(groups.every(group => group.label && group.icon && group.subgroups.length));
    assert.ok(groups.every(group => group.label && group.icon && group.subgroups.length));
    assert.ok(groups.every(group => group.subgroups.every(subgroup => subgroup.label && subgroup.emojis.length)));
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.equal(new Set(actual.map(item => item.code)).size, actual.length);
});

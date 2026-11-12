'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const publicDir = path.join(__dirname, '../../public');
const pages = [
    'index.html',
    'sticker-creator.html',
    'group-create.html',
    'group-details.html',
    'group-details-demo.html',
    'stories.html',
    'privacy.html',
    'view.html',
    'profile.html',
    'login.html'
];

test('all app pages load the shared native-selection guard', () => {
    for (const page of pages) {
        const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
        assert.match(html, /\/js\/interaction-guard\.js\?v=1/,
            `${page} includes the shared interaction guard`);
    }

    const shell = fs.readFileSync(path.join(publicDir, 'js/sw.js'), 'utf8');
    assert.match(shell, /\/js\/interaction-guard\.js\?v=1/);
});

test('the guard suppresses native menus except in editable fields', () => {
    const source = fs.readFileSync(path.join(publicDir, 'js/interaction-guard.js'), 'utf8');
    let handleContextMenu;
    const document = {
        addEventListener(type, handler, capture) {
            assert.equal(type, 'contextmenu');
            assert.equal(capture, true);
            handleContextMenu = handler;
        }
    };
    vm.runInNewContext(source, { document });

    let prevented = false;
    handleContextMenu({
        target: { nodeType: 1, closest: () => null },
        preventDefault() { prevented = true; }
    });
    assert.equal(prevented, true);

    prevented = false;
    handleContextMenu({
        target: { nodeType: 1, closest: selector => selector.includes('textarea') },
        preventDefault() { prevented = true; }
    });
    assert.equal(prevented, false);
});

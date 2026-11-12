'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const viewerPath = path.join(__dirname, '../../ops/db/db-viewer/viewer.js');

test('database viewer fetches the schema before rendering it', () => {
    const viewer = fs.readFileSync(viewerPath, 'utf8');
    assert.match(viewer, /const \[schema, graph\] = await Promise\.all\(\[\s*api\(withReveal\('\/api\/schema'\)\),\s*api\('\/api\/graph'\)\s*\]\)/);
});

test('database viewer keeps graph nodes in view and readable in 2D and 3D', () => {
    const viewer = fs.readFileSync(viewerPath, 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../../ops/db/db-viewer/index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../../ops/db/db-viewer/viewer.css'), 'utf8');
    assert.match(viewer, /const sceneScale = Math\.min\(view\.clientWidth, view\.clientHeight\) \* 0\.38 \/ extent/);
    assert.match(viewer, /state\.fitAfterSimulation = true/);
    assert.match(viewer, /function fit2D\(\)/);
    assert.match(viewer, /drawn\.sort\(\(a, b\) => a\._s - b\._s\)/);
    assert.match(css, /\.node2d text\s*\{[^}]*opacity: 0/s);
    assert.match(css, /\.world2d\.overview \.edge2d\s*\{[^}]*opacity: \.11/s);
    assert.match(html, /id="tgl-inferred"(?! checked)/);
});

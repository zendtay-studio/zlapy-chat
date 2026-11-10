const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');
const AnimatedWebP = require('../public/js/animated-webp.js');
const { DEFAULT_BBOT_STICKERS } = require('../src/stickers/default-pack.js');
const { startServer, stop, api, register } = require('./helpers.js');

function webpSquare(size = 512) {
    const bytes = Buffer.alloc(30);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WEBP', 8, 'ascii');
    bytes.write('VP8X', 12, 'ascii');
    bytes.writeUInt32LE(10, 16);
    const dimension = size - 1;
    bytes[24] = bytes[27] = dimension & 0xff;
    bytes[25] = bytes[28] = (dimension >>> 8) & 0xff;
    return bytes;
}

function gif512() {
    return Buffer.from([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x02, 0x00, 0x02,
        0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
        0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
    ]);
}

function staticWebpFrame() {
    const bytes = Buffer.alloc(24);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WEBP', 8, 'ascii');
    bytes.write('VP8 ', 12, 'ascii');
    bytes.writeUInt32LE(4, 16);
    bytes.set([0, 0, 0, 0], 20);
    return new Uint8Array(bytes);
}

function webpHasAlpha(bytes) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > bytes.length - start) return false;
        if (type === 'VP8X' && size >= 1) return (bytes[start] & 0x10) !== 0;
        if (type === 'VP8L' && size >= 5 && bytes[start] === 0x2f)
            return (bytes[start + 4] & 0x10) !== 0;
        offset = start + size + (size & 1);
    }
    return false;
}

function webpAnimationFrameCount(bytes) {
    let frames = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const type = bytes.toString('ascii', offset, offset + 4);
        const size = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (size > bytes.length - start) return 0;
        if (type === 'ANMF') frames++;
        offset = start + size + (size & 1);
    }
    return frames;
}

test('default bbot sticker files are transparent animated WebP', () => {
    for (const sticker of DEFAULT_BBOT_STICKERS) {
        const asset = fs.readFileSync(path.join(__dirname, '..', 'public', sticker.sticker));
        assert.equal(webpHasAlpha(asset), true, `${sticker.expression} has a transparent background`);
        assert.ok(webpAnimationFrameCount(asset) >= 20, `${sticker.expression} is an animated WebP (>=20 frames)`);
    }
});

test('creates private stickers, publishes tagged stickers voluntarily, and shares blobs with chat peers', async () => {
    const srv = await startServer();
    try {
        for (const [asset, contentType] of [
            ['/sticker-creator.html', 'text/html'],
            ['/js/appearance.js', 'javascript'],
            ['/js/animated-webp.js?v=1', 'javascript'],
            ['/js/sticker-editor.js?v=20', 'javascript'],
            ['/js/vendor/bbot-face.js', 'javascript'],
            ['/css/sticker-editor.css?v=22', 'text/css']
        ]) {
            const response = await fetch(srv.base + asset);
            assert.equal(response.status, 200, `${asset} is served`);
            assert.match(response.headers.get('content-type'), new RegExp(contentType));
        }
        const indexResponse = await fetch(srv.base + '/index.html');
        assert.equal(indexResponse.status, 200);
        const indexHtml = await indexResponse.text();
        const stickerCss = await (await fetch(srv.base + '/css/sticker-editor.css?v=22')).text();
        const favoritesButton = indexHtml.indexOf('id="stkTabFavs" class="on"');
        const zlapyButton = indexHtml.indexOf('id="stkSourceZlapy"');
        const giphyButton = indexHtml.indexOf('id="stkSourceGiphy"');
        const bbotButton = indexHtml.indexOf('id="stkSourceBbot"');
        assert.ok(favoritesButton >= 0 && favoritesButton < zlapyButton && zlapyButton < giphyButton && giphyButton < bbotButton,
            'sticker sources are ordered favorites, Zlapy, Giphy, bbot');
        assert.match(indexHtml, /id="stkTabFavs" class="on"[^>]*aria-selected="true"/);
        assert.doesNotMatch(indexHtml, /id="stickerSourceTabs"|id="stkTabSearch"/);
        assert.match(indexHtml, /<svg class="bbotFaceIcon"[\s\S]*?<circle class="bbotFaceHead"[^>]*><\/circle>[\s\S]*?<ellipse class="bbotFaceEye"/);
        assert.match(stickerCss, /\.bbotStickerTile\s*\{[^}]*justify-items: center/s);
        assert.doesNotMatch(stickerCss, /\.bbotStickerPreview\s*\{[^}]*background:/s);
        assert.match(indexHtml, /<aside id="stickerCreatorLayer" aria-hidden="true">[\s\S]*?class="stickerCreatorPanelInner"/);
        assert.match(indexHtml, /panel-sticker-creator/);
        assert.match(indexHtml, /id: 'create-sticker', label: 'Crear stricker'/);
        assert.match(indexHtml, /function loadBbotStickers/);
        assert.match(indexHtml, /fetch\('\/stickers\/discover\?tags=bbot&limit=48'\)/);
        assert.match(indexHtml, /id="stkSourceBbot"[^>]*aria-label="Stickers de caras bbot"/);
        assert.match(indexHtml, /className = 'stickerCreateTile bbotStickerCreateTile'/);
        assert.match(indexHtml, /createTile\.onclick = \(\) => openStickerCreator\(null, 'idle', \{\}, false\)/);
        assert.match(indexHtml, /tile\.onclick = \(\) => sendSticker\(sticker\.sticker\)/);
        assert.match(indexHtml, /if \(bbot && !bbot\.packaged\) items\.push/);
        assert.match(stickerCss, /#stickerGrid \.bbotStickerTile \.bbotStickerSavedImage\s*\{[^}]*background: radial-gradient/s);
        assert.match(indexHtml, /#stickerGrid \.bbotStickerTile/);
        assert.match(indexHtml, /const target = tile \|\| image/);
        assert.match(indexHtml, /if \(result\.sendAfterCreate\) sendSticker\(result\.sticker\)/);
        assert.match(indexHtml, /stickerSuppressClick = target/);
        assert.match(indexHtml, /event\.stopImmediatePropagation\(\)/);
        assert.match(indexHtml, /const stickerImageAvailable = m0 && m0\.kind === 'image' && !m0\.once/);
        assert.match(indexHtml, /item\.plain instanceof Blob/);
        assert.match(indexHtml, /id: 'sticker-image-' \+ index/);
        assert.match(indexHtml, /openStickerCreator\(selected\.item\.plain\)/);
        assert.match(indexHtml, /zlapy-sticker-edit-image/);
        const creatorHtml = await (await fetch(srv.base + '/sticker-creator.html')).text();
        assert.match(creatorHtml, /animated-webp\.js\?v=1/);
        assert.match(creatorHtml, /sticker-editor\.js\?v=21/);
        assert.match(creatorHtml, /id="stickerCreatorBbot"/);
        assert.match(creatorHtml, /id="stickerCreatorFormats"/);
        const editorResponse = await fetch(srv.base + '/js/sticker-editor.js?v=21');
        const editorScript = await editorResponse.text();
        assert.match(editorScript, /const VIDEO_FPS = \d+/);
        assert.match(editorScript, /formatMegabytes\(MAX_VIDEO_BYTES\)/);
        assert.match(editorScript, /formatMegabytes\(MAX_IMAGE_BYTES\)/);
        assert.match(editorScript, /formatMegabytes\(MAX_OUTPUT_BYTES\)/);
        assert.match(editorScript, /WebP animado de \$\{SIZE\} × \$\{SIZE\}/);
        assert.match(editorScript, /máximo \$\{VIDEO_SECONDS_MAX\} segundos a \$\{VIDEO_FPS\} FPS/);
        assert.match(editorScript, /Este GIF ya mide \$\{SIZE\} × \$\{SIZE\}/);
        assert.match(editorScript, /formats\.textContent = `Imágenes hasta \$\{formatMegabytes\(MAX_IMAGE_BYTES\)\}/);
        assert.match(editorScript, /fotogramas del tramo seleccionado directamente del video/);
        assert.doesNotMatch(editorScript, /compressTrimmedVideo|MediaRecorder|captureStream/);
        assert.match(editorScript, /Preparando el WebP animado del tramo/);
        assert.match(editorScript, /encodeAnimatedWebP\(frameCount, start\)/);
        assert.match(editorScript, /await videoPreview\.play\(\);\s*for \(let frame = 0; frame < frameCount; frame\+\+\) \{\s*await waitForVideoTime/);
        assert.match(editorScript, /Math\.round\(\(frame \+ 1\) \/ frameCount \* 100\)\}%/);
        assert.doesNotMatch(editorScript, /await seek\(asset, Math\.min\(asset\.duration, startAt \+ frame \/ VIDEO_FPS\)\)/);
        assert.match(editorScript, /AnimatedWebP\.mux\(frames, SIZE, SIZE\)/);
        assert.match(editorScript, /new File\(\[encoded\], 'stricker\.webp', \{ type: 'image\/webp' \}\)/);
        assert.match(editorScript, /event\.data\.type === 'zlapy-sticker-edit-image'/);
        assert.match(editorScript, /function openBbotEditor/);
        assert.match(editorScript, /async function renderBbotStickerFile/);
        assert.match(editorScript, /autoCreate === true/);
        assert.match(editorScript, /EXPRESSION_NAMES/);
        assert.match(editorScript, /canvas\.toBlob\(result => result[\s\S]+?image\/webp/);
        assert.match(editorScript, /result\.bbot = bbot/);
        assert.match(editorScript, /bbot: \{ \.\.\.settings \}/);
        assert.match(editorScript, /bbot: \{ \.\.\.initialSettings, expression \}/);
        assert.match(editorScript, /createStickerFromFile\(event\.data\.file\)/);
        assert.match(editorScript, /landing\.appendChild\(editorContent\)/);
        assert.doesNotMatch(editorScript, /document\.body\.appendChild/);
        assert.doesNotMatch(editorScript, /aria-modal/);
        assert.match(editorScript, /stagePointers = new Map\(\)/);
        assert.match(editorScript, /Math\.hypot\(second\.x - first\.x, second\.y - first\.y\)/);
        assert.match(editorScript, /stage\.addEventListener\('wheel'/);
        assert.doesNotMatch(editorScript, /Zoom del recorte/);
        assert.doesNotMatch(editorScript, /Reproducir tramo|stickerEditorPlay/);
        assert.match(editorScript, /trimPreviewTimer = setTimeout\(playTrimmedPreview, 140\)/);
        assert.match(editorScript, /videoPreview\.currentTime >= trimEnd/);
        assert.match(editorScript, /function minimumTrimStart\(\) \{\s*return Math\.max\(0, trimEnd - VIDEO_SECONDS_MAX\)/);
        assert.match(editorScript, /Math\.max\(minimumTrimStart\(\), Math\.min\(at, trimEnd - minimumClip\)\)/);
        assert.match(editorScript, /Math\.max\(minimumTrimStart\(\), Math\.min\(trimEnd - minimumClip, trimStart\)\)/);
        assert.match(editorScript, /class: 'stickerTrimPlayhead'/);
        const ana = await register(srv.base, 'stickerana');
        const beto = await register(srv.base, 'stickerbeto');
        const caro = await register(srv.base, 'stickercaro');
        const defaultPack = await api(srv.base, 'GET', '/stickers/discover?tags=bbot&limit=48', null, ana.cookie);
        assert.equal(defaultPack.status, 200);
        assert.equal(defaultPack.json.stickers.length, 30);
        assert.equal(defaultPack.json.stickers.find(sticker => sticker.expression === 'sad').tags.includes('triste'), true);
        assert.equal(defaultPack.json.stickers.find(sticker => sticker.expression === 'happy').tags.includes('happy'), true);
        for (const sticker of defaultPack.json.stickers) {
            const asset = fs.readFileSync(path.join(__dirname, '..', 'public', sticker.sticker));
            assert.equal(webpHasAlpha(asset), true, `${sticker.expression} has a transparent background`);
            assert.ok(webpAnimationFrameCount(asset) >= 20, `${sticker.expression} is an animated WebP (>=20 frames)`);
        }
        const sadTag = await api(srv.base, 'GET', '/stickers/discover?tags=triste', null, ana.cookie);
        assert.equal(sadTag.json.stickers.some(sticker => sticker.expression === 'sad'), true);
        assert.equal(sadTag.json.stickers.length, 1);
        await Promise.all(defaultPack.json.stickers.map(async sticker => {
            const image = await fetch(srv.base + sticker.sticker);
            assert.equal(image.status, 200, `${sticker.expression} asset is served`);
            assert.equal(image.headers.get('content-type'), 'image/webp');
            assert.equal(Buffer.from(await image.arrayBuffer()).toString('ascii', 8, 12), 'WEBP');
        }));
        const defaultFace = await fetch(srv.base + '/stickers/bbot-v3/sad.webp');
        assert.equal(defaultFace.status, 200);
        assert.equal(defaultFace.headers.get('content-type'), 'image/webp');
        const defaultFaceBytes = Buffer.from(await defaultFace.arrayBuffer());
        assert.equal(defaultFaceBytes.toString('ascii', 8, 12), 'WEBP');
        const createFromDefaultFace = await api(srv.base, 'POST', '/stickers/create', {
            data: `data:image/webp;base64,${defaultFaceBytes.toString('base64')}`
        }, ana.cookie);
        assert.equal(createFromDefaultFace.status, 201, 'the generated WebP is valid for normal sticker creation');
        const bytes = webpSquare(512);
        const data = `data:image/webp;base64,${bytes.toString('base64')}`;

        const invalid = await api(srv.base, 'POST', '/stickers/create', { data: 'data:image/svg+xml;base64,PHN2Zy8+' }, ana.cookie);
        assert.equal(invalid.status, 400);
        const created = await api(srv.base, 'POST', '/stickers/create', { data }, ana.cookie);
        assert.equal(created.status, 201);
        assert.equal(created.json.hash, crypto.createHash('sha256').update(bytes).digest('hex'));
        assert.equal(created.json.sticker, `/stickers/blob/${created.json.hash}`);

        const duplicate = await api(srv.base, 'POST', '/stickers/create', { data }, ana.cookie);
        assert.equal(duplicate.status, 201);
        assert.equal(duplicate.json.hash, created.json.hash);

        const webp256Bytes = webpSquare(256);
        const webp256 = await api(srv.base, 'POST', '/stickers/create', {
            data: `data:image/webp;base64,${webp256Bytes.toString('base64')}`
        }, ana.cookie);
        assert.equal(webp256.status, 201, '256 × 256 stickers are accepted when the editor size is configured to 256');
        const webp256Response = await fetch(srv.base + webp256.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(ana.cookie)}` }
        });
        assert.equal(webp256Response.headers.get('content-type'), 'image/webp');
        assert.deepEqual(Buffer.from(await webp256Response.arrayBuffer()), webp256Bytes);

        const gifBytes = gif512();
        const gif = await api(srv.base, 'POST', '/stickers/create', {
            data: `data:image/gif;base64,${gifBytes.toString('base64')}`,
            publish: true,
            tags: ['Reaction', 'happy']
        }, ana.cookie);
        assert.equal(gif.status, 201);
        assert.equal(gif.json.published, true);
        const gifResponse = await fetch(srv.base + gif.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(ana.cookie)}` }
        });
        assert.equal(gifResponse.headers.get('content-type'), 'image/gif');
        assert.deepEqual(Buffer.from(await gifResponse.arrayBuffer()), gifBytes);
        const animatedWebpBytes = Buffer.from(AnimatedWebP.mux([
            { bytes: staticWebpFrame(), duration: 167 },
            { bytes: staticWebpFrame(), duration: 167 }
        ], 512, 512));
        assert.equal(animatedWebpBytes.toString('ascii', 0, 4), 'RIFF');
        assert.equal(animatedWebpBytes.readUInt32LE(4), animatedWebpBytes.length - 8);
        assert.equal(animatedWebpBytes.toString('ascii', 8, 12), 'WEBP');
        assert.equal(animatedWebpBytes.toString('ascii', 12, 16), 'VP8X');
        assert.equal(animatedWebpBytes[20] & 0x02, 0x02, 'WebP animation flag is enabled');
        assert.equal((animatedWebpBytes.toString('ascii').match(/ANMF/g) || []).length, 2);
        const animatedWebp = await api(srv.base, 'POST', '/stickers/create', {
            data: `data:image/webp;base64,${animatedWebpBytes.toString('base64')}`
        }, ana.cookie);
        assert.equal(animatedWebp.status, 201);
        const animatedResponse = await fetch(srv.base + animatedWebp.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(ana.cookie)}` }
        });
        assert.equal(animatedResponse.headers.get('content-type'), 'image/webp');
        assert.deepEqual(Buffer.from(await animatedResponse.arrayBuffer()), animatedWebpBytes);
        const discover = await fetch(srv.base + '/stickers/discover?tags=reaction,happy', {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(beto.cookie)}` }
        });
        assert.equal(discover.status, 200);
        const discoverResult = await discover.json();
        assert.equal(discoverResult.stickers.length, 1);
        assert.equal(discoverResult.stickers[0].sticker, gif.json.sticker);
        assert.deepEqual(discoverResult.stickers[0].tags.sort(), ['happy', 'reaction']);
        const missing = await fetch(srv.base + '/stickers/discover?tags=missing', {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(beto.cookie)}` }
        });
        assert.equal((await missing.json()).stickers.length, 0);
        const publicGif = await fetch(srv.base + gif.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(caro.cookie)}` }
        });
        assert.equal(publicGif.status, 200);

        const blobDb = new Database(path.join(srv.dataDir, 'blob.db'), { readonly: true });
        try {
            assert.equal(blobDb.prepare('SELECT COUNT(*) AS count FROM blobs').get().count, 5);
        } finally { blobDb.close(); }

        const downloaded = await fetch(srv.base + created.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(ana.cookie)}` }
        });
        assert.equal(downloaded.status, 200);
        assert.equal(downloaded.headers.get('content-type'), 'image/webp');
        assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
        assert.equal((await fetch(srv.base + created.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(caro.cookie)}` }
        })).status, 404);

        await api(srv.base, 'POST', '/contacts', { username: 'stickerbeto' }, ana.cookie);
        const accepted = await api(srv.base, 'POST', '/contacts/respond', { username: 'stickerana', accept: true }, beto.cookie);
        assert.equal(accepted.json.ok, true);
        const sent = await api(srv.base, 'POST', '/send', {
            to: 'stickerbeto', kind: 'sticker', data: created.json.sticker
        }, ana.cookie);
        assert.equal(sent.status, 200);
        assert.equal(sent.json.ok, true);
        const sentDefault = await api(srv.base, 'POST', '/send', {
            to: 'stickerbeto', kind: 'sticker', data: '/stickers/bbot-v3/sad.webp'
        }, ana.cookie);
        assert.equal(sentDefault.status, 200);
        assert.equal(sentDefault.json.ok, true);
        const removedDefault = await fetch(srv.base + '/stickers/bbot-v2/sad.webp');
        assert.equal(removedDefault.status, 404, 'the previous bbot sticker URL is removed');
        const invalidOldDefault = await api(srv.base, 'POST', '/send', {
            to: 'stickerbeto', kind: 'sticker', data: '/stickers/bbot-v2/sad.webp'
        }, ana.cookie);
        assert.equal(invalidOldDefault.status, 400, 'the previous bbot sticker cannot be sent');
        const sentAnimated = await api(srv.base, 'POST', '/send', {
            to: 'stickerbeto', kind: 'sticker', data: animatedWebp.json.sticker
        }, ana.cookie);
        assert.equal(sentAnimated.status, 200);
        assert.equal(sentAnimated.json.ok, true);
        assert.equal((await fetch(srv.base + created.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(beto.cookie)}` }
        })).status, 200);
        assert.equal((await fetch(srv.base + animatedWebp.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(beto.cookie)}` }
        })).headers.get('content-type'), 'image/webp');

        const group = await api(srv.base, 'POST', '/groups', {
            name: 'stickers', visibility: 'public', joinPolicy: 'open'
        }, ana.cookie);
        assert.equal(group.status, 200);
        const joined = await api(srv.base, 'POST', `/groups/${group.json.id}`, { join: true }, beto.cookie);
        assert.equal(joined.status, 200);
        const groupSend = await api(srv.base, 'POST', `/groups/${group.json.id}`, {
            message: { kind: 'sticker', data: created.json.sticker }
        }, ana.cookie);
        assert.equal(groupSend.status, 200);
        assert.equal((await fetch(srv.base + created.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(beto.cookie)}` }
        })).status, 200);

        const db = new Database(path.join(srv.dataDir, 'zlapy.db'), { readonly: true });
        try {
            assert.equal(db.prepare('SELECT COUNT(*) AS count FROM user_sticker_blobs').get().count, 5);
        } finally { db.close(); }

        const unfavorited = await api(srv.base, 'POST', '/stickers', {
            stickers: [created.json.sticker, webp256.json.sticker, animatedWebp.json.sticker]
        }, ana.cookie);
        assert.equal(unfavorited.status, 200);
        assert.equal(unfavorited.json.stickers.includes(gif.json.sticker), false);
        const stillPublic = await fetch(srv.base + gif.json.sticker, {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(caro.cookie)}` }
        });
        assert.equal(stillPublic.status, 200, 'unfavoriting a published sticker keeps its blob available');
        const discoverAfterUnfavorite = await fetch(srv.base + '/stickers/discover?tags=reaction,happy', {
            headers: { Cookie: `chatlocal_session=${encodeURIComponent(beto.cookie)}` }
        });
        assert.equal(discoverAfterUnfavorite.status, 200);
        assert.equal((await discoverAfterUnfavorite.json()).stickers[0].sticker, gif.json.sticker);
    } finally { await stop(srv); }
});

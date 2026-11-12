const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { decodeRequestPath, resolvePublicFile } = require('../../src/shared/static-path.js');

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

test('todas las páginas públicas usan la tipografía Outfit local', () => {
    /* La app usa Outfit en todas sus páginas y la sirve desde /fonts: así no
       depende de Google en tiempo de ejecución y respeta `font-src 'self'`. */
    const publicDir = path.join(__dirname, '..', '..', 'public');
    const pages = fs.readdirSync(publicDir).filter(name => name.endsWith('.html'));
    assert.ok(pages.length > 0);
    for (const page of pages) {
        const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
        assert.match(html, /\/css\/fonts\.css/, `${page} debe cargar la tipografía compartida`);
        assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/,
            `${page} no debe depender de Google Fonts en tiempo de ejecución`);
    }

    const css = fs.readFileSync(path.join(publicDir, 'css', 'fonts.css'), 'utf8');
    assert.match(css, /font-family:\s*'Outfit'/);
    assert.match(css, /\/fonts\/outfit\/outfit-latin\.woff2/);
});

test('sirve las imágenes webp y la tipografía de la carpeta pública sin sesión', async () => {
    /* Los iconos del manifiesto y el isotipo del acceso son .webp: sin esta
       extensión en la lista pública, el navegador no lograba cargarlos antes
       de iniciar sesión. */
    const { startServer, stop } = require('../helpers.js');
    const srv = await startServer();
    try {
        const icono = await fetch(`${srv.base}/image/icon-192-border.webp`);
        assert.equal(icono.status, 200, 'el icono 192 debe servirse sin sesión');
        assert.equal(icono.headers.get('content-type'), 'image/webp', 'el MIME del webp debe ser correcto');
        assert.ok((await icono.arrayBuffer()).byteLength > 0);

        const isotipo = await fetch(`${srv.base}/image/isotype-512-full.webp`);
        assert.equal(isotipo.status, 200, 'el isotipo debe servirse sin sesión');

        // La tipografía también es un estático público: sin `.woff2` en la
        // lista de extensiones ni su MIME, la CSP la bloquearía.
        const cssFuente = await fetch(`${srv.base}/css/fonts.css`);
        assert.equal(cssFuente.status, 200);
        const fuente = await fetch(`${srv.base}/fonts/outfit/outfit-latin.woff2`);
        assert.equal(fuente.status, 200, 'la fuente debe servirse sin sesión');
        assert.equal(fuente.headers.get('content-type'), 'font/woff2', 'el MIME del woff2 debe ser correcto');
        assert.ok((await fuente.arrayBuffer()).byteLength > 0);

        // El PNG viejo ya no existe.
        assert.equal((await fetch(`${srv.base}/icon-192.png`)).status, 404);

        // El manifiesto apunta a las rutas nuevas.
        const manifest = await (await fetch(`${srv.base}/manifest.webmanifest`)).json();
        assert.ok(manifest.icons.every(icono => icono.src.startsWith('/image/')),
            'todos los iconos del manifiesto deben salir de /image/');
    } finally { await stop(srv); }
});

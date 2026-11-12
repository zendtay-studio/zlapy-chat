// Datos locales del navegador: auditoría y limpieza sin cerrar sesión.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ZL = require('../public/js/local-data.js');

/* Almacén Web Storage de mentira con la interfaz que usa el módulo. */
function fakeStorage(entries) {
    const map = new Map(Object.entries(entries || {}));
    return {
        get length() { return map.size; },
        key: i => [...map.keys()][i],
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: k => map.delete(k),
        clear: () => map.clear(),
        _map: map
    };
}

/* Cache Storage de mentira: names -> { url -> { size, type } } y las
   respuestas se miden por content-length salvo cuando no lo traen. */
function fakeCaches(caches) {
    const api = {
        keys: async () => Object.keys(caches),
        open: async name => ({
            keys: async () => Object.keys(caches[name]).map(url => ({ url })),
            match: async request => {
                const entry = caches[name][request.url];
                if (!entry) return undefined;
                const headers = new Map();
                if (entry.size !== null) headers.set('content-length', String(entry.size));
                if (entry.type) headers.set('content-type', entry.type);
                return {
                    headers: { get: k => headers.get(k) || null },
                    clone: () => ({ blob: async () => ({ size: entry.size === null ? entry.blobSize : entry.size, type: entry.type || '' }) })
                };
            }
        }),
        delete: async name => { delete caches[name]; return true; }
    };
    return api;
}

test('formatBytes uses bytes below 1 KB and one decimal above', () => {
    assert.equal(ZL.formatBytes(0), '0 B');
    assert.equal(ZL.formatBytes(-5), '0 B');
    assert.equal(ZL.formatBytes(512), '512 B');
    assert.equal(ZL.formatBytes(1024), '1.0 KB');
    assert.equal(ZL.formatBytes(1536), '1.5 KB');
    assert.equal(ZL.formatBytes(5 * 1024 * 1024), '5.0 MB');
    assert.equal(ZL.formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
});

test('measureText counts real UTF-8 bytes, not UTF-16 units', () => {
    assert.equal(ZL.measureText(''), 0);
    assert.equal(ZL.measureText('hola'), 4);
    assert.equal(ZL.measureText('añ'), 3); // ñ = 2 bytes
    assert.equal(ZL.measureText('🙂'), 4); // emoji = 4 bytes
});

test('classifyKey maps the real keys the app writes', () => {
    /* Apariencia: chatAppearanceKey, legacy, hint, wallpaper, migración. */
    assert.equal(ZL.classifyKey('zlapy_appearance_abc123'), 'apariencia');
    assert.equal(ZL.classifyKey('zlapy_appearance_beto'), 'apariencia');
    assert.equal(ZL.classifyKey('zlapy_appearance_hint'), 'apariencia');
    assert.equal(ZL.classifyKey('zlapy_wallpaper_abc123'), 'apariencia');
    assert.equal(ZL.classifyKey('zlapy_accent_migrated_abc123'), 'apariencia');
    assert.equal(ZL.classifyKey('zlapy_wall'), 'apariencia');
    /* Interfaz: los tres anchos guardados. */
    assert.equal(ZL.classifyKey('zlapy_sidebar_width'), 'interfaz');
    assert.equal(ZL.classifyKey('zlapy_info_width'), 'interfaz');
    assert.equal(ZL.classifyKey('zlapy_settings_hub_width'), 'interfaz');
    /* Cuentas, avisos, stickers, historias y depuración. */
    assert.equal(ZL.classifyKey('zlapy_linked_accounts'), 'cuentas');
    assert.equal(ZL.classifyKey('zlapy_account_abc123_sounds'), 'avisos');
    assert.equal(ZL.classifyKey('zlapy_account_abc123_security_notifications'), 'avisos');
    assert.equal(ZL.classifyKey('zlapy_account_abc123_sticker_favorites'), 'stickers');
    assert.equal(ZL.classifyKey('zlapy_account_abc123_debug_toasts'), 'depurar');
    assert.equal(ZL.classifyKey('story_seen'), 'historias');
    assert.equal(ZL.classifyKey('zlapy_storyseen'), 'historias');
    assert.equal(ZL.classifyKey('zlapyDebug'), 'depurar');
    assert.equal(ZL.classifyKey('zlapy_debug_toasts_beto'), 'depurar');
    assert.equal(ZL.classifyKey('zlapy_secnotif_beto'), 'depurar');
    /* Lo desconocido cae en 'otros', nunca se mezcla con lo conocido. */
    assert.equal(ZL.classifyKey('otra_cosa'), 'otros');
    assert.equal(ZL.classifyKey(''), 'otros');
});

test('auditStorage groups by category and omits empty groups sorted by size', () => {
    const storage = fakeStorage({
        zlapy_sidebar_width: '360',
        zlapy_appearance_abc: JSON.stringify({ wall: '#090c0f', sender: '#25483c', receiver: '#1c332b', opacity: 22, blur: 0, fontSize: 15 }),
        'zlapy_account_abc_sticker_favorites': JSON.stringify(['🙂', '🙃']),
        desconocida: 'x'
    });
    const audit = ZL.auditStorage(storage);
    assert.equal(audit.count, 4);
    assert.equal(audit.groups.length, 4);
    assert.deepEqual(audit.groups.map(g => g.id), ['apariencia', 'stickers', 'interfaz', 'otros']);
    assert.ok(audit.groups[0].bytes > audit.groups[1].bytes);
    assert.equal(audit.groups[2].count, 1);
    assert.deepEqual(audit.groups[2].keys, ['zlapy_sidebar_width']);
    assert.equal(audit.bytes, audit.groups.reduce((sum, g) => sum + g.bytes, 0));
});

test('auditCacheStorage measures by content-length, counts images and falls back to the body', async () => {
    const caches = {
        'zlapy-v156': {
            '/index.html': { size: 2048, type: 'text/html' },
            '/css/theme.css': { size: null, blobSize: 900, type: 'text/css' },
            '/image/isotype-308.webp': { size: 3000, type: 'image/webp' },
            '/image/isotype-512-full.webp': { size: 4200, type: 'image/webp' }
        },
        'zlapy-vieja': {
            '/login.html': { size: 1024, type: 'text/html' }
        }
    };
    const audit = await ZL.auditCacheStorage(fakeCaches(caches));
    assert.equal(audit.caches, 2);
    assert.equal(audit.count, 5);
    assert.equal(audit.bytes, 2048 + 900 + 3000 + 4200 + 1024);
    assert.equal(audit.images, 2);
    assert.deepEqual(audit.imageTypes, ['image/webp']);
});

test('auditCacheStorage survives a storage without permissions', async () => {
    assert.deepEqual(await ZL.auditCacheStorage(null), { caches: 0, count: 0, bytes: 0, images: 0, imageTypes: [] });
    assert.deepEqual(await ZL.auditCacheStorage({ keys: async () => { throw new Error('no'); } }),
        { caches: 0, count: 0, bytes: 0, images: 0, imageTypes: [] });
});

test('auditCookies counts only what JS can see (the session cookie is HttpOnly)', () => {
    assert.deepEqual(ZL.auditCookies({ cookie: 'a=1; b=2' }), { count: 2, bytes: 6 });
    assert.deepEqual(ZL.auditCookies({ cookie: '' }), { count: 0, bytes: 0 });
    assert.deepEqual(ZL.auditCookies({}), { count: 0, bytes: 0 });
});

test('auditServiceWorker reports the registration when it exists', async () => {
    assert.deepEqual(await ZL.auditServiceWorker(null), { active: false });
    assert.deepEqual(await ZL.auditServiceWorker({ getRegistration: async () => null }), { active: false, scope: '' });
    assert.deepEqual(await ZL.auditServiceWorker({ getRegistration: async () => ({ scope: '/' }) }), { active: true, scope: '/' });
});

/* Tarro de cookies como el del navegador: asignar cookie la añade, y
   asignarla con expires en el pasado la borra. */
function fakeDocument(cookieString) {
    const jar = new Map();
    for (const part of String(cookieString || '').split(';').map(p => p.trim()).filter(Boolean)) {
        const [name, ...rest] = part.split('=');
        if (name) jar.set(name.trim(), rest.join('='));
    }
    return {
        get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
        set cookie(value) {
            const raw = String(value || '');
            const [pair, ...attrs] = raw.split(';').map(s => s.trim());
            const [name, ...rest] = String(pair || '').split('=');
            if (!name) return;
            /* Una cookie con expires en el pasado se borra; el valor de
               expires lleva comas, así que se detecta sobre el string. */
            const expiring = /expires=Thu,\s*01 Jan 1970/i.test(raw);
            if (expiring) jar.delete(name);
            else jar.set(name, rest.join('='));
        }
    };
}

test('countRamMessages counts decrypted blobs by kind and ignores text', () => {
    const blob = () => ({ size: 1 });
    const entries = new Map([
        ['1', { message: { kind: 'image', plain: blob() } }],
        ['2', { message: { kind: 'video', plain: blob() } }],
        ['3', { message: { kind: 'audio', plain: blob() } }],
        ['4', { message: { kind: 'file', plain: blob() } }],
        ['5', { message: { kind: 'sticker', plain: blob() } }],
        ['6', { message: { kind: 'text', plain: 'hola' } }],
        ['7', { message: { kind: 'image', plain: null } }]
    ]);
    const counted = ZL.countRamMessages(entries);
    assert.deepEqual(
        { images: counted.images, videos: counted.videos, audios: counted.audios, files: counted.files, stickers: counted.stickers, text: counted.text, total: counted.total },
        { images: 1, videos: 1, audios: 1, files: 1, stickers: 1, text: 1, total: 5 }
    );
    assert.deepEqual(ZL.countRamMessages(null).total, 0);
    assert.deepEqual(ZL.countRamMessages([{ message: { kind: 'image', plain: blob() } }]).images, 1);
});

test('planCleanup resolves exactly the keys of the selected groups', () => {
    const storage = fakeStorage({
        zlapy_sidebar_width: '360',
        zlapy_info_width: '300',
        zlapy_linked_accounts: '[]',
        zlapyDebug: '1'
    });
    const plan = ZL.planCleanup({ groups: ['interfaz'], caches: true }, storage);
    assert.deepEqual(plan.localStorageKeys, ['zlapy_sidebar_width', 'zlapy_info_width']);
    assert.equal(plan.caches, true);
    assert.equal(plan.sessionStorage, false);
    /* Nada marcado: no se borra nada (ni siquiera las llaves conocidas). */
    const empty = ZL.planCleanup({ groups: [] }, storage);
    assert.deepEqual(empty.localStorageKeys, []);
    assert.equal(empty.caches, false);
    /* Varios grupos a la vez. */
    assert.deepEqual(
        ZL.planCleanup({ groups: ['interfaz', 'depurar'] }, storage).localStorageKeys.sort(),
        ['zlapyDebug', 'zlapy_info_width', 'zlapy_sidebar_width']
    );
});

test('cleanLocalData removes only what was selected and keeps the session', async () => {
    const storage = fakeStorage({
        zlapy_sidebar_width: '360',
        zlapy_linked_accounts: '[]',
        zlapyDebug: '1'
    });
    const session = fakeStorage({ 'zlapy:open-group': 'g1', 'zlapy:group-details-preview:g1': '{}' });
    const caches = { 'zlapy-v156': { '/index.html': { size: 10, type: 'text/html' } } };
    const deleted = [];
    const unregistered = [];
    const ctx = {
        localStorage: storage,
        sessionStorage: session,
        caches: {
            keys: async () => Object.keys(caches),
            delete: async name => { deleted.push(name); return true; }
        },
        document: fakeDocument('vista=1; tema=oscuro'),
        serviceWorker: {
            getRegistration: async () => ({ unregister: async () => { unregistered.push(true); return true; } })
        },
        releaseRam: async () => 7,
        location: { hostname: 'localhost' }
    };
    const out = await ZL.cleanLocalData({
        groups: ['interfaz'], caches: true, sessionStorage: true, ram: true, cookies: true
    }, ctx);

    assert.equal(out.removed.localStorageKeys, 1);
    assert.equal(storage.getItem('zlapy_linked_accounts'), '[]', 'las cuentas enlazadas siguen: no estaban marcadas');
    assert.equal(storage.getItem('zlapyDebug'), '1', 'la depuración sigue: no estaba marcada');
    assert.equal(storage.getItem('zlapy_sidebar_width'), null);
    assert.equal(out.removed.caches, 1);
    assert.deepEqual(deleted, ['zlapy-v156']);
    assert.equal(session.length, 0, 'sessionStorage quedó vacío');
    assert.equal(out.removed.ram, 7);
    assert.equal(out.reload, true);
    /* Las cookies visibles se borran; la de sesión ni aparece (HttpOnly),
       así que la sesión sobrevive a la limpieza. */
    assert.equal(ctx.document.cookie, '', 'el tarro de cookies visibles quedó vacío');
    assert.equal(out.removed.cookies, 2);
});

test('cleanLocalData changes nothing when the selection is empty', async () => {
    const storage = fakeStorage({ zlapy_sidebar_width: '360' });
    const session = fakeStorage({ 'zlapy:open-group': 'g1' });
    const removedCalls = [];
    const ctx = {
        localStorage: storage,
        sessionStorage: session,
        caches: { keys: async () => ['nunca'], delete: async () => { removedCalls.push('caches'); return true; } },
        document: { cookie: 'vista=1' },
        serviceWorker: { getRegistration: async () => ({ unregister: async () => { removedCalls.push('sw'); return true; } }) },
        releaseRam: async () => { removedCalls.push('ram'); return 1; }
    };
    const out = await ZL.cleanLocalData({ groups: [] }, ctx);
    assert.deepEqual(out.removed, { localStorageKeys: 0, caches: 0, sessionStorage: 0, cookies: 0, ram: 0 });
    assert.equal(out.reload, false);
    assert.equal(storage.length, 1);
    assert.equal(session.length, 1);
    assert.deepEqual(removedCalls, []);
});

test('collectReport assembles every storage of the browser', async () => {
    const storage = fakeStorage({ zlapy_sidebar_width: '360', zlapy_linked_accounts: '[]' });
    const report = await ZL.collectReport({
        localStorage: storage,
        sessionStorage: fakeStorage({ 'zlapy:open-group': 'g1' }),
        caches: fakeCaches({ 'zlapy-v156': { '/image/isotype-308.webp': { size: 3000, type: 'image/webp' } } }),
        document: { cookie: 'vista=1' },
        storage: { estimate: async () => ({ usage: 12345, quota: 999999 }) },
        serviceWorker: { getRegistration: async () => ({ scope: '/' }) },
        messages: new Map([['1', { message: { kind: 'image', plain: {} } }]])
    });
    assert.equal(report.local.count, 2);
    assert.equal(report.session.count, 1);
    assert.equal(report.cookies.count, 1);
    assert.equal(report.cache.images, 1);
    assert.equal(report.ram.images, 1);
    assert.equal(report.serviceWorker.active, true);
    assert.equal(report.quota.usage, 12345);
});

/* Empaquetado: el fichero se carga en la app y viaja en el shell del
   service worker (si falta del SHELL, el SW antiguo nunca lo cachea y la
   sección se queda sin él tras una instalación parcial). */
test('the module ships loaded in the app and inside the service worker shell', () => {
    const root = path.join(__dirname, '..');
    const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    const sw = fs.readFileSync(path.join(root, 'public/js/sw.js'), 'utf8');
    assert.ok(index.includes('<script src="/js/local-data.js'), 'index.html carga local-data.js');
    assert.ok(sw.includes("'/js/local-data.js"), 'sw.js incluye local-data.js en el SHELL');
});

/**
 * Datos locales: auditoría y limpieza del almacenamiento del navegador.
 *
 * La app guarda datos en cinco sitios del dispositivo:
 *
 *   1. Cache Storage (`caches`): el shell sin conexión que instala el
 *      service worker (HTML, CSS, JS, fuentes, emoji, isótipos).
 *   2. `localStorage`: apariencia, tamaños de paneles, cuentas enlazadas,
 *      stickers favoritos, historias vistas, ajustes por cuenta…
 *   3. `sessionStorage`: vistas previas de grupo y grupo abierto (solo
 *      esta pestaña).
 *   4. Cookies: solo las visibles desde JS. La de sesión es `HttpOnly`
 *      a propósito: este módulo NUNCA la escribe ni la borra, así que
 *      limpiar datos locales no cierra la sesión.
 *   5. RAM: los blobs de los adjuntos descifrados (fotos, vídeos, notas
 *      de voz) viven en objetos URL de la pestaña; mueren con ella.
 *
 * La lógica de medición y la de limpieza van separadas y con las API
 * inyectadas (`collectReport` / `cleanLocalData` reciben un contexto):
 * así `test/local-data.test.js` las ejecuta contra almacenes de mentira
 * sin necesidad de un navegador.
 *
 * Uso desde la sección Ajustes > Datos locales (index.html):
 *   const ZL = window.ZlapyLocalData;
 *   const reporte = await ZL.collectReport(contexto);
 *   const resumen = await ZL.cleanLocalData(seleccion, contexto);
 */
(function (global, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else global.ZlapyLocalData = api;
})(globalThis, function () {
    'use strict';

    const KB = 1024;

    /* Categorías de `localStorage` con las llaves REALES que escribe la app
       (ver `classifyKey`: si mañana se añade una llave nueva cae en 'otros'
       antes que mezclarse con otra categoría). */
    const GROUPS = [
        { id: 'apariencia', label: 'Fondos y colores', hint: 'Fondo del chat, colores de burbuja y acento' },
        { id: 'interfaz', label: 'Tamaños de paneles', hint: 'Ancho de la barra lateral y de los paneles' },
        { id: 'cuentas', label: 'Cuentas enlazadas', hint: 'El cambio rápido de cuentas pedirá la contraseña otra vez' },
        { id: 'avisos', label: 'Sonidos y avisos', hint: 'Sonidos de la app y avisos de inicio de sesión' },
        { id: 'stickers', label: 'Stickers favoritos', hint: 'Caras guardadas como favoritas' },
        { id: 'historias', label: 'Historias vistas', hint: 'Qué historias ya has visto' },
        { id: 'depurar', label: 'Depuración', hint: 'Avisos técnicos y registros' },
        { id: 'otros', label: 'Otros datos', hint: 'Llaves que esta versión no reconoce' }
    ];

    /* Tamaño legido: sin decimales por debajo de 1 KB, uno por encima. */
    function formatBytes(value) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return '0 B';
        if (n < KB) return `${Math.round(n)} B`;
        if (n < KB * KB) return `${(n / KB).toFixed(1)} KB`;
        if (n < KB * KB * KB) return `${(n / (KB * KB)).toFixed(1)} MB`;
        return `${(n / (KB * KB * KB)).toFixed(2)} GB`;
    }

    /* Bytes UTF-8 reales de un texto (localStorage mide en UTF-16, pero el
       disco lo gasta en UTF-8: es la medida que busca el usuario). */
    function measureText(text) {
        if (typeof text !== 'string' || text === '') return 0;
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
        /* Sin TextEncoder (navegadores muy viejos): aproximación contando
           el bit alto de cada unidad UTF-16. */
        let bytes = 0;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
        }
        return bytes;
    }

    /* Clasifica una llave de localStorage en su grupo. Las llaves salen de
       index.html: accountStorageKey(), chatAppearanceKey(), userSetting(),
       saveStickerCache()… Todas llevan el prefijo 'zlapy' salvo las dos
       legacy sin prefijo ('story_seen'). */
    function classifyKey(key) {
        const k = String(key == null ? '' : key);
        if (/^zlapy_appearance/.test(k)) return 'apariencia';
        if (/^zlapy_wallpaper/.test(k)) return 'apariencia';
        if (/^zlapy_accent_migrated/.test(k)) return 'apariencia';
        if (k === 'zlapy_wall') return 'apariencia';
        if (/^zlapy_(sidebar|info|settings_hub)_width$/.test(k)) return 'interfaz';
        if (k === 'zlapy_linked_accounts') return 'cuentas';
        if (/^zlapy_account_/.test(k)) {
            if (k.endsWith('_sticker_favorites')) return 'stickers';
            if (k.endsWith('_debug_toasts')) return 'depurar';
            return 'avisos';
        }
        if (k === 'story_seen' || k === 'zlapy_storyseen') return 'historias';
        if (k === 'zlapyDebug') return 'depurar';
        if (/^zlapy_debug_toasts(_|$)/.test(k)) return 'depurar';
        if (/^zlapy_secnotif(_|$)/.test(k)) return 'depurar';
        return 'otros';
    }

    /* Lee un almacén tipo Web Storage y devuelve sus entradas medidas.
       Acepta localStorage, sessionStorage o un stub con length/key/getItem. */
    function readStorage(storage) {
        if (!storage || typeof storage.length !== 'number') return [];
        const out = [];
        for (let i = 0; i < storage.length; i++) {
            let key = '';
            try { key = String(storage.key(i)); } catch { continue; }
            if (!key) continue;
            let value = '';
            try { value = storage.getItem(key) || ''; } catch { continue; }
            out.push({ key, value, bytes: measureText(key) + measureText(value) });
        }
        return out;
    }

    /* Auditoría de un almacén: totales y desglose por grupo (los grupos
       vacíos se omiten: la vista solo enseña lo que existe). */
    function auditStorage(storage) {
        const entries = readStorage(storage);
        const byId = new Map();
        for (const group of GROUPS) byId.set(group.id, []);
        for (const entry of entries) byId.get(classifyKey(entry.key)).push(entry);
        const groups = GROUPS
            .map(group => {
                const items = byId.get(group.id);
                return {
                    id: group.id,
                    label: group.label,
                    hint: group.hint,
                    count: items.length,
                    bytes: items.reduce((sum, item) => sum + item.bytes, 0),
                    keys: items.map(item => item.key)
                };
            })
            .filter(group => group.count > 0)
            .sort((a, b) => b.bytes - a.bytes);
        return {
            count: entries.length,
            bytes: entries.reduce((sum, item) => sum + item.bytes, 0),
            groups
        };
    }

    /* Tamaño de una respuesta cacheada: `content-length` si el servidor lo
       dio (no consume el cuerpo); si no, se mide el cuerpo clonado. */
    async function measureResponse(response) {
        if (!response) return { bytes: 0, type: '' };
        const type = String(response.headers && response.headers.get ? (response.headers.get('content-type') || '') : '');
        const header = response.headers && response.headers.get ? response.headers.get('content-length') : null;
        const parsed = header === null || header === '' ? NaN : Number(header);
        if (Number.isFinite(parsed) && parsed > 0) return { bytes: parsed, type };
        try {
            const blob = await response.clone().blob();
            return { bytes: blob ? blob.size : 0, type: type || (blob && blob.type) || '' };
        } catch {
            return { bytes: 0, type };
        }
    }

    /* Auditoría de Cache Storage (el shell sin conexión del service
       worker). Cuenta también las imágenes: son el dato que el usuario
       identifica de un vistazo. */
    async function auditCacheStorage(cachesApi) {
        const result = { caches: 0, count: 0, bytes: 0, images: 0, imageTypes: [] };
        if (!cachesApi || typeof cachesApi.keys !== 'function') return result;
        let names = [];
        try { names = await cachesApi.keys(); } catch { return result; }
        const types = new Set();
        for (const name of names) {
            let cache = null;
            try { cache = await cachesApi.open(name); } catch { continue; }
            if (!cache || typeof cache.keys !== 'function') continue;
            result.caches++;
            let requests = [];
            try { requests = await cache.keys(); } catch { continue; }
            for (const request of requests) {
                let response = null;
                try { response = await cache.match(request); } catch { continue; }
                const measure = await measureResponse(response);
                result.count++;
                result.bytes += measure.bytes;
                if (/^image\//i.test(measure.type)) {
                    result.images++;
                    types.add(measure.type.split(';')[0].trim().toLowerCase());
                }
            }
        }
        result.imageTypes = [...types].sort();
        return result;
    }

    /* Cookies visibles desde JS. Las HttpOnly no aparecen (el navegador ni
       las entrega): es justo lo que permite limpiar sin cerrar sesión. */
    function auditCookies(doc) {
        const raw = doc && typeof doc.cookie === 'string' ? doc.cookie : '';
        const items = raw.split(';').map(part => part.trim()).filter(Boolean);
        return {
            count: items.length,
            bytes: items.reduce((sum, item) => sum + measureText(item), 0)
        };
    }

    /* Estado del service worker: instalado o no (y su ámbito). */
    async function auditServiceWorker(sw) {
        if (!sw || typeof sw.getRegistration !== 'function') return { active: false };
        try {
            const reg = await sw.getRegistration();
            return { active: !!reg, scope: reg && reg.scope ? reg.scope : '' };
        } catch {
            return { active: false };
        }
    }

    /* Adjuntos vivos en RAM. Cada mensaje trae su blob descifrado en
       `plain`: se cuentan por tipo para responder "¿cuántas fotos hay?".
       Solo cuentan los blobs reales (`plain` de texto es string). */
    function countRamMessages(messages) {
        const out = { images: 0, videos: 0, audios: 0, files: 0, stickers: 0, text: 0 };
        const list = messages && typeof messages.values === 'function'
            ? [...messages.values()]
            : (Array.isArray(messages) ? messages : []);
        for (const entry of list) {
            const message = entry && entry.message ? entry.message : entry;
            if (!message || typeof message !== 'object') continue;
            if (message.plain && typeof message.plain === 'object') {
                if (message.kind === 'image') out.images++;
                else if (message.kind === 'video') out.videos++;
                else if (message.kind === 'audio') out.audios++;
                else if (message.kind === 'sticker') out.stickers++;
                else if (message.kind === 'file') out.files++;
            } else if (message.kind === 'text') out.text++;
        }
        out.total = out.images + out.videos + out.audios + out.files + out.stickers;
        return out;
    }

    /* Reporte completo para la sección de Ajustes. El contexto trae las
       API reales del navegador (o los dobles de prueba). */
    async function collectReport(ctx) {
        const c = ctx || {};
        const [cache, estimate, sw] = await Promise.all([
            auditCacheStorage(c.caches),
            (c.storage && typeof c.storage.estimate === 'function')
                ? c.storage.estimate().catch(() => null)
                : Promise.resolve(null),
            auditServiceWorker(c.serviceWorker)
        ]);
        return {
            local: auditStorage(c.localStorage),
            session: auditStorage(c.sessionStorage),
            cookies: auditCookies(c.document),
            cache,
            serviceWorker: sw,
            ram: countRamMessages(c.messages),
            quota: estimate && typeof estimate.usage === 'number' ? estimate : null
        };
    }

    /* Convierte la selección de casillas en el plan exacto: grupos de
       localStorage (por id) y qué más se vacía. La lista de llaves se
       resuelve contra el almacén real para no borrar "a ciegas". */
    function planCleanup(selection, storage) {
        const selected = new Set(Array.isArray(selection && selection.groups) ? selection.groups : []);
        const entries = readStorage(storage);
        return {
            localStorageKeys: entries
                .filter(entry => selected.has(classifyKey(entry.key)))
                .map(entry => entry.key),
            caches: !!(selection && selection.caches),
            sessionStorage: !!(selection && selection.sessionStorage),
            cookies: !!(selection && selection.cookies),
            ram: !!(selection && selection.ram),
            serviceWorker: !!(selection && selection.serviceWorker)
        };
    }

    /* Ejecuta el plan y devuelve cuánto se borró de cada sitio. Solo
       toca lo marcado: la cookie de sesión (HttpOnly) no está en ninguna
       rama porque no es alcanzable desde JS. */
    async function cleanLocalData(selection, ctx) {
        const c = ctx || {};
        const plan = planCleanup(selection, c.localStorage);
        const removed = { localStorageKeys: plan.localStorageKeys.length, caches: 0, sessionStorage: 0, cookies: 0, ram: 0 };
        let reload = false;

        if (plan.caches && c.caches && typeof c.caches.keys === 'function') {
            try {
                for (const name of await c.caches.keys()) {
                    if (await c.caches.delete(name)) removed.caches++;
                }
            } catch { /* sin permiso: se sigue con el resto */ }
        }
        if (plan.sessionStorage && c.sessionStorage && typeof c.sessionStorage.clear === 'function') {
            try {
                removed.sessionStorage = c.sessionStorage.length || 0;
                c.sessionStorage.clear();
            } catch { }
        }
        if (plan.cookies && c.document && typeof c.document.cookie === 'string') {
            const host = c.cookieHost || (c.location && c.location.hostname) || '';
            for (const item of c.document.cookie.split(';').map(part => part.trim().split('=')[0]).filter(Boolean)) {
                /* expires en el pasado: única forma de borrar desde JS. Se
                   prueban las dos variantes (host-only y con dominio),
                   porque una cookie creada sin dominio no se borra
                   especificándolo. La de sesión es HttpOnly y aquí no
                   aparece, así que la sesión sobrevive. */
                try {
                    c.document.cookie = `${item}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
                    if (host) c.document.cookie = `${item}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${host}`;
                    removed.cookies++;
                } catch { }
            }
        }
        if (plan.localStorageKeys.length && c.localStorage && typeof c.localStorage.removeItem === 'function') {
            for (const key of plan.localStorageKeys) {
                try { c.localStorage.removeItem(key); } catch { }
            }
        }
        if (plan.ram && typeof c.releaseRam === 'function') {
            try {
                removed.ram = Number(await c.releaseRam()) || 0;
                reload = true;
            } catch { }
        }
        if (plan.serviceWorker && c.serviceWorker && typeof c.serviceWorker.getRegistration === 'function') {
            try {
                const reg = await c.serviceWorker.getRegistration();
                if (reg) { await reg.unregister(); }
                /* El index vuelve a registrar el SW al cargar: tras la
                   recarga se reinstala y repuebla el shell. */
                reload = true;
            } catch { }
        }
        if (plan.caches) reload = true;
        return { removed, reload };
    }

    return {
        KB,
        GROUPS,
        formatBytes,
        measureText,
        classifyKey,
        readStorage,
        auditStorage,
        measureResponse,
        auditCacheStorage,
        auditCookies,
        auditServiceWorker,
        countRamMessages,
        collectReport,
        planCleanup,
        cleanLocalData
    };
});

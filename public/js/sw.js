const CACHE = 'chatlocal-v67';
const SHELL = ['/', '/index.html', '/login.html', '/profile.html', '/stories.html', '/view.html', '/css/theme.css', '/css/login.css?v=1', '/css/avatar-editor.css?v=1', '/js/appearance.js', '/js/avatar-editor.js?v=1', '/manifest.webmanifest'];
// Rutas navegables de la app. Sólo estas navigaciones pueden
// servirse desde la caché cuando no hay red: para el resto de rutas del
// mismo origen (p. ej. /privacy.html) no se inventa un shell que el
// usuario no pidió, se deja que la petición falle de forma explícita.
const NAV_SHELL = ['/', '/index.html', '/login.html', '/profile.html', '/stories.html', '/view.html'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // Solo GET same-origin; ni websockets ni recursos externos.
  if (e.request.method !== 'GET' || u.pathname.startsWith('/ws') || u.origin !== self.location.origin) return;
  // Solo la navegación y los archivos del SHELL tienen respaldo
  // offline. Las APIs (JSON) y los blobs no se sirven de caché: ante fallo de
  // red devuelven el error real en vez de un 504 vacío que enmascaraba bugs.
  const isNavigation = e.request.mode === 'navigate';
  const isShellAsset = SHELL.some(path => u.pathname === path || u.pathname + u.search === path);
  if (!isNavigation && !isShellAsset) return;
  // Una navegación fuera del alcance de la app no se intercepta: no se le
  // sirve el shell cacheado como si fuera la página pedida.
  if (isNavigation && !NAV_SHELL.includes(u.pathname)) return;
  e.respondWith(
    fetch(new Request(e.request, { cache: 'no-store' })).catch(() =>
      caches.match(e.request).then(resp => {
        if (resp) return resp;
        // La caché no tiene esa ruta: sólo se recurre al índice cuando la
        // navegación pedía el propio índice.
        if (isNavigation && (u.pathname === '/' || u.pathname === '/index.html'))
          return caches.match('/').then(r => r || new Response('', { status: 504, statusText: 'Gateway Timeout' }));
        return new Response('', { status: 504, statusText: 'Gateway Timeout' });
      })
    )
  );
});
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { }
  e.waitUntil(self.registration.showNotification(d.title || 'Zlapy', {
    body: d.body || 'Tienes un mensaje nuevo',
    tag: d.tag || 'chat',
    renotify: !!d.renotify,
    requireInteraction: !!d.requireInteraction,
    vibrate: d.vibrate || [100, 50, 100],
    data: { url: d.url || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  /* Solo se navega a rutas propias: la URL viene del servidor (no del
     usuario), pero el service worker es el último sitio donde conviene
     comprobarlo antes de abrir una ventana. */
  let destino = '/';
  try {
    const parsed = new URL(url, self.location.origin);
    destino = parsed.origin === self.location.origin ? parsed.pathname + parsed.search : '/';
  } catch (err) { destino = '/'; }
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
    /* `navigate` no está en todos los motores y puede rechazar en clientes
       especiales (about:blank, etc.): en ese caso se intenta con el siguiente
       y, si nada funciona, se abre una ventana nueva. */
    for (const c of list) {
      if (!('focus' in c)) continue;
      try {
        if ('navigate' in c) await c.navigate(destino);
        await c.focus();
        return;
      } catch (err) { /* este cliente no sirve: el siguiente */ }
    }
    try { if (clients.openWindow) await clients.openWindow(destino); } catch (err) { }
  }));
});

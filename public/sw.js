/* HRM STOCK · service worker — app shell offline, data always live (/api is never cached) */
const V = '1793115382', CACHE = 'hrm-stock-' + V;
const SHELL = ['/', '/assets/app.css?v=' + V, '/assets/data.js?v=' + V, '/assets/app.js?v=' + V, '/assets/pwa.js?v=' + V, '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('hrm-stock-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (r.mode === 'navigate') {   // newest page when online · cached page when offline
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put('/', c)); return res; })
      .catch(() => caches.match('/', { ignoreSearch: true })));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
    if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)); }
    return res;
  })));
});

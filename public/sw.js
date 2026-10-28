/* HRM STOCK · service worker — app shell offline, data always live (/api is never cached) */
const V = '1793181218', CACHE = 'hrm-stock-' + V;
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

/* ---------- push: "ทีม X ยังไม่ลง STOCK" ---------- */
self.addEventListener('push', e => {
  let m = {}; try { m = e.data ? e.data.json() : {}; } catch (er) { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'HRM STOCK', {
    body: m.body || '', tag: m.tag || 'hrm', renotify: true, icon: '/icons/icon-192.png', badge: '/icons/maskable-192.png',
    data: { url: m.url || '/' }, vibrate: [120, 60, 120],
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => c.url.startsWith(location.origin));
    if (w) { w.focus(); return w.navigate(url).catch(() => { }); }
    return self.clients.openWindow(url);
  }));
});

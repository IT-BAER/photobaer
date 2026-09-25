// Offline shell: precache every built file, network-first for navigations, cache-first for the rest.
const CACHE = 'photobaer';

self.addEventListener('install', e => e.waitUntil((async () => {
  const files = await (await fetch('precache.json', { cache: 'no-store' })).json();
  const c = await caches.open(CACHE);
  await c.addAll(['./', ...files.filter(f => f !== 'index.html')]);
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const put = (key, r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; };
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => put('./', r)).catch(() => caches.match('./', { ignoreVary: true })));
    return;
  }
  // ignoreVary: static hosts often send "Vary: Origin", which would make module-script requests miss offline.
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(hit => hit ?? fetch(req).then(r => put(req, r))));
});

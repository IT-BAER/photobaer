// Offline shell: precache every built file, network-first for navigations, cache-first for the rest.
// The build rewrites CACHE to 'photobaer-<content hash>', so each release installs a fresh worker and cache.
const CACHE = 'photobaer';

self.addEventListener('install', e => e.waitUntil((async () => {
  const files = await (await fetch('precache.json', { cache: 'no-store' })).json();
  const c = await caches.open(CACHE);
  // no-cache: unhashed files (icons, fonts) must not come from a stale HTTP cache.
  await c.addAll(['./', ...files.filter(f => f !== 'index.html')].map(u => new Request(u, { cache: 'no-cache' })));
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const put = (key, r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return r; };
  if (req.mode === 'navigate') {
    // Only the app URL refreshes the cached shell; content pages such as /features/ pass through.
    const shell = new URL(req.url).pathname === new URL('./', location).pathname;
    e.respondWith(fetch(req).then(r => (shell ? put('./', r) : r)).catch(() => caches.match('./', { ignoreVary: true })));
    return;
  }
  // ignoreVary: static hosts often send "Vary: Origin", which would make module-script requests miss offline.
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(hit => hit ?? fetch(req).then(r => put(req, r))));
});

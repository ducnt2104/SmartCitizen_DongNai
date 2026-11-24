/* Service Worker: mở app tức thì khi ngoại tuyến (app shell + tài nguyên build + tile bản đồ đã xem).
 * Dữ liệu nghiệp vụ nằm ở IndexedDB (Dexie) nên SW KHÔNG cache /api. */
const SHELL = 'sc-shell-v1';
const TILES = 'sc-tiles-v1';
const ASSETS = 'sc-assets-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['/', '/favicon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES, ASSETS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api') || url.pathname === '/healthz') return; // luôn đi mạng

  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith(staleWhileRevalidate(TILES, req));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || new Response('Offline', { status: 503 }))),
    );
    return;
  }
  event.respondWith(staleWhileRevalidate(ASSETS, req));
});

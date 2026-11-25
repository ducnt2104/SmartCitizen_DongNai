/* Service Worker v3: mở app tức thì khi ngoại tuyến (app shell + tài nguyên build + tile bản đồ đã xem).
 * Dữ liệu nghiệp vụ nằm ở IndexedDB (Dexie) nên SW KHÔNG cache /api và KHÔNG cache nhầm HTML cho chunk .js/.css. */
const SHELL = 'sc-shell-v3';
const TILES = 'sc-tiles-v3';
const ASSETS = 'sc-assets-v3';

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

function isCacheableAssetResponse(pathname, res) {
  if (!res || !res.ok) return false;
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if ((pathname.endsWith('.js') || pathname.endsWith('.mjs')) && ct.includes('text/html')) return false;
  if (pathname.endsWith('.css') && ct.includes('text/html')) return false;
  return true;
}

async function staleWhileRevalidate(cacheName, request, checkMime = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const url = new URL(request.url);
  const network = fetch(request)
    .then((res) => {
      const valid = checkMime
        ? isCacheableAssetResponse(url.pathname, res)
        : Boolean(res && res.ok);
      if (valid) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api') || url.pathname === '/healthz' || url.pathname === '/sw.js') return;

  if (
    url.hostname.endsWith('tile.openstreetmap.org') ||
    url.hostname.endsWith('basemaps.cartocdn.com') ||
    url.hostname === 'server.arcgisonline.com' ||
    url.hostname === 'tiles.openfreemap.org'
  ) {
    event.respondWith(staleWhileRevalidate(TILES, req, false));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || new Response('Offline', { status: 503 }))),
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(ASSETS, req, true));
});

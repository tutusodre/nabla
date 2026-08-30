/* Nabla service worker.
 *
 * Two caches: the app shell (small, revved on every deploy) and a runtime
 * cache for jsdelivr. Every jsdelivr URL here is version-pinned and therefore
 * immutable, so cache-first is safe and makes the second launch fast — the
 * Pyodide + SymPy payload is ~25 MB and otherwise re-downloads every time.
 */

const VERSION = 'v4';
const SHELL_CACHE = `nabla-shell-${VERSION}`;
const VENDOR_CACHE = `nabla-vendor-${VERSION}`;
const KEEP = new Set([SHELL_CACHE, VENDOR_CACHE]);

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './src/style.css',
  './src/app.js',
  './src/i18n.js',
  './src/worker.js',
  './src/math.py',
  './icons/nabla.svg',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

const VENDOR_HOSTS = new Set(['cdn.jsdelivr.net']);

/* worker.js reaches this through importScripts(), which issues a no-cors
 * request whose opaque response Cache.put() will not store. Precaching it
 * here as an ordinary CORS fetch means the cache holds a usable copy that
 * the importScripts request can still be answered from. */
const VENDOR_PRECACHE = [
  'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    const vendor = await caches.open(VENDOR_CACHE);
    // addAll is atomic — one 404 would throw away the whole install.
    const warm = (cache, url) => cache
      .add(new Request(url, { cache: 'reload' }))
      .catch(() => { /* a missing optional asset shouldn't block activation */ });

    await Promise.all([
      ...SHELL.map((url) => warm(shell, url)),
      ...VENDOR_PRECACHE.map((url) => warm(vendor, url)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => (KEEP.has(name) ? null : caches.delete(name))));
    await self.clients.claim();
  })());
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response && response.ok) {
    try {
      await cache.put(request, response.clone());
    } catch (err) {
      /* over quota — serving the response still works */
    }
  }
  return response;
}

/* Shell files are small and change on every deploy, so the network wins when
 * it's available. Stale-while-revalidate would serve one load of old code
 * after each update — not worth it to save a few kB. */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch (err) { /* over quota */ }
    }
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (VENDOR_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE).catch(() => fetch(request)));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (err) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               Response.error();
      }
    })());
    return;
  }

  event.respondWith(networkFirst(request, SHELL_CACHE));
});

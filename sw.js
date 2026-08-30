/* Service worker.
 *
 * Two caches on purpose. The shell is small and precached during `install`, so a
 * first visit becomes offline-capable immediately. The OCR assets are several
 * megabytes and are fetched only when the page asks for them, with progress
 * reported back: an addAll() that large inside `install` is the classic way to
 * end up with a worker that never activates on a flaky mobile connection.
 */

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const OCR_CACHE = `ocr-${VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/camera.js',
  './js/crop.js',
  './js/warp.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// Filled in once the Tesseract assets are vendored.
const OCR_ASSETS = [];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, OCR_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;

    try {
      const response = await fetch(request);
      if (response.ok && isVendorAsset(request.url)) {
        const cache = await caches.open(OCR_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      // Offline and uncached: a navigation can still be answered by the shell.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'cache-ocr') {
    event.waitUntil(cacheOcrAssets(event.source));
  } else if (data.type === 'ocr-status') {
    event.waitUntil(reportOcrStatus(event.source));
  }
});

function isVendorAsset(url) {
  return url.includes('/vendor/');
}

async function cacheOcrAssets(client) {
  const cache = await caches.open(OCR_CACHE);
  let done = 0;

  const post = (extra) => client && client.postMessage({
    type: 'ocr-progress', done, total: OCR_ASSETS.length, ...extra,
  });

  post({});
  for (const asset of OCR_ASSETS) {
    try {
      if (!(await cache.match(asset))) await cache.add(asset);
    } catch (err) {
      post({ error: `${asset}: ${err.message}` });
      return;
    }
    done += 1;
    post({});
  }
  post({ complete: true });
}

async function reportOcrStatus(client) {
  const cache = await caches.open(OCR_CACHE);
  const present = await Promise.all(OCR_ASSETS.map((a) => cache.match(a)));
  const done = present.filter(Boolean).length;
  if (client) {
    client.postMessage({
      type: 'ocr-progress',
      done,
      total: OCR_ASSETS.length,
      complete: done === OCR_ASSETS.length,
    });
  }
}

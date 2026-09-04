/* Service worker.
 *
 * Two caches on purpose. The shell is small and precached during `install`, so a
 * first visit becomes offline-capable immediately, then served network-first —
 * a deploy takes effect the moment the phone is next online, and the cache
 * only steps in when there is no connection. The OCR assets are several
 * megabytes, fetched only when the page asks for them (an addAll() that large
 * inside `install` is the classic way to end up with a worker that never
 * activates on a flaky mobile connection), and served cache-first forever
 * once downloaded, since a vendored build never changes under its own name.
 */

const SHELL_CACHE = 'shell-v5';

/* The OCR cache is deliberately *not* versioned with the shell. Those files are
 * vendored and immutable — a new build of Tesseract would arrive under a new
 * name — so tying them to the shell version would throw several megabytes off
 * the user's phone every time a stylesheet changed. `ocr-v2` is the name earlier
 * versions wrote to, kept alive so nobody has to download the packs twice. */
const OCR_CACHE = 'ocr';
const LEGACY_OCR_CACHES = ['ocr-v1', 'ocr-v2'];

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/ui.js',
  './js/nav.js',
  './js/camera.js',
  './js/crop.js',
  './js/drag.js',
  './js/exif.js',
  './js/warp.js',
  './js/ocr.js',
  './js/schema.js',
  './js/form.js',
  './js/parse.js',
  './js/wine-data.js',
  './js/vault.js',
  './js/idb.js',
  './js/languages.js',
  './js/note.js',
  './js/save.js',
  './js/geocode.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// Vendored so recognition never needs the network. Several megabytes, which is
// why these are fetched on request rather than during install.
const OCR_CORE = [
  './vendor/tesseract/tesseract.esm.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
];

// Every pack is in the repository, but only the ones the user picked are worth
// pushing onto their phone.
const KNOWN_LANGS = ['eng', 'fra', 'ita', 'spa', 'por', 'deu', 'kat'];

function ocrAssets(langs) {
  const chosen = (Array.isArray(langs) ? langs : []).filter((l) => KNOWN_LANGS.includes(l));
  const packs = (chosen.length ? chosen : ['eng'])
    .map((lang) => `./vendor/tesseract/${lang}.traineddata.gz`);
  return [...OCR_CORE, ...packs];
}

self.addEventListener('install', (event) => {
  // Bypass the HTTP cache here too — precaching a stale response the instant a
  // new worker installs would defeat the point of installing it.
  const fresh = SHELL_ASSETS.map((url) => new Request(url, { cache: 'no-store' }));
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(fresh))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, OCR_CACHE, ...LEGACY_OCR_CACHES]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(isVendorAsset(request.url) ? cacheFirst(request) : networkFirst(request));
});

/**
 * The vendored OCR files: several megabytes, immutable — a new build of
 * Tesseract arrives under a new filename — so once cached, never worth
 * fetching again.
 */
async function cacheFirst(request) {
  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(OCR_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/**
 * Everything else — the app's own code. This used to be cache-first too,
 * repopulated only when `install` ran again, which meant a fix could ship and
 * sit unseen on every phone that already had a shell cached, forever, unless
 * this file's own bytes happened to change in the same deploy. Network-first
 * means a deploy takes effect the moment the phone is next online, while the
 * cache — refreshed on every successful fetch — is exactly what answers the
 * same request offline.
 *
 * `no-store` on the fetch itself, or this is answered by the browser's own
 * HTTP cache — a layer underneath the service worker that still obeys
 * whatever Cache-Control the host sent, silently undoing "network-first" for
 * as long as that header says the file is fresh. Different files expire at
 * different times, so half an update can land: the markup for a new button
 * refreshed while the stylesheet and the script that wires it up were still
 * being served from that cache, which is exactly as broken as it sounds.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    // Offline and never cached: a navigation can still be answered by the shell.
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'cache-ocr') {
    event.waitUntil(cacheOcrAssets(event.source, data.langs));
  } else if (data.type === 'ocr-status') {
    event.waitUntil(reportOcrStatus(event.source, data.langs));
  }
});

function isVendorAsset(url) {
  return url.includes('/vendor/');
}

/** Look in every cache, not just the current one, so a pack downloaded under an
 *  older cache name still counts as downloaded. */
const alreadyCached = (asset) => caches.match(asset);

async function cacheOcrAssets(client, langs) {
  const assets = ocrAssets(langs);
  const cache = await caches.open(OCR_CACHE);
  let done = 0;

  const post = (extra) => client && client.postMessage({
    type: 'ocr-progress', done, total: assets.length, ...extra,
  });

  post({});
  for (const asset of assets) {
    try {
      if (!(await alreadyCached(asset))) await cache.add(asset);
    } catch (err) {
      post({ error: `${asset}: ${err.message}` });
      return;
    }
    done += 1;
    post({});
  }
  post({ complete: true });
}

async function reportOcrStatus(client, langs) {
  const assets = ocrAssets(langs);
  const present = await Promise.all(assets.map(alreadyCached));
  const done = present.filter(Boolean).length;
  if (client) {
    client.postMessage({
      type: 'ocr-progress',
      done,
      total: assets.length,
      complete: done === assets.length,
    });
  }
}

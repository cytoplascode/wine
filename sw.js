/* Service worker.
 *
 * Two caches on purpose. The shell is small and precached during `install`, so a
 * first visit becomes offline-capable immediately. The OCR assets are several
 * megabytes and are fetched only when the page asks for them, with progress
 * reported back: an addAll() that large inside `install` is the classic way to
 * end up with a worker that never activates on a flaky mobile connection.
 */

const SHELL_CACHE = 'shell-v4';

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
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
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

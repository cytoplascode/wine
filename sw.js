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

const SHELL_CACHE = 'shell-v16';

/* The OCR cache is deliberately *not* versioned with the shell. Those files are
 * vendored and immutable — a new build of Tesseract would arrive under a new
 * name — so tying them to the shell version would throw several megabytes off
 * the user's phone every time a stylesheet changed. `ocr-v2` is the name earlier
 * versions wrote to, kept alive so nobody has to download the packs twice. */
const OCR_CACHE = 'ocr';
/* The label finder is a separate, optional 38 MB, so it gets its own cache
   and can be cleared without taking the recogniser with it. */
const SAM_CACHE = 'sam';
/* The finder runs on the same ONNX Runtime as the text engine, so the
 * runtime files are part of this download too. `cacheAssets` skips whatever
 * is already on the phone, so downloading both cards costs the runtime once. */
const ORT_RUNTIME = [
  './vendor/ppocr/ort.wasm.min.mjs',
  './vendor/ppocr/ort-wasm-simd-threaded.mjs',
  './vendor/ppocr/ort-wasm-simd-threaded.wasm.gz',
];
const SAM_ASSETS = [
  ...ORT_RUNTIME,
  './vendor/edgesam/edge_sam_3x_encoder.onnx',
  './vendor/edgesam/edge_sam_3x_decoder.onnx',
];
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
  './js/engine.js',
  './js/ppocr.js',
  './js/ppocr-post.js',
  './js/detect.js',
  './js/flatten.js',
  './js/refine.js',
  './js/ort.js',
  './js/edgesam.js',
  './js/download.js',
  './js/mask-fit.js',
  './js/viewport.js',
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
  './js/drafts.js',
  './js/archive.js',
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

// PP-OCR: the ONNX Runtime loader, its wasm core (gzipped) and the two
// models. Same deal — immutable under these names, fetched on request.
const PPOCR_ASSETS = [
  ...ORT_RUNTIME,
  './vendor/ppocr/ch_PP-OCRv4_det_infer.onnx',
  './vendor/ppocr/en_PP-OCRv4_rec.onnx',
];

function ocrAssets(langs, engine) {
  if (engine === 'ppocr') return PPOCR_ASSETS;
  const chosen = (Array.isArray(langs) ? langs : []).filter((l) => KNOWN_LANGS.includes(l));
  const packs = (chosen.length ? chosen : ['eng'])
    .map((lang) => `./vendor/tesseract/${lang}.traineddata.gz`);
  return [...OCR_CORE, ...packs];
}

/* Cross-origin isolation, supplied from here.
 *
 * ONNX Runtime's threaded build needs SharedArrayBuffer, which the browser
 * only enables on a page that carries COOP/COEP headers. GitHub Pages cannot
 * send custom headers, but a service worker can add them to every response
 * it hands the page — the same trick as the coi-serviceworker shim. The
 * page becomes isolated on its next load after this worker takes control;
 * app.js reloads once at startup to get there straight away.
 *
 * `credentialless` rather than `require-corp` so a cross-origin fetch that
 * already answers CORS (the reverse geocoder) keeps working without every
 * such resource also needing a CORP header. Set INJECT_ISOLATION to false to
 * back this out: recognition then runs single-threaded and nothing else
 * changes. */
const INJECT_ISOLATION = true;

function withIsolation(response) {
  if (!INJECT_ISOLATION || !response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
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
    const keep = new Set([SHELL_CACHE, OCR_CACHE, SAM_CACHE, ...LEGACY_OCR_CACHES]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Android's share sheet POSTs a multipart form to this URL when the user
  // shares a photo into the app (declared as share_target in manifest.json).
  // Take the file out of the form, stash it in a session-local place the
  // app itself can find, then redirect to the app's own start URL with a
  // flag so app.js knows to pick it up.
  if (request.method === 'POST' && url.pathname.endsWith('/share/')) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method !== 'GET') return;

  // The page downloads the big model files itself, so it can show real
  // progress and catch a stalled connection (js/download.js). Leaving those
  // requests alone matters: the vendor rule below would put a second copy of
  // every byte in a cache of its own, 22 MB at a time. Not calling
  // respondWith hands the request straight back to the browser.
  if (url.searchParams.has('download')) return;

  event.respondWith(
    (isVendorAsset(request.url) ? cacheFirst(request) : networkFirst(request)).then(withIsolation),
  );
});

/** Received a photo shared from another app. Stash it and redirect. */
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('image');
    if (file && file.type && file.type.startsWith('image/')) {
      // Pass the file to whichever client picks it up. IndexedDB accepts
      // File/Blob objects, which is what the SW gets from the form and
      // what the app needs to hand to createImageBitmap.
      await stashSharedFile(file);
    }
  } catch {
    // A malformed post is not worth halting on — better to land the user
    // on the home screen than a broken share flow.
  }
  return Response.redirect('./?share=1', 303);
}

async function stashSharedFile(file) {
  // Use the same schema idb.js declares (version 3, three stores). Opening
  // at the current version means no upgrade is triggered when the app has
  // already run; declaring the upgrade path keeps the SW self-contained
  // for the case where the share target fires before the page ever loads.
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('label-scanner', 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('handles')) d.createObjectStore('handles');
      if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts');
      if (!d.objectStoreNames.contains('shared')) d.createObjectStore('shared');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('shared', 'readwrite');
    tx.objectStore('shared').put(file, 'pending');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

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
    event.waitUntil(cacheOcrAssets(event.source, data.langs, data.engine));
  } else if (data.type === 'ocr-status') {
    event.waitUntil(reportOcrStatus(event.source, data.langs, data.engine));
  } else if (data.type === 'cache-sam') {
    event.waitUntil(cacheAssets(event.source, SAM_ASSETS, SAM_CACHE, 'sam-progress'));
  } else if (data.type === 'sam-status') {
    event.waitUntil(reportStatus(event.source, SAM_ASSETS, 'sam-progress'));
  }
});

function isVendorAsset(url) {
  return url.includes('/vendor/');
}

/** Look in every cache, not just the current one, so a pack downloaded under an
 *  older cache name still counts as downloaded. */
const alreadyCached = (asset) => caches.match(asset);

async function cacheOcrAssets(client, langs, engine) {
  return cacheAssets(client, ocrAssets(langs, engine), OCR_CACHE, 'ocr-progress', { engine });
}

/** Fetch a set of assets into a cache, reporting progress as it goes. */
async function cacheAssets(client, assets, cacheName, type, extra = {}) {
  const cache = await caches.open(cacheName);
  let done = 0;

  const post = (more) => client && client.postMessage({
    type, done, total: assets.length, ...extra, ...more,
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

/** How much of a set is already on the phone. */
async function reportStatus(client, assets, type, extra = {}) {
  const present = await Promise.all(assets.map(alreadyCached));
  const done = present.filter(Boolean).length;
  if (client) {
    client.postMessage({ type, done, total: assets.length, complete: done === assets.length, ...extra });
  }
}

async function reportOcrStatus(client, langs, engine) {
  return reportStatus(client, ocrAssets(langs, engine), 'ocr-progress', { engine });
}

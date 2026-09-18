/* Fetching a model onto the phone, from the page rather than the worker.
 *
 * The service worker used to do this with `cache.add`, one call per file.
 * That is the wrong place for it once a single file is 22 MB: `cache.add`
 * reports nothing until the whole file has landed, has no timeout, and a
 * backgrounded worker can be killed mid-`waitUntil` — so a connection that
 * quietly stops is indistinguishable from a slow one, forever, and the card
 * says "downloading" until the app is reinstalled.
 *
 * Here the page does it. It is alive and on screen for as long as the user
 * is looking at the progress bar, the body is read a chunk at a time so the
 * bar moves by the megabyte, and a stall is caught and named. Files already
 * cached are skipped, so a retry resumes rather than starting over. There is
 * no resume *within* a file: Range requests against Pages would work, but
 * that is more machinery than two files need.
 *
 * Requests carry `?download=1`, which sw.js lets fall through to the network
 * untouched — otherwise its vendor-asset cache-first rule would store a
 * second copy of every byte.
 */

/** No bytes for this long and the connection is not slow, it is gone. */
export const STALL_MS = 30000;

/** Ask for a little more room than the download needs, so the write itself
 *  is not what runs the phone out of space. */
const QUOTA_HEADROOM = 1.15;

const MARKER = 'download=1';

/** `12.4 MB`, `812 kB` — for a progress line a person reads. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/**
 * How many bytes short of comfortable the phone is, or 0 when there is room.
 * `estimate` is what `navigator.storage.estimate()` returns; a browser that
 * reports nothing useful gets the benefit of the doubt.
 */
export function shortfall(estimate, needed) {
  if (!estimate || !Number.isFinite(estimate.quota)) return 0;
  const free = estimate.quota - (estimate.usage || 0);
  const want = needed * QUOTA_HEADROOM;
  return free < want ? Math.ceil(want - free) : 0;
}

/** Which of `assets` are not in any cache yet, in the order given. */
export async function missingAssets(assets, cacheStore = globalThis.caches) {
  if (!cacheStore) return [...assets];
  const hits = await Promise.all(assets.map((url) => cacheStore.match(url).catch(() => null)));
  return assets.filter((_, i) => !hits[i]);
}

const marked = (url) => url + (url.includes('?') ? '&' : '?') + MARKER;

const name = (url) => url.split('/').pop().split('?')[0];

/** Content-Length, via a HEAD that the worker does not intercept. */
async function sizeOf(url, deps) {
  try {
    const response = await deps.fetch(marked(url), { method: 'HEAD' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) && length > 0 ? length : 0;
  } catch (err) {
    // A HEAD that fails is not fatal — it only costs us the total, and the
    // GET below will report the real problem with a better message.
    return 0;
  }
}

/**
 * Read a response body to completion, reporting bytes as they arrive and
 * giving up if they stop. Returns the assembled bytes.
 */
async function drain(response, controller, onChunk, stallMs) {
  const reader = response.body.getReader();
  const chunks = [];
  let timer = null;
  // Race each read against the clock rather than waiting for the abort to
  // reject it: a half-open socket can leave `read()` pending for as long as
  // the OS keeps the connection, which is the hang this exists to prevent.
  const deadline = () => new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('stalled')), stallMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline()]);
      clearTimeout(timer);
      if (next.done) break;
      chunks.push(next.value);
      onChunk(next.value.length);
    }
  } catch (err) {
    controller.abort();          // let the socket go
    reader.cancel().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return chunks;
}

/**
 * Put every one of `assets` that is missing into `cacheName`.
 *
 * `onProgress` is called with `{ loaded, total, file, index, count }` as
 * bytes arrive, where `total` is the size of everything still to fetch.
 * Throws an Error whose message names the file and what went wrong, so the
 * card can show it verbatim.
 *
 * `deps` exists so the tests can run this without a network or a cache.
 */
export async function downloadToCache(assets, cacheName, onProgress, deps = {}) {
  const {
    fetch: doFetch = globalThis.fetch.bind(globalThis),
    caches: cacheStore = globalThis.caches,
    storage = globalThis.navigator && navigator.storage,
    stallMs = STALL_MS,
  } = deps;
  const env = { fetch: doFetch };

  const todo = await missingAssets(assets, cacheStore);
  if (!todo.length) {
    if (onProgress) onProgress({ loaded: 0, total: 0, index: 0, count: 0, complete: true });
    return { fetched: 0, bytes: 0 };
  }

  const sizes = await Promise.all(todo.map((url) => sizeOf(url, env)));
  const total = sizes.reduce((a, b) => a + b, 0);

  if (total && storage && storage.estimate) {
    const short = shortfall(await storage.estimate().catch(() => null), total);
    if (short) {
      throw new Error(`not enough room on the phone — about ${formatSize(short)} short`);
    }
  }

  const cache = await cacheStore.open(cacheName);
  let loaded = 0;
  let bytes = 0;

  for (let i = 0; i < todo.length; i += 1) {
    const url = todo[i];
    const report = (extra) => onProgress && onProgress({
      loaded, total, file: name(url), index: i, count: todo.length, ...extra,
    });
    report({});

    const controller = new AbortController();
    let response;
    try {
      response = await doFetch(marked(url), { signal: controller.signal });
    } catch (err) {
      throw new Error(`${name(url)}: ${err.message || 'the connection failed'}`);
    }
    if (!response.ok) {
      throw new Error(`${name(url)}: ${response.status} ${response.statusText}`.trim());
    }

    let chunks;
    try {
      chunks = await drain(response, controller, (n) => {
        loaded += n;
        report({});
      }, stallMs);
    } catch (err) {
      const stalled = controller.signal.aborted || /abort|stall/i.test(err.message || '');
      throw new Error(`${name(url)}: ${stalled
        ? `the connection stalled after ${formatSize(loaded)}`
        : err.message}`);
    }

    const body = new Blob(chunks, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    });
    bytes += body.size;
    // Stored under the clean URL: `?download=1` is only how the request gets
    // past the worker, and `caches.match(url)` is what everything else asks.
    await cache.put(url, new Response(body, {
      headers: { 'content-type': body.type, 'content-length': String(body.size) },
    }));
  }

  if (onProgress) onProgress({ loaded, total, index: todo.length, count: todo.length, complete: true });
  return { fetched: todo.length, bytes };
}

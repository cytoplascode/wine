/* The ONNX Runtime, loaded once and shared.
 *
 * Two models now run through it — PP-OCR for the text and EdgeSAM for the
 * label's outline — and the runtime itself is the big part: a 14 MB wasm
 * core, 3.6 MB on the wire. Loading it twice would cost that twice in
 * memory and in start-up, so both engines come through here.
 *
 * The files live beside the PP-OCR models under vendor/ppocr; the eval
 * harness points `vendor` at the same folder over its own server.
 */

const DEFAULT_VENDOR = new URL('../vendor/ppocr/', import.meta.url).href;

export const ORT_FILES = {
  loader: 'ort.wasm.min.mjs',
  threads: 'ort-wasm-simd-threaded.mjs',
  wasm: 'ort-wasm-simd-threaded.wasm.gz',
};

/** Beyond four, the little cores on a phone slow the pool down more than they help. */
const MAX_THREADS = 4;

let settings = { vendor: DEFAULT_VENDOR, threads: null };
let loaded = null;

export function configureOrt(next) {
  const before = JSON.stringify(settings);
  settings = { ...settings, ...next };
  if (JSON.stringify(settings) !== before) loaded = null;
}

export const ortVendor = () => settings.vendor;

/** How many threads this page can use: needs SharedArrayBuffer, which needs
 *  cross-origin isolation (the service worker supplies the headers). */
export function threadCount() {
  if (settings.threads) return settings.threads;
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return 1;
  return Math.max(1, Math.min(MAX_THREADS, navigator.hardwareConcurrency || 1));
}

export async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} fetching ${url.split('/').pop()}`);
  return response;
}

async function inflate(response) {
  const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/** The runtime, ready to create sessions. Loaded at most once. */
export function loadOrt(onProgress) {
  loaded ||= (async () => {
    const { vendor } = settings;
    if (onProgress) onProgress({ status: 'Starting the recognition engine…', progress: 0 });
    const ort = await import(`${vendor}${ORT_FILES.loader}`);
    ort.env.wasm.wasmPaths = vendor;
    ort.env.wasm.wasmBinary = await inflate(await fetchBytes(`${vendor}${ORT_FILES.wasm}`));
    ort.env.wasm.numThreads = threadCount();
    return ort;
  })().catch((err) => { loaded = null; throw err; });
  return loaded;
}

/** Create a session from a model file, with the runtime's own options. */
export async function createSession(url, onProgress) {
  const ort = await loadOrt(onProgress);
  const bytes = await (await fetchBytes(url)).arrayBuffer();
  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}

/** Is a set of vendored files already in the cache? The UI asks before
 *  starting anything that would otherwise download megabytes unbidden. */
export async function filesCached(urls) {
  if (typeof caches === 'undefined') return false;
  try {
    const hits = await Promise.all(urls.map((u) => caches.match(u)));
    return hits.every(Boolean);
  } catch {
    return false;
  }
}

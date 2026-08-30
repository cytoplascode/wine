/* Text recognition, entirely on the device.
 *
 * Everything Tesseract needs is vendored under ./vendor/tesseract, so no
 * request ever leaves the phone: the worker script, the wasm core and the
 * language data are all local files served from the cache.
 */

/* Absolute, derived from this module's own URL. A page-relative path would
 * resolve against /js/ for the dynamic import, and the worker runs from a blob
 * URL where relative paths have no meaningful base at all. */
const VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;

/** The canonical wasm SIMD feature-detection module (from wasm-feature-detect).
 *  We pick the core build ourselves rather than letting Tesseract probe and
 *  request a variant that is not vendored. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
  3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export const hasSimd = () => WebAssembly.validate(SIMD_PROBE);

let workerPromise = null;

async function getWorker(onProgress) {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    if (!hasSimd()) {
      throw new Error('This browser lacks WebAssembly SIMD, which the recognition engine needs');
    }
    const { default: Tesseract } = await import(`${VENDOR}tesseract.esm.min.js`);
    const worker = await Tesseract.createWorker('eng', 1 /* LSTM only */, {
      workerPath: `${VENDOR}worker.min.js`,
      // Ends in ".js", which is Tesseract's signal to use this exact build
      // instead of probing for a variant we have not vendored.
      corePath: `${VENDOR}tesseract-core-simd-lstm.wasm.js`,
      langPath: VENDOR.replace(/\/$/, ''),
      gzip: true,
      logger: (m) => onProgress && onProgress(m),
    });

    // Sparse text, not a page of prose. Tesseract's default layout analysis
    // reads a label's small print fine but discards the largest lines — the
    // producer name and the vintage — as non-text graphics.
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    return worker;
  })();

  try {
    return await workerPromise;
  } catch (err) {
    workerPromise = null;      // let the next attempt start clean
    throw err;
  }
}

/**
 * Read a flattened label.
 * Returns `{ text, lines }`, where each line carries the bounding box the
 * producer heuristic needs to tell a big name from small print.
 */
export async function recognize(canvas, onProgress) {
  const worker = await getWorker(onProgress);
  const prepared = preprocess(canvas);

  const { data } = await worker.recognize(prepared, {}, { blocks: true, text: true });
  return { text: data.text || '', lines: extractLines(data) };
}

export async function terminate() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerPromise = null;
  if (worker) await worker.terminate();
}

/**
 * Grayscale plus a percentile contrast stretch. Wine labels are frequently
 * cream-on-cream or gold-on-black, and Tesseract's own thresholding does much
 * better once the range is opened up.
 */
function preprocess(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = image.data;

  const histogram = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const grey = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = grey;
    histogram[grey] += 1;
  }

  const total = px.length / 4;
  const low = percentile(histogram, total, 0.02);
  const high = percentile(histogram, total, 0.98);
  const span = Math.max(1, high - low);

  if (span < 250) {
    for (let i = 0; i < px.length; i += 4) {
      const v = Math.min(255, Math.max(0, ((px[i] - low) * 255) / span));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function percentile(histogram, total, fraction) {
  let seen = 0;
  const target = total * fraction;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v];
    if (seen >= target) return v;
  }
  return 255;
}

/**
 * Flatten Tesseract's block/paragraph/line tree into the shape the parser
 * wants. Falls back to plain text when block output is unavailable.
 */
function extractLines(data) {
  const lines = [];

  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const text = (line.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const box = line.bbox || {};
        lines.push({
          text,
          height: (box.y1 - box.y0) || 0,
          top: box.y0 || 0,
          confidence: line.confidence ?? 0,
        });
      }
    }
  }

  if (lines.length) return lines;

  return (data.text || '')
    .split('\n')
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text, i) => ({ text, height: 0, top: i, confidence: 0 }));
}

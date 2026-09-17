/* Candidate C: PP-OCR (DB detector + CRNN recogniser) via ONNX Runtime Web
 * on WASM — the engine the app ships, measured through the app's own module.
 *
 * `js/ppocr.js` does all the work; this wrapper only points it at the
 * vendored files over the harness's server, pins the thread count from
 * `--options '{"threads":N}'`, and hands the lines to the app's parseLabel
 * so the parser is held constant across candidates.
 */

import { parseLabel } from '../../js/parse.js';
import { configure, recognize } from '../../js/ppocr.js';

let configured = false;

export async function extract(blob, options = {}) {
  const opts = { threads: 4, thresh: 0.3, boxThresh: 0.6, unclip: 1.5, ...options };
  if (!configured) {
    configure({
      vendor: new URL('/vendor/ppocr/', location.href).href,
      threads: self.crossOriginIsolated ? opts.threads : 1,
    });
    configured = true;
  }

  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const { text, lines, timing, threads } = await recognize(bitmap, null, opts);
    const { fields } = parseLabel({ text, lines });
    const box = lines.length ? {
      left: Math.min(...lines.map((l) => l.left)), top: Math.min(...lines.map((l) => l.top)),
      right: Math.max(...lines.map((l) => l.right)), bottom: Math.max(...lines.map((l) => l.top + l.height)),
    } : null;
    return {
      fields, rawText: text, lineCount: lines.length, box, lines, timing,
      threads, crossOriginIsolated: self.crossOriginIsolated,
    };
  } finally {
    bitmap.close();
  }
}

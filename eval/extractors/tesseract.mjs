/* Baseline: the app's own pipeline — Tesseract on a downscaled copy of the
 * photo, then parseLabel. No handles, no unwrap: this is what the app gets
 * with zero human help, which is the honest floor to beat. */

import { recognize } from '../../js/ocr.js';
import { parseLabel } from '../../js/parse.js';
import { MAX_SIDE } from '../../js/warp.js';

export async function extract(blob, { langs = 'eng' } = {}) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const result = await recognize(canvas, null, langs);
  const { fields } = parseLabel(result);
  return { fields, rawText: result.text, lineCount: result.lines.length };
}

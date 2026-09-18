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
import { findLabel } from '../../js/autocrop.js';
import { flattenLabel } from '../../js/flatten.js';
import { fitWrapAngle } from '../../js/warp.js';

/** A whole-frame box, for the photos where the heuristic finds no text. */
function insetSeed(bitmap, inset = 0.1) {
  const { width: w, height: h } = bitmap;
  return [
    { x: w * inset, y: h * inset },
    { x: w * 0.5, y: h * (inset - 0.035) },
    { x: w * (1 - inset), y: h * inset },
    { x: w * (1 - inset), y: h * (1 - inset) },
    { x: w * 0.5, y: h * (1 - inset + 0.035) },
    { x: w * inset, y: h * (1 - inset) },
  ];
}

/* A stand-in for a human's rough drag: every handle pushed `amount` of the
 * label's size in a fixed direction, so the same photo is always roughened
 * the same way and both paths get the identical start. */
const ROUGH_DIRS = [[1, 1], [0, -1], [-1, 1], [-1, -1], [0, 1], [1, -1]];
function roughen(points, amount) {
  const xs = points.map((p) => p.x); const ys = points.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return points.map((p, i) => ({
    x: p.x + ROUGH_DIRS[i][0] * amount * w,
    y: p.y + ROUGH_DIRS[i][1] * amount * h,
  }));
}

/** Snap, on the same working planes the app builds. */
async function snapOn(bitmap, points) {
  const { refineHandles } = await import('../../js/refine.js');
  const { toGray, toChroma } = await import('../../js/detect.js');
  const { detInputSize } = await import('../../js/ppocr-post.js');
  const size = detInputSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  const image = ctx.getImageData(0, 0, size.width, size.height);
  const planes = {
    gray: toGray(image.data, size.width, size.height),
    chroma: toChroma(image.data, size.width, size.height),
  };
  const sx = bitmap.width / size.width; const sy = bitmap.height / size.height;
  const refined = refineHandles(planes, size.width, size.height,
    points.map((p) => ({ x: p.x / sx, y: p.y / sy })));
  return { points: refined.points.map((p) => ({ x: p.x * sx, y: p.y * sy })), moved: refined.moved };
}

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
    // How the six handles get placed before the unwrap:
    //   true   the heuristic label finder + Snap — the old shipped path
    //   'snap' the same, but from a deliberately rough placement (`roughen`)
    //   'sam'  rough placement → EdgeSAM → Snap — the crop screen's Find
    // `roughen` exists because that is the whole question: Snap only looks a
    // few percent either side of where the handles already are, so the two
    // paths can only differ when the start is further out than that — which
    // is exactly what a human drag is.
    let source = bitmap;
    let crop = null;
    if (opts.autoCrop) {
      const rough = await findLabel(bitmap, null, { snap: false });
      let seed = rough ? rough.points : insetSeed(bitmap);
      if (opts.roughen) seed = roughen(seed, opts.roughen);

      let points = seed;
      let extra = {};
      if (opts.autoCrop === 'sam') {
        const sam = await import('../../js/edgesam.js');
        sam.configure({ vendor: new URL('/vendor/edgesam/', location.href).href });
        const { handlesFromMask } = await import('../../js/mask-fit.js');
        const region = await sam.segment(bitmap, seed);
        const fit = handlesFromMask(region);
        if (fit) {
          points = fit.points.map((p) => ({ x: p.x * region.toSource, y: p.y * region.toSource }));
          extra = { score: region.score, coverage: region.coverage, timing: region.timing };
        } else {
          extra = { noFit: true, coverage: region.coverage, timing: region.timing };
        }
      }
      const snapped = await snapOn(bitmap, points);
      points = snapped.points;
      const wrap = fitWrapAngle(points);
      source = flattenLabel(bitmap, points, wrap);
      crop = {
        points, wrap, seed, seededBy: rough ? 'auto' : 'inset',
        found: rough ? rough.found : null, snapped: snapped.moved, ...extra,
      };
    }
    const { text, lines, timing, threads } = await recognize(source, null, opts);
    const { fields } = parseLabel({ text, lines });
    const box = lines.length ? {
      left: Math.min(...lines.map((l) => l.left)), top: Math.min(...lines.map((l) => l.top)),
      right: Math.max(...lines.map((l) => l.right)), bottom: Math.max(...lines.map((l) => l.top + l.height)),
    } : null;
    return {
      fields, rawText: text, lineCount: lines.length, box, lines, timing, crop,
      threads, crossOriginIsolated: self.crossOriginIsolated,
    };
  } finally {
    bitmap.close();
  }
}

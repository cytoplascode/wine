/* PP-OCR on the device: a DB text detector and a CRNN recogniser (PaddleOCR
 * v4, Apache-2.0) run by ONNX Runtime Web on WebAssembly.
 *
 * Everything is vendored under ./vendor/ppocr, so no request ever leaves the
 * phone: the runtime loader, its wasm core (gzipped, inflated here with
 * DecompressionStream) and the two models are local files served from the
 * cache. This module is shared verbatim by the app and by the eval harness,
 * so the numbers in eval/results.md are measured on exactly this code.
 *
 * Preprocessing follows PaddleOCR/RapidOCR: the models were trained on cv2
 * BGR input, the detector normalised with ImageNet mean/std, the recogniser
 * with (x/255 − 0.5)/0.5. Detected boxes are cut out with the app's own
 * warpQuad so a tilted line arrives upright, then decoded greedily.
 */

import { warpQuad } from './warp.js';
import {
  EN_CHARSET, detInputSize, recInputWidth, boxesFromMap, orderBoxes, ctcDecode,
} from './ppocr-post.js';
import { toGray, toChroma } from './detect.js';
import {
  ORT_FILES, configureOrt, threadCount, loadOrt, createSession, ortVendor, filesCached,
} from './ort.js';

/** The two model files; the runtime's own live in js/ort.js. */
export const FILES = {
  det: 'ch_PP-OCRv4_det_infer.onnx',
  rec: 'en_PP-OCRv4_rec.onnx',
};

const DET_MEAN = [0.406, 0.456, 0.485]; // BGR order of ImageNet RGB means
const DET_STD = [0.225, 0.224, 0.229];
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

/** The detector's long side; the recogniser crops from a sharper copy. */
const DET_LIMIT = 960;
const REC_LIMIT = 1600;

/** A photo whose long side is below this is enlarged before detection: a
 *  gallery picture or a thumbnail puts label text under the ~12 px the
 *  detector wants. The flattened label from the app's own camera is far
 *  larger and is left alone. */
const MIN_LONG_SIDE = 1000;

let loaded = null;

/**
 * Override where the files come from or how many threads to use. The eval
 * harness points `vendor` at the same folder over its own server and pins
 * `threads` to make the single-core number reproducible. The models live
 * beside the runtime, so this configures both.
 */
export function configure(next) {
  configureOrt(next);
  loaded = null;
}

export { threadCount };

function getEngine(onProgress) {
  loaded ||= (async () => {
    const report = (label) => onProgress && onProgress({ status: label, progress: 0 });
    const ort = await loadOrt(onProgress);
    report('Loading the text models…');
    const [det, rec] = await Promise.all([
      createSession(`${ortVendor()}${FILES.det}`),
      createSession(`${ortVendor()}${FILES.rec}`),
    ]);
    return { ort, det, rec, threads: ort.env.wasm.numThreads };
  })().catch((err) => { loaded = null; throw err; });
  return loaded;
}

/** Are all the files on the phone already? The crop screen asks before
 *  running the detector on its own, so a 16 MB download never starts
 *  without the user having pressed the button for it. */
export function isEngineCached() {
  const names = [...Object.values(ORT_FILES), ...Object.values(FILES)];
  return filesCached(names.map((f) => `${ortVendor()}${f}`));
}

/** RGBA ImageData → BGR CHW float32 with the given per-channel mean/std. */
function toTensorBGR(ort, image, mean, std) {
  const { width, height, data } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    const r = data[i * 4] / 255; const g = data[i * 4 + 1] / 255; const b = data[i * 4 + 2] / 255;
    out[i] = (b - mean[0]) / std[0];
    out[plane + i] = (g - mean[1]) / std[1];
    out[2 * plane + i] = (r - mean[2]) / std[2];
  }
  return new ort.Tensor('float32', out, [1, 3, height, width]);
}

/* Plain drawImage, deliberately without imageSmoothingQuality = 'high': the
 * sharper filter changed the detector's boxes and the recogniser's spacing
 * on the smoke set and cost 15 points (eval/results.md). */
function drawTo(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function resample(imageData, width, height) {
  const src = document.createElement('canvas');
  src.width = imageData.width; src.height = imageData.height;
  src.getContext('2d').putImageData(imageData, 0, 0);
  return drawTo(src, width, height);
}

/** Let the progress overlay paint between two long synchronous runs. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Just the detector: where the text is, without reading it. Returns the
 * boxes in the source's pixels (`corners`, plus `left/top/right/bottom`),
 * and the grayscale working image the detector saw with its scale, which
 * the label finder scans for the paper's edge.
 */
export async function detectText(source, onProgress, options = {}) {
  const { thresh = 0.3, boxThresh = 0.6, unclip = 1.5 } = options;
  const { ort, det } = await getEngine(onProgress);
  const size = detInputSize(source.width, source.height, DET_LIMIT);
  const detImage = drawTo(source, size.width, size.height);

  const t0 = performance.now();
  const detOut = await det.run({ x: toTensorBGR(ort, detImage, DET_MEAN, DET_STD) });
  const prob = detOut[det.outputNames[0]].data;
  const ms = performance.now() - t0;

  const mapBoxes = orderBoxes(boxesFromMap(prob, size.width, size.height, { thresh, boxThresh, unclip }));
  const sx = source.width / size.width;
  const sy = source.height / size.height;
  const boxes = mapBoxes.map((box) => {
    const corners = box.corners.map((c) => ({ x: c.x * sx, y: c.y * sy }));
    const xs = corners.map((c) => c.x); const ys = corners.map((c) => c.y);
    return {
      corners, score: box.score, w: box.w * sx, h: box.h * sy,
      left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys),
    };
  });
  return {
    boxes, ms,
    gray: {
      data: toGray(detImage.data, size.width, size.height),
      chroma: toChroma(detImage.data, size.width, size.height),
      width: size.width, height: size.height, scale: { x: sx, y: sy },
    },
  };
}

/**
 * Read a label from a canvas or ImageBitmap.
 * Returns `{ text, lines }` in the source's pixel coordinates, each line
 * carrying the box the producer heuristic needs to tell a big name from small
 * print — the same shape the Tesseract path produces.
 */
export async function recognize(source, onProgress, options = {}) {
  const { thresh = 0.3, boxThresh = 0.6, unclip = 1.5, upscale = 1 } = options;
  const { ort, det, rec } = await getEngine(onProgress);
  const report = (progress, status) => onProgress && onProgress({ status, progress });

  // Work on an enlarged copy when the photo is small; every box is mapped
  // back through `zoom` so the lines come out in the caller's pixels.
  const longSide = Math.max(source.width, source.height);
  const zoom = upscale > 1 && longSide < MIN_LONG_SIDE ? Math.min(upscale, MIN_LONG_SIDE / longSide) : 1;
  if (zoom !== 1) {
    const big = document.createElement('canvas');
    big.width = Math.round(source.width * zoom);
    big.height = Math.round(source.height * zoom);
    big.getContext('2d').drawImage(source, 0, 0, big.width, big.height);
    source = big;
  }

  const full = { width: source.width, height: source.height };
  const size = detInputSize(full.width, full.height, DET_LIMIT);
  const detImage = drawTo(source, size.width, size.height);

  report(0.05, 'Finding the text…');
  await breathe();
  const t0 = performance.now();
  const detOut = await det.run({ x: toTensorBGR(ort, detImage, DET_MEAN, DET_STD) });
  const prob = detOut[det.outputNames[0]].data;
  const detMs = performance.now() - t0;

  const boxes = orderBoxes(boxesFromMap(prob, size.width, size.height, { thresh, boxThresh, unclip }));

  // Recognise from a copy at a size where the smallest box is still legible.
  const recScale = Math.min(1, REC_LIMIT / Math.max(full.width, full.height));
  const recSource = drawTo(source, Math.round(full.width * recScale), Math.round(full.height * recScale));
  const sx = recSource.width / size.width;
  const sy = recSource.height / size.height;

  const lines = [];
  const t1 = performance.now();
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    report(0.2 + (0.8 * i) / boxes.length, `Reading line ${i + 1} of ${boxes.length}…`);
    if (i % 4 === 0) await breathe();

    const quad = box.corners.map((c) => ({ x: c.x * sx, y: c.y * sy }));
    const bw = Math.max(1, Math.round(box.w * sx));
    const bh = Math.max(1, Math.round(box.h * sy));
    const warped = warpQuad(recSource, quad, bw, bh);
    const patch = new ImageData(warped.data, warped.width, warped.height);

    const recIn = resample(patch, recInputWidth(bw, bh), 48);
    const out = await rec.run({ x: toTensorBGR(ort, recIn, REC_MEAN, REC_STD) });
    const tensor = out[rec.outputNames[0]];
    const [, T, C] = tensor.dims;
    const { text, confidence } = ctcDecode(tensor.data, T, C, EN_CHARSET);
    if (!text) continue;
    const logits = options.debugLogits ? { data: Array.from(tensor.data), T, C } : undefined;

    const ys = quad.map((p) => p.y); const xs = quad.map((p) => p.x);
    const back = recScale * zoom;
    lines.push({
      text,
      confidence,
      top: Math.min(...ys) / back,
      height: (Math.max(...ys) - Math.min(...ys)) / back,
      left: Math.min(...xs) / back,
      right: Math.max(...xs) / back,
      score: box.score,
      logits,
    });
  }
  const recMs = performance.now() - t1;

  return {
    text: lines.map((l) => l.text).join('\n'),
    lines,
    timing: { det: Math.round(detMs), rec: Math.round(recMs), boxes: boxes.length },
    threads: ort.env.wasm.numThreads,
  };
}

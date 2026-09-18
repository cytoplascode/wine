/* EdgeSAM: the label's outline from a prompt, on the device.
 *
 * EdgeSAM (3x) is a distilled Segment Anything that answers "which pixels
 * belong to the thing I am pointing at". The crop screen points it at
 * whatever the six handles currently enclose, and the mask it returns
 * becomes a better set of handles. It is optional twice over: the weights
 * are a separate download, and nothing runs until the Find button is
 * pressed.
 *
 * The ONNX interface is fixed by EdgeSAM's own export script:
 *   encoder  image [1,3,1024,1024] f32     -> image_embeddings [1,256,64,64]
 *   decoder  image_embeddings, point_coords [1,N,2], point_labels [1,N]
 *            -> scores [1,4], masks [1,4,256,256]
 * Coordinates go in in 1024-padded pixel space (the model does the +0.5 and
 * the divide itself), and labels follow SAM's convention: 1 foreground,
 * 0 background, 2 box top-left, 3 box bottom-right. The decoder was exported
 * with --use-stability-score, so `scores` is a stability score and the best
 * of the four masks is simply its argmax.
 *
 * The encoder is the expensive half (about a second), the decoder is not
 * (a fifth of that), so the embedding is kept per photo: moving the handles
 * and pressing Find again re-runs only the decoder.
 */

import { createSession, ortVendor, filesCached, ORT_FILES } from './ort.js';

const DEFAULT_VENDOR = new URL('../vendor/edgesam/', import.meta.url).href;

export const FILES = {
  encoder: 'edge_sam_3x_encoder.onnx',
  decoder: 'edge_sam_3x_decoder.onnx',
};

/** What the model was trained at, and the side of its mask grid. */
export const SAM_SIZE = 1024;
export const MASK_SIZE = 256;

/** SAM's own normalisation, in image pixels rather than 0…1. */
const PIXEL_MEAN = [123.675, 116.28, 103.53];
const PIXEL_STD = [58.395, 57.12, 57.375];

let settings = { vendor: DEFAULT_VENDOR };
let loaded = null;

export function configure(next) {
  settings = { ...settings, ...next };
  loaded = null;
}

/** The finder itself: the two weight files, as absolute URLs. This is what
 *  "is the label finder downloaded?" means — the runtime below is a shared
 *  dependency, and counting it as part of the finder made a card that had
 *  never started a download read as three fifths of the way through one. */
export function modelWeights() {
  return Object.values(FILES).map((f) => `${settings.vendor}${f}`);
}

/** Everything it needs to run: the weights plus the shared ONNX Runtime,
 *  which the text engine may well have fetched already. */
export function modelAssets() {
  return [
    ...Object.values(ORT_FILES).map((f) => `${ortVendor()}${f}`),
    ...modelWeights(),
  ];
}

/** All of them present in the cache? The button asks before running. */
export function isModelCached() {
  return filesCached(modelAssets());
}

/* ── Pure pieces ─────────────────────────────────────────────────────── */

/**
 * How a photo maps into the model's square input: the long side becomes
 * `size`, the short side keeps its proportion, and the rest is padding at
 * the right and bottom.
 */
export function samInputSize(width, height, size = SAM_SIZE) {
  const scale = size / Math.max(width, height);
  return {
    scale,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    size,
  };
}

/**
 * The six handles as a prompt: their bounding box (labels 2 and 3) plus a
 * foreground point at the centre (label 1), in the model's padded pixel
 * space. The box says roughly where, the point says which side of an edge
 * is the label.
 */
export function boxPrompt(points, scale, size = SAM_SIZE) {
  const clamp = (v) => Math.max(0, Math.min(size - 1, v * scale));
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const left = clamp(Math.min(...xs));
  const right = clamp(Math.max(...xs));
  const top = clamp(Math.min(...ys));
  const bottom = clamp(Math.max(...ys));
  return {
    coords: Float32Array.from([left, top, right, bottom, (left + right) / 2, (top + bottom) / 2]),
    labels: Float32Array.from([2, 3, 1]),
    count: 3,
  };
}

/**
 * The best of the four masks, cut down to the part of the grid the photo
 * actually occupies. The 256-square grid is the 1024-square input at a
 * quarter scale, so the photo's own region is simply its resized size over
 * four — no interpolation, just a crop. Returns a binary mask in that
 * space, which `handlesFromMask` reads and whose coordinates multiply by
 * `4 / scale` to become source pixels.
 */
export function maskRegion(masks, scores, input, maskSize = MASK_SIZE) {
  const count = scores.length;
  let best = 0;
  for (let k = 1; k < count; k += 1) if (scores[k] > scores[best]) best = k;

  const width = Math.max(1, Math.round(input.width / (input.size / maskSize)));
  const height = Math.max(1, Math.round(input.height / (input.size / maskSize)));
  const plane = maskSize * maskSize;
  const mask = new Uint8Array(width * height);
  let on = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Mask values are logits; SAM's threshold is zero.
      const v = masks[best * plane + y * maskSize + x] > 0 ? 1 : 0;
      mask[y * width + x] = v;
      on += v;
    }
  }
  return {
    mask, width, height, score: scores[best], coverage: on / (width * height),
    toSource: (input.size / maskSize) / input.scale,
  };
}

/* ── Running it ──────────────────────────────────────────────────────── */

function drawPadded(source, input) {
  const canvas = document.createElement('canvas');
  canvas.width = input.size;
  canvas.height = input.size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, input.width, input.height);
  return ctx.getImageData(0, 0, input.size, input.size);
}

/** RGBA → RGB CHW float32 with SAM's normalisation. */
function toSamTensor(ort, image) {
  const { width, height, data } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    out[i] = (data[i * 4] - PIXEL_MEAN[0]) / PIXEL_STD[0];
    out[plane + i] = (data[i * 4 + 1] - PIXEL_MEAN[1]) / PIXEL_STD[1];
    out[2 * plane + i] = (data[i * 4 + 2] - PIXEL_MEAN[2]) / PIXEL_STD[2];
  }
  return new ort.Tensor('float32', out, [1, 3, height, width]);
}

function sessions(onProgress) {
  loaded ||= (async () => {
    const { vendor } = settings;
    if (onProgress) onProgress({ status: 'Loading the label finder…', progress: 0 });
    const encoder = await createSession(`${vendor}${FILES.encoder}`, onProgress);
    const decoder = await createSession(`${vendor}${FILES.decoder}`);
    const { loadOrt } = await import('./ort.js');
    return { ort: await loadOrt(), encoder, decoder };
  })().catch((err) => { loaded = null; throw err; });
  return loaded;
}

/* One embedding per photo: the encoder is the slow half and the photo does
 * not change while the handles are dragged. */
const embeddings = new WeakMap();

async function embed(source, onProgress) {
  const cached = embeddings.get(source);
  if (cached) return cached;
  const pending = (async () => {
    const { ort, encoder } = await sessions(onProgress);
    const input = samInputSize(source.width, source.height);
    if (onProgress) onProgress({ status: 'Looking at the photo…', progress: 0.2 });
    const image = drawPadded(source, input);
    const t0 = performance.now();
    const out = await encoder.run({ image: toSamTensor(ort, image) });
    return { embedding: out.image_embeddings, input, ms: Math.round(performance.now() - t0) };
  })();
  embeddings.set(source, pending);
  pending.catch(() => embeddings.delete(source));
  return pending;
}

/**
 * Segment whatever the handles enclose. `source` is a canvas or
 * ImageBitmap, `points` the six handles in its pixels. Resolves to
 * `{ mask, width, height, toSource, score, coverage, timing }`, or throws
 * if the weights are missing.
 */
export async function segment(source, points, onProgress) {
  const { ort, decoder } = await sessions(onProgress);
  const { embedding, input, ms: encoderMs } = await embed(source, onProgress);
  if (onProgress) onProgress({ status: 'Finding the label…', progress: 0.7 });

  const prompt = boxPrompt(points, input.scale, input.size);
  const t0 = performance.now();
  const out = await decoder.run({
    image_embeddings: embedding,
    point_coords: new ort.Tensor('float32', prompt.coords, [1, prompt.count, 2]),
    point_labels: new ort.Tensor('float32', prompt.labels, [1, prompt.count]),
  });
  const region = maskRegion(out.masks.data, out.scores.data, input);
  return { ...region, timing: { encoder: encoderMs, decoder: Math.round(performance.now() - t0) } };
}

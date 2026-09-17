/* Candidate C: PP-OCR (DB detector + CRNN recogniser, optional 0/180°
 * classifier) via ONNX Runtime Web on WASM.
 *
 * Preprocessing follows PaddleOCR/RapidOCR: the models were trained on
 * cv2 BGR input, detector normalised with ImageNet mean/std, recogniser and
 * classifier with (x/255 − 0.5)/0.5. Boxes are cut out with the app's own
 * warpQuad so a tilted line arrives upright, then decoded greedily.
 *
 * Models come from eval/models/ppocr/ (npm run eval:models). Lines go to the
 * app's parseLabel unchanged — the parser is held constant across candidates.
 */

import { parseLabel } from '../../js/parse.js';
import { warpQuad } from '../../js/warp.js';
import {
  EN_CHARSET, detInputSize, recInputWidth, boxesFromMap, orderBoxes, ctcDecode,
} from '../ppocr-post.mjs';

const ORT = '/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs';
const MODELS = '/eval/models/ppocr/';

let loaded = null;

async function load({ threads, useCls }) {
  const ort = await import(ORT);
  ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
  ort.env.wasm.numThreads = self.crossOriginIsolated ? threads : 1;
  const opts = { executionProviders: ['wasm'] };
  const fetchModel = async (name) => (await fetch(MODELS + name)).arrayBuffer();
  const [det, rec, cls] = await Promise.all([
    ort.InferenceSession.create(await fetchModel('ch_PP-OCRv4_det_infer.onnx'), opts),
    ort.InferenceSession.create(await fetchModel('en_PP-OCRv4_rec.onnx'), opts),
    useCls ? ort.InferenceSession.create(await fetchModel('ch_ppocr_mobile_v2.0_cls_infer.onnx'), opts) : null,
  ]);
  return { ort, det, rec, cls, threadsUsed: ort.env.wasm.numThreads };
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

const DET_MEAN = [0.406, 0.456, 0.485]; // BGR order of ImageNet RGB means
const DET_STD = [0.225, 0.224, 0.229];
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

function drawTo(bitmapOrCanvas, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmapOrCanvas, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function imageDataFromWarp(warped) {
  return new ImageData(warped.data, warped.width, warped.height);
}

function resample(imageData, width, height) {
  const src = document.createElement('canvas');
  src.width = imageData.width; src.height = imageData.height;
  src.getContext('2d').putImageData(imageData, 0, 0);
  return drawTo(src, width, height);
}

export async function extract(blob, options = {}) {
  const opts = { threads: 4, useCls: false, detLimit: 960, thresh: 0.3, boxThresh: 0.6, unclip: 1.5, ...options };
  loaded ||= load(opts);
  const { ort, det, rec, cls, threadsUsed } = await loaded;

  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const full = { width: bitmap.width, height: bitmap.height };
  const size = detInputSize(full.width, full.height, opts.detLimit);
  const detImage = drawTo(bitmap, size.width, size.height);

  const t0 = performance.now();
  const detOut = await det.run({ x: toTensorBGR(ort, detImage, DET_MEAN, DET_STD) });
  const prob = detOut[det.outputNames[0]].data;
  const tDet = performance.now() - t0;

  const boxes = orderBoxes(boxesFromMap(prob, size.width, size.height, {
    thresh: opts.thresh, boxThresh: opts.boxThresh, unclip: opts.unclip,
  }));

  // Recognise from a copy of the photo at a size where the smallest box is
  // still legible: crop from ≤1600 px rather than the 960 px detector input.
  const recScale = Math.min(1, 1600 / Math.max(full.width, full.height));
  const recSource = drawTo(bitmap, Math.round(full.width * recScale), Math.round(full.height * recScale));
  bitmap.close();
  const sx = recSource.width / size.width;
  const sy = recSource.height / size.height;

  const lines = [];
  const t1 = performance.now();
  for (const box of boxes) {
    const quad = box.corners.map((c) => ({ x: c.x * sx, y: c.y * sy }));
    const bw = Math.max(1, Math.round(box.w * sx));
    const bh = Math.max(1, Math.round(box.h * sy));
    let patch = imageDataFromWarp(warpQuad(recSource, quad, bw, bh));

    if (cls) {
      const c = resample(patch, 192, 48);
      const out = await cls.run({ x: toTensorBGR(ort, c, REC_MEAN, REC_STD) });
      const p = out[cls.outputNames[0]].data;
      if (p[1] > p[0] && p[1] > 0.9) {
        const rot = document.createElement('canvas');
        rot.width = patch.width; rot.height = patch.height;
        const rc = rot.getContext('2d');
        const tmp = document.createElement('canvas'); tmp.width = patch.width; tmp.height = patch.height;
        tmp.getContext('2d').putImageData(patch, 0, 0);
        rc.translate(patch.width, patch.height); rc.rotate(Math.PI); rc.drawImage(tmp, 0, 0);
        patch = rc.getImageData(0, 0, patch.width, patch.height);
      }
    }

    const w = recInputWidth(bw, bh);
    const recIn = resample(patch, w, 48);
    const out = await rec.run({ x: toTensorBGR(ort, recIn, REC_MEAN, REC_STD) });
    const tensor = out[rec.outputNames[0]];
    const [, T, C] = tensor.dims;
    const { text, confidence } = ctcDecode(tensor.data, T, C, EN_CHARSET);
    if (!text) continue;
    const ys = quad.map((p) => p.y); const xs = quad.map((p) => p.x);
    lines.push({
      text, confidence,
      top: Math.min(...ys) / recScale, height: (Math.max(...ys) - Math.min(...ys)) / recScale,
      left: Math.min(...xs) / recScale, right: Math.max(...xs) / recScale,
      score: box.score,
    });
  }
  const tRec = performance.now() - t1;

  const text = lines.map((l) => l.text).join('\n');
  const { fields } = parseLabel({ text, lines });
  const box = lines.length ? {
    left: Math.min(...lines.map((l) => l.left)), top: Math.min(...lines.map((l) => l.top)),
    right: Math.max(...lines.map((l) => l.right)), bottom: Math.max(...lines.map((l) => l.top + l.height)),
  } : null;
  return {
    fields, rawText: text, lineCount: lines.length, box, lines,
    timing: { det: Math.round(tDet), rec: Math.round(tRec), boxes: boxes.length },
    threads: threadsUsed, crossOriginIsolated: self.crossOriginIsolated,
  };
}

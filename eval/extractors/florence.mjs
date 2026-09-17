/* Candidate A: Florence-2 via transformers.js, task <OCR_WITH_REGION>.
 *
 * One model gives both halves of the problem: text lines *and* their boxes,
 * so the union of the boxes is a label-detection candidate for free. The
 * lines are fed to the app's own parseLabel so the parser is held constant
 * across candidates — any gain here is the recogniser's, not a parser tweak.
 *
 * Weights are never fetched from the network by default (the app is offline
 * and the sandbox cannot reach the model hosts anyway): they are served from
 * /eval/models/<model>/ — see eval/README.md for the file list. Pass
 * { remote: true } in --options to let transformers.js download them, which
 * is the convenient path when running the harness on a laptop.
 */

import { parseLabel } from '../../js/parse.js';
import { MAX_SIDE } from '../../js/warp.js';

const LIB = '/node_modules/@huggingface/transformers/dist/transformers.js';
const TASK = '<OCR_WITH_REGION>';

let loaded = null;

async function load({ model: modelId, device, dtype, remote }) {
  const tf = await import(LIB);
  tf.env.allowRemoteModels = !!remote;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = '/eval/models/';
  // The default points at a CDN; the wasm sits in the package we serve.
  tf.env.backends.onnx.wasm.wasmPaths = '/node_modules/@huggingface/transformers/dist/';

  const tryDevice = async (dev) => {
    const model = await tf.Florence2ForConditionalGeneration.from_pretrained(modelId, { dtype, device: dev });
    return { tf, model, device: dev };
  };
  let core;
  try {
    core = await tryDevice(device);
  } catch (err) {
    if (device !== 'wasm') core = await tryDevice('wasm'); else throw err;
  }
  const [processor, tokenizer] = await Promise.all([
    tf.AutoProcessor.from_pretrained(modelId),
    tf.AutoTokenizer.from_pretrained(modelId),
  ]);
  return { ...core, processor, tokenizer };
}

/** EXIF-orientated, downscaled copy of the photo as a RawImage. */
async function toRawImage(tf, blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const oriented = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return tf.RawImage.fromBlob(oriented);
}

export async function extract(blob, options = {}) {
  const opts = {
    model: 'Florence-2-base-ft', device: 'webgpu', dtype: 'fp32', remote: false,
    maxNewTokens: 1024, ...options,
  };
  loaded ||= load(opts);
  const { tf, model, processor, tokenizer, device } = await loaded;

  const image = await toRawImage(tf, blob);
  const visionInputs = await processor(image);
  const textInputs = tokenizer(processor.construct_prompts(TASK));
  const generated = await model.generate({ ...textInputs, ...visionInputs, max_new_tokens: opts.maxNewTokens });
  const decoded = tokenizer.batch_decode(generated, { skip_special_tokens: false })[0];
  const parsed = processor.post_process_generation(decoded, TASK, image.size);
  const out = parsed[TASK] || {};
  const labels = out.labels || [];
  const quads = out.quad_boxes || [];

  const lines = labels.map((label, i) => {
    const q = quads[i] || [];
    const xs = q.filter((_, k) => k % 2 === 0);
    const ys = q.filter((_, k) => k % 2 === 1);
    const left = xs.length ? Math.min(...xs) : 0;
    const right = xs.length ? Math.max(...xs) : 0;
    const top = ys.length ? Math.min(...ys) : i;
    const bottom = ys.length ? Math.max(...ys) : i;
    const text = String(label).replace(/<\/?s>|<pad>/g, '').replace(/\s+/g, ' ').trim();
    return { text, height: bottom - top, top, left, right, confidence: 100 };
  }).filter((l) => l.text);

  const text = lines.map((l) => l.text).join('\n');
  const { fields } = parseLabel({ text, lines });
  const box = lines.length ? {
    left: Math.min(...lines.map((l) => l.left)),
    top: Math.min(...lines.map((l) => l.top)),
    right: Math.max(...lines.map((l) => l.right)),
    bottom: Math.max(...lines.map((l) => l.top + l.height)),
  } : null;
  return { fields, rawText: text, lineCount: lines.length, box, device };
}

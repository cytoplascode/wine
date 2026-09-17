/* Automatic label detection: the text detector plus the paper-edge scan,
 * composed into "six handles for this photo". Shared by the crop screen and
 * the eval harness. */

import { detectText } from './ppocr.js';
import { detectLabelUpright } from './detect.js';

/**
 * Find the label in `source` (a canvas or ImageBitmap). Resolves to
 * `{ points, found, boxes, ms }` with the six handles in source pixels, or
 * null when no text was found to start from. Throws if the engine cannot
 * be loaded — the caller decides whether that is worth mentioning.
 */
export async function findLabel(source, onProgress) {
  const t0 = performance.now();
  const { boxes, gray } = await detectText(source, onProgress);
  const working = boxes.map((b) => ({
    left: b.left / gray.scale.x, top: b.top / gray.scale.y,
    right: b.right / gray.scale.x, bottom: b.bottom / gray.scale.y,
    w: b.w / gray.scale.x, h: b.h / gray.scale.y,
    corners: b.corners.map((c) => ({ x: c.x / gray.scale.x, y: c.y / gray.scale.y })),
  }));
  const result = detectLabelUpright({
    gray: gray.data, chroma: gray.chroma, width: gray.width, height: gray.height, boxes: working,
  });
  if (!result) return null;
  return {
    points: result.points.map((p) => ({ x: p.x * gray.scale.x, y: p.y * gray.scale.y })),
    found: result.found,
    tilt: result.tilt || 0,
    boxes,
    ms: Math.round(performance.now() - t0),
  };
}

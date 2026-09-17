/* The unwrap, from a photo and six handles to a flat label canvas. Shared by
 * the crop screen and the eval harness so the measurement runs the code the
 * app ships. */

import { cylinderSize, warpCylinder, MAX_SIDE, DEFAULT_WRAP } from './warp.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Indices into the six handles: A, B, C, D, E, F. */
const TL = 0; const TR = 2; const BR = 3; const BL = 5;

function boundingBox(shape, width, height) {
  const xs = shape.map((p) => p.x);
  const ys = shape.map((p) => p.y);
  const x = clamp(Math.floor(Math.min(...xs)), 0, width);
  const y = clamp(Math.floor(Math.min(...ys)), 0, height);
  const right = clamp(Math.ceil(Math.max(...xs)), 0, width);
  const bottom = clamp(Math.ceil(Math.max(...ys)), 0, height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/**
 * Unwrap the label bounded by `points` (six handles in `source` pixels) off a
 * cylinder of wrap angle `wrap`. `source` is anything drawImage accepts.
 * Returns a canvas.
 */
export function flattenLabel(source, points, wrap = DEFAULT_WRAP) {
  const size = cylinderSize(points, MAX_SIDE, wrap);

  // Read back only the bounding box, and only at the resolution the output can
  // use. Height is the honest yardstick: unrolling stretches width on purpose.
  const rawHeight = Math.max(
    Math.hypot(points[TL].x - points[BL].x, points[TL].y - points[BL].y),
    Math.hypot(points[TR].x - points[BR].x, points[TR].y - points[BR].y),
  );
  const scale = Math.min(1, size.height / Math.max(1, rawHeight));

  const box = boundingBox(points, source.width, source.height);
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = Math.max(1, Math.round(box.width * scale));
  srcCanvas.height = Math.max(1, Math.round(box.height * scale));
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, srcCanvas.width, srcCanvas.height);
  const image = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  const local = points.map((p) => ({ x: (p.x - box.x) * scale, y: (p.y - box.y) * scale }));
  const warped = warpCylinder(image, local, size.width, size.height, wrap);

  const canvas = document.createElement('canvas');
  canvas.width = warped.width;
  canvas.height = warped.height;
  canvas.getContext('2d').putImageData(new ImageData(warped.data, warped.width, warped.height), 0, 0);
  return canvas;
}

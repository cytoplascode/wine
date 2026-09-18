/* A segmentation mask, turned into the six handles the crop screen uses.
 *
 * The mask says which pixels are the label; the crop screen wants two
 * straight sides and two half-ellipses, because that is the shape the
 * unwrap inverts. So the blob's outline is measured and those four curves
 * are fitted to it: for each row the leftmost and rightmost pixel give the
 * sides, and for each column the topmost and bottommost give the top and
 * bottom edges.
 *
 * Only the middle of each span is measured. Near the very top of a bowed
 * label the leftmost pixel of a row lies on the arc, not on the side, and
 * the same confusion happens at the ends of the top edge; ignoring the
 * outer fifth keeps each fit to the part of the outline it is about.
 *
 * Pure: no DOM, no model. `fitEdge` is the same least-squares-with-outlier
 * -rejection Snap uses, so a line and a half-ellipse mean the same thing in
 * both places.
 */

import { components } from './ppocr-post.js';
import { fitEdge } from './refine.js';

/** Ignore this share of each span at both ends when fitting. */
const MARGIN = 0.2;

/** A mask this thin or this wide is not a label. */
const MIN_COVERAGE = 0.02;
const MIN_SIDE = 8;

/**
 * Six handles for the biggest blob in `mask` (a Uint8Array of 0/1).
 * Returns `{ points, bounds, area }` in mask coordinates, or null when
 * there is nothing label-shaped to fit.
 */
export function handlesFromMask({ mask, width, height }) {
  if (!mask || width < MIN_SIDE || height < MIN_SIDE) return null;

  const blobs = components(mask, width, height, 0.5);
  if (!blobs.length) return null;
  const blob = blobs.reduce((a, b) => (b.length > a.length ? b : a));
  if (blob.length < width * height * MIN_COVERAGE) return null;

  // Outline: the extreme pixel of every row and every column.
  const rowMin = new Int32Array(height).fill(-1);
  const rowMax = new Int32Array(height).fill(-1);
  const colMin = new Int32Array(width).fill(-1);
  const colMax = new Int32Array(width).fill(-1);
  let left = width; let right = -1; let top = height; let bottom = -1;
  for (const i of blob) {
    const x = i % width;
    const y = (i - x) / width;
    if (rowMin[y] < 0 || x < rowMin[y]) rowMin[y] = x;
    if (x > rowMax[y]) rowMax[y] = x;
    if (colMin[x] < 0 || y < colMin[x]) colMin[x] = y;
    if (y > colMax[x]) colMax[x] = y;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) return null;

  // Each edge gets a −1…1 parameter across its *whole* span, so ±1 is the
  // corner, and the half-ellipse's bulge vanishes there exactly as it does
  // on the real outline. Only the middle is sampled, but the parameter is
  // not rescaled to it, so the corners need no extrapolation.
  const inset = (from, to) => Math.round((to - from) * MARGIN);
  const sample = (full, extremes) => {
    const us = []; const vs = [];
    const half = (full.to - full.from) / 2 || 1;
    const mid = full.from + half;
    const skip = inset(full.from, full.to);
    for (let k = full.from + skip; k <= full.to - skip; k += 1) {
      us.push((k - mid) / half);
      vs.push(extremes[k] >= 0 ? extremes[k] : null);
    }
    return { us, vs };
  };

  const rows = { from: top, to: bottom };
  const cols = { from: left, to: right };
  const tolerance = Math.max(2, (right - left) * 0.02);
  const sideFit = (extremes) => {
    const { us, vs } = sample(rows, extremes);
    return fitEdge(us, vs, { curved: false, tolerance });
  };
  const capFit = (extremes) => {
    const { us, vs } = sample(cols, extremes);
    return fitEdge(us, vs, { curved: true, tolerance });
  };

  const leftFit = sideFit(rowMin);
  const rightFit = sideFit(rowMax);
  const topFit = capFit(colMin);
  const bottomFit = capFit(colMax);
  if (!leftFit || !rightFit || !topFit || !bottomFit) return null;

  // A side is a line in the row parameter; a cap is a line plus a bulge in
  // the column parameter. Both reach ±1 at the corners, where they meet.
  const line = (fit, u) => fit.alpha + fit.beta * u;
  const cap = (fit, u) => fit.alpha + fit.beta * u + fit.h * Math.sqrt(Math.max(0, 1 - u * u));

  const xTopLeft = line(leftFit, -1);
  const xBottomLeft = line(leftFit, 1);
  const xTopRight = line(rightFit, -1);
  const xBottomRight = line(rightFit, 1);
  const yLeftTop = cap(topFit, -1);
  const yRightTop = cap(topFit, 1);
  const yLeftBottom = cap(bottomFit, -1);
  const yRightBottom = cap(bottomFit, 1);

  // A fitted curve cannot leave the blob it was fitted to. It can try when
  // the label runs off the photo and one edge is a straight cut across the
  // frame: the outline then has no curve to measure and the fit runs away.
  // The blob's own bounds are the honest limit, and the true apex sits on
  // them, so clamping loses nothing where the fit is sound.
  const clampX = (x) => Math.max(left, Math.min(right, x));
  const clampY = (y) => Math.max(top, Math.min(bottom, y));

  const points = [
    { x: clampX(xTopLeft), y: clampY(yLeftTop) },
    { x: clampX((xTopLeft + xTopRight) / 2), y: clampY(cap(topFit, 0)) },
    { x: clampX(xTopRight), y: clampY(yRightTop) },
    { x: clampX(xBottomRight), y: clampY(yRightBottom) },
    { x: clampX((xBottomLeft + xBottomRight) / 2), y: clampY(cap(bottomFit, 0)) },
    { x: clampX(xBottomLeft), y: clampY(yLeftBottom) },
  ];

  return {
    points,
    bounds: { left, top, right, bottom },
    area: blob.length,
  };
}

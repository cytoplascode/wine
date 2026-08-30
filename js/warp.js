/* Perspective correction.
 *
 * Canvas 2D can only do affine transforms, so flattening a label photographed
 * at an angle is done by hand: solve the projective transform that maps the
 * output rectangle back onto the quad the user dragged, then walk every output
 * pixel and sample the source through it. Mapping destination -> source (rather
 * than the other way round) is what guarantees no holes in the result.
 *
 * Pure: no DOM, so it runs under `node --test` as well as in the browser.
 */

/** Longest side of the flattened image. Keeps a 12 MP phone photo to ~2 MP of
 *  resampling, which is a few hundred milliseconds of JS on a mid-range phone. */
export const MAX_SIDE = 1600;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Solve the 8 coefficients mapping `from` onto `to` (four points each).
 *
 *   u = (h0·x + h1·y + h2) / (h6·x + h7·y + 1)
 *   v = (h3·x + h4·y + h5) / (h6·x + h7·y + 1)
 */
export function solveHomography(from, to) {
  const a = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return solve(a, b);
}

/** Apply the 8 coefficients to a single point. */
export function applyHomography(h, x, y) {
  const den = h[6] * x + h[7] * y + 1;
  return {
    x: (h[0] * x + h[1] * y + h[2]) / den,
    y: (h[3] * x + h[4] * y + h[5]) / den,
  };
}

/** Gaussian elimination with partial pivoting. */
function solve(a, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('Those corners are degenerate');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];

    const p = a[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = a[row][col] / p;
      if (!factor) continue;
      for (let k = col; k < n; k++) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }

  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) sum -= a[row][k] * x[k];
    x[row] = sum / a[row][row];
  }
  return x;
}

/**
 * Put four dragged corners into top-left, top-right, bottom-right, bottom-left
 * order. Dragging one corner past another would otherwise produce a bow-tie and
 * a scrambled result.
 */
export function orderQuad(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  // Screen coordinates run y-down, so ascending angle is clockwise.
  const sorted = [...points].sort(
    (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
  );

  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  }
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

/**
 * Output size for a quad: the longer of each opposing pair of edges, so nothing
 * is squeezed, scaled down to fit `maxSide`.
 */
export function outputSize(quad, maxSide = MAX_SIDE) {
  const [tl, tr, br, bl] = quad;
  let width = Math.max(distance(tl, tr), distance(bl, br));
  let height = Math.max(distance(tl, bl), distance(tr, br));

  const longest = Math.max(width, height);
  if (longest > maxSide) {
    const k = maxSide / longest;
    width *= k;
    height *= k;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * Flatten `quad` out of `source` into a `width`×`height` image.
 *
 * `source` and the result are both plain `{ width, height, data }`, so this
 * works with a browser ImageData or a bare typed array in tests.
 */
export function warpQuad(source, quad, width, height) {
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const h = solveHomography(corners, quad);

  const src = source.data;
  const sw = source.width;
  const sh = source.height;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sample through the pixel centre, then step back to texel space.
      const dx = x + 0.5;
      const dy = y + 0.5;
      const den = h[6] * dx + h[7] * dy + 1;
      const sx = (h[0] * dx + h[1] * dy + h[2]) / den - 0.5;
      const sy = (h[3] * dx + h[4] * dy + h[5]) / den - 0.5;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      const x0c = clamp(x0, 0, sw - 1);
      const x1c = clamp(x0 + 1, 0, sw - 1);
      const y0c = clamp(y0, 0, sh - 1);
      const y1c = clamp(y0 + 1, 0, sh - 1);

      const i00 = (y0c * sw + x0c) * 4;
      const i10 = (y0c * sw + x1c) * 4;
      const i01 = (y1c * sw + x0c) * 4;
      const i11 = (y1c * sw + x1c) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = src[i00 + c] * w00 + src[i10 + c] * w10
                   + src[i01 + c] * w01 + src[i11 + c] * w11;
      }
    }
  }

  return { width, height, data: out };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

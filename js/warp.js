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

  return resample(source, width, height, (dx, dy, point) => {
    const den = h[6] * dx + h[7] * dy + 1;
    point.x = (h[0] * dx + h[1] * dy + h[2]) / den;
    point.y = (h[3] * dx + h[4] * dy + h[5]) / den;
  });
}

/* ── Cylindrical unwrap ─────────────────────────────────────────────── */

/** Widest and narrowest wrap the app will apply, and where it starts.
 *
 *  A wine label typically covers 120–150° of the bottle. Assuming a full 180°
 *  — which this did at first — stretches every label by π/2 instead of the
 *  ~1.25 it deserves, and smears the left and right thirds worst of all.
 */
export const MIN_WRAP = Math.PI / 3;      //  60°, barely curved
export const MAX_WRAP = Math.PI;          // 180°, all the way round the front
export const DEFAULT_WRAP = (140 * Math.PI) / 180;

/** How much longer the unrolled arc is than the chord you can see. */
export const arcOverChord = (wrap) => wrap / (2 * Math.sin(wrap / 2));

/**
 * Flatten a label that is wrapped round a bottle.
 *
 * A homography corrects perspective but cannot undo curvature: the label's own
 * surface is curved, so its text is compressed towards the silhouette edges and
 * its lines bow. Measured on a modelled bottle, that is what shreds the small
 * print into fragments like "APPE" / "LLATION SAINT-ESTE" / "PHE".
 *
 * `points` are [A, B, C, D, E, F]: the top-left, top-middle and top-right of
 * the label, then bottom-right, bottom-middle and bottom-left.
 *
 *      A ---- B ---- C          The top edge A-B-C and the bottom edge F-E-D
 *      |             |          are the projection of the cylinder's circular
 *      |             |          cross-section, so each is half an ellipse.
 *      F ---- E ---- D
 *
 * An ellipse through those three points is `centre + axis·cos φ + bulge·sin φ`,
 * where `axis` is the half-chord and `bulge` runs from the chord's midpoint to
 * the middle handle. Walking it in equal *angular* steps is equal steps of arc
 * length on the label itself — so writing those into evenly spaced output
 * columns is exactly the unrolling.
 *
 * `wrap` is how much of the bottle the label covers, in radians. It cannot be
 * recovered from the handles: writing `d = D/R` for the camera distance in radii
 * and `c = cos(wrap/2)`, the centre-to-edge height ratio is `(d−c)/(d−1)` and the
 * edges' bulge relative to the label height is `(1−c)/(d−1)` — the same equation
 * twice, so a near bottle wrapping a little projects exactly like a far one
 * wrapping a lot. The caller supplies it; the app puts it on a slider.
 */
export function warpCylinder(source, points, width, height, wrap = DEFAULT_WRAP) {
  const [a, b, c, d, e, f] = points;

  const top = ellipseThrough(a, b, c);
  const bottom = ellipseThrough(f, e, d);
  const halfWrap = wrap / 2;
  const edge = Math.sin(halfWrap);

  return resample(source, width, height, (dx, dy, point) => {
    // Equal steps of arc length along the label are equal steps of angle on the
    // bottle. Their position across the chord is sin α, normalised so that the
    // ends land exactly on the corner handles.
    const alpha = (dx / width - 0.5) * wrap;
    const along = Math.sin(alpha) / edge;
    const off = Math.sqrt(Math.max(0, 1 - along * along));

    const topX = top.cx + top.ax * along + top.bx * off;
    const topY = top.cy + top.ay * along + top.by * off;
    const bottomX = bottom.cx + bottom.ax * along + bottom.bx * off;
    const bottomY = bottom.cy + bottom.ay * along + bottom.by * off;

    const v = dy / height;
    point.x = topX + (bottomX - topX) * v;
    point.y = topY + (bottomY - topY) * v;
  });
}

/**
 * Points along the edge from `left` to `right` through `middle`, for drawing the
 * same curve the unwrap samples. `count` points, endpoints included.
 */
export function edgeArc(left, middle, right, count = 32) {
  const e = ellipseThrough(left, middle, right);
  const points = [];
  for (let i = 0; i < count; i++) {
    const phi = (1 - i / (count - 1)) * Math.PI;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    points.push({
      x: e.cx + e.ax * cos + e.bx * sin,
      y: e.cy + e.ay * cos + e.by * sin,
    });
  }
  return points;
}

/** The half-ellipse passing through `left` at φ=π, `middle` at φ=π/2, `right` at φ=0. */
function ellipseThrough(left, middle, right) {
  const cx = (left.x + right.x) / 2;
  const cy = (left.y + right.y) / 2;
  return {
    cx,
    cy,
    ax: (right.x - left.x) / 2,
    ay: (right.y - left.y) / 2,
    bx: middle.x - cx,
    by: middle.y - cy,
  };
}

/**
 * Output size for a wrapped label. The width is the *arc* length, not the chord:
 * a label wrapping `wrap` radians of a bottle has chord `2R·sin(wrap/2)` and arc
 * `R·wrap`, so the chord grows by `wrap / (2·sin(wrap/2))` — π/2 only in the
 * limiting case of a label that goes all the way round the visible half.
 */
export function cylinderSize(points, maxSide = MAX_SIDE, wrap = DEFAULT_WRAP) {
  const [a, b, c, d, e, f] = points;

  const chord = (distance(a, c) + distance(f, d)) / 2;
  let width = chord * arcOverChord(wrap);
  let height = Math.max(distance(a, f), distance(c, d));

  const longest = Math.max(width, height);
  if (longest > maxSide) {
    const k = maxSide / longest;
    width *= k;
    height *= k;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/* ── Shared resampler ───────────────────────────────────────────────── */

/**
 * Walk every output pixel, ask `mapPoint` where it came from, and sample the
 * source there with bilinear interpolation. Mapping destination → source (never
 * the reverse) is what guarantees the result has no holes.
 */
function resample(source, width, height, mapPoint) {
  const src = source.data;
  const sw = source.width;
  const sh = source.height;
  const out = new Uint8ClampedArray(width * height * 4);
  const point = { x: 0, y: 0 };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      mapPoint(x + 0.5, y + 0.5, point);

      // Step back from pixel centres into texel space.
      const sx = point.x - 0.5;
      const sy = point.y - 0.5;

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
      for (let ch = 0; ch < 4; ch++) {
        out[o + ch] = src[i00 + ch] * w00 + src[i10 + ch] * w10
                    + src[i01 + ch] * w01 + src[i11 + ch] * w11;
      }
    }
  }

  return { width, height, data: out };
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

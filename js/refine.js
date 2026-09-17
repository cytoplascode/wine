/* Snap: the last, precise adjustment of six handles the user has already
 * placed roughly on the label.
 *
 * A handle a few pixels off skews the whole unwrapped label, and a
 * fingertip cannot place it better than that. But once the handles are
 * roughly right, the hard question — what is paper and what is not — has
 * been answered by the user: paper is what lies inside the handles, the
 * rest is outside. Each edge is then a small, local problem: sample the
 * user's edge, look a little way to either side of every sample for the
 * point where inside-looking pixels give way to outside-looking ones, and
 * fit the edge's own shape (a line for the sides, a half-ellipse for the top
 * and bottom, the same curve the unwrap uses) through those points.
 *
 * Pure: no DOM. Works on the luminance + chroma planes at a working scale;
 * points come and go in that scale. Every handle stays within `radius` of
 * where the user put it, and an edge with too little contrast is left alone.
 */

import { edgeArc } from './warp.js';

const TL = 0; const TM = 1; const TR = 2; const BR = 3; const BM = 4; const BL = 5;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Bilinear sample of a plane at a fractional position; null outside. */
function sample(plane, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;
  const x0 = Math.floor(x); const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0; const fy = y - y0;
  const a = plane[y0 * width + x0]; const b = plane[y0 * width + x1];
  const c = plane[y1 * width + x0]; const d = plane[y1 * width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** How unlike two pixels are, in a scale where ~1 is "clearly different". */
const LUM_SCALE = 30;
const CHROMA_SCALE = 25;
const unlikeness = (lum, chroma, model) => (
  Math.abs(lum - model.lum) / LUM_SCALE + (chroma === null ? 0 : Math.abs(chroma - model.chroma) / CHROMA_SCALE)
);

/**
 * Along a set of samples `{x, y, nx, ny}` (position and outward unit
 * normal), find where inside turns into outside. Returns per-sample
 * offsets along the normal (null where no clean edge was seen), and
 * whether inside and outside differ enough to be told apart at all.
 */
export function edgeOffsets(planes, width, height, samples, radius) {
  const { gray, chroma } = planes;
  const read = (s, t) => {
    const x = s.x + s.nx * t; const y = s.y + s.ny * t;
    const lum = sample(gray, width, height, x, y);
    if (lum === null) return null;
    return { lum, chroma: chroma ? sample(chroma, width, height, x, y) : null };
  };

  // Inside and outside, as the user's placement defines them.
  const inside = { lum: [], chroma: [] }; const outside = { lum: [], chroma: [] };
  for (const s of samples) {
    for (let t = radius * 1.5; t <= radius * 3; t += Math.max(1, radius / 4)) {
      const inPx = read(s, -t); const outPx = read(s, t);
      if (inPx) { inside.lum.push(inPx.lum); if (inPx.chroma !== null) inside.chroma.push(inPx.chroma); }
      if (outPx) { outside.lum.push(outPx.lum); if (outPx.chroma !== null) outside.chroma.push(outPx.chroma); }
    }
  }
  if (inside.lum.length < 8 || outside.lum.length < 8) return { offsets: samples.map(() => null), contrast: 0 };
  const inModel = { lum: median(inside.lum), chroma: inside.chroma.length ? median(inside.chroma) : 0 };
  const outModel = { lum: median(outside.lum), chroma: outside.chroma.length ? median(outside.chroma) : 0 };
  const contrast = unlikeness(outModel.lum, chroma ? outModel.chroma : null, inModel);
  if (contrast < 0.8) return { offsets: samples.map(() => null), contrast };

  const offsets = samples.map((s) => {
    // Profile across the edge: −radius (inside) … +radius (outside).
    const looksInside = [];
    for (let t = -radius; t <= radius; t += 1) {
      const px = read(s, t);
      if (!px) return null;
      looksInside.push(unlikeness(px.lum, px.chroma, inModel) <= unlikeness(px.lum, px.chroma, outModel));
    }
    // The split that best separates inside-looking from outside-looking.
    const n = looksInside.length;
    let insideBefore = 0;
    let outsideAfter = looksInside.filter((v) => !v).length;
    let best = -1; let bestAt = 0;
    for (let k = 0; k <= n; k += 1) {
      const agreement = insideBefore + outsideAfter;
      if (agreement > best) { best = agreement; bestAt = k; }
      if (k < n) { if (looksInside[k]) insideBefore += 1; else outsideAfter -= 1; }
    }
    if (best / n < 0.7 || bestAt === 0 || bestAt === n) return null;
    return bestAt - radius - 0.5;
  });
  return { offsets, contrast };
}

/**
 * Least squares of v = α + β u (+ h·sqrt(1 − u²) when `curved`) with three
 * rounds of inlier rejection. `u` runs −1…1 along the edge, `v` is the
 * measured offset. Returns { alpha, beta, h, inliers } or null.
 */
export function fitEdge(us, vs, { curved, tolerance }) {
  let keep = us.map((_, i) => vs[i] !== null);
  let fit = null;
  for (let round = 0; round < 3; round += 1) {
    const rows = []; const rhs = [];
    us.forEach((u, i) => {
      if (!keep[i]) return;
      rows.push(curved ? [1, u, Math.sqrt(Math.max(0, 1 - u * u))] : [1, u]);
      rhs.push(vs[i]);
    });
    if (rows.length < (curved ? 5 : 3)) return null;
    fit = solveLeastSquares(rows, rhs);
    if (!fit) return null;
    const residual = (i) => {
      const u = us[i];
      const predicted = fit[0] + fit[1] * u + (curved ? fit[2] * Math.sqrt(Math.max(0, 1 - u * u)) : 0);
      return Math.abs(vs[i] - predicted);
    };
    const next = us.map((_, i) => vs[i] !== null && residual(i) <= tolerance);
    if (next.every((v, i) => v === keep[i])) break;
    keep = next;
  }
  return { alpha: fit[0], beta: fit[1], h: curved ? fit[2] : 0, inliers: keep.filter(Boolean).length };
}

/** Normal equations for a tiny linear system (2 or 3 unknowns). */
function solveLeastSquares(rows, rhs) {
  const n = rows[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  rows.forEach((r, i) => {
    for (let p = 0; p < n; p += 1) {
      b[p] += r[p] * rhs[i];
      for (let q = 0; q < n; q += 1) A[p][q] += r[p] * r[q];
    }
  });
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-9) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]]; [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let q = col; q < n; q += 1) A[r][q] -= f * A[col][q];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

const unit = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l }; };
const clampStep = (dx, dy, max) => {
  const l = Math.hypot(dx, dy);
  return l > max ? { x: (dx * max) / l, y: (dy * max) / l } : { x: dx, y: dy };
};

/**
 * Six handles at working scale → six handles moved onto the nearby paper
 * edge. `radius` defaults to 4% of the label's width. Returns
 * `{ points, moved }` with a flag per edge; nothing throws.
 */
export function refineHandles(planes, width, height, points, { radius, passes = 3 } = {}) {
  let current = points.map((p) => ({ ...p }));
  const chord = (Math.hypot(points[TR].x - points[TL].x, points[TR].y - points[TL].y)
    + Math.hypot(points[BR].x - points[BL].x, points[BR].y - points[BL].y)) / 2;
  let R = Math.max(6, radius ?? chord * 0.04);
  const moved = { left: false, right: false, top: false, bottom: false };

  for (let pass = 0; pass < passes; pass += 1) {
    const centre = {
      x: current.reduce((s, p) => s + p.x, 0) / 6,
      y: current.reduce((s, p) => s + p.y, 0) / 6,
    };
    const outwardNormal = (px, py, tx, ty) => {
      // Perpendicular to the tangent (tx, ty), pointing away from the centre.
      let n = unit(-ty, tx);
      if ((px - centre.x) * n.x + (py - centre.y) * n.y < 0) n = { x: -n.x, y: -n.y };
      return n;
    };

    const shift = [0, 1, 2, 3, 4, 5].map(() => ({ x: 0, y: 0 }));

    // Sides: a straight line from one corner to the other.
    for (const [a, b, key] of [[BL, TL, 'left'], [TR, BR, 'right']]) {
      const A = current[a]; const B = current[b];
      const t = unit(B.x - A.x, B.y - A.y);
      const samples = []; const us = [];
      const count = 40;
      for (let i = 0; i < count; i += 1) {
        const u = -0.8 + (1.6 * i) / (count - 1);   // keep clear of the corners
        const f = (u + 1) / 2;
        const x = A.x + (B.x - A.x) * f; const y = A.y + (B.y - A.y) * f;
        const n = outwardNormal(x, y, t.x, t.y);
        samples.push({ x, y, nx: n.x, ny: n.y });
        us.push(u);
      }
      const { offsets } = edgeOffsets(planes, width, height, samples, R);
      const fit = fitEdge(us, offsets, { curved: false, tolerance: R / 2 });
      if (!fit || fit.inliers < count * 0.3) continue;
      const nA = samples[0]; const nB = samples[count - 1];
      const vA = fit.alpha - fit.beta; const vB = fit.alpha + fit.beta;
      shift[a] = { x: shift[a].x + nA.nx * vA, y: shift[a].y + nA.ny * vA };
      shift[b] = { x: shift[b].x + nB.nx * vB, y: shift[b].y + nB.ny * vB };
      moved[key] = true;
    }

    // Top and bottom: the half-ellipse through the corners and the middle.
    for (const [l, m, r, key] of [[TL, TM, TR, 'top'], [BL, BM, BR, 'bottom']]) {
      const count = 41;
      const arc = edgeArc(current[l], current[m], current[r], count);
      const samples = []; const us = [];
      for (let i = 4; i < count - 4; i += 1) {   // keep clear of the corners
        const p = arc[i]; const prev = arc[i - 1]; const next = arc[i + 1];
        const n = outwardNormal(p.x, p.y, next.x - prev.x, next.y - prev.y);
        samples.push({ x: p.x, y: p.y, nx: n.x, ny: n.y });
        us.push(-1 + (2 * i) / (count - 1));
      }
      const { offsets } = edgeOffsets(planes, width, height, samples, R);
      const fit = fitEdge(us, offsets, { curved: true, tolerance: R / 2 });
      if (!fit || fit.inliers < samples.length * 0.3) continue;
      // Endpoints and apex move along the chord's outward normal.
      const L = current[l]; const Rt = current[r];
      const tc = unit(Rt.x - L.x, Rt.y - L.y);
      const mid = { x: (L.x + Rt.x) / 2, y: (L.y + Rt.y) / 2 };
      const n = outwardNormal(mid.x, mid.y, tc.x, tc.y);
      const vL = fit.alpha - fit.beta; const vR = fit.alpha + fit.beta; const vM = fit.alpha + fit.h;
      shift[l] = { x: shift[l].x + n.x * vL, y: shift[l].y + n.y * vL };
      shift[r] = { x: shift[r].x + n.x * vR, y: shift[r].y + n.y * vR };
      shift[m] = { x: shift[m].x + n.x * vM, y: shift[m].y + n.y * vM };
      moved[key] = true;
    }

    // Apply, never further than the radius from where the handle was.
    current = current.map((p, i) => {
      const step = clampStep(shift[i].x, shift[i].y, i === TM || i === BM ? R * 1.5 : R);
      return { x: p.x + step.x, y: p.y + step.y };
    });
    // The middle handles live on their chord's perpendicular bisector.
    for (const [l, m, r] of [[TL, TM, TR], [BL, BM, BR]]) {
      const L = current[l]; const Rt = current[r]; const M = current[m];
      const mid = { x: (L.x + Rt.x) / 2, y: (L.y + Rt.y) / 2 };
      const n = unit(-(Rt.y - L.y), Rt.x - L.x);
      const reach = (M.x - mid.x) * n.x + (M.y - mid.y) * n.y;
      current[m] = { x: mid.x + n.x * reach, y: mid.y + n.y * reach };
    }
    // Each pass looks a little less far: the first finds the edge, the
    // later ones settle onto it.
    R = Math.max(3, R * 0.6);
  }

  return { points: current, moved };
}

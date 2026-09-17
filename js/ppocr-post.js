/* Pure pre/post-processing for the PP-OCR pipeline: DB probability map →
 * text boxes, box ordering, and CTC decoding for the recogniser. No DOM, no
 * ORT — everything here runs under `node --test`.
 *
 * Mirrors PaddleOCR's DBPostProcess (thresh / box_thresh / unclip_ratio) and
 * CTCLabelDecode closely enough that the ONNX models see what they were
 * trained against; the unclip is the rectangle special case of the polygon
 * offset PaddleOCR does with pyclipper, which is exact for the min-area rects
 * used here.
 */

/** PaddleOCR `en_dict.txt`: printable ASCII from '0' to '~', then '!' to '/',
 *  then a space — plus CTC blank at index 0 and the extra space
 *  CTCLabelDecode appends (use_space_char). 97 classes, matching the
 *  recogniser's output width. The blank is represented by an empty string. */
export const EN_CHARSET = (() => {
  const chars = [];
  for (let c = 0x30; c <= 0x7e; c += 1) chars.push(String.fromCharCode(c));
  for (let c = 0x21; c <= 0x2f; c += 1) chars.push(String.fromCharCode(c));
  chars.push(' ');
  return ['', ...chars, ' '];
})();

/** Size for the detector: long side ≤ `limit`, both sides multiples of 32. */
export function detInputSize(width, height, limit = 960) {
  const scale = Math.min(1, limit / Math.max(width, height));
  const round32 = (v) => Math.max(32, Math.round((v * scale) / 32) * 32);
  return { width: round32(width), height: round32(height) };
}

/** Width for the recogniser at height `h`: keep the box's aspect, clamp. */
export function recInputWidth(boxW, boxH, h = 48, min = 16, max = 1280) {
  const w = Math.round((boxW / Math.max(1, boxH)) * h);
  return Math.max(min, Math.min(max, w));
}

/* ── DB map → boxes ─────────────────────────────────────────────────── */

/** 4-connected components over prob >= thresh. Returns pixel-index lists. */
export function components(prob, width, height, thresh = 0.3) {
  const seen = new Uint8Array(width * height);
  const out = [];
  const stack = new Int32Array(width * height);
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || prob[start] < thresh) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const pixels = [];
    while (sp) {
      const i = stack[--sp];
      pixels.push(i);
      const x = i % width;
      const y = (i - x) / width;
      const tryPush = (j) => { if (!seen[j] && prob[j] >= thresh) { seen[j] = 1; stack[sp++] = j; } };
      if (x > 0) tryPush(i - 1);
      if (x < width - 1) tryPush(i + 1);
      if (y > 0) tryPush(i - width);
      if (y < height - 1) tryPush(i + width);
    }
    out.push(pixels);
  }
  return out;
}

/** Andrew's monotone chain. Points as [x, y]. Returns the hull CCW. */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Minimum-area bounding rectangle of a hull (calipers over hull edges).
 *  Returns { cx, cy, w, h, angle } with `w` measured along `angle` (radians). */
export function minAreaRect(hull) {
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 1, h: 1, angle: 0 };
  if (hull.length === 2) {
    const [a, b] = hull;
    return {
      cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2,
      w: Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, h: 1,
      angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
    };
  }
  let best = null;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const [x, y] of hull) {
      const rx = x * c - y * s;
      const ry = x * s + y * c;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (!best || area < best.area) {
      const mx = (minX + maxX) / 2;
      const my = (minY + maxY) / 2;
      best = {
        area,
        cx: mx * Math.cos(angle) - my * Math.sin(angle),
        cy: mx * Math.sin(angle) + my * Math.cos(angle),
        w: maxX - minX, h: maxY - minY, angle,
      };
    }
  }
  const { area, ...rect } = best;
  return rect;
}

/** Corners of a rect ordered TL, TR, BR, BL in image space, with the long
 *  side made horizontal so a text line reads left→right. */
export function rectCorners({ cx, cy, w, h, angle }) {
  let W = w; let H = h; let A = angle;
  if (H > W) { [W, H] = [H, W]; A += Math.PI / 2; }
  while (A > Math.PI / 2) A -= Math.PI;
  while (A < -Math.PI / 2) A += Math.PI;
  const c = Math.cos(A); const s = Math.sin(A);
  const dx = W / 2; const dy = H / 2;
  const pt = (px, py) => ({ x: cx + px * c - py * s, y: cy + px * s + py * c });
  return [pt(-dx, -dy), pt(dx, -dy), pt(dx, dy), pt(-dx, dy)];
}

/** Grow a rect the way PaddleOCR unclips a polygon: offset every side by
 *  area·ratio/perimeter. */
export function unclipRect(rect, ratio = 1.5) {
  const area = rect.w * rect.h;
  const perimeter = 2 * (rect.w + rect.h);
  const d = perimeter ? (area * ratio) / perimeter : 0;
  return { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
}

/** Mean of `prob` over a component's pixels — the DB "box score". */
export function meanScore(prob, pixels) {
  let s = 0;
  for (const i of pixels) s += prob[i];
  return pixels.length ? s / pixels.length : 0;
}

/**
 * Probability map → text boxes in *map* pixel coordinates.
 * Each box: { corners: [{x,y}×4], score, w, h } with w the long side.
 */
export function boxesFromMap(prob, width, height, {
  thresh = 0.3, boxThresh = 0.6, unclip = 1.5, minSide = 3, maxBoxes = 1000,
} = {}) {
  const comps = components(prob, width, height, thresh);
  const boxes = [];
  for (const pixels of comps) {
    if (pixels.length < 4) continue;
    const score = meanScore(prob, pixels);
    if (score < boxThresh) continue;
    const pts = pixels.map((i) => [i % width, Math.floor(i / width)]);
    const rect = unclipRect(minAreaRect(convexHull(pts)), unclip);
    if (Math.min(rect.w, rect.h) < minSide) continue;
    const corners = rectCorners(rect).map(({ x, y }) => ({
      x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)),
    }));
    boxes.push({ corners, score, w: Math.max(rect.w, rect.h), h: Math.min(rect.w, rect.h) });
  }
  return boxes.sort((a, b) => b.score - a.score).slice(0, maxBoxes);
}

/** Top-to-bottom, then left-to-right, with a tolerance so a slightly tilted
 *  row stays one row. */
export function orderBoxes(boxes, rowTolerance = 0.5) {
  const withTop = boxes.map((b) => ({
    b,
    top: Math.min(...b.corners.map((c) => c.y)),
    left: Math.min(...b.corners.map((c) => c.x)),
  }));
  withTop.sort((p, q) => p.top - q.top);
  const rows = [];
  for (const item of withTop) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(item.top - row.top) <= rowTolerance * Math.min(item.b.h, row.h)) {
      row.items.push(item);
    } else {
      rows.push({ top: item.top, h: item.b.h, items: [item] });
    }
  }
  return rows.flatMap((r) => r.items.sort((p, q) => p.left - q.left).map((i) => i.b));
}

/* ── CTC ────────────────────────────────────────────────────────────── */

/** Greedy CTC decode of a [T, C] softmax (flat Float32Array). */
export function ctcDecode(logits, T, C, charset = EN_CHARSET) {
  let text = '';
  let last = -1;
  let confSum = 0;
  let n = 0;
  for (let t = 0; t < T; t += 1) {
    let best = 0; let bestP = -1;
    const off = t * C;
    for (let c = 0; c < C; c += 1) {
      const p = logits[off + c];
      if (p > bestP) { bestP = p; best = c; }
    }
    if (best !== 0 && best !== last) { text += charset[best] ?? ''; confSum += bestP; n += 1; }
    last = best;
  }
  return { text: text.trim(), confidence: n ? (confSum / n) * 100 : 0 };
}

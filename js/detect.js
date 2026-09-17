/* Where is the label? Six crop handles from a photo, with no help.
 *
 * Two clues, used in order. The text detector says where the printing is:
 * its boxes are clustered and the main cluster's extent is the label's
 * core. Then a grayscale scan walks outward from that core on each side
 * until the paper gives way to glass or background — a label is a patch of
 * one material against another, and the change in brightness at its edge
 * is the strongest thing in the picture after the text itself. The top and
 * bottom edges are scanned at three columns, which is enough to fit the arc
 * a curved label makes and so to place the middle handles.
 *
 * Pure: no DOM. The grayscale is a Uint8ClampedArray of luminance at some
 * working scale; boxes are text boxes at that same scale; the result is six
 * points at that scale, mapped back by the caller.
 */

/** Indices into the six handles: A, B, C, D, E, F. */
export const TL = 0; export const TM = 1; export const TR = 2;
export const BR = 3; export const BM = 4; export const BL = 5;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/* ── Text cluster ───────────────────────────────────────────────────── */

const overlaps = (a, b) => a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;

const grow = (r, by) => ({ left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by });

const union = (rects) => ({
  left: Math.min(...rects.map((r) => r.left)),
  top: Math.min(...rects.map((r) => r.top)),
  right: Math.max(...rects.map((r) => r.right)),
  bottom: Math.max(...rects.map((r) => r.bottom)),
});

/**
 * The text that belongs together. Starting from the largest box, keep
 * pulling in boxes that sit within about three line-heights of the cluster
 * so far; a neck label, a menu in the background or a second bottle is
 * further away than that and stays out. Boxes: `{left, top, right, bottom}`.
 */
export function clusterBoxes(boxes, reach = 3) {
  if (!boxes.length) return [];
  const area = (b) => (b.right - b.left) * (b.bottom - b.top);
  const groups = [];
  const rest = [...boxes].sort((a, b) => area(b) - area(a));
  while (rest.length) {
    const cluster = [rest.shift()];
    let changed = true;
    while (changed) {
      changed = false;
      const bounds = union(cluster);
      // Reach is the smaller of the candidate's height and the cluster's
      // typical line height: a big headline must not reach three of its own
      // heights across a gap to small print on another label. Text that
      // belongs together but sits further apart is picked up later by the
      // paper-continuity pass.
      const typical = median(cluster.map((b) => b.bottom - b.top));
      for (let i = rest.length - 1; i >= 0; i -= 1) {
        const box = rest[i];
        const h = Math.max(1, Math.min(box.bottom - box.top, typical));
        if (overlaps(grow(box, reach * h), bounds)) {
          cluster.push(box);
          rest.splice(i, 1);
          changed = true;
        }
      }
    }
    groups.push(cluster);
  }
  // The main label is the group with the most printing, not the one with
  // the single biggest word: a neck label's one big name loses to the
  // front label's seven lines. Area weighted by the square root of the
  // count, so one headline still beats a scatter of tiny boxes elsewhere.
  const weight = (g) => g.reduce((sum, b) => sum + area(b), 0) * Math.sqrt(g.length);
  groups.sort((a, b) => weight(b) - weight(a));
  const best = groups[0];
  best.sort((a, b) => area(b) - area(a));   // the seed stays the biggest box
  return best;
}

/* ── Scans ──────────────────────────────────────────────────────────── */

/** What the paper looks like: its median brightness over some pixels, and
 *  how far a pixel may stray from it and still be paper. */
export function paperModel(values, chromaValues = null, minTolerance = 28, maxTolerance = 60) {
  const paper = median(values);
  const spread = median(values.map((v) => Math.abs(v - paper)));
  // A sample that straddles the paper's edge has a huge spread; capping the
  // tolerance keeps such a sample from declaring everything paper.
  const model = { paper, tolerance: Math.min(maxTolerance, Math.max(minTolerance, 4 * spread)) };
  if (chromaValues && chromaValues.length) {
    // Colour is the second opinion: a highlight on green glass is as bright
    // as white paper but not as grey, and glass between two labels is as
    // dark as a purple label but not as purple.
    const chroma = median(chromaValues);
    const chromaSpread = median(chromaValues.map((v) => Math.abs(v - chroma)));
    model.chroma = chroma;
    model.chromaTolerance = Math.min(50, Math.max(22, 4 * chromaSpread));
  }
  return model;
}

/** Does the pixel at `idx` look like this paper? `planes` = { gray, chroma? }. */
const matcher = (planes, model) => (idx) => {
  if (Math.abs(planes.gray[idx] - model.paper) > model.tolerance) return false;
  if (planes.chroma && model.chroma !== undefined
      && Math.abs(planes.chroma[idx] - model.chroma) > model.chromaTolerance) return false;
  return true;
};

/** Index of the pixel at `pos` along `axis`, `k` across it. */
const indexer = (width, axis) => (axis === 'x' ? (pos, k) => k * width + pos : (pos, k) => pos * width + k);

/**
 * Walk from `from` along `axis` in `direction` (+1 or −1), looking at the
 * band `[bandStart, bandEnd)` across the other axis, until the band stops
 * looking like the paper next to the start. The paper is measured in the
 * first few steps unless a `model` is given. A change counts as the edge
 * only if it persists for `confirm` further steps: a printed rule or a
 * line of type is thin and the paper resumes behind it, glass does not.
 *
 * Returns the last paper position, the image boundary when the label runs
 * out of the frame, or null when nothing changed within `limit` steps.
 */
export function scanEdge(planes, width, height, {
  axis, from, direction, bandStart, bandEnd, limit, share = 0.45, model = null, confirm = 6,
}) {
  const { gray } = planes;
  const length = axis === 'x' ? width : height;
  const across = axis === 'x' ? height : width;
  const b0 = Math.max(0, Math.floor(bandStart));
  const b1 = Math.min(across, Math.ceil(bandEnd));
  if (b1 - b0 < 2) return null;
  const at = indexer(width, axis);

  let current = model;
  if (!current) {
    const sample = []; const chromaSample = [];
    for (let step = 1; step <= 3; step += 1) {
      const pos = from + step * direction;
      if (pos < 0 || pos >= length) break;
      for (let k = b0; k < b1; k += 1) {
        sample.push(gray[at(pos, k)]);
        if (planes.chroma) chromaSample.push(planes.chroma[at(pos, k)]);
      }
    }
    if (!sample.length) return from;
    current = paperModel(sample, planes.chroma ? chromaSample : null);
  }
  let matches = matcher(planes, current);
  const differing = (pos) => {
    let n = 0;
    for (let k = b0; k < b1; k += 1) if (!matches(at(pos, k))) n += 1;
    return n / (b1 - b0) >= share;
  };

  // The paper's brightness drifts as a bottle curves away from the light;
  // the baseline follows it slowly, so a gradient is not an edge but a
  // step still is.
  const origin = current.paper;
  const follow = (pos) => {
    const band = [];
    for (let k = b0; k < b1; k += 1) band.push(gray[at(pos, k)]);
    const drifted = current.paper * 0.9 + median(band) * 0.1;
    // A soft, out-of-focus edge is a gradient too; the baseline may not
    // wander further than one tolerance from where it started.
    const capped = Math.max(origin - current.tolerance, Math.min(origin + current.tolerance, drifted));
    current = { ...current, paper: capped };
    matches = matcher(planes, current);
  };

  let streak = 0;
  for (let step = model ? 1 : 4; step <= limit; step += 1) {
    const pos = from + step * direction;
    if (pos < 0 || pos >= length) return direction < 0 ? 0 : length - 1;
    if (!differing(pos)) { streak = 0; follow(pos); continue; }
    streak += 1;
    if (streak < 2) continue;
    // Is it still not paper a little further on?
    let beyond = 0; let seen = 0;
    for (let extra = 1; extra <= confirm; extra += 1) {
      const q = pos + extra * direction;
      if (q < 0 || q >= length) break;
      seen += 1;
      if (differing(q)) beyond += 1;
    }
    if (!seen || beyond / seen >= 0.6) return pos - direction * 2;
    streak = 0;
  }
  return null;
}

/**
 * Come in from outside: walk from `from` in `direction` until the band turns
 * into paper (per `model`) for two steps running, having first seen at least
 * three steps of something else. Returns the first paper position, or null
 * when the scan starts on paper-coloured background or finds none within
 * `limit` steps — either way there is no edge to report.
 */
export function scanInward(planes, width, height, {
  axis, from, direction, bandStart, bandEnd, limit, model, share = 0.7, streakNeeded = 2,
}) {
  const length = axis === 'x' ? width : height;
  const across = axis === 'x' ? height : width;
  const b0 = Math.max(0, Math.floor(bandStart));
  const b1 = Math.min(across, Math.ceil(bandEnd));
  if (b1 - b0 < 2) return null;
  const at = indexer(width, axis);
  const matches = matcher(planes, model);
  const isPaper = (pos) => {
    let n = 0;
    for (let k = b0; k < b1; k += 1) if (matches(at(pos, k))) n += 1;
    return n / (b1 - b0) >= share;
  };
  let other = 0;
  let streak = 0;
  for (let step = 0; step <= limit; step += 1) {
    const pos = from + step * direction;
    if (pos < 0 || pos >= length) continue;
    if (isPaper(pos)) {
      if (other < 3) return null;
      streak += 1;
      if (streak >= streakNeeded) return pos - direction * (streakNeeded - 1);
    } else {
      other += 1;
      streak = 0;
    }
  }
  return null;
}

/** Share of positions in `[a, b]` along `axis` whose band is paper-like. */
export function paperShare(planes, width, height, { axis, a, b, bandStart, bandEnd, model, share = 0.7 }) {
  const across = axis === 'x' ? height : width;
  const b0 = Math.max(0, Math.floor(bandStart));
  const b1 = Math.min(across, Math.ceil(bandEnd));
  if (b1 - b0 < 1 || a >= b) return 1;
  const at = indexer(width, axis);
  const matches = matcher(planes, model);
  let ok = 0; let total = 0;
  for (let pos = Math.max(0, Math.ceil(a)); pos <= Math.min((axis === 'x' ? width : height) - 1, Math.floor(b)); pos += 1) {
    let n = 0;
    for (let k = b0; k < b1; k += 1) if (matches(at(pos, k))) n += 1;
    total += 1;
    if (n / (b1 - b0) >= share) ok += 1;
  }
  return total ? ok / total : 1;
}

/* ── Arc through three points ───────────────────────────────────────── */

/** y at `x` on the parabola through three points. */
export function parabolaAt(pts, x) {
  const [[x0, y0], [x1, y1], [x2, y2]] = pts;
  const l0 = ((x - x1) * (x - x2)) / ((x0 - x1) * (x0 - x2));
  const l1 = ((x - x0) * (x - x2)) / ((x1 - x0) * (x1 - x2));
  const l2 = ((x - x0) * (x - x1)) / ((x2 - x0) * (x2 - x1));
  return y0 * l0 + y1 * l1 + y2 * l2;
}

/* ── The label ──────────────────────────────────────────────────────── */

/** Default curve on the top and bottom edges when none could be measured. */
const DEFAULT_BULGE = 0.03;
/** No measured curve is trusted beyond this share of the label's height. */
const MAX_BULGE = 0.15;
/** How far past its text a label's side may plausibly be, as a share of
 *  the text's width. */
const MAX_SIDE_MARGIN = 0.4;
/** How far in from the label's sides the corner columns run: inside the
 *  unprinted border most labels keep, and inside the narrowing a curved or
 *  tilted bottle gives the label towards its top and bottom. */
const MARGIN = 0.08;

/**
 * Six handles for the label in a picture.
 *
 * `gray` is luminance, `width`×`height`; `boxes` are text boxes at the same
 * scale. Returns `{ points, found, core }` — the handles, which edges were
 * actually seen (the rest fall back to a margin round the text), and the
 * text cluster's extent — or null when there is no text to start from.
 *
 * Order of work: the text near the biggest box is gathered; the label's
 * sides are found by walking out from that text until the paper ends;
 * text further up or down the bottle joins only if the paper continues to
 * it along the label's margin, which is what keeps a back label or a neck
 * label out; then the top and bottom edges are found on the margin columns
 * (no print there) and the arc's apex by coming in from outside at the
 * middle, where a headline would otherwise stop a scan from inside.
 */
export function detectLabel({ gray, chroma = null, width, height, boxes }) {
  const planes = { gray, chroma };
  const near = clusterBoxes(boxes);
  if (!near.length) return null;
  let core = union(near);
  let coreW = core.right - core.left;
  let coreH = core.bottom - core.top;
  if (coreW < width * 0.08 || coreH < height * 0.03) return null;

  const lineH = median(near.map((b) => b.bottom - b.top));
  const margin = Math.max(lineH * 0.8, coreW * 0.04);
  const clampX = (x) => Math.max(0, Math.min(width - 1, x));
  const clampY = (y) => Math.max(0, Math.min(height - 1, y));

  // Sides, from the biggest box's rows: it is the most surely on the label.
  const seed = near[0];
  // No thin-line forgiveness on the sides: the bottle's own silhouette is a
  // thin dark line, and beyond it a bright wall would pass for paper.
  const side = (direction) => scanEdge(planes, width, height, {
    axis: 'x',
    from: direction < 0 ? Math.round(core.left) : Math.round(core.right),
    direction,
    bandStart: seed.top,
    bandEnd: seed.bottom,
    limit: Math.round(width * 0.5),
    confirm: 0,
  });
  // A label is seldom much wider than its printing. When the paper seems
  // to go on further than that — a cream label against a cream wall — the
  // edge was not really seen: the side falls back to the usual margin.
  const farthest = coreW * MAX_SIDE_MARGIN;
  let leftEdge = side(-1);
  let rightEdge = side(1);
  if (leftEdge !== null && core.left - leftEdge > farthest) leftEdge = null;
  if (rightEdge !== null && rightEdge - core.right > farthest) rightEdge = null;
  const left = clampX(leftEdge ?? core.left - Math.min(margin, farthest));
  const right = clampX(rightEdge ?? core.right + Math.min(margin, farthest));
  const labelW = Math.max(1, right - left);

  // The paper, sampled beside the seed in the inner part of the strips
  // between the text and the sides — clear of the text and of the shading
  // and curvature at the very edge.
  const marginBand = Math.max(2, labelW * 0.03);
  const columns = [left + labelW * MARGIN, right - labelW * MARGIN];
  const sample = []; const chromaSample = [];
  const strips = [
    [core.left - (core.left - left) * 0.7, core.left - (core.left - left) * 0.1],
    [core.right + (right - core.right) * 0.1, core.right + (right - core.right) * 0.7],
  ];
  for (const [x0, x1] of strips) {
    for (let y = Math.max(0, Math.floor(seed.top)); y < Math.min(height, seed.bottom); y += 1) {
      for (let k = Math.max(0, Math.round(x0)); k < Math.min(width, Math.round(x1)); k += 1) {
        sample.push(gray[y * width + k]);
        if (chroma) chromaSample.push(chroma[y * width + k]);
      }
    }
  }
  const model = sample.length >= 20 ? paperModel(sample, chroma ? chromaSample : null) : null;

  // The paper as each corner column sees it: brightness varies across a
  // curved label, so every column is judged against its own stretch of
  // paper beside the text rather than one figure for the whole label.
  const columnModel = (x, rows) => {
    const values = []; const chromaValues = [];
    for (let y = Math.max(0, Math.floor(rows.top)); y < Math.min(height, rows.bottom); y += 1) {
      for (let k = Math.max(0, Math.round(x - marginBand / 2)); k < Math.min(width, Math.round(x + marginBand / 2)); k += 1) {
        values.push(gray[y * width + k]);
        if (chroma) chromaValues.push(chroma[y * width + k]);
      }
    }
    return values.length >= 10 ? paperModel(values, chroma ? chromaValues : null) : model;
  };
  // Beside the seed first: the seed is the one box surely on this label.
  const seedModels = columns.map((x) => columnModel(x, seed));

  // Text further up or down joins only if the paper reaches it.
  const continuous = (from, to) => !model || columns.some((x, i) => seedModels[i] && paperShare(planes, width, height, {
    axis: 'y', a: from, b: to, bandStart: x - marginBand / 2, bandEnd: x + marginBand / 2, model: seedModels[i],
  }) >= 0.8);
  const inSpan = (b) => b.left >= left - marginBand && b.right <= right + marginBand;
  const cluster = [seed];
  const rest = boxes.filter((b) => b !== seed && inSpan(b)).sort((a, b) => Math.abs((a.top + a.bottom) / 2 - (seed.top + seed.bottom) / 2) - Math.abs((b.top + b.bottom) / 2 - (seed.top + seed.bottom) / 2));
  for (const box of rest) {
    const bounds = union(cluster);
    const joined = box.top >= bounds.bottom ? continuous(bounds.bottom, box.top)
      : box.bottom <= bounds.top ? continuous(box.bottom, bounds.top) : true;
    if (joined) cluster.push(box);
  }
  core = union(cluster);
  coreW = core.right - core.left;
  coreH = core.bottom - core.top;
  const columnModels = columns.map((x) => columnModel(x, core));
  const trace = [];

  // Top and bottom corners: walk the margin columns out from the text.
  const cornerY = (x, direction, colModel) => scanEdge(planes, width, height, {
    axis: 'y',
    from: direction < 0 ? Math.round(core.top) : Math.round(core.bottom),
    direction,
    bandStart: x - marginBand / 2,
    bandEnd: x + marginBand / 2,
    limit: Math.round(labelW * 0.8),
    model: colModel,
  });
  const midX = (left + right) / 2;
  const edge = (direction) => {
    const ys = columns.map((x, i) => cornerY(x, direction, columnModels[i]));
    trace.push({ direction, ys });
    const seen = ys.filter((y) => y !== null);
    const fallback = direction < 0 ? core.top - margin : core.bottom + margin;
    // Two columns that disagree: the one nearer the text is believed, since
    // running past the edge is the way a scan fails, stopping short is not.
    const yCorner = seen.length ? (direction < 0 ? Math.max(...seen) : Math.min(...seen)) : fallback;
    // The apex, from outside in, at the middle of the label.
    const reach = Math.round(labelW * 0.3);
    // The middle sees paper about as bright as the average of the sides.
    const known = columnModels.filter(Boolean);
    const midModel = known.length ? {
      ...known[0],
      paper: known.reduce((sum, m) => sum + m.paper, 0) / known.length,
      tolerance: Math.max(...known.map((m) => m.tolerance)),
    } : model;
    // A glass highlight can be as bright as paper for a few rows; the
    // paper is asked to persist for a while, and to carry on from the apex
    // to the corners' height, before it is believed.
    const persist = Math.max(3, Math.round(labelW * 0.04));
    let apex = midModel && seen.length ? scanInward(planes, width, height, {
      axis: 'y',
      from: Math.round(yCorner + direction * reach),
      direction: -direction,
      bandStart: midX - labelW * 0.06,
      bandEnd: midX + labelW * 0.06,
      limit: Math.round(reach + labelW * 0.05),
      model: midModel,
      streakNeeded: persist,
    }) : null;
    if (apex !== null) {
      const [a, b] = direction < 0 ? [apex, yCorner] : [yCorner, apex];
      const solid = paperShare(planes, width, height, {
        axis: 'y', a, b, bandStart: midX - labelW * 0.06, bandEnd: midX + labelW * 0.06, model: midModel,
      });
      if (solid < 0.6) apex = null;
    }
    return { found: seen.length > 0, yCorner, apex };
  };
  const top = edge(-1);
  const bottom = edge(1);

  // A corner scan that ran far past the text ran away: bound it to a
  // plausible distance and admit the edge was not seen.
  const farthestY = Math.min(coreH * 0.6 + margin, labelW * 0.5);
  if (core.top - top.yCorner > farthestY) { top.yCorner = core.top - margin; top.found = false; top.apex = null; }
  if (bottom.yCorner - core.bottom > farthestY) { bottom.yCorner = core.bottom + margin; bottom.found = false; bottom.apex = null; }
  const yTop = top.yCorner;
  const yBottom = bottom.yCorner;
  const labelH = Math.max(1, yBottom - yTop);
  const limitBulge = (b) => Math.max(-MAX_BULGE * labelH, Math.min(MAX_BULGE * labelH, b));
  const topBulge = top.apex === null ? (top.found ? 0 : DEFAULT_BULGE * labelH) : limitBulge(yTop - top.apex);
  const bottomBulge = bottom.apex === null ? (bottom.found ? 0 : DEFAULT_BULGE * labelH) : limitBulge(bottom.apex - yBottom);

  const points = [
    { x: left, y: clampY(yTop) },
    { x: midX, y: yTop - topBulge },
    { x: right, y: clampY(yTop) },
    { x: right, y: clampY(yBottom) },
    { x: midX, y: yBottom + bottomBulge },
    { x: left, y: clampY(yBottom) },
  ];
  return {
    points,
    found: { left: leftEdge !== null, right: rightEdge !== null, top: top.found, bottom: bottom.found },
    core,
    cluster,
    model,
    trace: { columns, columnModels, seedModels, corners: trace, sides: [leftEdge, rightEdge] },
  };
}

/* ── Tilt ───────────────────────────────────────────────────────────── */

/**
 * How much the label leans, from the text lines: the median angle of the
 * boxes that are clearly wider than tall. Radians, positive clockwise in
 * image coordinates; 0 when there is nothing to go on.
 */
export function tiltFromBoxes(boxes) {
  const angles = [];
  for (const box of boxes) {
    if (!box.corners || box.w < box.h * 2.5) continue;
    const [a, b] = box.corners;
    let angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    angles.push(angle);
  }
  if (angles.length < 2) return 0;
  const tilt = median(angles);
  return Math.abs(tilt) < (0.75 * Math.PI) / 180 ? 0 : tilt;
}

/** Rotate a point about a centre. */
export function rotatePoint({ x, y }, angle, cx, cy) {
  const c = Math.cos(angle); const s = Math.sin(angle);
  const dx = x - cx; const dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** The grayscale turned by `angle` about the image centre, same size,
 *  nearest-neighbour; what falls outside the source is left black. */
export function rotateGray(gray, width, height, angle) {
  const out = new Uint8ClampedArray(width * height);
  const cx = width / 2; const cy = height / 2;
  const c = Math.cos(-angle); const s = Math.sin(-angle);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx; const dy = y - cy;
      const sx = Math.round(cx + dx * c - dy * s);
      const sy = Math.round(cy + dx * s + dy * c);
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) out[y * width + x] = gray[sy * width + sx];
    }
  }
  return out;
}

/** Axis-aligned bounds of a box's corners after rotation. */
export function rotateBox(box, angle, cx, cy) {
  const corners = (box.corners || [
    { x: box.left, y: box.top }, { x: box.right, y: box.top },
    { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom },
  ]).map((p) => rotatePoint(p, angle, cx, cy));
  const xs = corners.map((p) => p.x); const ys = corners.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/**
 * detectLabel for a leaning bottle: straighten the picture by the text's
 * tilt, find the label, and lean the handles back. Boxes need `corners`
 * (four points) for the tilt to be measured; without them this is plain
 * detectLabel.
 */
export function detectLabelUpright({ gray, chroma = null, width, height, boxes }) {
  const tilt = tiltFromBoxes(boxes);
  if (!tilt) return detectLabel({ gray, chroma, width, height, boxes });
  const cx = width / 2; const cy = height / 2;
  const straight = rotateGray(gray, width, height, -tilt);
  const straightChroma = chroma ? rotateGray(chroma, width, height, -tilt) : null;
  const turned = boxes.map((b) => rotateBox(b, -tilt, cx, cy));
  const result = detectLabel({ gray: straight, chroma: straightChroma, width, height, boxes: turned });
  if (!result) return null;
  return { ...result, tilt, points: result.points.map((p) => rotatePoint(p, tilt, cx, cy)) };
}

/** Luminance of an RGBA buffer. */
export function toGray(data, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) {
    out[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }
  return out;
}

/** Chroma of an RGBA buffer: how far from grey each pixel is (max − min). */
export function toChroma(data, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = data[i * 4]; const g = data[i * 4 + 1]; const b = data[i * 4 + 2];
    out[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  return out;
}

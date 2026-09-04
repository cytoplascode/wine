/* Auto-frame the label on a wine bottle.
 *
 * Wine labels are almost always light-coloured paper on darker (green,
 * brown, red) glass, which is a strong colour-contrast signal — the exact
 * shape of problem classical CV is well-suited to. So: threshold the
 * photo's brightness (via Otsu, no magic numbers), take connected
 * components of the bright half, pick the one that most looks like a
 * label, and hand its bounding box back for the crop screen to seed the
 * six handles with. Best-effort — a photo where the label isn't the
 * dominant bright thing (blown-out background, brighter tablecloth,
 * multiple bottles) returns null and the crop falls back to its usual
 * inset-from-the-edges default for the user to drag.
 *
 * Split deliberately in two halves. `detectLabel` is browser-only: it
 * draws the bitmap to a canvas and reads pixels via getImageData.
 * `otsu`, `labelComponents`, and `pickComponent` are pure and live
 * below — Node-testable with no canvas, no bitmap, just numbers.
 */

const MAX_DIM = 800;

// Plausibility filters for what a wine label looks like on a photo — a
// tiny bright spot is probably a specular highlight, something that fills
// most of the frame is probably the sky or a wall behind the bottle.
const MIN_AREA_FRACTION = 0.03;
const MAX_AREA_FRACTION = 0.70;
// A label is roughly rectangular; a thin sliver or a very tall column is
// probably a light fixture or a napkin fold, not what we want.
const MIN_ASPECT = 0.2;
const MAX_ASPECT = 5.0;
// (component area) / (bounding-box area). A real label roughly fills its
// bounding box; a spray of bright specks does not.
const MIN_SOLIDITY = 0.5;

/**
 * Try to find the label in a captured photo. Returns a
 * `{ left, top, right, bottom }` rectangle in source-image (bitmap)
 * pixels, or null if nothing plausible was found.
 */
export function detectLabel(bitmap) {
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  // BT.601 luminance, in fixed-point so the inner loop stays integer-only.
  const gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }

  const threshold = otsu(gray);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > threshold ? 1 : 0;

  const components = labelComponents(mask, w, h);
  const picked = pickComponent(components, w, h);
  if (!picked) return null;

  // Undo the downscale so the caller works in source-image coordinates,
  // and +1 the right/bottom because the component's own coordinates are
  // pixel indices, not half-open intervals.
  return {
    left: picked.left / scale,
    top: picked.top / scale,
    right: (picked.right + 1) / scale,
    bottom: (picked.bottom + 1) / scale,
  };
}

/**
 * Otsu's method: the threshold value that maximises the between-class
 * variance of a bimodal grey histogram — the trough between dark bottle
 * and light label without picking either side by hand. Returns a value in
 * [0, 255]; a pixel with `gray > threshold` counts as bright.
 */
export function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let bestT = 0;
  let bestVariance = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > bestVariance) {
      bestVariance = variance;
      bestT = t;
    }
  }
  return bestT;
}

/**
 * 4-connected connected-components labelling on a 0/1 mask, returning
 * `[{ area, left, top, right, bottom }, …]` for every non-zero blob.
 * One pass with union-find for the label equivalences, one pass to
 * canonicalise the labels and accumulate the stats.
 */
export function labelComponents(mask, w, h) {
  const labels = new Int32Array(mask.length);
  const parent = [0];   // labels are 1-indexed; parent[0] unused

  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a); const rb = find(b);
    if (ra < rb) parent[rb] = ra;
    else if (rb < ra) parent[ra] = rb;
  };

  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - w] : 0;
      if (left && up) {
        labels[i] = Math.min(left, up);
        if (left !== up) union(left, up);
      } else if (left) {
        labels[i] = left;
      } else if (up) {
        labels[i] = up;
      } else {
        labels[i] = next;
        parent[next] = next;
        next++;
      }
    }
  }

  const stats = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const root = find(labels[i]);
      let s = stats.get(root);
      if (!s) {
        s = { area: 0, left: x, right: x, top: y, bottom: y };
        stats.set(root, s);
      }
      s.area++;
      if (x < s.left) s.left = x;
      if (x > s.right) s.right = x;
      if (y < s.top) s.top = y;
      if (y > s.bottom) s.bottom = y;
    }
  }
  return [...stats.values()];
}

/**
 * Pick the component most likely to be a wine label from a list. Filters
 * by area, aspect and solidity; then scores the survivors by `area ×
 * centrality`, so a big central bright blob beats a small edge-hugging
 * one even when both survive the filters. Returns null if none survive.
 */
export function pickComponent(components, w, h) {
  const imageArea = w * h;
  const centerX = w / 2;
  const centerY = h / 2;

  let best = null;
  let bestScore = 0;
  for (const c of components) {
    const bw = c.right - c.left + 1;
    const bh = c.bottom - c.top + 1;
    const boxArea = bw * bh;
    if (c.area < imageArea * MIN_AREA_FRACTION) continue;
    if (c.area > imageArea * MAX_AREA_FRACTION) continue;
    const aspect = bw / bh;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
    if (c.area / boxArea < MIN_SOLIDITY) continue;

    const cx = (c.left + c.right) / 2;
    const cy = (c.top + c.bottom) / 2;
    const dx = (cx - centerX) / centerX;
    const dy = (cy - centerY) / centerY;
    const centrality = 1 / (1 + dx * dx + dy * dy);
    const score = c.area * centrality;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

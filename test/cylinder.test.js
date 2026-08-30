import test from 'node:test';
import assert from 'node:assert/strict';

import { warpCylinder, cylinderSize, warpQuad, outputSize } from '../js/warp.js';

/**
 * Photograph a flat image wrapped round a cylinder using the actual physics: a
 * point at angle α sits at depth `R cos α` and is projected through a pinhole.
 *
 * This is deliberately *not* the ellipse model `warpCylinder` uses, so
 * recovering the original measures the approximation rather than restating it.
 */
function photographCylinder(source, { span = 2.4, R = 37, labelH = 118, D = 260, F = 620, W = 300, H = 420 } = {}) {
  const project = (u, v) => {
    const alpha = (u - 0.5) * span;
    const depth = D - R * Math.cos(alpha);
    return {
      x: W / 2 + (F * R * Math.sin(alpha)) / depth,
      y: H / 2 + (F * (v - 0.5) * labelH) / depth,
    };
  };

  // x is monotonic in α across the visible span, so bisection inverts it.
  const alphaForX = (x) => {
    let lo = -span / 2;
    let hi = span / 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (project(mid / span + 0.5, 0.5).x <= x) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 20;
    data[i * 4 + 3] = 255;
  }

  const edge = project(0, 0.5).x;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (px + 0.5 < edge || px + 0.5 > W - edge) continue;
      const alpha = alphaForX(px + 0.5);
      const depth = D - R * Math.cos(alpha);
      const v = ((py + 0.5 - H / 2) * depth) / (F * labelH) + 0.5;
      if (v < 0 || v >= 1) continue;

      const u = alpha / span + 0.5;
      const sx = Math.min(source.width - 1, Math.max(0, Math.round(u * source.width)));
      const sy = Math.min(source.height - 1, Math.max(0, Math.round(v * source.height)));
      const s = (sy * source.width + sx) * 4;
      const o = (py * W + px) * 4;
      data[o] = source.data[s];
      data[o + 1] = source.data[s + 1];
      data[o + 2] = source.data[s + 2];
    }
  }

  return {
    photo: { width: W, height: H, data },
    // The six handles a user would place: A, B, C, D, E, F.
    points: [project(0, 0), project(0.5, 0), project(1, 0),
      project(1, 1), project(0.5, 1), project(0, 1)],
  };
}

/** Blocks of distinct greys — large-scale structure that survives a coarse compare. */
function blocks(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.floor((x / w) * 5);
      const cy = Math.floor((y / h) * 7);
      const v = ((cx * 7 + cy * 13) % 5) * 55 + 15;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Normalised cross-correlation over box-averaged cells (averaging, not point
 *  sampling, so fine detail cannot alias into noise). */
function correlate(a, b, gw = 20, gh = 28) {
  const grid = (img) => {
    const out = new Float64Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const x0 = Math.floor((gx / gw) * img.width);
        const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) / gw) * img.width));
        const y0 = Math.floor((gy / gh) * img.height);
        const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) / gh) * img.height));
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) { sum += img.data[(y * img.width + x) * 4]; n++; }
        }
        out[gy * gw + gx] = sum / n;
      }
    }
    const mean = out.reduce((s, v) => s + v, 0) / out.length;
    const sd = Math.sqrt(out.reduce((s, v) => s + (v - mean) ** 2, 0) / out.length) || 1;
    return out.map((v) => (v - mean) / sd);
  };
  const ga = grid(a);
  const gb = grid(b);
  let sum = 0;
  for (let i = 0; i < ga.length; i++) sum += ga[i] * gb[i];
  return sum / ga.length;
}

const score = (span) => {
  const flat = blocks(240, 320);
  const { photo, points } = photographCylinder(flat, { span });

  const cylSize = cylinderSize(points, 1600);
  const unwrapped = warpCylinder(photo, points, cylSize.width, cylSize.height);

  const quad = [points[0], points[2], points[3], points[5]];
  const flatSize = outputSize(quad, 1600);
  const flattened = warpQuad(photo, quad, flatSize.width, flatSize.height);

  return { cylinder: correlate(unwrapped, flat), flat: correlate(flattened, flat) };
};

/* ── Size ───────────────────────────────────────────────────────────── */

test('the unrolled width is the arc length, not the chord', () => {
  const points = [
    { x: 0, y: 0 }, { x: 50, y: -10 }, { x: 100, y: 0 },
    { x: 100, y: 60 }, { x: 50, y: 70 }, { x: 0, y: 60 },
  ];
  const size = cylinderSize(points, 4000);
  // Unrolling half a cylinder of chord 100 gives 100·π/2 ≈ 157.
  assert.equal(size.width, 157);
  assert.equal(size.height, 60);
});

test('cylinderSize honours the cap while keeping proportions', () => {
  const points = [
    { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 2000, y: 0 },
    { x: 2000, y: 1000 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 },
  ];
  const size = cylinderSize(points, 1600);
  assert.equal(size.width, 1600);
  assert.ok(Math.abs(size.height / size.width - 1000 / (2000 * (Math.PI / 2))) < 0.01);
});

/* ── Geometry ───────────────────────────────────────────────────────── */

test('each corner handle feeds its own corner of the output', () => {
  // A distinct grey patch in each source corner shows where it comes out.
  const w = 80;
  const h = 60;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  const patch = (px, py, v) => {
    for (let y = py; y < py + 12; y++) {
      for (let x = px; x < px + 12; x++) data[(y * w + x) * 4] = v;
    }
  };
  patch(0, 0, 40); patch(w - 12, 0, 90); patch(w - 12, h - 12, 150); patch(0, h - 12, 210);

  const points = [
    { x: 0, y: 0 }, { x: w / 2, y: 0 }, { x: w, y: 0 },
    { x: w, y: h }, { x: w / 2, y: h }, { x: 0, y: h },
  ];
  const out = warpCylinder({ width: w, height: h, data }, points, 40, 30);
  const at = (x, y) => out.data[(y * out.width + x) * 4];

  assert.equal(at(0, 0), 40, 'top-left');
  assert.equal(at(39, 0), 90, 'top-right');
  assert.equal(at(39, 29), 150, 'bottom-right');
  assert.equal(at(0, 29), 210, 'bottom-left');
});

test('the middle handles steer the middle of the output', () => {
  // A bright band down the centre of the source; the middle handles are pulled
  // off the chord, and the band must still come out down the middle.
  const w = 90;
  const h = 60;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 30; data[i * 4 + 3] = 255; }
  for (let y = 0; y < h; y++) {
    for (let x = 40; x < 50; x++) data[(y * w + x) * 4] = 240;
  }

  const points = [
    { x: 0, y: 10 }, { x: 45, y: 0 }, { x: 90, y: 10 },
    { x: 90, y: 50 }, { x: 45, y: 60 }, { x: 0, y: 50 },
  ];
  const out = warpCylinder({ width: w, height: h, data }, points, 60, 40);
  const row = 20;
  let brightest = 0;
  let brightestX = -1;
  for (let x = 0; x < out.width; x++) {
    const v = out.data[(row * out.width + x) * 4];
    if (v > brightest) { brightest = v; brightestX = x; }
  }
  assert.ok(brightest > 200, `band should survive the unwrap, peak ${brightest}`);
  assert.ok(Math.abs(brightestX - out.width / 2) < 6, `band should stay centred, at ${brightestX}`);
});

/* ── Recovery against a physically projected cylinder ───────────────── */

test('a typical wrap is recovered far better than a flat warp manages', () => {
  // ~137°, which is roughly a 95 mm label on a standard bottle.
  const { cylinder, flat } = score(2.4);
  assert.ok(cylinder > 0.9, `unwrap should recover the label, got ${cylinder.toFixed(3)}`);
  assert.ok(cylinder > flat + 0.2, `unwrap ${cylinder.toFixed(3)} vs flat warp ${flat.toFixed(3)}`);
});

test('a wide wrap is where the flat warp falls apart', () => {
  const { cylinder, flat } = score(2.9);
  assert.ok(cylinder > 0.9, `unwrap ${cylinder.toFixed(3)}`);
  assert.ok(flat < 0.6, `flat warp should be visibly poor here, got ${flat.toFixed(3)}`);
});

test('on a narrow wrap the flat warp is the better model', () => {
  // The unwrap assumes the label spans the full visible half of the bottle. A
  // small label on a fat bottle breaks that assumption and gets over-corrected,
  // which is exactly why the crop screen offers Flat as well as Curved.
  const { cylinder, flat } = score(1.8);
  assert.ok(flat > cylinder, `flat ${flat.toFixed(3)} should beat unwrap ${cylinder.toFixed(3)} here`);
});

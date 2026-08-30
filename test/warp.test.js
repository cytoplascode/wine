import test from 'node:test';
import assert from 'node:assert/strict';

import {
  solveHomography,
  applyHomography,
  orderQuad,
  outputSize,
  warpQuad,
} from '../js/warp.js';

const rect = (w, h) => [
  { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h },
];

function checkerboard(w, h, cell = 4) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = ((x / cell | 0) + (y / cell | 0)) % 2 === 0;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = on ? 220 : 30;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const pixel = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

test('solveHomography maps each source corner onto its target', () => {
  const from = rect(100, 50);
  const to = [{ x: 10, y: 4 }, { x: 92, y: 20 }, { x: 80, y: 60 }, { x: 2, y: 44 }];
  const h = solveHomography(from, to);

  for (let i = 0; i < 4; i++) {
    const got = applyHomography(h, from[i].x, from[i].y);
    assert.ok(Math.abs(got.x - to[i].x) < 1e-6, `corner ${i} x: ${got.x} vs ${to[i].x}`);
    assert.ok(Math.abs(got.y - to[i].y) < 1e-6, `corner ${i} y: ${got.y} vs ${to[i].y}`);
  }
});

test('a genuinely projective transform is not merely affine', () => {
  // A trapezoid, narrow at the top: under perspective the square's centre lands
  // on the intersection of the trapezoid's diagonals, pulled towards the narrow
  // (far) end — at (50, 37.5) here, not the affine answer of (50, 50).
  const h = solveHomography(rect(100, 100), [
    { x: 20, y: 0 }, { x: 80, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ]);
  const centre = applyHomography(h, 50, 50);
  assert.ok(Math.abs(centre.x - 50) < 1e-9, `x: ${centre.x}`);
  assert.ok(Math.abs(centre.y - 37.5) < 1e-9, `y: ${centre.y}`);
});

test('a degenerate quad is rejected rather than producing garbage', () => {
  const collapsed = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  assert.throws(() => solveHomography(rect(10, 10), collapsed), /degenerate/);
});

test('warping the full frame back to its own size is a no-op', () => {
  const src = checkerboard(32, 24);
  const out = warpQuad(src, rect(32, 24), 32, 24);

  assert.equal(out.width, 32);
  assert.equal(out.height, 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 32; x++) {
      assert.deepEqual(pixel(out, x, y), pixel(src, x, y), `pixel ${x},${y}`);
    }
  }
});

test('warping a sub-rectangle crops to it', () => {
  const src = checkerboard(40, 40, 10);
  // The bottom-right 20×20 quadrant, taken at 1:1.
  const out = warpQuad(src, [
    { x: 20, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 40 }, { x: 20, y: 40 },
  ], 20, 20);

  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      assert.deepEqual(pixel(out, x, y), pixel(src, x + 20, y + 20), `pixel ${x},${y}`);
    }
  }
});

test('a rotated quad is straightened', () => {
  // Left half black, right half white; sampled through a quad rotated 90°, so
  // the halves must come out stacked instead of side by side.
  const w = 32, h = 32;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = x < w / 2 ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  const out = warpQuad({ width: w, height: h, data }, [
    { x: 0, y: h }, { x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h },
  ], 32, 32);

  assert.equal(pixel(out, 16, 4)[0], 0, 'top of the result comes from the black half');
  assert.equal(pixel(out, 16, 28)[0], 255, 'bottom comes from the white half');
});

test('outputSize uses the longer of each opposing edge pair', () => {
  const quad = [
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 260, y: 100 }, { x: 0, y: 100 },
  ];
  // Bottom edge 260 beats top edge 200; the slanted right edge is
  // hypot(60, 100) ≈ 116.6, which beats the vertical left edge of 100.
  assert.deepEqual(outputSize(quad, 1600), { width: 260, height: 117 });
});

test('outputSize scales down to the cap while keeping the aspect ratio', () => {
  const quad = rect(4000, 3000);
  const size = outputSize(quad, 1600);
  assert.equal(size.width, 1600);
  assert.equal(size.height, 1200);
});

test('orderQuad puts shuffled corners into TL, TR, BR, BL order', () => {
  const tl = { x: 10, y: 12 };
  const tr = { x: 90, y: 8 };
  const br = { x: 95, y: 70 };
  const bl = { x: 5, y: 75 };
  assert.deepEqual(orderQuad([br, bl, tr, tl]), [tl, tr, br, bl]);
  assert.deepEqual(orderQuad([tl, tr, br, bl]), [tl, tr, br, bl]);
});

test('orderQuad untangles a crossed quad', () => {
  // Two corners dragged past each other: the bow-tie must come back as a quad.
  const points = [
    { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 },
  ];
  const ordered = orderQuad(points);
  assert.deepEqual(ordered, [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
  ]);
});

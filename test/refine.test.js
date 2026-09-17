import test from 'node:test';
import assert from 'node:assert/strict';

import { refineHandles, fitEdge, edgeOffsets } from '../js/refine.js';
import { edgeArc } from '../js/warp.js';

/** A light label with half-ellipse top and bottom edges on a dark background,
 *  drawn from six true handles so the truth is exactly what Snap fits. */
function paint(truth, width = 400, height = 500) {
  const gray = new Uint8ClampedArray(width * height).fill(40);
  const top = edgeArc(truth[0], truth[1], truth[2], 200);
  const bottom = edgeArc(truth[5], truth[4], truth[3], 200);
  const topAt = (x) => interp(top, x); const bottomAt = (x) => interp(bottom, x);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fl = truth[0].x + ((truth[5].x - truth[0].x) * (y - truth[0].y)) / (truth[5].y - truth[0].y);
      const fr = truth[2].x + ((truth[3].x - truth[2].x) * (y - truth[2].y)) / (truth[3].y - truth[2].y);
      if (x < fl || x > fr) continue;
      const ty = topAt(x); const by = bottomAt(x);
      if (ty !== null && by !== null && y >= ty && y <= by) gray[y * width + x] = 215 + ((x * 7 + y * 3) % 11);
    }
  }
  return { gray, width, height };
}
function interp(curve, x) {
  for (let i = 1; i < curve.length; i += 1) {
    const a = curve[i - 1]; const b = curve[i];
    if ((x >= a.x && x <= b.x) || (x >= b.x && x <= a.x)) {
      const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * f;
    }
  }
  return null;
}

const truth = [
  { x: 90, y: 130 }, { x: 200, y: 118 }, { x: 310, y: 130 },
  { x: 310, y: 380 }, { x: 200, y: 392 }, { x: 90, y: 380 },
];

test('Snap pulls handles perturbed by a few percent back onto the paper edge', () => {
  const { gray, width, height } = paint(truth);
  const wobble = [[7, -5], [-4, 6], [-6, 4], [5, 7], [3, -6], [-7, -4]];
  const rough = truth.map((p, i) => ({ x: p.x + wobble[i][0], y: p.y + wobble[i][1] }));
  const { points, moved } = refineHandles({ gray }, width, height, rough, { radius: 12 });
  assert.deepEqual(moved, { left: true, right: true, top: true, bottom: true });
  points.forEach((p, i) => {
    const err = Math.hypot(p.x - truth[i].x, p.y - truth[i].y);
    assert.ok(err <= 1.5, `handle ${i} off by ${err.toFixed(2)}`);
  });
});

test('Snap leaves handles alone where there is no contrast to snap to', () => {
  const width = 400; const height = 500;
  const gray = new Uint8ClampedArray(width * height).fill(200);
  const { points, moved } = refineHandles({ gray }, width, height, truth);
  assert.deepEqual(moved, { left: false, right: false, top: false, bottom: false });
  assert.deepEqual(points, truth);
});

test('a handle never moves further than the radius', () => {
  const { gray, width, height } = paint(truth);
  const far = truth.map((p) => ({ x: p.x + 40, y: p.y }));
  const { points } = refineHandles({ gray }, width, height, far, { radius: 6, passes: 1 });
  points.forEach((p, i) => assert.ok(Math.hypot(p.x - far[i].x, p.y - far[i].y) <= 6.01 + (i === 1 || i === 4 ? 3 : 0)));
});

test('fitEdge recovers a line and a half-ellipse through noisy points', () => {
  const us = Array.from({ length: 30 }, (_, i) => -0.8 + (1.6 * i) / 29);
  const line = us.map((u, i) => 2 + 3 * u + Math.sin(i) * 0.05);
  const f1 = fitEdge(us, line, { curved: false, tolerance: 1 });
  assert.ok(Math.abs(f1.alpha - 2) < 0.1 && Math.abs(f1.beta - 3) < 0.1);
  const curve = us.map((u) => 1 - 0.5 * u + 4 * Math.sqrt(1 - u * u));
  curve[7] = 50; // one outlier
  const f2 = fitEdge(us, curve, { curved: true, tolerance: 1 });
  assert.ok(Math.abs(f2.alpha - 1) < 0.1 && Math.abs(f2.beta + 0.5) < 0.1 && Math.abs(f2.h - 4) < 0.1);
  assert.equal(f2.inliers, 29);
});

test('edgeOffsets finds a step where inside meets outside', () => {
  const width = 60; const height = 20;
  const gray = new Uint8ClampedArray(width * height).fill(30);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < 35; x += 1) gray[y * width + x] = 220;
  const samples = Array.from({ length: 8 }, (_, i) => ({ x: 32, y: 4 + i, nx: 1, ny: 0 }));
  const { offsets, contrast } = edgeOffsets({ gray }, width, height, samples, 8);
  assert.ok(contrast > 0.8);
  offsets.forEach((o) => assert.ok(o !== null && Math.abs(o - 2.5) <= 1, `offset ${o}`));
});

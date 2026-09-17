import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EN_CHARSET, detInputSize, recInputWidth, components, convexHull, minAreaRect,
  rectCorners, unclipRect, boxesFromMap, orderBoxes, ctcDecode,
} from '../eval/ppocr-post.mjs';

test('the English charset has 97 classes with blank first and space last', () => {
  assert.equal(EN_CHARSET.length, 97);
  assert.equal(EN_CHARSET[0], '');
  assert.equal(EN_CHARSET[1], '0');
  assert.equal(EN_CHARSET[11], ':');
  assert.equal(EN_CHARSET[18], 'A');
  assert.equal(EN_CHARSET[EN_CHARSET.length - 1], ' ');
  assert.equal(EN_CHARSET[EN_CHARSET.length - 2], ' ');
  assert.equal(EN_CHARSET.indexOf('!'), 80);
});

test('detInputSize caps the long side and rounds to multiples of 32', () => {
  assert.deepEqual(detInputSize(3072, 4080), { width: 736, height: 960 });
  assert.deepEqual(detInputSize(100, 50), { width: 96, height: 64 });
});

test('recInputWidth keeps the box aspect at height 48 and clamps', () => {
  assert.equal(recInputWidth(480, 48), 480);
  assert.equal(recInputWidth(10, 100), 16);
  assert.equal(recInputWidth(100000, 10), 1280);
});

test('components separates two blobs and ignores the background', () => {
  const w = 8; const h = 4;
  const prob = new Float32Array(w * h);
  for (const i of [1, 2, 9, 10]) prob[i] = 0.9;
  for (const i of [21, 22, 23, 29, 30, 31]) prob[i] = 0.8;
  const comps = components(prob, w, h, 0.3);
  assert.equal(comps.length, 2);
  assert.deepEqual(comps.map((c) => c.length).sort(), [4, 6]);
});

test('convexHull + minAreaRect recover an axis-aligned rectangle', () => {
  const pts = [];
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 20; x += 1) pts.push([x, y]);
  const rect = minAreaRect(convexHull(pts));
  assert.ok(Math.abs(Math.max(rect.w, rect.h) - 19) < 1e-6);
  assert.ok(Math.abs(Math.min(rect.w, rect.h) - 4) < 1e-6);
  assert.ok(Math.abs(rect.cx - 9.5) < 1e-6 && Math.abs(rect.cy - 2) < 1e-6);
});

test('minAreaRect finds the tilt of a rotated bar', () => {
  const pts = [];
  const a = Math.PI / 6;
  for (let t = 0; t <= 40; t += 1) {
    for (let s = -2; s <= 2; s += 1) {
      pts.push([t * Math.cos(a) - s * Math.sin(a), t * Math.sin(a) + s * Math.cos(a)]);
    }
  }
  const rect = minAreaRect(convexHull(pts));
  const tilt = ((rect.w >= rect.h ? rect.angle : rect.angle + Math.PI / 2) + Math.PI) % Math.PI;
  assert.ok(Math.abs(tilt - a) < 0.05, `tilt ${tilt} vs ${a}`);
});

test('rectCorners orders TL, TR, BR, BL with the long side as the top edge', () => {
  // A wide box: top edge runs left→right, bottom-left sits below top-left.
  const w = rectCorners({ cx: 10, cy: 5, w: 20, h: 4, angle: 0 });
  assert.ok(w[0].x < w[1].x && Math.abs(w[0].y - w[1].y) < 1e-9, 'top edge left→right');
  assert.ok(w[3].y > w[0].y, 'bottom-left below top-left');
  assert.ok(Math.abs(Math.hypot(w[1].x - w[0].x, w[1].y - w[0].y) - 20) < 1e-9);
  // A tall box (vertical text): the long side still becomes the top edge of
  // the patch — corner 0→1 has length 20 — and never runs right→left.
  const t = rectCorners({ cx: 10, cy: 5, w: 4, h: 20, angle: 0 });
  assert.ok(Math.abs(Math.hypot(t[1].x - t[0].x, t[1].y - t[0].y) - 20) < 1e-9);
  assert.ok(t[1].x >= t[0].x - 1e-9);
});

test('unclipRect grows by area·ratio/perimeter on every side', () => {
  const r = unclipRect({ cx: 0, cy: 0, w: 10, h: 2, angle: 0 }, 1.5);
  const d = (20 * 1.5) / 24;
  assert.ok(Math.abs(r.w - (10 + 2 * d)) < 1e-9 && Math.abs(r.h - (2 + 2 * d)) < 1e-9);
});

test('boxesFromMap drops low-score and tiny components', () => {
  const w = 32; const h = 16;
  const prob = new Float32Array(w * h);
  for (let y = 2; y < 6; y += 1) for (let x = 2; x < 20; x += 1) prob[y * w + x] = 0.95;
  for (let y = 10; y < 12; y += 1) for (let x = 2; x < 20; x += 1) prob[y * w + x] = 0.4;
  prob[15 * w + 30] = 0.99;
  const boxes = boxesFromMap(prob, w, h);
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].score > 0.9);
  assert.ok(boxes[0].w > boxes[0].h);
});

test('orderBoxes reads rows top-down and left-right', () => {
  const box = (x, y) => ({
    corners: [{ x, y }, { x: x + 10, y }, { x: x + 10, y: y + 4 }, { x, y: y + 4 }], w: 10, h: 4, score: 1,
  });
  const ordered = orderBoxes([box(50, 20), box(0, 21), box(0, 0), box(30, 1)]);
  assert.deepEqual(ordered.map((b) => [b.corners[0].x, b.corners[0].y]), [[0, 0], [30, 1], [0, 21], [50, 20]]);
});

test('ctcDecode collapses repeats and drops blanks', () => {
  const C = EN_CHARSET.length;
  const idx = (ch) => EN_CHARSET.indexOf(ch);
  const steps = [idx('N'), idx('N'), 0, idx('I'), 0, idx('M'), idx('B'), idx('B'), 0, idx('I')];
  const logits = new Float32Array(steps.length * C);
  steps.forEach((k, t) => { logits[t * C + k] = 0.9; });
  const { text, confidence } = ctcDecode(logits, steps.length, C);
  assert.equal(text, 'NIMBI');
  assert.ok(Math.abs(confidence - 90) < 1e-3); // 0.9 is not exact in float32
});

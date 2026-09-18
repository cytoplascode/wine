import test from 'node:test';
import assert from 'node:assert/strict';

import { handlesFromMask } from '../js/mask-fit.js';
import { samInputSize, boxPrompt, maskRegion, SAM_SIZE, MASK_SIZE } from '../js/edgesam.js';
import { edgeArc } from '../js/warp.js';

/** Fill a binary mask with the label shape six handles describe. */
function paintMask(points, width, height) {
  const mask = new Uint8Array(width * height);
  const top = edgeArc(points[0], points[1], points[2], 400);
  const bottom = edgeArc(points[5], points[4], points[3], 400);
  const at = (curve, x) => {
    for (let i = 1; i < curve.length; i += 1) {
      const a = curve[i - 1]; const b = curve[i];
      if ((x >= a.x && x <= b.x) || (x >= b.x && x <= a.x)) {
        const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
        return a.y + (b.y - a.y) * f;
      }
    }
    return null;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fl = points[0].x + ((points[5].x - points[0].x) * (y - points[0].y)) / (points[5].y - points[0].y);
      const fr = points[2].x + ((points[3].x - points[2].x) * (y - points[2].y)) / (points[3].y - points[2].y);
      if (x < fl || x > fr) continue;
      const ty = at(top, x); const by = at(bottom, x);
      if (ty !== null && by !== null && y >= ty && y <= by) mask[y * width + x] = 1;
    }
  }
  return { mask, width, height };
}

const truth = [
  { x: 40, y: 60 }, { x: 110, y: 48 }, { x: 180, y: 60 },
  { x: 180, y: 200 }, { x: 110, y: 212 }, { x: 40, y: 200 },
];

test('handlesFromMask recovers the handles a mask was painted from', () => {
  const painted = paintMask(truth, 220, 260);
  const fit = handlesFromMask(painted);
  assert.ok(fit, 'a label was found');
  fit.points.forEach((p, i) => {
    const err = Math.hypot(p.x - truth[i].x, p.y - truth[i].y);
    assert.ok(err <= 3, `handle ${i} off by ${err.toFixed(2)}`);
  });
  // The middles bow outward, as a label on a bottle does.
  assert.ok(fit.points[1].y < fit.points[0].y, 'top bows up');
  assert.ok(fit.points[4].y > fit.points[5].y, 'bottom bows down');
});

test('handlesFromMask ignores a speck and takes the real blob', () => {
  const painted = paintMask(truth, 220, 260);
  painted.mask[5 * 220 + 5] = 1;
  painted.mask[5 * 220 + 6] = 1;
  const fit = handlesFromMask(painted);
  assert.ok(fit);
  assert.ok(fit.bounds.left > 30, `bounds followed the speck: ${fit.bounds.left}`);
});

test('handlesFromMask gives up on an empty or tiny mask', () => {
  assert.equal(handlesFromMask({ mask: new Uint8Array(100 * 100), width: 100, height: 100 }), null);
  const speck = new Uint8Array(100 * 100);
  for (let i = 0; i < 20; i += 1) speck[50 * 100 + 10 + i] = 1;
  assert.equal(handlesFromMask({ mask: speck, width: 100, height: 100 }), null);
  assert.equal(handlesFromMask({ mask: new Uint8Array(4), width: 2, height: 2 }), null);
});

test('samInputSize fits the long side and keeps the proportion', () => {
  const portrait = samInputSize(3000, 4000);
  assert.equal(portrait.height, SAM_SIZE);
  assert.equal(portrait.width, 768);
  assert.ok(Math.abs(portrait.scale - 0.256) < 1e-6);
  const square = samInputSize(500, 500);
  assert.deepEqual([square.width, square.height], [SAM_SIZE, SAM_SIZE]);
});

test('boxPrompt sends the handles as a box plus a foreground point', () => {
  const points = [
    { x: 100, y: 200 }, { x: 300, y: 180 }, { x: 500, y: 200 },
    { x: 500, y: 600 }, { x: 300, y: 620 }, { x: 100, y: 600 },
  ];
  const { coords, labels, count } = boxPrompt(points, 0.5);
  assert.equal(count, 3);
  assert.deepEqual([...labels], [2, 3, 1]);
  // Box corners come from the extremes, including the bowed middles.
  assert.deepEqual([...coords], [50, 90, 250, 310, 150, 200]);
  // Nothing may fall outside the model's square.
  const far = boxPrompt([{ x: -50, y: -50 }, { x: 0, y: 0 }, { x: 9000, y: 9000 },
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], 1);
  assert.ok([...far.coords].every((v) => v >= 0 && v <= SAM_SIZE - 1));
});

test('maskRegion picks the best-scoring mask and crops away the padding', () => {
  const masks = new Float32Array(4 * MASK_SIZE * MASK_SIZE).fill(-10);
  const plane = MASK_SIZE * MASK_SIZE;
  // Mask 2 is the good one: a filled square in the top-left quarter.
  for (let y = 0; y < 40; y += 1) for (let x = 0; x < 40; x += 1) masks[2 * plane + y * MASK_SIZE + x] = 5;
  const input = samInputSize(2000, 1000);            // 1024x512, padded below
  const region = maskRegion(masks, new Float32Array([0.1, 0.3, 0.9, 0.2]), input);
  assert.ok(Math.abs(region.score - 0.9) < 1e-6);
  assert.equal(region.width, MASK_SIZE);
  assert.equal(region.height, MASK_SIZE / 2);        // the padding is gone
  assert.equal(region.mask[0], 1);
  assert.equal(region.mask[50 * region.width + 50], 0);
  assert.ok(Math.abs(region.coverage - (40 * 40) / (region.width * region.height)) < 1e-9);
  // Mask coordinates times toSource are source pixels.
  assert.ok(Math.abs(region.toSource - 2000 / MASK_SIZE) < 1e-6);
});

test('handlesFromMask keeps the handles inside the blob it fitted', () => {
  // A label cut off by the top of the photo: its top edge is a straight
  // line across the frame, so there is no arc to measure and the fit has
  // nothing to hold it down. The handles must still land on the blob.
  const width = 200; const height = 240;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < 180; y += 1) {
    for (let x = 20; x < 180; x += 1) mask[y * width + x] = 1;
  }
  const fit = handlesFromMask({ mask, width, height });
  assert.ok(fit, 'a label was found');
  for (const p of fit.points) {
    assert.ok(p.x >= fit.bounds.left && p.x <= fit.bounds.right, `x ${p.x} inside`);
    assert.ok(p.y >= fit.bounds.top && p.y <= fit.bounds.bottom, `y ${p.y} inside`);
  }
});

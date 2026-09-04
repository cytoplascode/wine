import test from 'node:test';
import assert from 'node:assert/strict';

import { otsu, labelComponents, pickComponent } from '../js/detect.js';

/* detectLabel itself draws to a canvas and calls getImageData, so it needs
 * a browser — verified by hand in Chromium. The three pure pieces it leans
 * on are testable here directly: Otsu picks the trough between two peaks,
 * the connected-components pass groups pixels into blobs and bounding
 * boxes, and pickComponent filters and scores what came back. */

/** Build a small greyscale image with a bright rectangle on a dark ground. */
function scene(width, height, rects, { background = 30, foreground = 220 } = {}) {
  const pixels = new Uint8Array(width * height).fill(background);
  for (const { left, top, right, bottom, value = foreground } of rects) {
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        pixels[y * width + x] = value;
      }
    }
  }
  return pixels;
}

function mask(pixels, threshold) {
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) out[i] = pixels[i] > threshold ? 1 : 0;
  return out;
}

/* ── Otsu ───────────────────────────────────────────────────────────── */

test('Otsu splits a bimodal image so every pixel lands on the right side', () => {
  // The rectangle is 21×21 = 441 bright pixels on a 40×40 = 1600-px ground.
  // Any threshold in [30, 219] produces the same clean split; the point is
  // that whichever one Otsu picks, the mask reproduces the original scene
  // rather than dragging half a class across the boundary.
  const pixels = scene(40, 40, [{ left: 10, top: 10, right: 30, bottom: 30 }]);
  const bright = mask(pixels, otsu(pixels)).reduce((a, b) => a + b, 0);
  assert.equal(bright, 441);
});

test('Otsu handles a completely uniform image without throwing', () => {
  // Nothing to separate — there is no meaningful threshold, so the point
  // is only that Otsu terminates. What the caller does with that image
  // (see pickComponent's max-area filter) is another test's problem.
  assert.doesNotThrow(() => otsu(new Uint8Array(100).fill(20)));
  assert.doesNotThrow(() => otsu(new Uint8Array([200])));   // 1 pixel too
});

/* ── Connected components ───────────────────────────────────────────── */

test('one bright rectangle comes back as one component with the right box', () => {
  const pixels = scene(20, 20, [{ left: 4, top: 5, right: 14, bottom: 12 }]);
  const components = labelComponents(mask(pixels, 100), 20, 20);
  assert.equal(components.length, 1);
  assert.deepEqual(components[0], { area: 88, left: 4, top: 5, right: 14, bottom: 12 });
});

test('two separated rectangles come back as two components', () => {
  const pixels = scene(30, 20, [
    { left: 2, top: 2, right: 8, bottom: 8 },
    { left: 20, top: 10, right: 26, bottom: 16 },
  ]);
  const components = labelComponents(mask(pixels, 100), 30, 20);
  assert.equal(components.length, 2);
});

test('an L-shape is one component, not two — union-find merges the corner', () => {
  // The classic worst case for a one-pass labeller: the two arms of the L
  // meet at a pixel that has both an already-labelled left neighbour and
  // an already-labelled up neighbour with different labels.
  const pixels = scene(10, 10, [
    { left: 1, top: 1, right: 3, bottom: 8 },   // vertical arm
    { left: 1, top: 6, right: 8, bottom: 8 },   // horizontal arm
  ]);
  const components = labelComponents(mask(pixels, 100), 10, 10);
  assert.equal(components.length, 1);
  assert.equal(components[0].left, 1);
  assert.equal(components[0].right, 8);
  assert.equal(components[0].top, 1);
  assert.equal(components[0].bottom, 8);
});

test('a blank mask returns no components at all', () => {
  assert.deepEqual(labelComponents(new Uint8Array(100), 10, 10), []);
});

/* ── Component picking ──────────────────────────────────────────────── */

/** A helper: shorthand for the shape labelComponents actually returns. */
const c = (left, top, right, bottom, area) => ({ left, top, right, bottom, area });

test('a plausible central rectangle is picked as the label', () => {
  const picked = pickComponent([c(20, 20, 80, 80, 61 * 61)], 100, 100);
  assert.ok(picked);
  assert.equal(picked.left, 20);
  assert.equal(picked.right, 80);
});

test('too-small components are rejected as noise', () => {
  // 5×5 = 25 px on a 100×100 image (2.5%) — below MIN_AREA_FRACTION.
  const picked = pickComponent([c(45, 45, 49, 49, 25)], 100, 100);
  assert.equal(picked, null);
});

test('too-large components are rejected as background', () => {
  // 95×95 = 9025 px on a 100×100 image (90%) — above MAX_AREA_FRACTION.
  const picked = pickComponent([c(2, 2, 96, 96, 95 * 95)], 100, 100);
  assert.equal(picked, null);
});

test('a thin sliver is rejected on aspect ratio', () => {
  // 6 wide × 60 tall = aspect 0.1, below MIN_ASPECT.
  const picked = pickComponent([c(47, 20, 52, 79, 6 * 60)], 100, 100);
  assert.equal(picked, null);
});

test('a scattered blob (low solidity) is rejected', () => {
  // Bounding box 50×50 = 2500 px, but only 500 filled — solidity 0.2.
  const picked = pickComponent([c(25, 25, 74, 74, 500)], 100, 100);
  assert.equal(picked, null);
});

test('given two candidates, the more central one wins', () => {
  const central = c(35, 35, 64, 64, 30 * 30);       // dead centre
  const cornered = c(1, 1, 30, 30, 30 * 30);        // same area, off in a corner
  const picked = pickComponent([cornered, central], 100, 100);
  assert.equal(picked, central);
});

test('given two centred candidates, the larger one wins', () => {
  const small = c(45, 45, 54, 54, 10 * 10);         // 100 px
  const big = c(30, 30, 69, 69, 40 * 40);           // 1600 px — 16%, still in range
  const picked = pickComponent([small, big], 100, 100);
  assert.equal(picked, big);
});

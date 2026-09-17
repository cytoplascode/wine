import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clusterBoxes, scanEdge, parabolaAt, detectLabel, TL, TM, TR, BR, BM, BL,
} from '../js/detect.js';

/** A light label with parabolic top and bottom edges on a dark background. */
function syntheticLabel({ width = 400, height = 500, left = 80, right = 320, top = 120, bottom = 380, bulge = 12 }) {
  const gray = new Uint8ClampedArray(width * height).fill(40);
  const midX = (left + right) / 2;
  const halfW = (right - left) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const t = (x - midX) / halfW;              // −1 … 1 across the label
      const topY = top - bulge * (1 - t * t);      // apex above the corners
      const bottomY = bottom + bulge * (1 - t * t);
      if (y >= topY && y <= bottomY) gray[y * width + x] = 220 + ((x * 7 + y * 3) % 9); // paper with a little grain
    }
  }
  return { gray, width, height };
}

const box = (left, top, right, bottom) => ({ left, top, right, bottom });

test('clusterBoxes keeps the main block and drops far-away text', () => {
  const main = [box(100, 200, 300, 220), box(120, 240, 280, 260), box(110, 280, 290, 300)];
  const neck = [box(150, 20, 250, 35)];
  const cluster = clusterBoxes([...neck, ...main]);
  assert.equal(cluster.length, 3);
  assert.ok(cluster.every((b) => b.top >= 200));
});

test('scanEdge finds where the paper ends and reports the frame edge when it never does', () => {
  const { gray, width, height } = syntheticLabel({});
  const leftEdge = scanEdge({ gray }, width, height, { axis: 'x', from: 140, direction: -1, bandStart: 150, bandEnd: 350, limit: 120 });
  assert.ok(Math.abs(leftEdge - 80) <= 2, `left edge ${leftEdge}`);
  const none = scanEdge({ gray }, width, height, { axis: 'x', from: 140, direction: -1, bandStart: 150, bandEnd: 350, limit: 20 });
  assert.equal(none, null);
  const uniform = new Uint8ClampedArray(width * height).fill(200);
  assert.equal(scanEdge({ gray: uniform }, width, height, { axis: 'x', from: 140, direction: -1, bandStart: 150, bandEnd: 350, limit: 500 }), 0);
});

test('parabolaAt interpolates through its three points', () => {
  const pts = [[0, 0], [1, 1], [2, 4]];
  assert.ok(Math.abs(parabolaAt(pts, 3) - 9) < 1e-9);
  assert.ok(Math.abs(parabolaAt(pts, 1) - 1) < 1e-9);
});

test('detectLabel places the corners on the paper edge and bows the middles outward', () => {
  const shape = { width: 400, height: 500, left: 80, right: 320, top: 120, bottom: 380, bulge: 12 };
  const { gray, width, height } = syntheticLabel(shape);
  const boxes = [box(130, 170, 270, 200), box(140, 220, 260, 240), box(120, 300, 280, 320)];
  const result = detectLabel({ gray, width, height, boxes });
  assert.ok(result, 'a label was found');
  const p = result.points;
  assert.ok(Math.abs(p[TL].x - 80) <= 3 && Math.abs(p[BL].x - 80) <= 3, `left ${p[TL].x}`);
  assert.ok(Math.abs(p[TR].x - 320) <= 3, `right ${p[TR].x}`);
  assert.ok(Math.abs(p[TL].y - 120) <= 4, `top ${p[TL].y}`);
  assert.ok(Math.abs(p[BR].y - 380) <= 4, `bottom ${p[BR].y}`);
  assert.ok(p[TM].y < p[TL].y - 6 && p[TM].y > p[TL].y - 20, `top bow ${p[TL].y - p[TM].y}`);
  assert.ok(p[BM].y > p[BL].y + 6 && p[BM].y < p[BL].y + 20, `bottom bow ${p[BM].y - p[BL].y}`);
  assert.deepEqual(result.found, { left: true, right: true, top: true, bottom: true });
});

test('detectLabel bounds the sides when the paper never ends', () => {
  const width = 400; const height = 500;
  const gray = new Uint8ClampedArray(width * height).fill(200);
  const boxes = [box(130, 170, 270, 200), box(140, 220, 260, 240)];
  const result = detectLabel({ gray, width, height, boxes });
  assert.ok(result);
  // A uniform image: the paper never ends, so the sides are bounded by how
  // much wider than its text a label plausibly is, and not counted as seen.
  assert.equal(result.found.left, false);
  assert.equal(result.found.right, false);
  // …and fall back to the usual margin round the text (0.8 line heights).
  assert.ok(Math.abs(result.points[TL].x - 110) < 1, `left ${result.points[TL].x}`);
  assert.ok(Math.abs(result.points[TR].x - 290) < 1, `right ${result.points[TR].x}`);
});

test('detectLabel gives up without text', () => {
  assert.equal(detectLabel({ gray: new Uint8ClampedArray(100), width: 10, height: 10, boxes: [] }), null);
});

test('tiltFromBoxes reads the lean of wide text lines and ignores tall ones', async () => {
  const { tiltFromBoxes, rotatePoint, rotateGray } = await import('../js/detect.js');
  const line = (angle, x = 100, y = 100, w = 200, h = 20) => {
    const c = Math.cos(angle); const s = Math.sin(angle);
    return {
      w, h,
      corners: [{ x, y }, { x: x + w * c, y: y + w * s }, { x: x + w * c - h * s, y: y + w * s + h * c }, { x: x - h * s, y: y + h * c }],
    };
  };
  const lean = (5 * Math.PI) / 180;
  assert.ok(Math.abs(tiltFromBoxes([line(lean), line(lean, 100, 200), line(0, 0, 0, 20, 100)]) - lean) < 1e-9);
  assert.equal(tiltFromBoxes([line(0.001), line(0.002)]), 0);
  const back = rotatePoint(rotatePoint({ x: 10, y: 20 }, lean, 50, 50), -lean, 50, 50);
  assert.ok(Math.abs(back.x - 10) < 1e-9 && Math.abs(back.y - 20) < 1e-9);
  const gray = new Uint8ClampedArray(16).fill(7);
  assert.equal(rotateGray(gray, 4, 4, 0)[5], 7);
});

test('paperShare measures the stretch between two rows, not always one', async () => {
  const { paperShare, paperModel } = await import('../js/detect.js');
  const width = 10; const height = 40;
  const gray = new Uint8ClampedArray(width * height).fill(200);
  for (let y = 10; y < 30; y += 1) for (let x = 0; x < width; x += 1) gray[y * width + x] = 20;
  const model = paperModel([200, 201, 199, 200]);
  const share = paperShare({ gray }, width, height, { axis: 'y', a: 0, b: 39, bandStart: 2, bandEnd: 8, model });
  assert.ok(share > 0.45 && share < 0.55, `share ${share}`);
  assert.equal(paperShare({ gray }, width, height, { axis: 'y', a: 30, b: 39, bandStart: 2, bandEnd: 8, model }), 1);
  assert.equal(paperShare({ gray }, width, height, { axis: 'y', a: 12, b: 28, bandStart: 2, bandEnd: 8, model }), 0);
});

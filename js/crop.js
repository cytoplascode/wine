/* Crop screen: four draggable corners over the captured photo, and the
 * flattening step that turns the quad they enclose into a rectangle. */

import { $, canvasToBlob } from './ui.js';
import { orderQuad, outputSize, warpQuad, MAX_SIDE } from './warp.js';

const HANDLE_RADIUS = 13;   // CSS px — drawn size
const GRAB_RADIUS = 30;     // CSS px — touch target, comfortably past a fingertip
const INSET = 0.1;          // corners start 10% in from each edge

/** Never sample from more pixels than the flattened result can use. A 12 MP
 *  photo would otherwise mean a 48 MB pixel buffer for no added detail. */
const clampSourceScale = (scale) => Math.min(1, scale);

let bitmap = null;
let corners = null;         // 4 points in source-image pixels
let dragging = -1;
let view = { scale: 1 };    // image pixels -> canvas pixels

export function initCrop() {
  const canvas = $('#crop-canvas');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  $('#btn-crop-reset').addEventListener('click', resetCorners);
}

export function showImage(nextBitmap, savedCorners) {
  bitmap = nextBitmap;
  if (!bitmap) return;
  corners = savedCorners || defaultCorners();
  layout();
  draw();
}

export function getCorners() { return corners; }

function defaultCorners() {
  const x0 = bitmap.width * INSET;
  const x1 = bitmap.width * (1 - INSET);
  const y0 = bitmap.height * INSET;
  const y1 = bitmap.height * (1 - INSET);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

function resetCorners() {
  if (!bitmap) return;
  corners = defaultCorners();
  draw();
}

/* ── Layout and painting ────────────────────────────────────────────── */

function layout() {
  const canvas = $('#crop-canvas');
  const stage = $('#crop-stage');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const scale = Math.min(stage.clientWidth / bitmap.width, stage.clientHeight / bitmap.height);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;

  canvas.style.width = `${drawW}px`;
  canvas.style.height = `${drawH}px`;
  canvas.width = Math.round(drawW * dpr);
  canvas.height = Math.round(drawH * dpr);

  // The canvas is sized to the fitted image, so image and canvas share an origin.
  view = { scale: scale * dpr, dpr };
}

function draw() {
  const canvas = $('#crop-canvas');
  const ctx = canvas.getContext('2d');
  const { dpr } = view;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const pts = corners.map((p) => toCanvas(p.x, p.y));

  // Dim everything outside the quad: full rect and quad in one even-odd path.
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill('evenodd');

  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.strokeStyle = '#c8324f';
  ctx.lineWidth = 3 * dpr;
  ctx.stroke();

  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE_RADIUS * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = '#c8324f';
    ctx.stroke();
  }
}

function toCanvas(x, y) { return { x: x * view.scale, y: y * view.scale }; }

function toCanvasPixels(clientX, clientY) {
  const canvas = $('#crop-canvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

/* ── Dragging ───────────────────────────────────────────────────────── */

function onPointerDown(event) {
  if (!bitmap) return;
  const point = toCanvasPixels(event.clientX, event.clientY);
  const limit = GRAB_RADIUS * view.dpr;

  let best = -1;
  let bestDistance = Infinity;
  corners.forEach((corner, i) => {
    const c = toCanvas(corner.x, corner.y);
    const d = Math.hypot(c.x - point.x, c.y - point.y);
    if (d < bestDistance) { bestDistance = d; best = i; }
  });

  if (bestDistance > limit) return;
  dragging = best;
  event.target.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event) {
  if (dragging < 0) return;
  const point = toCanvasPixels(event.clientX, event.clientY);
  corners[dragging] = {
    x: clamp(point.x / view.scale, 0, bitmap.width),
    y: clamp(point.y / view.scale, 0, bitmap.height),
  };
  draw();
  event.preventDefault();
}

function onPointerUp(event) {
  if (dragging < 0) return;
  dragging = -1;
  try { event.target.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
}

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/* ── Flattening ─────────────────────────────────────────────────────── */

/**
 * Warp the quad out of the source photo into an upright rectangle.
 * Returns `{ canvas, blob }`.
 */
export async function flatten() {
  const quad = orderQuad(corners);
  corners = quad;

  const size = outputSize(quad, MAX_SIDE);
  const rawWidth = Math.max(
    Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y),
    Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y),
  );
  const scale = clampSourceScale(size.width / rawWidth);

  // Read back only the quad's bounding box, at only the resolution the output
  // can actually use.
  const box = boundingBox(quad);
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = Math.max(1, Math.round(box.width * scale));
  srcCanvas.height = Math.max(1, Math.round(box.height * scale));
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.drawImage(
    bitmap,
    box.x, box.y, box.width, box.height,
    0, 0, srcCanvas.width, srcCanvas.height,
  );
  const source = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  const local = quad.map((p) => ({ x: (p.x - box.x) * scale, y: (p.y - box.y) * scale }));
  const warped = warpQuad(source, local, size.width, size.height);

  const canvas = document.createElement('canvas');
  canvas.width = warped.width;
  canvas.height = warped.height;
  canvas.getContext('2d').putImageData(
    new ImageData(warped.data, warped.width, warped.height), 0, 0,
  );

  return { canvas, blob: await canvasToBlob(canvas) };
}

function boundingBox(quad) {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const x = clamp(Math.floor(Math.min(...xs)), 0, bitmap.width);
  const y = clamp(Math.floor(Math.min(...ys)), 0, bitmap.height);
  const right = clamp(Math.ceil(Math.max(...xs)), 0, bitmap.width);
  const bottom = clamp(Math.ceil(Math.max(...ys)), 0, bitmap.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

window.addEventListener('resize', () => {
  if (bitmap && document.body.dataset.screen === 'crop') { layout(); draw(); }
});

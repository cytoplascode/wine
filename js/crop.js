/* Crop screen: six draggable handles over the captured photo, and the step that
 * unwraps the label off the curve of the bottle.
 *
 * How far round the bottle the label goes cannot be worked out from the handles
 * — the geometry is genuinely ambiguous, a near bottle wrapping a little
 * projects the same as a far one wrapping a lot — so the Curve slider sets it,
 * and a live preview shows the result while you drag.
 */

import { $, canvasToBlob } from './ui.js';
import {
  cylinderSize, warpCylinder, edgeArc, fitWrapAngle,
  MAX_SIDE, DEFAULT_WRAP, MIN_WRAP, MAX_WRAP,
} from './warp.js';

const HANDLE_RADIUS = 13;   // CSS px — drawn size
const GRAB_RADIUS = 30;     // CSS px — touch target, comfortably past a fingertip
const INSET = 0.1;          // handles start 10% in from each edge
const BULGE = 0.035;        // default curve on the top and bottom edges

/** How far (in source-image pixels) the snap-to-edge feature looks around a
 *  released corner. Small enough that hands and neighbouring bottles cannot
 *  attract a handle across the frame, wide enough to fix a finger that landed
 *  a few CSS pixels off the real edge on a phone screen. */
const SNAP_RADIUS = 60;

/** Minimum gradient magnitude the snap needs to see before it fires. Well
 *  below the darkest paper-to-glass step on a well-lit label, well above the
 *  noise floor of a slightly out-of-focus region. */
const SNAP_MIN_GRAD = 60;

const SNAP_STORAGE_KEY = 'cropSnap';

/** Indices into `points`: A, B, C, D, E, F. */
const TL = 0; const TM = 1; const TR = 2; const BR = 3; const BM = 4; const BL = 5;
const ALL_HANDLES = [TL, TM, TR, BR, BM, BL];

/** How wide the live preview is rendered. Small enough to re-warp on every
 *  pointer move without the drag ever feeling heavy. */
const PREVIEW_WIDTH = 260;

/** The magnifying loupe shown while a handle is dragged: its on-screen size —
 *  small enough to sit under the Flattened tag, clear of any finger — and how
 *  much closer than the current view it zooms in. Kept in step with the size
 *  set in app.css. */
const LOUPE_SIZE = 96;
const LOUPE_ZOOM = 3;

let bitmap = null;
let points = null;          // 6 points in source-image pixels
let wrap = DEFAULT_WRAP;    // how far round the bottle the label goes
let dragging = -1;
let view = { scale: 1, dpr: 1 };
let previewSource = null;   // small copy of the photo, for the preview warp
let edgeMap = null;         // gradient magnitudes on the preview copy, for snap
let snapEnabled = readSnapPref();

export function initCrop() {
  const canvas = $('#crop-canvas');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  $('#btn-crop-reset').addEventListener('click', resetPoints);

  const snapButton = $('#btn-crop-snap');
  snapButton.setAttribute('aria-pressed', String(snapEnabled));
  snapButton.addEventListener('click', () => {
    snapEnabled = !snapEnabled;
    snapButton.setAttribute('aria-pressed', String(snapEnabled));
    writeSnapPref(snapEnabled);
  });

  const slider = $('#wrap-slider');
  slider.value = String(Math.round((DEFAULT_WRAP * 180) / Math.PI));
  slider.addEventListener('input', () => {
    wrap = (Number(slider.value) * Math.PI) / 180;
    renderWrap();
    if (bitmap) { draw(); drawPreview(); }
  });
  renderWrap();
}

export function showImage(nextBitmap, saved) {
  bitmap = nextBitmap;
  if (!bitmap) return;
  points = saved || defaultPoints();
  buildPreviewSource();
  layout();
  // Seed the wrap slider from the handles — same shape whether opened on a
  // fresh capture or a resumed draft. Drafts do not currently persist the
  // slider position, so the fit is the best guess either way.
  autoFitWrap();
  draw();
  drawPreview();
}

export function getPoints() { return points; }

function renderWrap() {
  $('#wrap-label').textContent = `Curve ${Math.round((wrap * 180) / Math.PI)}°`;
}

function defaultPoints() {
  const x0 = bitmap.width * INSET;
  const x1 = bitmap.width * (1 - INSET);
  const y0 = bitmap.height * INSET;
  const y1 = bitmap.height * (1 - INSET);
  const mx = (x0 + x1) / 2;
  const bulge = bitmap.height * BULGE;
  return [
    { x: x0, y: y0 },            // A  top-left
    { x: mx, y: y0 - bulge },    // B  top-middle, bowed up
    { x: x1, y: y0 },            // C  top-right
    { x: x1, y: y1 },            // D  bottom-right
    { x: mx, y: y1 + bulge },    // E  bottom-middle, bowed down
    { x: x0, y: y1 },            // F  bottom-left
  ];
}

function resetPoints() {
  if (!bitmap) return;
  points = defaultPoints();
  draw();
  drawPreview();
}

/* ── Live preview ───────────────────────────────────────────────────── */

/** A small copy of the photo, so the preview can be re-warped on every pointer
 *  move without touching the full-resolution image. The edge map for the snap
 *  feature rides along on the same downscale — one canvas, one readback. */
function buildPreviewSource() {
  const scale = Math.min(1, (PREVIEW_WIDTH * 2.5) / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  previewSource = { image, scale };
  edgeMap = buildEdgeMap(image);
}

/** Sobel-lite gradient magnitude on the luminance channel of `image`. A pure
 *  |dx| + |dy| central difference on BT.601 luminance — cheap, ~100 µs on a
 *  650×870 preview copy, more than enough to see a paper-to-glass edge. */
function buildEdgeMap({ width, height, data }) {
  const grad = new Float32Array(width * height);
  const lum = new Float32Array(width * height);
  for (let i = 0, o = 0; i < data.length; i += 4, o += 1) {
    lum[o] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const dx = lum[i + 1] - lum[i - 1];
      const dy = lum[i + width] - lum[i - width];
      grad[i] = Math.abs(dx) + Math.abs(dy);
    }
  }
  return { width, height, data: grad };
}

/** Read/write the snap toggle across sessions. Wrapped so a private-window
 *  refusal or a full storage never breaks the crop screen. */
function readSnapPref() {
  try { return localStorage.getItem(SNAP_STORAGE_KEY) !== 'off'; } catch { return true; }
}
function writeSnapPref(on) {
  try { localStorage.setItem(SNAP_STORAGE_KEY, on ? 'on' : 'off'); } catch { /* full or blocked */ }
}

/**
 * Look for a strong image edge within `SNAP_RADIUS` source pixels of `(x, y)`
 * and, if one is close enough, return its position. The search runs on the
 * downscaled `edgeMap`, so a large radius here is still a small window of
 * a few dozen samples. Returns `null` when nothing crosses the threshold —
 * silent no-op is the point.
 */
function snapCornerToEdge(x, y) {
  if (!edgeMap || !previewSource) return null;
  const scale = previewSource.scale;
  const { width, height, data } = edgeMap;

  const cx = Math.round(x * scale);
  const cy = Math.round(y * scale);
  const r = Math.max(2, Math.round(SNAP_RADIUS * scale));
  const x0 = Math.max(1, cx - r);
  const y0 = Math.max(1, cy - r);
  const x1 = Math.min(width - 2, cx + r);
  const y1 = Math.min(height - 2, cy + r);

  let bestG = 0;
  let bestX = -1;
  let bestY = -1;
  for (let py = y0; py <= y1; py++) {
    const rowStart = py * width;
    for (let px = x0; px <= x1; px++) {
      const g = data[rowStart + px];
      if (g > bestG) { bestG = g; bestX = px; bestY = py; }
    }
  }
  if (bestG < SNAP_MIN_GRAD || bestX < 0) return null;
  return { x: bestX / scale, y: bestY / scale, strength: bestG };
}

/** Flatten at preview size, so the user can watch the label straighten as they
 *  drag instead of finding out after recognition has already run. */
function drawPreview() {
  const canvas = $('#preview-canvas');
  if (!previewSource || !points) return;

  const local = points.map((p) => ({
    x: p.x * previewSource.scale,
    y: p.y * previewSource.scale,
  }));

  let size;
  try {
    size = cylinderSize(local, PREVIEW_WIDTH, wrap);
  } catch {
    return;                       // degenerate mid-drag; the next move fixes it
  }

  const warped = warpCylinder(previewSource.image, local, size.width, size.height, wrap);
  canvas.width = warped.width;
  canvas.height = warped.height;
  canvas.getContext('2d').putImageData(
    new ImageData(warped.data, warped.width, warped.height), 0, 0,
  );
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

  view = { scale: scale * dpr, dpr };
}

/** Trace the crop outline: the two edge arcs, joined down the sides. */
function tracePath(ctx) {
  const toCanvasPoint = (p) => toCanvas(p.x, p.y);
  const top = edgeArc(points[TL], points[TM], points[TR]).map(toCanvasPoint);
  const bottom = edgeArc(points[BL], points[BM], points[BR]).map(toCanvasPoint);

  ctx.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < top.length; i++) ctx.lineTo(top[i].x, top[i].y);
  for (let i = bottom.length - 1; i >= 0; i--) ctx.lineTo(bottom[i].x, bottom[i].y);
  ctx.closePath();
}

function draw() {
  const canvas = $('#crop-canvas');
  const ctx = canvas.getContext('2d');
  const { dpr } = view;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  // Dim everything outside the crop: the frame and the shape in one even-odd path.
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  tracePath(ctx);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill('evenodd');

  ctx.beginPath();
  tracePath(ctx);
  ctx.strokeStyle = '#c8324f';
  ctx.lineWidth = 3 * dpr;
  ctx.stroke();

  for (const i of ALL_HANDLES) {
    const p = toCanvas(points[i].x, points[i].y);
    const middle = i === TM || i === BM;
    ctx.beginPath();
    ctx.arc(p.x, p.y, (middle ? HANDLE_RADIUS - 2 : HANDLE_RADIUS) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = middle ? 'rgba(200, 50, 79, 0.9)' : 'rgba(255, 255, 255, 0.9)';
    ctx.fill();
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = middle ? '#fff' : '#c8324f';
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
  const at = toCanvasPixels(event.clientX, event.clientY);
  const limit = GRAB_RADIUS * view.dpr;

  let best = -1;
  let bestDistance = Infinity;
  for (const i of ALL_HANDLES) {
    const c = toCanvas(points[i].x, points[i].y);
    const d = Math.hypot(c.x - at.x, c.y - at.y);
    if (d < bestDistance) { bestDistance = d; best = i; }
  }

  if (bestDistance > limit) return;
  dragging = best;
  rememberChords();
  $('#crop-loupe').hidden = false;
  drawLoupe();
  event.target.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event) {
  if (dragging < 0) return;
  const at = toCanvasPixels(event.clientX, event.clientY);
  const x = at.x / view.scale;
  const y = at.y / view.scale;

  if (dragging === TM || dragging === BM) {
    // The unwrap reads the middle handle as the halfway point across the label.
    // Letting it slide sideways would quietly misalign every column, so it only
    // moves along the perpendicular — it sets how much the edge bows, nothing
    // else. On a tilted bottle the visual high point of the edge is *not* the
    // halfway point, which is a trap when the handle is free to go anywhere.
    points[dragging] = bowTowards(dragging === TM ? EDGES[0] : EDGES[1], x, y);
  } else {
    // Middle handles may sit outside the frame: a label's curve often bows past
    // the top or bottom of a tightly framed photo.
    const slack = bitmap.height * 0.25;
    points[dragging] = {
      x: clamp(x, 0, bitmap.width),
      y: clamp(y, -slack, bitmap.height + slack),
    };
    // Dragging a corner carries its edge's middle handle along, so the bow the
    // user set is kept instead of being left stranded off the edge.
    carryMiddles();
  }

  draw();
  drawPreview();
  drawLoupe();
  event.preventDefault();
}

/**
 * A magnified look at the handle being dragged, redrawn into a fixed spot in
 * the preview band — beside the flattened image, not floating over the photo
 * — so a fingertip can never end up covering the one thing meant to show what
 * is underneath it. Centred on the handle's own (post-constraint) position
 * rather than the raw touch point, so the crosshair marks exactly where it
 * will land.
 */
function drawLoupe() {
  const canvas = $('#crop-loupe-canvas');
  const dpr = view.dpr || 1;
  const backing = Math.round(LOUPE_SIZE * dpr);
  if (canvas.width !== backing) { canvas.width = backing; canvas.height = backing; }
  const ctx = canvas.getContext('2d');

  const p = points[dragging];
  const srcSpan = backing / (view.scale * LOUPE_ZOOM);
  const half = srcSpan / 2;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, backing, backing);
  ctx.drawImage(bitmap, p.x - half, p.y - half, srcSpan, srcSpan, 0, 0, backing, backing);

  const mid = backing / 2;
  const arm = 11 * dpr;
  ctx.lineWidth = Math.max(1.5, dpr * 1.5);
  ctx.strokeStyle = '#c8324f';
  ctx.beginPath();
  ctx.moveTo(mid - arm, mid); ctx.lineTo(mid + arm, mid);
  ctx.moveTo(mid, mid - arm); ctx.lineTo(mid, mid + arm);
  ctx.stroke();
}

/** Put a middle handle on the perpendicular through its chord's midpoint,
 *  as far along it as the pointer reached. */
function bowTowards(edge, x, y) {
  const [, left, right] = edge;
  const mid = chordMidpoint(edge);
  const dx = points[right].x - points[left].x;
  const dy = points[right].y - points[left].y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length;
  const ny = dx / length;
  const reach = (x - mid.x) * nx + (y - mid.y) * ny;
  return { x: mid.x + nx * reach, y: mid.y + ny * reach };
}

function onPointerUp(event) {
  if (dragging < 0) return;
  const released = dragging;
  dragging = -1;
  $('#crop-loupe').hidden = true;
  try { event.target.releasePointerCapture(event.pointerId); } catch { /* already gone */ }

  // Corner handles get pulled onto the nearest strong edge, if the user's
  // finger landed close to one. Middle handles set curvature and have no
  // "edge" to snap to; the auto-fit below handles them instead.
  if (snapEnabled && (released === TL || released === TR
                       || released === BR || released === BL)) {
    const p = points[released];
    const snap = snapCornerToEdge(p.x, p.y);
    if (snap) {
      points[released] = { x: snap.x, y: snap.y };
      // Bringing a corner in means its edge's middle handle should ride along
      // just like it does mid-drag; otherwise a snapped corner leaves the
      // curvature stranded off the new position.
      rememberChords();
      carryMiddles();
      draw();
    }
  }

  // Every handle release changes what the fitter would say — the label's own
  // geometry tells the fitter where to put the slider. Runs on pointer-up
  // rather than pointer-move so the drag itself never feels heavy.
  autoFitWrap();
}

/**
 * Ask the fitter where the wrap slider should be for the current handles, and
 * move it there. Silent on failure — nothing about a bad fit should stop the
 * user from placing a handle.
 */
function autoFitWrap() {
  if (!bitmap || !points) return;
  let fitted;
  try {
    fitted = fitWrapAngle(points);
  } catch {
    return;
  }
  // fitWrapAngle already clamps to [MIN_WRAP, MAX_WRAP]; keep the guard local
  // in case future callers pass tighter candidate ranges.
  fitted = Math.max(MIN_WRAP, Math.min(MAX_WRAP, fitted));
  if (Math.abs(fitted - wrap) < 1e-6) return;
  wrap = fitted;
  const slider = $('#wrap-slider');
  slider.value = String(Math.round((wrap * 180) / Math.PI));
  renderWrap();
  drawPreview();
}

const EDGES = [[TM, TL, TR], [BM, BL, BR]];
const chordMidpoint = ([, left, right]) => ({
  x: (points[left].x + points[right].x) / 2,
  y: (points[left].y + points[right].y) / 2,
});

let chordsAtDragStart = null;

function rememberChords() {
  chordsAtDragStart = EDGES.map(chordMidpoint);
}

function carryMiddles() {
  if (!chordsAtDragStart) return;
  EDGES.forEach((edge, i) => {
    const now = chordMidpoint(edge);
    const before = chordsAtDragStart[i];
    const middle = points[edge[0]];
    points[edge[0]] = { x: middle.x + (now.x - before.x), y: middle.y + (now.y - before.y) };
    chordsAtDragStart[i] = now;
  });
}

const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

/* ── Flattening ─────────────────────────────────────────────────────── */

/**
 * Warp what the handles enclose into an upright rectangle.
 * Returns `{ canvas, blob }`.
 */
export async function flatten() {
  const shape = points;
  const size = cylinderSize(shape, MAX_SIDE, wrap);

  // Read back only the bounding box, and only at the resolution the output can
  // use. Height is the honest yardstick: unrolling stretches width on purpose.
  const rawHeight = Math.max(
    Math.hypot(points[TL].x - points[BL].x, points[TL].y - points[BL].y),
    Math.hypot(points[TR].x - points[BR].x, points[TR].y - points[BR].y),
  );
  const scale = Math.min(1, size.height / Math.max(1, rawHeight));

  const box = boundingBox(shape);
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

  const local = shape.map((p) => ({ x: (p.x - box.x) * scale, y: (p.y - box.y) * scale }));
  const warped = warpCylinder(source, local, size.width, size.height, wrap);

  const canvas = document.createElement('canvas');
  canvas.width = warped.width;
  canvas.height = warped.height;
  canvas.getContext('2d').putImageData(
    new ImageData(warped.data, warped.width, warped.height), 0, 0,
  );

  return { canvas, blob: await canvasToBlob(canvas) };
}

function boundingBox(shape) {
  const xs = shape.map((p) => p.x);
  const ys = shape.map((p) => p.y);
  const x = clamp(Math.floor(Math.min(...xs)), 0, bitmap.width);
  const y = clamp(Math.floor(Math.min(...ys)), 0, bitmap.height);
  const right = clamp(Math.ceil(Math.max(...xs)), 0, bitmap.width);
  const bottom = clamp(Math.ceil(Math.max(...ys)), 0, bitmap.height);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

window.addEventListener('resize', () => {
  if (bitmap && document.body.dataset.screen === 'crop') { layout(); draw(); drawPreview(); }
});

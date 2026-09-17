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
import { flattenLabel } from './flatten.js';
import { toGray, toChroma } from './detect.js';
import { refineHandles } from './refine.js';
import { detInputSize } from './ppocr-post.js';

const HANDLE_RADIUS = 13;   // CSS px — drawn size
const GRAB_RADIUS = 30;     // CSS px — touch target, comfortably past a fingertip
const INSET = 0.1;          // handles start 10% in from each edge
const BULGE = 0.035;        // default curve on the top and bottom edges

/** How far back in time to look when correcting for finger-lift drift.
 *  When a fingertip rolls off the glass on release, iOS and Android emit one
 *  last pointermove with a few pixels of unintended motion; freezing at the
 *  position the finger was already at ~90 ms earlier gives back the precision
 *  that drift takes away. */
const RELEASE_LOOKBACK_MS = 90;

/** The drift correction only fires if the finger really had settled. Anything
 *  above this cumulative movement during the lookback window is treated as
 *  the user still steering the handle on purpose, and the release position is
 *  honoured as-is. */
const RELEASE_SETTLED_PX = 6;   // in source-image pixels

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
let dragTrail = [];         // recent {point, time} — see release-drift below

export function initCrop() {
  const canvas = $('#crop-canvas');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  $('#btn-crop-reset').addEventListener('click', resetPoints);
  $('#btn-crop-snap').addEventListener('click', snapHandles);

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
  planes = null;
  setHint('');
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

let planes = null;          // luminance + chroma of the photo at working scale, for Snap

function setHint(text) {
  const hint = $('#crop-hint');
  hint.textContent = text;
  hint.hidden = !text;
}

/** The photo as Snap reads it: luminance and chroma at ≤960 px, made once. */
function workingPlanes() {
  if (planes) return planes;
  const size = detInputSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size.width, size.height);
  const image = ctx.getImageData(0, 0, size.width, size.height);
  planes = {
    gray: toGray(image.data, size.width, size.height),
    chroma: toChroma(image.data, size.width, size.height),
    width: size.width,
    height: size.height,
    scale: { x: bitmap.width / size.width, y: bitmap.height / size.height },
  };
  return planes;
}

/**
 * Snap: move each edge onto the paper's boundary near where the handles
 * are. Local, fast, and needs no engine. Handles never move further than
 * a few percent of the label's width; edges without contrast stay put.
 */
export function snapHandles() {
  if (!bitmap || !points) return null;
  const p = workingPlanes();
  const local = points.map((q) => ({ x: q.x / p.scale.x, y: q.y / p.scale.y }));
  const { points: refined, moved } = refineHandles(p, p.width, p.height, local);
  points = refined.map((q) => ({ x: q.x * p.scale.x, y: q.y * p.scale.y }));
  autoFitWrap();
  draw();
  drawPreview();
  const edges = Object.entries(moved).filter(([, v]) => v).map(([k]) => k);
  setHint(edges.length === 4 ? 'Snapped to the paper on all four edges.'
    : edges.length ? `Snapped ${edges.join(', ')}; no clear edge on the rest.`
      : 'No clear paper edge near the handles — drag them closer and try again.');
  return moved;
}

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
 *  move without touching the full-resolution image. */
function buildPreviewSource() {
  const scale = Math.min(1, (PREVIEW_WIDTH * 2.5) / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  previewSource = {
    image: ctx.getImageData(0, 0, canvas.width, canvas.height),
    scale,
  };
}

/** Position from `RELEASE_LOOKBACK_MS` ago if the finger settled during that
 *  window, otherwise null. What the drift correction reads at pointer-up. */
function preReleasePosition() {
  if (dragTrail.length < 2) return null;
  const now = performance.now();
  let anchor = null;
  for (let i = dragTrail.length - 1; i >= 0; i--) {
    if (now - dragTrail[i].t >= RELEASE_LOOKBACK_MS) { anchor = dragTrail[i]; break; }
  }
  if (!anchor) return null;
  // Everything from the anchor to the release must be within a small radius,
  // or the finger was still moving — respect its landing spot.
  for (const sample of dragTrail) {
    if (sample.t < anchor.t) continue;
    if (Math.hypot(sample.p.x - anchor.p.x, sample.p.y - anchor.p.y) > RELEASE_SETTLED_PX) {
      return null;
    }
  }
  return anchor.p;
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
  dragTrail = [];
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

  // Remember where this handle actually landed after constraints. On release
  // preReleasePosition() walks back through this trail to spot the position
  // the finger had already reached before the lift-drift micro-motion.
  dragTrail.push({ p: { ...points[dragging] }, t: performance.now() });
  if (dragTrail.length > 32) dragTrail.shift();

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

  // Undo the little bit of finger-lift drift the OS reports as the fingertip
  // rolls off the glass. Only when the finger really had settled — a still
  // moving handle keeps its landing position.
  const settled = preReleasePosition();
  if (settled) {
    points[released] = { x: settled.x, y: settled.y };
    // Corner handles carry their middle-handle bulge along mid-drag; rewinding
    // the corner would leave the middle sitting a couple of pixels off. Call
    // carryMiddles WITHOUT rememberChords first: the existing chord-start
    // captured a moment ago holds the drifted midpoint, so the delta this
    // computes is exactly the drift, applied in reverse.
    if (released !== TM && released !== BM) carryMiddles();
    draw();
    drawPreview();
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
  const canvas = flattenLabel(bitmap, points, wrap);
  return { canvas, blob: await canvasToBlob(canvas) };
}

window.addEventListener('resize', () => {
  if (bitmap && document.body.dataset.screen === 'crop') { layout(); draw(); drawPreview(); }
});

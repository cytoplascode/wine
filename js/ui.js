/* Shared UI plumbing: DOM helpers, the screen router, app state, toasts. */

import { Nav } from './nav.js';

export const $ = (sel) => document.querySelector(sel);

export const state = {
  labelBitmap: null,   // ImageBitmap straight from camera or gallery
  labelDate: null,     // when that photo was taken — today, or its EXIF date
  labelLocation: null, // { lat, lon } where it was taken — live GPS or EXIF
  cropPoints: null,    // the crop handles, in source-image pixels
  flattened: null,     // { canvas, blob } after perspective correction
  foodBlob: null,
  ocrText: '',
  ocrLines: [],
  fields: {},
};

export function resetCapture() {
  if (state.labelBitmap) state.labelBitmap.close();
  state.labelBitmap = null;
  state.labelDate = null;
  state.labelLocation = null;
  state.cropPoints = null;
  state.flattened = null;
  state.foodBlob = null;
  state.ocrText = '';
  state.ocrLines = [];
  state.fields = {};
}

/* ── Screen routing ─────────────────────────────────────────────────── */

/* Every screen is a history entry, so the phone's back button walks the flow
 * backwards instead of closing the app from wherever you happen to be. The
 * stack lives in `nav.js`; this half owns the DOM and the History API. */

const enterHooks = new Map();
const leaveHooks = new Map();
const nav = new Nav();
let overlayClose = null;

export function onEnter(screen, fn) { enterHooks.set(screen, fn); }
export function onLeave(screen, fn) { leaveHooks.set(screen, fn); }

function render(screen, arg) {
  const current = document.body.dataset.screen;
  if (current && leaveHooks.has(current)) leaveHooks.get(current)();
  document.body.dataset.screen = screen;
  if (enterHooks.has(screen)) enterHooks.get(screen)(arg);
}

export function go(screen, arg) {
  const plan = nav.go(screen, arg);
  // A jump is performed by the browser; its history event does the drawing.
  if (plan.action === 'jump') { history.go(plan.delta); return; }
  if (plan.action === 'push') history.pushState({ depth: plan.depth }, '');
  else if (plan.action === 'replace') history.replaceState({ depth: plan.depth }, '');
  render(screen, arg);
}

window.addEventListener('popstate', (event) => {
  // An overlay is not a screen, but back should still close it first.
  if (overlayClose) { const close = overlayClose; overlayClose = null; close(); }

  const depth = event.state && typeof event.state.depth === 'number' ? event.state.depth : 0;
  const target = nav.pop(depth);
  if (target) render(target.screen, target.arg);
});

/**
 * Open something the back button should close — a zoomed photo, say, which
 * covers the screen but is not one. It borrows a history entry so that closing
 * it and pressing back are the same action.
 */
export function openOverlay(close) {
  overlayClose = close;
  history.pushState({ depth: nav.depth, overlay: true }, '');
}

export function dismissOverlay() {
  if (overlayClose) history.back();
}

/**
 * A back arrow that always means "wherever I actually came from," not a
 * screen name hardcoded to the usual route. A screen can be reached more
 * than one way — the crop screen from capture, but also from review's pencil
 * — and `go(screen)` would just jump to that screen's *original* place in
 * the stack rather than back to whichever place led here this time.
 */
export function goBack() {
  history.back();
}

/* A reload restores whichever entry was current, but the photo that entry stood
 * for went with the page, so the app always restarts at home. Unwind the
 * entries left behind, or the first few back presses would appear to do
 * nothing. The navigation is queued, so it lands after startup has replaced the
 * current entry with home's. */
const restored = history.state && history.state.depth;
if (restored > 0) history.go(-restored);

/* ── Toast ──────────────────────────────────────────────────────────── */

let toastTimer = null;

export function toast(message, ms = 3600) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ── Misc ───────────────────────────────────────────────────────────── */

/** Draw an ImageBitmap to a canvas and hand back a JPEG blob. */
export function bitmapToBlob(bitmap, quality = 0.9) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return canvasToBlob(canvas, quality);
}

export function canvasToBlob(canvas, quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image'))),
      'image/jpeg',
      quality,
    );
  });
}

export function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

/* Android's clipboard is not a place to put an unbounded amount of text: it
 * travels through the same transaction buffer as everything else crossing a
 * process boundary, around a megabyte, and a parcel that overruns it fails in
 * whatever way that particular phone chooses. A worst-case label measured
 * ~1.2 MB as base64 on its own, and a bottle can carry two, so each photo is
 * re-encoded until it fits its share — quality first, and only then size. */
export const CLIPBOARD_BUDGET = 800_000;
const QUALITY_STEPS = [0.75, 0.6];
const FALLBACK_WIDTH = 1200;

/**
 * The photo as a data URI small enough to survive the clipboard, re-encoded
 * only if the stored one is too big for `budget` characters. Returns
 * `{ dataUri, reduced }` so the caller can say when a photo went across at
 * less than full quality.
 */
export async function photoDataUri(blob, budget = CLIPBOARD_BUDGET) {
  const first = await blobToDataUri(blob);
  if (first.length <= budget) return { dataUri: first, reduced: false };

  const bitmap = await createImageBitmap(blob);
  try {
    for (const quality of QUALITY_STEPS) {
      const candidate = await blobToDataUri(await drawToBlob(bitmap, bitmap.width, quality));
      if (candidate.length <= budget) return { dataUri: candidate, reduced: true };
    }
    const scale = Math.min(1, FALLBACK_WIDTH / Math.max(bitmap.width, bitmap.height));
    const smaller = await drawToBlob(bitmap, Math.round(bitmap.width * scale), 0.7);
    return { dataUri: await blobToDataUri(smaller), reduced: true };
  } finally {
    bitmap.close();
  }
}

function drawToBlob(bitmap, width, quality) {
  const scale = width / bitmap.width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, quality);
}

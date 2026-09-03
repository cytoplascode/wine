/* Shared UI plumbing: DOM helpers, the screen router, app state, toasts. */

import { Nav } from './nav.js';

export const $ = (sel) => document.querySelector(sel);

export const state = {
  labelBitmap: null,   // ImageBitmap straight from camera or gallery
  labelDate: null,     // when that photo was taken — today, or its EXIF date
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

/**
 * Re-encode a blob as PNG. The system clipboard's write() only accepts
 * `image/png` for images — not the `image/jpeg` this app stores photos
 * as — so this is the one conversion the QuickAdd "copy this photo" step
 * needs before it can put anything on the clipboard at all.
 */
export async function blobToPngBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvasToBlob(canvas, undefined, 'image/png');
}

export function canvasToBlob(canvas, quality = 0.9, type = 'image/jpeg') {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image'))),
      type,
      quality,
    );
  });
}

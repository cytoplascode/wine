/* Shared UI plumbing: DOM helpers, the screen router, app state, toasts. */

export const $ = (sel) => document.querySelector(sel);

export const state = {
  labelBitmap: null,   // ImageBitmap straight from camera or gallery
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
  state.cropPoints = null;
  state.flattened = null;
  state.foodBlob = null;
  state.ocrText = '';
  state.ocrLines = [];
  state.fields = {};
}

/* ── Screen routing ─────────────────────────────────────────────────── */

const enterHooks = new Map();
const leaveHooks = new Map();

export function onEnter(screen, fn) { enterHooks.set(screen, fn); }
export function onLeave(screen, fn) { leaveHooks.set(screen, fn); }

export function go(screen, arg) {
  const current = document.body.dataset.screen;
  if (current && leaveHooks.has(current)) leaveHooks.get(current)();
  document.body.dataset.screen = screen;
  if (enterHooks.has(screen)) enterHooks.get(screen)(arg);
}

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

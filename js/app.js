/* App shell: screen routing, service worker lifecycle, offline-OCR status. */

export const $ = (sel) => document.querySelector(sel);

export const state = {
  labelBitmap: null,   // ImageBitmap straight from camera/gallery
  corners: null,       // 4 points in source-image pixels
  flattened: null,     // { canvas, blob } after perspective correction
  foodBlob: null,
  ocrText: '',
  fields: {},
};

/* ── Screen routing ─────────────────────────────────────────────────── */

const leaveHooks = new Map();
const enterHooks = new Map();

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

export function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ── Offline OCR status ─────────────────────────────────────────────── */

const ocrDot = $('#ocr-dot');
const ocrStatus = $('#ocr-status');
const ocrBar = $('#ocr-bar');
const ocrCacheBtn = $('#btn-cache-ocr');

function renderOcrProgress({ done, total, complete, error }) {
  if (error) {
    ocrDot.dataset.state = 'err';
    ocrStatus.textContent = `Download failed — ${error}`;
    ocrBar.hidden = true;
    ocrCacheBtn.hidden = false;
    ocrCacheBtn.textContent = 'Retry download';
    return;
  }
  if (total === 0) {
    ocrDot.dataset.state = 'warn';
    ocrStatus.textContent = 'Recognition engine not bundled yet.';
    ocrBar.hidden = true;
    ocrCacheBtn.hidden = true;
    return;
  }
  if (complete) {
    ocrDot.dataset.state = 'ok';
    ocrStatus.textContent = 'Ready — recognition runs on this phone, offline.';
    ocrBar.hidden = true;
    ocrCacheBtn.hidden = true;
    return;
  }
  ocrDot.dataset.state = 'warn';
  ocrBar.hidden = false;
  ocrBar.querySelector('i').style.width = `${Math.round((done / total) * 100)}%`;
  ocrStatus.textContent = done === 0
    ? 'Not downloaded — needs one connection, then works offline forever.'
    : `Downloading… ${done} of ${total} files.`;
  ocrCacheBtn.hidden = done !== 0;
}

function messageServiceWorker(payload) {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(payload);
  }
}

/* ── Startup ────────────────────────────────────────────────────────── */

function wireStaticButtons() {
  $('#btn-new-bottle').addEventListener('click', () => go('capture', 'label'));
  $('#btn-capture-back').addEventListener('click', () => go('home'));
  $('#btn-crop-back').addEventListener('click', () => go('capture', 'label'));
  $('#btn-review-back').addEventListener('click', () => go('crop'));
  $('#btn-another').addEventListener('click', () => go('capture', 'label'));
  $('#btn-home').addEventListener('click', () => go('home'));
  ocrCacheBtn.addEventListener('click', () => messageServiceWorker({ type: 'cache-ocr' }));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    ocrDot.dataset.state = 'warn';
    ocrStatus.textContent = 'This browser cannot store the app for offline use.';
    return;
  }
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'ocr-progress') renderOcrProgress(event.data);
  });
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    messageServiceWorker({ type: 'ocr-status' });
  } catch (err) {
    ocrDot.dataset.state = 'err';
    ocrStatus.textContent = `Offline setup failed: ${err.message}`;
  }
}

wireStaticButtons();
registerServiceWorker();
go('home');

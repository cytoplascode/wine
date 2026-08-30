/* Wiring and startup: buttons, screen hooks, service worker lifecycle. */

import { $, state, go, onEnter, onLeave, toast, resetCapture, bitmapToBlob } from './ui.js';
import { initCapture, startCapture, stopCapture } from './camera.js';
import * as crop from './crop.js';
import * as ocr from './ocr.js';
import { buildForm, setValues } from './form.js';
import { emptyRecord } from './schema.js';
import { parseLabel } from './parse.js';

/* ── Photo handling ─────────────────────────────────────────────────── */

async function handlePhoto(bitmap, mode) {
  if (mode === 'food') {
    state.foodBlob = await bitmapToBlob(bitmap);
    bitmap.close();
    go('review');
    return;
  }
  if (state.labelBitmap) state.labelBitmap.close();
  state.labelBitmap = bitmap;
  state.corners = null;
  go('crop');
}

/* ── Screen hooks ───────────────────────────────────────────────────── */

onEnter('capture', (mode) => startCapture(mode || 'label'));
onLeave('capture', stopCapture);
onEnter('crop', () => crop.showImage(state.labelBitmap, state.corners));

/* ── Flattening ─────────────────────────────────────────────────────── */

let labelUrl = null;

async function flattenAndReview() {
  const button = $('#btn-crop-done');
  button.disabled = true;
  button.textContent = 'Flattening…';
  // Yield a frame so the button's new label paints before the resampling loop.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    state.corners = crop.getCorners();
    state.flattened = await crop.flatten();

    if (labelUrl) URL.revokeObjectURL(labelUrl);
    labelUrl = URL.createObjectURL(state.flattened.blob);
    $('#thumb-label').src = labelUrl;

    go('review');
  } catch (err) {
    toast(`Could not flatten the label: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Read label';
  }
}

/* ── Recognition ────────────────────────────────────────────────────── */

const PHASES = {
  'loading tesseract core': 'Starting the recognition engine…',
  'initializing tesseract': 'Starting the recognition engine…',
  'loading language traineddata': 'Loading the language data…',
  'initializing api': 'Almost ready…',
  'recognizing text': 'Reading the label…',
};

function showOcrProgress(fraction, label) {
  $('#ocr-progress').hidden = false;
  $('#ocr-progress .bar > i').style.width = `${Math.round(fraction * 100)}%`;
  $('#ocr-progress-label').textContent = label;
}

async function runOcr() {
  if (!state.flattened || state.ocrText) return;

  setValues(emptyRecord());
  showOcrProgress(0, 'Starting the recognition engine…');
  try {
    const result = await ocr.recognize(state.flattened.canvas, (m) => {
      showOcrProgress(m.progress || 0, PHASES[m.status] || 'Working…');
    });
    state.ocrText = result.text;
    state.ocrLines = result.lines;
    $('#raw-text').textContent = result.text.trim() || '(nothing was recognised)';

    const { fields, auto } = parseLabel(result);
    state.fields = fields;
    setValues({ ...emptyRecord(), ...fields }, auto);
  } catch (err) {
    $('#raw-text').textContent = '';
    toast(`Could not read the label: ${err.message}`);
  } finally {
    $('#ocr-progress').hidden = true;
  }
}

onEnter('review', runOcr);

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
    ? 'Not downloaded — needs one connection, then works offline for good.'
    : `Downloading… ${done} of ${total} files.`;
  ocrCacheBtn.hidden = done !== 0;
}

async function messageServiceWorker(payload) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  // On a first visit the worker has not taken control yet, so `controller` is
  // still null; the active worker can be messaged either way.
  const worker = navigator.serviceWorker.controller || registration.active;
  if (worker) worker.postMessage(payload);
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

/* ── Startup ────────────────────────────────────────────────────────── */

function newBottle() {
  resetCapture();
  go('capture', 'label');
}

initCapture({ onPhoto: handlePhoto });
crop.initCrop();
buildForm();

$('#btn-new-bottle').addEventListener('click', newBottle);
$('#btn-another').addEventListener('click', newBottle);
$('#btn-home').addEventListener('click', () => go('home'));
$('#btn-capture-back').addEventListener('click', () => go('home'));
$('#btn-crop-back').addEventListener('click', () => go('capture', 'label'));
$('#btn-crop-done').addEventListener('click', flattenAndReview);
$('#btn-review-back').addEventListener('click', () => go('crop'));
ocrCacheBtn.addEventListener('click', () => {
  ocrCacheBtn.hidden = true;
  toast('Downloading the recognition engine…');
  messageServiceWorker({ type: 'cache-ocr' });
});

registerServiceWorker();
go('home');

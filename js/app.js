/* Wiring and startup: buttons, screen hooks, service worker lifecycle. */

import {
  $, state, go, onEnter, onLeave, toast, resetCapture, bitmapToBlob,
  openOverlay, dismissOverlay,
} from './ui.js';
import { initCapture, startCapture, stopCapture } from './camera.js';
import * as crop from './crop.js';
import * as ocr from './ocr.js';
import { buildForm, setValues } from './form.js';
import { initFieldDrag } from './drag.js';
import { emptyRecord } from './schema.js';
import { parseLabel } from './parse.js';
import * as vault from './vault.js';
import { readValues } from './form.js';
import { save, PermissionNeeded } from './save.js';
import {
  LANGUAGES, MAX_ACTIVE, getLanguages, setLanguages, toTesseractLangs, totalMegabytes,
} from './languages.js';

/* ── Photo handling ─────────────────────────────────────────────────── */

async function handlePhoto(bitmap, mode, capturedOn) {
  if (mode === 'food') {
    state.foodBlob = await bitmapToBlob(bitmap);
    bitmap.close();
    go('review');
    return;
  }
  if (state.labelBitmap) state.labelBitmap.close();
  state.labelBitmap = bitmap;
  state.labelDate = capturedOn || null;
  state.cropPoints = null;
  go('crop');
}

/* ── Screen hooks ───────────────────────────────────────────────────── */

onEnter('capture', (mode) => startCapture(mode || 'label'));
onLeave('capture', stopCapture);
onEnter('crop', () => crop.showImage(state.labelBitmap, state.cropPoints));

/* ── Flattening ─────────────────────────────────────────────────────── */

let labelUrl = null;

async function flattenAndReview() {
  const button = $('#btn-crop-done');
  button.disabled = true;
  button.textContent = 'Flattening…';
  // Yield a frame so the button's new label paints before the resampling loop.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    state.cropPoints = crop.getPoints();
    state.flattened = await crop.flatten();
    // A fresh flatten needs a fresh read — otherwise runOcr's guard against
    // re-running on every re-entry to review (added a food photo, went back
    // and forward) would just as happily skip it here, and review would show
    // whatever the previous crop happened to read.
    state.ocrText = '';
    state.ocrLines = [];
    state.fields = {};

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

/**
 * Merge in the label photo's capture date as a guess at when it was drunk —
 * often the same moment — marked AUTO like any other guess, so it stays
 * visibly a guess until edited. Independent of OCR, and applied both before
 * and after it runs, so the date survives whether or not recognition itself
 * succeeds.
 */
function withCaptureDate(record) {
  return state.labelDate ? { ...record, 'Drink date': state.labelDate } : record;
}
const captureDateAuto = () => (state.labelDate ? ['Drink date'] : []);

async function runOcr() {
  if (!state.flattened || state.ocrText) return;

  setValues(withCaptureDate(emptyRecord()), captureDateAuto());
  $('#raw-text').textContent = '';
  showOcrProgress(0, 'Starting the recognition engine…');
  try {
    const result = await ocr.recognize(state.flattened.canvas, (m) => {
      showOcrProgress(m.progress || 0, PHASES[m.status] || 'Working…');
    }, toTesseractLangs(getLanguages()));
    state.ocrText = result.text;
    state.ocrLines = result.lines;
    $('#raw-text').textContent = result.lines.length
      ? result.lines
        .map((l) => `${String(Math.round(l.confidence)).padStart(3)}%  ${l.text}`)
        .join('\n')
      : '(nothing was recognised)';

    const { fields, auto } = parseLabel(result);
    state.fields = fields;
    setValues(withCaptureDate({ ...emptyRecord(), ...fields }), [...auto, ...captureDateAuto()]);
  } catch (err) {
    $('#raw-text').textContent = '';
    toast(`Could not read the label: ${err.message}`);
  } finally {
    $('#ocr-progress').hidden = true;
  }
}

onEnter('review', () => {
  renderFoodThumb();
  runOcr();
});

/* ── Food photo ─────────────────────────────────────────────────────── */

let foodUrl = null;

function renderFoodThumb() {
  const image = $('#thumb-food');
  const addButton = $('#btn-add-food');
  const removeButton = $('#btn-remove-food');
  const caption = $('#food-caption');

  if (foodUrl) { URL.revokeObjectURL(foodUrl); foodUrl = null; }

  if (state.foodBlob) {
    foodUrl = URL.createObjectURL(state.foodBlob);
    image.src = foodUrl;
    image.hidden = false;
    addButton.hidden = true;
    removeButton.hidden = false;
    caption.hidden = false;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
    addButton.hidden = false;
    removeButton.hidden = true;
    // The + button already says "Food photo" — a caption under it too would
    // repeat itself before there is even a photo to caption.
    caption.hidden = true;
  }
}

function removeFoodPhoto() {
  state.foodBlob = null;
  renderFoodThumb();
}

/* ── Enlarged photo ─────────────────────────────────────────────────── */

/* The review thumbnails are small enough that "is that really what it says?"
 * is unanswerable, so tapping one fills the screen with it. It is an overlay
 * rather than a screen, but the back button still closes it. */
function enlarge(thumbnail) {
  if (!thumbnail.getAttribute('src')) return;
  const view = $('#lightbox-image');
  view.src = thumbnail.src;
  view.alt = thumbnail.alt;
  $('#lightbox').hidden = false;
  openOverlay(() => {
    $('#lightbox').hidden = true;
    view.removeAttribute('src');
  });
}

/* ── Saving ─────────────────────────────────────────────────────────── */

async function saveBottle() {
  const button = $('#btn-save');

  if (!state.flattened) {
    toast('There is no label image to save yet.');
    return;
  }

  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const result = await save({
      record: readValues(),
      labelBlob: state.flattened.blob,
      foodBlob: state.foodBlob,
      ocrText: state.ocrText,
    });

    $('#saved-title').textContent = result.mode === 'vault' ? 'Saved to your vault' : 'Downloaded';
    $('#saved-path').textContent = result.path;
    go('saved');
  } catch (err) {
    toast(err instanceof PermissionNeeded
      ? 'The vault needs reconnecting — do that on the home screen, then save again.'
      : `Could not save: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Save to vault';
  }
}

/* ── Vault card ─────────────────────────────────────────────────────── */

const vaultDot = $('#vault-dot');
const vaultStatus = $('#vault-status');
const vaultButton = $('#btn-connect-vault');

async function renderVaultCard() {
  const state = await vault.status();
  const card = vault.describe(state, vault.getVaultName());

  vaultDot.dataset.state = card.dot;
  vaultStatus.textContent = card.text;

  if (card.button) {
    [vaultButton.textContent, vaultButton.dataset.action] = card.button;
    vaultButton.hidden = false;
  } else {
    vaultButton.hidden = true;
  }
  return state;
}

async function onVaultButton() {
  try {
    if (vaultButton.dataset.action === 'reconnect') {
      // requestPermission only works inside a gesture, which is why this lives
      // behind a button rather than running on load.
      if (await vault.reconnect() !== 'granted') toast('Access was not granted.');
    } else {
      await vault.pick();
      toast('Vault connected.');
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast(`Could not connect: ${err.message}`);
  }
  renderVaultCard();
}

onEnter('home', renderVaultCard);

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

function renderLanguageChips() {
  const chips = $('#language-chips');
  const chosen = getLanguages();
  chips.textContent = '';

  for (const language of LANGUAGES) {
    const on = chosen.includes(language.code);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = language.label;
    button.setAttribute('aria-pressed', String(on));
    button.disabled = !on && chosen.length >= MAX_ACTIVE;
    button.addEventListener('click', () => {
      const next = on
        ? chosen.filter((code) => code !== language.code)
        : [...chosen, language.code];
      setLanguages(next);
      renderLanguageChips();
      messageServiceWorker({ type: 'ocr-status', langs: getLanguages() });
    });
    chips.append(button);
  }

  const size = totalMegabytes(chosen).toFixed(1);
  $('#language-hint').textContent = chosen.length >= MAX_ACTIVE
    ? `${size} MB of language data. That is the limit — each one slows recognition down.`
    : `${size} MB of language data. Pick the languages your labels are printed in.`;
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
    messageServiceWorker({ type: 'ocr-status', langs: getLanguages() });
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
initFieldDrag();
renderLanguageChips();

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
  messageServiceWorker({ type: 'cache-ocr', langs: getLanguages() });
});

vaultButton.addEventListener('click', onVaultButton);
$('#btn-add-food').addEventListener('click', () => go('capture', 'food'));
$('#btn-remove-food').addEventListener('click', removeFoodPhoto);
$('#btn-save').addEventListener('click', saveBottle);
$('#thumb-label').addEventListener('click', (event) => enlarge(event.currentTarget));
$('#thumb-food').addEventListener('click', (event) => enlarge(event.currentTarget));
$('#btn-edit-label').addEventListener('click', () => go('crop'));
$('#lightbox').addEventListener('click', dismissOverlay);

registerServiceWorker();
vault.restore().then(renderVaultCard);
go('home');

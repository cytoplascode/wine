/* Wiring and startup: buttons, screen hooks, service worker lifecycle. */

import {
  $, state, go, goBack, onEnter, onLeave, toast, resetCapture, bitmapToBlob,
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
import * as quickadd from './quickadd.js';
import { getMode, setMode, getFolders, setFolders } from './connection.js';
import { readValues, patchIfEmpty } from './form.js';
import { reverseGeocode } from './geocode.js';
import { save, launchUri, PermissionNeeded } from './save.js';
import {
  putDraft, listDrafts, getDraft, removeDraft, newDraftId,
} from './drafts.js';
import {
  LANGUAGES, MAX_ACTIVE, getLanguages, setLanguages, toTesseractLangs, totalMegabytes,
} from './languages.js';

/* ── Photo handling ─────────────────────────────────────────────────── */

async function handlePhoto(bitmap, mode, capturedOn, location, sourceBlob) {
  if (mode === 'food') {
    state.foodBlob = await bitmapToBlob(bitmap);
    bitmap.close();
    scheduleDraftSave();
    go('review');
    return;
  }
  if (mode === 'back') {
    // Back label rides through the same crop/warp/OCR pipeline as the
    // front — same curve, same handles — so it hands off to the crop
    // screen too, just tagged so the crop-done step lands the flattened
    // output in its own slot instead of clobbering the front's.
    if (state.backLabelBitmap) state.backLabelBitmap.close();
    state.backLabelBitmap = bitmap;
    state.backLabelBlob = sourceBlob || null;
    state.backCropPoints = null;
    state.cropTarget = 'back';
    go('crop', 'back');
    return;
  }
  if (state.labelBitmap) state.labelBitmap.close();
  state.labelBitmap = bitmap;
  state.labelBlob = sourceBlob || null;
  state.labelDate = capturedOn || null;
  state.labelLocation = location || null;
  state.cropPoints = null;
  state.cropTarget = 'front';
  go('crop');
}

/* ── Screen hooks ───────────────────────────────────────────────────── */

onEnter('capture', (mode) => startCapture(mode || 'label'));
onLeave('capture', stopCapture);
onEnter('crop', (arg) => {
  // `arg` says which label the crop screen was opened for; state.cropTarget
  // is set to match by the caller so the crop-done step knows where to
  // land the flattened output.
  const isBack = arg === 'back' || arg === 'back-edit';
  state.cropTarget = isBack ? 'back' : 'front';
  crop.showImage(
    isBack ? state.backLabelBitmap : state.labelBitmap,
    isBack ? state.backCropPoints : state.cropPoints,
  );
});

/* ── Flattening ─────────────────────────────────────────────────────── */

let labelUrl = null;

async function flattenAndReview() {
  const button = $('#btn-crop-done');
  button.disabled = true;
  button.textContent = 'Flattening…';
  // Yield a frame so the button's new label paints before the resampling loop.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const points = crop.getPoints();
    const flattened = await crop.flatten();

    if (state.cropTarget === 'back') {
      state.backCropPoints = points;
      state.backFlattened = flattened;
      // Clear the last back-OCR so the review re-runs it — same reason
      // the front path clears state.ocrText below.
      state.backOcrText = '';
      state.backOcrLines = [];
      updateBackThumb();
      go('review');
    } else {
      state.cropPoints = points;
      state.flattened = flattened;
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
    }
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

/** Merge in the label photo's coordinates and reverse-geocoded city/country
 *  — guesses, marked AUTO. All three survive an OCR-completion setValues()
 *  by riding in on every one, which is what stops a slow lookup that landed
 *  before OCR finished from being wiped a second later by the setValues that
 *  ships the OCR guesses. Drink venue is user-typed and stays out of this. */
function withLocation(record) {
  const extras = {};
  if (state.labelLocation) extras['Drink coordinates'] = formatCoordinates(state.labelLocation);
  if (state.labelCity) extras['Drink city'] = state.labelCity;
  if (state.labelCountry) extras['Drink country'] = state.labelCountry;
  return Object.keys(extras).length ? { ...record, ...extras } : record;
}
const locationAuto = () => [
  ...(state.labelLocation ? ['Drink coordinates'] : []),
  ...(state.labelCity ? ['Drink city'] : []),
  ...(state.labelCountry ? ['Drink country'] : []),
];

function formatCoordinates({ lat, lon }) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

const withAutoContext = (record) => withLocation(withCaptureDate(record));
const autoContextKeys = () => [...captureDateAuto(), ...locationAuto()];

/**
 * A best-effort city and country for the label's coordinates, filled in once
 * they resolve rather than blocking review on a network round trip. Guarded
 * against a fetch that is still in flight when the user moves on to a
 * different bottle — state.labelLocation is a fresh object per capture, so a
 * reference check catches a result that would otherwise land on the wrong
 * one.
 */
async function resolveDrinkLocation() {
  const location = state.labelLocation;
  if (!location) return;
  const result = await reverseGeocode(location);
  if (!result || state.labelLocation !== location) return;
  // Kept in state so a subsequent setValues (the one that ships OCR guesses)
  // re-applies them via withAutoContext — patchIfEmpty alone would fill each
  // field once and then have it wiped by the next full setValues.
  state.labelCity = result.city;
  state.labelCountry = result.country;
  if (result.city) patchIfEmpty('Drink city', result.city);
  if (result.country) patchIfEmpty('Drink country', result.country);
}

async function runOcr() {
  if (!state.flattened || state.ocrText) return;

  setValues(withAutoContext(emptyRecord()), autoContextKeys());
  resolveDrinkLocation();
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
    setValues(withAutoContext({ ...emptyRecord(), ...fields }), [...auto, ...autoContextKeys()]);
    scheduleDraftSave();
  } catch (err) {
    $('#raw-text').textContent = '';
    toast(`Could not read the label: ${err.message}`);
  } finally {
    $('#ocr-progress').hidden = true;
  }
  // Front OCR is done. If a back label is waiting for its own read, do
  // it now — sequentially rather than in parallel because the OCR
  // engine holds one Tesseract worker, and running two recognitions on
  // it at once serializes anyway. The merge happens inside runBackOcr.
  runBackOcrIfPending();
}

/**
 * OCR the back label (if there is one and it hasn't been read yet), and
 * merge any new field guesses into fields the user has left blank. Never
 * overwrites something already filled in — front OCR's guesses stay
 * whether or not the back would have said otherwise, and hand-typed
 * values are always safe.
 */
async function runBackOcrIfPending() {
  if (!state.backFlattened || state.backOcrText) return;
  // A resumed draft that never finished its back OCR arrives with a blob
  // but no canvas — rebuild one from the blob so Tesseract has something
  // to read.
  if (!state.backFlattened.canvas) {
    const bmp = await createImageBitmap(state.backFlattened.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    state.backFlattened.canvas = c;
  }
  showOcrProgress(0, 'Reading the back label…');
  try {
    const result = await ocr.recognize(state.backFlattened.canvas, (m) => {
      showOcrProgress(m.progress || 0, 'Reading the back label…');
    }, toTesseractLangs(getLanguages()));
    state.backOcrText = result.text;
    state.backOcrLines = result.lines;

    // Show back-label lines alongside the front's in the raw text panel,
    // so a wrong guess is still traceable.
    if (result.lines.length) {
      const separator = $('#raw-text').textContent ? '\n\n— Back label —\n' : '— Back label —\n';
      $('#raw-text').textContent += separator + result.lines
        .map((l) => `${String(Math.round(l.confidence)).padStart(3)}%  ${l.text}`)
        .join('\n');
    }

    // Re-parse the two texts as one bigger label, then fill only the
    // fields that are still empty — patchIfEmpty is what enforces the
    // "never overwrite" rule.
    const combined = {
      text: `${state.ocrText}\n\n${result.text}`,
      lines: [...state.ocrLines, ...result.lines],
    };
    const { fields } = parseLabel(combined);
    for (const [key, value] of Object.entries(fields)) {
      if (value) patchIfEmpty(key, value);
    }
    scheduleDraftSave();
  } catch (err) {
    toast(`Could not read the back label: ${err.message}`);
  } finally {
    $('#ocr-progress').hidden = true;
  }
}

onEnter('review', () => {
  renderFoodThumb();
  updateBackThumb();
  runOcr();
  scheduleDraftSave();
  attachFormSaveListener();
});

/* ── Drafts ─────────────────────────────────────────────────────────── */

/* A bottle is auto-saved to IndexedDB the moment it reaches review, then
 * on every edit that follows, so leaving the app (a lock screen, a switch
 * to Obsidian, "New bottle" on top of an unfinished one) never loses it.
 * A successful send to the vault deletes the draft; the Drafts card on
 * the home screen lists everything still pending. */

// Debounce so a burst of form edits (typing into a field) collapses into
// one write instead of racing IndexedDB on every keystroke.
const DRAFT_SAVE_DEBOUNCE_MS = 400;
let draftSaveTimer = null;
let formSaveListenerAttached = false;

function scheduleDraftSave() {
  if (!state.flattened || !state.flattened.blob) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftNow, DRAFT_SAVE_DEBOUNCE_MS);
}

async function saveDraftNow() {
  if (!state.flattened || !state.flattened.blob) return;
  if (!state.draftId) state.draftId = newDraftId();

  const record = readValues();
  const snapshot = {
    labelBlob: state.labelBlob,
    flattenedBlob: state.flattened.blob,
    foodBlob: state.foodBlob,
    ocrText: state.ocrText,
    ocrLines: state.ocrLines,
    cropPoints: state.cropPoints,
    labelDate: state.labelDate,
    labelLocation: state.labelLocation,
    labelCity: state.labelCity,
    labelCountry: state.labelCountry,
    backLabelBlob: state.backLabelBlob,
    backFlattenedBlob: state.backFlattened ? state.backFlattened.blob : null,
    backCropPoints: state.backCropPoints,
    backOcrText: state.backOcrText,
    backOcrLines: state.backOcrLines,
    fields: record,
  };

  try {
    await putDraft(state.draftId, snapshot);
    renderDraftsCard();
  } catch (err) {
    // Storage full, or a transient IDB error — nothing to surface loudly:
    // the user is mid-review, and next edit will retry the save.
    console.warn('Draft save failed:', err);
  }
}

/** Listen to every form change so a typed field, a picked suggestion,
 *  or a re-cropped label all get folded into the draft. Attached lazily
 *  once, since the form's DOM lives across review re-entries. */
function attachFormSaveListener() {
  if (formSaveListenerAttached) return;
  const form = $('#wine-form');
  if (!form) return;
  form.addEventListener('input', scheduleDraftSave);
  formSaveListenerAttached = true;
}

/** Resume a draft: rebuild the review-screen state from an IndexedDB row
 *  and jump to review. Skips OCR — the stored `ocrText` is already the
 *  guard `runOcr` checks against, so the OCR pass sees "already done"
 *  and moves on, saving several seconds and an engine warm-up. */
async function resumeDraft(id) {
  const draft = await getDraft(id);
  if (!draft) return;

  resetCapture();
  state.draftId = id;
  state.labelBlob = draft.labelBlob || null;
  if (draft.labelBlob) {
    // A source blob is only there if the draft was written by a build
    // that stored one; older ones just have the flattened. Rebuild the
    // bitmap so the pencil-to-recrop workflow still lands on the source.
    try { state.labelBitmap = await createImageBitmap(draft.labelBlob); } catch {
      // Corrupt blob or a browser mid-refresh — fall back to the flattened
      // as the source. Crops from here will be crops of the flattened,
      // which is a small regression but never a data loss.
      state.labelBitmap = await createImageBitmap(draft.flattenedBlob);
    }
  } else {
    state.labelBitmap = await createImageBitmap(draft.flattenedBlob);
  }
  state.flattened = { blob: draft.flattenedBlob, canvas: null };
  state.foodBlob = draft.foodBlob || null;
  state.ocrText = draft.ocrText || '';
  state.ocrLines = draft.ocrLines || [];
  state.cropPoints = draft.cropPoints || null;
  state.labelDate = draft.labelDate || null;
  state.labelLocation = draft.labelLocation || null;
  state.labelCity = draft.labelCity || null;
  state.labelCountry = draft.labelCountry || null;
  state.fields = draft.fields || {};

  // Back label — everything is optional; a draft written by an older
  // build simply has none of these keys, and the review screen behaves as
  // if the user never added one.
  state.backLabelBlob = draft.backLabelBlob || null;
  state.backCropPoints = draft.backCropPoints || null;
  state.backOcrText = draft.backOcrText || '';
  state.backOcrLines = draft.backOcrLines || [];
  if (draft.backFlattenedBlob) {
    state.backFlattened = { blob: draft.backFlattenedBlob, canvas: null };
    if (draft.backLabelBlob) {
      try { state.backLabelBitmap = await createImageBitmap(draft.backLabelBlob); } catch {
        state.backLabelBitmap = await createImageBitmap(draft.backFlattenedBlob);
      }
    } else {
      state.backLabelBitmap = await createImageBitmap(draft.backFlattenedBlob);
    }
  }

  // Point the review-screen thumbnail at the flattened image directly
  // (runOcr won't run for this pass, so its usual side effect that sets
  // the thumbnail via labelUrl doesn't fire).
  if (labelUrl) URL.revokeObjectURL(labelUrl);
  labelUrl = URL.createObjectURL(draft.flattenedBlob);
  $('#thumb-label').src = labelUrl;

  go('review');
  // Restore the form after render — the setValues in the OCR path runs
  // *before* our fields would otherwise get to the DOM; setting them here
  // (with autoContextKeys marking the Drink * fields as guesses) matches
  // exactly how the OCR flow leaves the form on a fresh capture.
  setValues(withAutoContext(draft.fields || {}), autoContextKeys());
}

async function discardDraft(id) {
  await removeDraft(id);
  if (state.draftId === id) state.draftId = null;
  renderDraftsCard();
}

/** Render the Drafts card on the home screen: hide it entirely when empty,
 *  otherwise one row per draft with a resume button and a discard × . */
async function renderDraftsCard() {
  const card = $('#drafts-card');
  const list = $('#drafts-list');
  if (!card || !list) return;

  let drafts;
  try {
    drafts = await listDrafts();
  } catch {
    drafts = [];
  }
  if (!drafts.length) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  list.textContent = '';
  for (const draft of drafts) {
    list.append(renderDraftRow(draft));
  }
}

function renderDraftRow(draft) {
  const row = document.createElement('div');
  row.className = 'draft-row';

  const resume = document.createElement('button');
  resume.type = 'button';
  resume.className = 'draft-resume';
  resume.append(nameLine(draft.title), whenLine(draft.updatedAt));
  resume.addEventListener('click', () => resumeDraft(draft.id));

  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'draft-discard';
  discard.setAttribute('aria-label', `Discard draft ${draft.title}`);
  discard.textContent = '×';
  discard.addEventListener('click', async () => {
    // A tap is cheap to undo (retake the photo) but not free — a confirm
    // stops a slipped finger from erasing a bottle mid-edit.
    if (confirm(`Discard the draft “${draft.title}”?`)) await discardDraft(draft.id);
  });

  row.append(resume, discard);
  return row;
}

function nameLine(title) {
  const span = document.createElement('span');
  span.className = 'draft-name';
  span.textContent = title;
  return span;
}

function whenLine(timestamp) {
  const span = document.createElement('span');
  span.className = 'draft-when';
  span.textContent = relativeTime(timestamp);
  return span;
}

/** A short "3 minutes ago" / "yesterday" without loading a whole date
 *  library — the drafts list is the only place this is needed and its
 *  precision doesn't have to be exact, only readable at a glance. */
function relativeTime(then) {
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

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
  scheduleDraftSave();
}

/* ── Back label ─────────────────────────────────────────────────────── */

let backUrl = null;

function updateBackThumb() {
  const image = $('#thumb-back');
  const addButton = $('#btn-add-back');
  const removeButton = $('#btn-remove-back');
  const caption = $('#back-caption');

  if (backUrl) { URL.revokeObjectURL(backUrl); backUrl = null; }

  if (state.backFlattened && state.backFlattened.blob) {
    backUrl = URL.createObjectURL(state.backFlattened.blob);
    image.src = backUrl;
    image.hidden = false;
    addButton.hidden = true;
    removeButton.hidden = false;
    caption.hidden = false;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
    addButton.hidden = false;
    removeButton.hidden = true;
    caption.hidden = true;
  }
}

function removeBackLabel() {
  if (state.backLabelBitmap) state.backLabelBitmap.close();
  state.backLabelBitmap = null;
  state.backLabelBlob = null;
  state.backCropPoints = null;
  state.backFlattened = null;
  state.backOcrText = '';
  state.backOcrLines = [];
  updateBackThumb();
  scheduleDraftSave();
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

const SAVED_TITLES = {
  vault: 'Saved to your vault',
  quickadd: 'Note sent to Obsidian',
  download: 'Downloaded',
};

/**
 * The bottle goes over in one parcel on one tap, so there is nothing to do
 * here when it lands — this is only the recovery. A clipboard write can be
 * refused when the tap that started the save has already expired, which
 * leaves the parcel built but unsent; rather than lose it, offer it again as
 * its own tap, which carries its own fresh permission to write.
 */
function renderUnsent(result) {
  const panel = $('#saved-retry');
  panel.hidden = result.mode !== 'quickadd' || result.sent !== false;
  if (panel.hidden) return;

  const button = $('#btn-saved-retry');
  button.disabled = false;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(result.payload);
      launchUri(result.uri);
      // The retry landed — the draft this bottle came from can go now,
      // same as if the first send had succeeded.
      if (state.draftId) {
        const id = state.draftId;
        state.draftId = null;
        await removeDraft(id).catch(() => {});
      }
    } catch (err) {
      toast(`Could not send it: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  };
}

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
      backLabelBlob: state.backFlattened ? state.backFlattened.blob : null,
      foodBlob: state.foodBlob,
      ocrText: [state.ocrText, state.backOcrText].filter(Boolean).join('\n\n'),
    });

    $('#saved-title').textContent = result.sent === false
      ? 'Not sent yet'
      : SAVED_TITLES[result.mode] || 'Saved';
    $('#saved-path').textContent = result.path;
    if (result.reduced) toast('A photo was compressed a little to fit the clipboard.');
    renderUnsent(result);
    // Drop the draft only once the bottle really left — a refused clipboard
    // (sent === false) still has the parcel in memory and offers a retry,
    // so the draft has to stay until either that retry succeeds or the
    // user discards it by hand from the home screen.
    if (state.draftId && result.sent !== false) {
      const id = state.draftId;
      state.draftId = null;
      await removeDraft(id).catch(() => {});
    }
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

/* Two backends, one card: the folder picker Chromium's File System Access
 * API gives us, or firing Obsidian's QuickAdd plugin by URI for a vault
 * that sits somewhere a folder picker cannot reach at all — Android's own
 * per-app "App Storage", say. Whichever the user last chose is what
 * `save()` actually uses (see connection.js); this section only draws
 * whichever one is currently selected. */

const vaultDot = $('#vault-dot');
const vaultStatus = $('#vault-status');
const vaultButton = $('#btn-connect-vault');
const modeButton = $('#btn-vault-mode');
const quickaddForm = $('#quickadd-form');
const qaVault = $('#qa-vault');
const qaChoice = $('#qa-choice');

function readQuickAddForm() {
  return { vault: qaVault.value.trim(), choice: qaChoice.value.trim() };
}

function renderCard(card) {
  vaultDot.dataset.state = card.dot;
  vaultStatus.textContent = card.text;
  if (card.button) {
    [vaultButton.textContent, vaultButton.dataset.action] = card.button;
    vaultButton.hidden = false;
  } else {
    vaultButton.hidden = true;
  }
}

async function renderVaultCard() {
  const mode = getMode();
  quickaddForm.hidden = mode !== 'quickadd';
  modeButton.textContent = mode === 'quickadd'
    ? 'Use a folder instead'
    : "Use Obsidian's QuickAdd instead";

  // The gear icon on the home screen carries a small dot when the vault
  // still needs attention — a first-run user who hasn't set anything up,
  // or a Chromium session whose permission has lapsed. Kept in step with
  // whatever the vault card itself would say, so the two never disagree.
  refreshSettingsBadge();

  if (mode === 'quickadd') {
    quickaddForm.insertAdjacentElement('afterend', vaultButton);
    const config = quickadd.getConfig();
    if (config) {
      qaVault.value = config.vault || '';
      qaChoice.value = config.choice || '';
    }
    renderCard(quickadd.isConfigured()
      ? {
        dot: 'ok',
        text: `Set up for “${config.vault}”. Saving sends the note and its photos over in one tap.`,
        button: ['Save connection', 'save-quickadd'],
      }
      : {
        dot: 'warn',
        text: 'Fill in your vault name and the name of your QuickAdd macro below, then save.',
        button: ['Save connection', 'save-quickadd'],
      });
    return;
  }

  vaultStatus.insertAdjacentElement('afterend', vaultButton);
  const state = await vault.status();
  renderCard(vault.describe(state, vault.getVaultName()));
}

/**
 * A dot on the gear when the app is not yet in a state where Save to
 * vault would actually reach a vault. Two paths: QuickAdd mode needs a
 * saved config, folder mode needs a granted directory handle. Anything
 * else — no vault chosen, permission lapsed, browser without the API —
 * is unresolved and gets the badge.
 */
async function refreshSettingsBadge() {
  const badge = $('#settings-badge');
  if (!badge) return;
  let needsAttention = true;
  try {
    if (getMode() === 'quickadd') {
      needsAttention = !quickadd.isConfigured();
    } else {
      needsAttention = (await vault.status()) !== 'granted';
    }
  } catch {
    needsAttention = true;
  }
  badge.hidden = !needsAttention;
}

async function onVaultButton() {
  if (getMode() === 'quickadd') {
    const config = readQuickAddForm();
    if (!config.vault || !config.choice) {
      toast('Fill in both fields first.');
      return;
    }
    quickadd.setConfig(config);
    toast('Saved.');
    renderVaultCard();
    return;
  }

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

modeButton.addEventListener('click', () => {
  setMode(getMode() === 'quickadd' ? 'folder' : 'quickadd');
  renderVaultCard();
});

/* ── Folders ────────────────────────────────────────────────────────── */

const notesFolderInput = $('#notes-folder');
const attachmentsFolderInput = $('#attachments-folder');

function renderFoldersCard() {
  const folders = getFolders();
  notesFolderInput.value = folders.notes;
  attachmentsFolderInput.value = folders.attachments;
}

$('#btn-save-folders').addEventListener('click', () => {
  const saved = setFolders({
    notes: notesFolderInput.value,
    attachments: attachmentsFolderInput.value,
  });
  renderFoldersCard();
  toast(`Saved. Notes go to “${saved.notes}”, photos to “${saved.attachments}”.`);
});

/* Split by screen: home shows drafts + the gear's setup badge (which
 * depends on vault status), settings shows the vault card, the folders
 * card, and lets the OCR card refresh itself. */
onEnter('home', () => { renderDraftsCard(); refreshSettingsBadge(); });
onEnter('settings', () => { renderVaultCard(); renderFoldersCard(); });

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
$('#btn-settings').addEventListener('click', () => go('settings'));
$('#btn-settings-back').addEventListener('click', goBack);
$('#btn-capture-back').addEventListener('click', goBack);
$('#btn-crop-back').addEventListener('click', goBack);
$('#btn-crop-done').addEventListener('click', flattenAndReview);
$('#btn-review-back').addEventListener('click', goBack);
ocrCacheBtn.addEventListener('click', () => {
  ocrCacheBtn.hidden = true;
  toast('Downloading the recognition engine…');
  messageServiceWorker({ type: 'cache-ocr', langs: getLanguages() });
});

vaultButton.addEventListener('click', onVaultButton);
$('#btn-add-food').addEventListener('click', () => go('capture', 'food'));
$('#btn-remove-food').addEventListener('click', removeFoodPhoto);
$('#btn-add-back').addEventListener('click', () => go('capture', 'back'));
$('#btn-remove-back').addEventListener('click', removeBackLabel);
$('#btn-save').addEventListener('click', saveBottle);
$('#thumb-label').addEventListener('click', (event) => enlarge(event.currentTarget));
$('#thumb-back').addEventListener('click', (event) => enlarge(event.currentTarget));
$('#thumb-food').addEventListener('click', (event) => enlarge(event.currentTarget));
// A distinct arg, not a bare `go('crop')` — this crop screen was reached from
// review, not from capture, so it needs its own place in the stack rather
// than jumping back to the original crop entry (which would leave review
// unreachable by back and land two steps too far on a phone/camera).
$('#btn-edit-label').addEventListener('click', () => go('crop', 'edit'));
$('#btn-edit-back').addEventListener('click', () => go('crop', 'back-edit'));
$('#lightbox').addEventListener('click', dismissOverlay);

registerServiceWorker();
vault.restore().then(renderVaultCard);
go('home');

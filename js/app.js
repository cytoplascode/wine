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
  archiveBottle, listArchive, getArchive, removeArchive, ARCHIVE_LIMIT,
} from './archive.js';
import { sharedGet, sharedClear } from './idb.js';
import { readCaptureDate, readCaptureLocation, localIsoDate } from './exif.js';
import {
  LANGUAGES, MAX_ACTIVE, getLanguages, setLanguages, toTesseractLangs, totalMegabytes,
} from './languages.js';
import { ENGINES, getEngine, setEngine } from './engine.js';
import { startViewportWatch } from './viewport.js';
import { threadCount } from './ppocr.js';

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

/** Tesseract reports machine statuses that PHASES translates; PP-OCR
 *  reports a sentence ready to show. */
function progressLabel(m, engine) {
  if (engine === 'ppocr') return m.status || 'Working…';
  return PHASES[m.status] || 'Working…';
}

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
  renderRawText();
  showOcrProgress(0, 'Starting the recognition engine…');
  try {
    const engine = getEngine();
    const result = await ocr.recognize(state.flattened.canvas, (m) => {
      showOcrProgress(m.progress || 0, progressLabel(m, engine));
    }, toTesseractLangs(getLanguages()), engine);
    state.ocrText = result.text;
    state.ocrLines = result.lines;
    renderRawText();

    const { fields, auto } = parseLabel(result);
    state.fields = fields;
    setValues(withAutoContext({ ...emptyRecord(), ...fields }), [...auto, ...autoContextKeys()]);
    scheduleDraftSave();
  } catch (err) {
    renderRawText();
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
 * Rebuild the raw-text panel from what's currently in state. Called on every
 * review-screen entry so a resumed draft (or a switch between bottles) shows
 * *this* bottle's lines instead of whatever the previous bottle's OCR left in
 * the DOM, and after each OCR pass so the panel picks up newly recognised
 * lines. Confidence numbers are left off — the panel is what users copy from,
 * and "85%  " prefixes make paste unusable.
 */
function renderRawText() {
  const panel = $('#raw-text');
  if (!panel) return;
  const front = (state.ocrLines || []).map((l) => l.text).join('\n');
  const back = (state.backOcrLines || []).map((l) => l.text).join('\n');
  const parts = [];
  if (front) parts.push(front);
  if (back) parts.push(`— Back label —\n${back}`);
  if (parts.length) {
    panel.textContent = parts.join('\n\n');
  } else if (state.ocrText === '' && state.flattened) {
    // Fresh flatten, OCR has not run yet — leave the panel empty rather than
    // stamping "(nothing was recognised)" before the engine even ran.
    panel.textContent = '';
  } else {
    panel.textContent = state.flattened ? '(nothing was recognised)' : '';
  }
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
    }, toTesseractLangs(getLanguages()), getEngine());
    state.backOcrText = result.text;
    state.backOcrLines = result.lines;
    renderRawText();

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
  // Rebuild the raw-text panel from THIS bottle's state before OCR maybe
  // fires — otherwise a resumed draft shows the previous bottle's lines (which
  // the DOM still holds from that session) until the OCR guard clears them,
  // and a resumed draft never fires OCR at all.
  renderRawText();
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

/** The full review-screen state as a plain object, ready to be written to a
 *  draft or an archive row. Photos as blobs, form values, OCR text — enough
 *  to rebuild the review screen exactly. */
function currentSnapshot() {
  return {
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
    fields: readValues(),
  };
}

async function saveDraftNow() {
  if (!state.flattened || !state.flattened.blob) return;
  if (!state.draftId) state.draftId = newDraftId();

  const snapshot = currentSnapshot();

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

/** Rebuild the full review-screen state from a stored snapshot (draft or
 *  archive row). Then jumps to review. Whether the resulting review edits
 *  auto-save back to the ORIGINAL row is the caller's decision, via
 *  `state.draftId` — pass the id to keep saving into that draft, pass null
 *  to let the review screen mint a fresh draft on the next save. */
async function restoreSnapshot(snapshot, draftId) {
  resetCapture();
  state.draftId = draftId;
  state.labelBlob = snapshot.labelBlob || null;
  if (snapshot.labelBlob) {
    // A source blob is only there if the snapshot was written by a build
    // that stored one; older ones just have the flattened. Rebuild the
    // bitmap so the pencil-to-recrop workflow still lands on the source.
    try { state.labelBitmap = await createImageBitmap(snapshot.labelBlob); } catch {
      // Corrupt blob or a browser mid-refresh — fall back to the flattened
      // as the source. Crops from here will be crops of the flattened,
      // which is a small regression but never a data loss.
      state.labelBitmap = await createImageBitmap(snapshot.flattenedBlob);
    }
  } else {
    state.labelBitmap = await createImageBitmap(snapshot.flattenedBlob);
  }
  state.flattened = { blob: snapshot.flattenedBlob, canvas: null };
  state.foodBlob = snapshot.foodBlob || null;
  state.ocrText = snapshot.ocrText || '';
  state.ocrLines = snapshot.ocrLines || [];
  state.cropPoints = snapshot.cropPoints || null;
  state.labelDate = snapshot.labelDate || null;
  state.labelLocation = snapshot.labelLocation || null;
  state.labelCity = snapshot.labelCity || null;
  state.labelCountry = snapshot.labelCountry || null;
  state.fields = snapshot.fields || {};

  // Back label — everything is optional; a snapshot written by an older
  // build simply has none of these keys, and the review screen behaves as
  // if the user never added one.
  state.backLabelBlob = snapshot.backLabelBlob || null;
  state.backCropPoints = snapshot.backCropPoints || null;
  state.backOcrText = snapshot.backOcrText || '';
  state.backOcrLines = snapshot.backOcrLines || [];
  if (snapshot.backFlattenedBlob) {
    state.backFlattened = { blob: snapshot.backFlattenedBlob, canvas: null };
    if (snapshot.backLabelBlob) {
      try { state.backLabelBitmap = await createImageBitmap(snapshot.backLabelBlob); } catch {
        state.backLabelBitmap = await createImageBitmap(snapshot.backFlattenedBlob);
      }
    } else {
      state.backLabelBitmap = await createImageBitmap(snapshot.backFlattenedBlob);
    }
  }

  // Point the review-screen thumbnail at the flattened image directly
  // (runOcr won't run for this pass, so its usual side effect that sets
  // the thumbnail via labelUrl doesn't fire).
  if (labelUrl) URL.revokeObjectURL(labelUrl);
  labelUrl = URL.createObjectURL(snapshot.flattenedBlob);
  $('#thumb-label').src = labelUrl;

  go('review');
  // Restore the form after render — the setValues in the OCR path runs
  // *before* our fields would otherwise get to the DOM; setting them here
  // (with autoContextKeys marking the Drink * fields as guesses) matches
  // exactly how the OCR flow leaves the form on a fresh capture.
  setValues(withAutoContext(snapshot.fields || {}), autoContextKeys());
}

/** Resume a draft: rebuild the review-screen state from an IndexedDB row
 *  and jump to review. Skips OCR — the stored `ocrText` is already the
 *  guard `runOcr` checks against, so the OCR pass sees "already done"
 *  and moves on, saving several seconds and an engine warm-up. */
async function resumeDraft(id) {
  const draft = await getDraft(id);
  if (!draft) return;
  await restoreSnapshot(draft, id);
}

/** Reopen a sent bottle from the archive. Starts a fresh draft cycle, so a
 *  re-send lands as a new draft and (if it succeeds) a new archive entry —
 *  the original archive row stays put as a record of the earlier send until
 *  the user discards it. */
async function reopenArchived(id) {
  const row = await getArchive(id);
  if (!row) return;
  await restoreSnapshot(row, null);
}

async function discardDraft(id) {
  await removeDraft(id);
  if (state.draftId === id) state.draftId = null;
  renderDraftsCard();
}

async function discardArchived(id) {
  await removeArchive(id);
  renderRecentCard();
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
  resume.append(thumbnail(draft.flattenedBlob), textColumn(draft));
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

/** Render the Recent-sends card on the home screen: hides itself when the
 *  archive is empty, otherwise a compact collapsed list of the bottles
 *  already sent to the vault. Tapping a row reopens it in review for a
 *  potential re-send. */
async function renderRecentCard() {
  const card = $('#recent-card');
  const list = $('#recent-list');
  const count = $('#recent-count');
  if (!card || !list) return;

  let rows;
  try {
    rows = await listArchive();
  } catch {
    rows = [];
  }
  if (!rows.length) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  if (count) {
    count.textContent = rows.length === ARCHIVE_LIMIT
      ? `${rows.length} (max)`
      : String(rows.length);
  }
  list.textContent = '';
  for (const row of rows) list.append(renderArchiveRow(row));
}

function renderArchiveRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'draft-row';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'draft-resume';
  open.append(thumbnail(row.flattenedBlob), textColumn({
    title: row.title,
    updatedAt: row.sentAt,     // "sent 3 mins ago" reads the same way
  }));
  open.addEventListener('click', () => reopenArchived(row.id));

  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'draft-discard';
  discard.setAttribute('aria-label', `Remove ${row.title} from recent`);
  discard.textContent = '×';
  discard.addEventListener('click', async () => {
    if (confirm(`Remove “${row.title}” from Recent?`)) await discardArchived(row.id);
  });

  wrap.append(open, discard);
  return wrap;
}

function textColumn(draft) {
  const col = document.createElement('span');
  col.className = 'draft-text';
  col.append(nameLine(draft.title), whenLine(draft.updatedAt));
  return col;
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

/* A small preview of the flattened label so the row's identity is obvious
 * even before its title is read. Two hands to release: the object URL
 * (revoked when the image detaches, so a rebuilt list doesn't leak N URLs
 * per redraw), and a fallback when the draft has no flattened blob for any
 * reason — a plain grape emoji rather than a broken-image icon. */
function thumbnail(blob) {
  const img = document.createElement('img');
  img.className = 'draft-thumb';
  img.alt = '';
  if (!blob) {
    img.classList.add('draft-thumb-empty');
    img.setAttribute('aria-hidden', 'true');
    return img;
  }
  const url = URL.createObjectURL(blob);
  img.src = url;
  // Revoke once the browser is finished with the URL — the load event fires
  // after the image is decoded, which is when the URL is no longer needed.
  img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
  img.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
  return img;
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
      // Archive the bottle for safety-net purposes and drop the draft — same
      // as if the first send had succeeded.
      await archiveBottle(currentSnapshot()).catch(() => {});
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
    if (result.sent !== false) {
      // Copy the bottle into the archive first, so a vault that quietly
      // dropped the note still leaves the phone with the bottle. Falls off
      // the tail of the ring on the next save.
      await archiveBottle(currentSnapshot()).catch(() => {});
      if (state.draftId) {
        const id = state.draftId;
        state.draftId = null;
        await removeDraft(id).catch(() => {});
      }
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
onEnter('home', () => { renderDraftsCard(); renderRecentCard(); refreshSettingsBadge(); });
onEnter('settings', () => { renderVaultCard(); renderFoldersCard(); });

/* ── Offline OCR status ─────────────────────────────────────────────── */

const ocrDot = $('#ocr-dot');
const ocrStatus = $('#ocr-status');
const ocrBar = $('#ocr-bar');
const ocrCacheBtn = $('#btn-cache-ocr');

/** What the service worker needs to know to answer for the current engine. */
const ocrRequest = (type) => ({ type, langs: getLanguages(), engine: getEngine() });

function renderOcrProgress({ engine, done, total, complete, error }) {
  // A report about the other engine — the answer to a status request sent
  // before the user switched — must not repaint the card for this one.
  if (engine && engine !== getEngine()) return;
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
    const threads = getEngine() === 'ppocr' ? threadCount() : 1;
    ocrStatus.textContent = threads > 1
      ? `Ready — recognition runs on this phone, offline, on ${threads} cores.`
      : 'Ready — recognition runs on this phone, offline.';
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

function renderEngineChips() {
  const chips = $('#engine-chips');
  const current = getEngine();
  chips.textContent = '';

  for (const engine of ENGINES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = engine.label;
    button.setAttribute('aria-pressed', String(engine.code === current));
    button.addEventListener('click', () => {
      if (engine.code === current) return;
      setEngine(engine.code);
      renderEngineChips();
      renderLanguageChips();
      messageServiceWorker(ocrRequest('ocr-status'));
    });
    chips.append(button);
  }

  const chosen = ENGINES.find((e) => e.code === current);
  $('#engine-hint').textContent = chosen.mb
    ? `${chosen.hint} ${chosen.mb} MB, downloaded once.`
    : chosen.hint;
}

function renderLanguageChips() {
  const chips = $('#language-chips');
  const chosen = getLanguages();
  chips.textContent = '';
  // Language packs are Tesseract's; PP-OCR ships one recogniser.
  const tesseract = getEngine() === 'tesseract';
  chips.hidden = !tesseract;
  $('#language-hint').hidden = !tesseract;

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
      messageServiceWorker(ocrRequest('ocr-status'));
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
  // The worker adds the cross-origin-isolation headers that let recognition
  // use several cores, but only to pages it serves — this one, on a first
  // visit or right after an update, was served without them. Reload once
  // the moment the worker takes control, before the user has done anything;
  // a page that arrived through the share sheet is left alone, since its
  // photo is being picked up right now. The flag stops any loop.
  if (!crossOriginIsolated && !new URLSearchParams(location.search).get('share')) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // An update that activates while the app is in use also fires this;
      // reloading then would pull the screen out from under the user.
      if (performance.now() > 5000) return;
      let done = false;
      try { done = sessionStorage.getItem('coi-reload') === '1'; } catch { /* fine */ }
      if (done) return;
      try { sessionStorage.setItem('coi-reload', '1'); } catch { /* fine */ }
      location.reload();
    });
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    messageServiceWorker(ocrRequest('ocr-status'));
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

startViewportWatch();
initCapture({ onPhoto: handlePhoto });
crop.initCrop();
buildForm();
initFieldDrag();
renderEngineChips();
renderLanguageChips();

$('#btn-new-bottle').addEventListener('click', newBottle);
$('#btn-another').addEventListener('click', newBottle);
$('#btn-home').addEventListener('click', () => go('home'));
$('#btn-settings').addEventListener('click', () => go('settings'));
$('#btn-settings-back').addEventListener('click', goBack);
$('#btn-capture-back').addEventListener('click', goBack);
$('#btn-crop-back').addEventListener('click', goBack);
$('#btn-crop-done').addEventListener('click', flattenAndReview);
// The review screen is a "wine page" — leaving it goes home, never back to
// the capture-and-crop trail that led to it. Re-cropping is done through the
// pencil on the review screen itself; back is for closing this wine.
$('#btn-review-back').addEventListener('click', () => go('home'));
ocrCacheBtn.addEventListener('click', () => {
  ocrCacheBtn.hidden = true;
  toast('Downloading the recognition engine…');
  messageServiceWorker(ocrRequest('cache-ocr'));
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

/* ── Share target ───────────────────────────────────────────────────── */

/* Android's share sheet POSTs the image to `./share/`; the service worker
 * intercepts it, stashes the file in IndexedDB under key 'pending', and
 * redirects here with `?share=1`. Pick it up now, then clear it — reading
 * before clearing means a browser reload doesn't lose the shared photo
 * either, and the ?share flag is what tells us to look. */
async function pickUpSharedFile() {
  if (!new URLSearchParams(location.search).get('share')) return;
  // Strip the flag so a reload doesn't try to consume the same file twice
  // (the row is already gone by then; the query would just be noise).
  const url = new URL(location.href);
  url.searchParams.delete('share');
  history.replaceState(null, '', url.pathname + url.search + url.hash);

  let file;
  try {
    file = await sharedGet();
  } catch {
    return;
  }
  if (!file) return;
  sharedClear().catch(() => {});

  try {
    const [bitmap, capturedOn, location_] = await Promise.all([
      createImageBitmap(file, { imageOrientation: 'from-image' }),
      readCaptureDate(file),
      readCaptureLocation(file),
    ]);
    resetCapture();
    handlePhoto(bitmap, 'label', capturedOn || localIsoDate(), location_, file);
  } catch (err) {
    toast(`That shared image could not be opened: ${err.message}`);
  }
}

pickUpSharedFile();

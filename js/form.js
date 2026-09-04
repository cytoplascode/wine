/* The review form, generated from the Wine schema so the vault's field list
 * never has to be repeated in markup. */

import { $ } from './ui.js';
import { GROUPS, EDITABLE_FIELDS, emptyRecord, fieldLabel } from './schema.js';

const TASTING_NOTE_KEY = 'tastingNote';

export function buildForm() {
  const form = $('#wine-form');
  form.textContent = '';

  for (const field of EDITABLE_FIELDS.filter((f) => f.group === 'main')) {
    form.append(renderField(field));
  }

  // Visible, not folded behind a summary — a second "Tasting note" heading
  // above the field's own label read as a mistake, and it is filled in often
  // enough that hiding it a tap away was the wrong trade.
  form.append(renderTastingNote());

  for (const group of GROUPS) {
    const fields = EDITABLE_FIELDS.filter((f) => f.group === group.id);
    if (fields.length) form.append(renderGroup(group.title, fields.map(renderField)));
  }
}

function renderGroup(title, children) {
  const details = document.createElement('details');
  details.className = 'group';

  const summary = document.createElement('summary');
  summary.textContent = title;
  details.append(summary);

  const body = document.createElement('div');
  body.append(...children);
  details.append(body);
  return details;
}

function renderField(field) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  wrapper.dataset.field = field.key;

  const id = `f-${field.key.replace(/\s+/g, '-')}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.append(document.createTextNode(fieldLabel(field)));

  if (field.auto) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = 'AUTO';
    chip.hidden = true;
    chip.dataset.chipFor = field.key;
    label.append(chip);
  }
  wrapper.append(label);

  let input;
  if (field.type === 'select') {
    input = document.createElement('select');
    for (const option of field.options) {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = option;
      input.append(el);
    }
  } else {
    input = document.createElement('input');
    input.type = field.type === 'number' ? 'number'
      : field.type === 'date' ? 'date'
      : field.type === 'url' ? 'url'
      : 'text';
    if (field.step) input.step = field.step;
    if (field.inputMode) input.inputMode = field.inputMode;
    if (field.suggestions) attachPicker(input, field.suggestions, wrapper);
  }

  input.id = id;
  input.name = field.key;
  input.dataset.key = field.key;
  wrapper.append(input);

  // A dropdown that only cannot be dragged out of; the value still belongs to
  // its own box.
  if (input.tagName !== 'SELECT') addGrip(wrapper, fieldLabel(field));

  input.addEventListener('input', () => {
    markManual(field.key);          // any hand edit clears the "guessed" marker
    refreshGrip(wrapper);
  });
  return wrapper;
}

/**
 * A short pick list under the field, standing in for `<input list>` +
 * `<datalist>`. That native pairing looked wrong on Android Chrome in three
 * ways at once — the popup renders in the browser's own colours, not the
 * app's; a browser-drawn indicator stacks with the arrow already added for
 * this field, so it shows two; and once a value is picked, choosing a
 * different one means clearing the text first, since the popup only offers
 * completions of whatever is already typed. A plain custom list sidesteps
 * all three: it is themed like the rest of the app, draws nothing of its
 * own, and reopens on every tap regardless of the field's current value —
 * typing something outside the list is still just typing.
 */
function attachPicker(input, values, wrapper) {
  const list = document.createElement('div');
  list.className = 'suggest';
  list.hidden = true;

  for (const value of values) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'suggest-option';
    option.textContent = value;
    // pointerdown, not click: preventDefault here stops the input from
    // blurring, so picking a value never has to fight the keyboard closing
    // or the list disappearing out from under the tap.
    option.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      list.hidden = true;
    });
    list.append(option);
  }

  const open = () => { list.hidden = false; };
  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('blur', () => { list.hidden = true; });

  wrapper.append(list);
  wrapper.classList.add('field-list');
}

/* ── Drag grips ─────────────────────────────────────────────────────── */

/** The handle for dragging this field's value into another field. It appears
 *  only when there is something to drag. */
function addGrip(wrapper, name) {
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'grip';
  grip.textContent = '⠿';
  grip.hidden = true;
  grip.setAttribute('aria-label', `Move ${name} to another field`);
  wrapper.append(grip);
}

function refreshGrip(wrapper) {
  const grip = wrapper.querySelector('.grip');
  const input = wrapper.querySelector('input, textarea');
  if (grip && input) grip.hidden = !input.value.trim();
}

const refreshGrips = () => $('#wine-form').querySelectorAll('.field').forEach(refreshGrip);

function renderTastingNote() {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';

  const id = 'f-tasting-note';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = 'Tasting note';

  const textarea = document.createElement('textarea');
  textarea.id = id;
  textarea.name = TASTING_NOTE_KEY;
  textarea.dataset.key = TASTING_NOTE_KEY;
  textarea.rows = 4;
  textarea.placeholder = 'How was it?';

  wrapper.dataset.field = TASTING_NOTE_KEY;
  wrapper.append(label, textarea);
  addGrip(wrapper, 'the tasting note');
  textarea.addEventListener('input', () => refreshGrip(wrapper));
  return wrapper;
}

function markManual(key) {
  const chip = $(`#wine-form [data-chip-for="${CSS.escape(key)}"]`);
  if (chip) chip.hidden = true;
}

/**
 * Fill the form. `autoKeys` marks which values came from OCR rather than the
 * user, so a guess is visibly a guess.
 */
export function setValues(record, autoKeys = []) {
  const auto = new Set(autoKeys);

  for (const field of EDITABLE_FIELDS) {
    const input = $(`#wine-form [data-key="${CSS.escape(field.key)}"]`);
    if (!input) continue;
    input.value = record[field.key] ?? field.default ?? '';

    const chip = $(`#wine-form [data-chip-for="${CSS.escape(field.key)}"]`);
    if (chip) {
      chip.hidden = !auto.has(field.key);
      // A guess hidden behind an unopened fold is not visibly a guess — Drink
      // date filling in inside the collapsed Rating section is invisible
      // otherwise, and "where did it go" is a worse outcome than an
      // already-open section.
      if (!chip.hidden) chip.closest('details.group')?.setAttribute('open', '');
    }
  }

  const note = $(`#wine-form [data-key="${TASTING_NOTE_KEY}"]`);
  if (note) note.value = record[TASTING_NOTE_KEY] || '';

  refreshGrips();
}

/**
 * Fill in one field's guess after the form is already showing — a result
 * that arrived later than the rest, such as a reverse-geocoded place name
 * that took a network round trip. Only touches that one field, and only
 * while it is still blank, so it can never overwrite something the user
 * typed elsewhere, or into this field itself, while the guess was in flight.
 */
export function patchIfEmpty(key, value) {
  if (!value) return;
  const wrapper = $(`#wine-form [data-field="${CSS.escape(key)}"]`);
  if (!wrapper) return;
  const input = wrapper.querySelector('[data-key]');
  if (!input || input.value.trim()) return;

  input.value = value;
  const chip = wrapper.querySelector('.chip');
  if (chip) {
    chip.hidden = false;
    chip.closest('details.group')?.setAttribute('open', '');
  }
  refreshGrip(wrapper);
}

/** Read the form back into a record, plus the tasting note. */
export function readValues() {
  const record = emptyRecord();

  for (const field of EDITABLE_FIELDS) {
    const input = $(`#wine-form [data-key="${CSS.escape(field.key)}"]`);
    if (input) record[field.key] = input.value.trim();
  }

  const note = $(`#wine-form [data-key="${TASTING_NOTE_KEY}"]`);
  record[TASTING_NOTE_KEY] = note ? note.value.trim() : '';
  return record;
}

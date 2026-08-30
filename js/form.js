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

  for (const group of GROUPS) {
    const fields = EDITABLE_FIELDS.filter((f) => f.group === group.id);
    if (group.id === 'note') {
      form.append(renderGroup(group.title, [renderTastingNote()]));
    } else if (fields.length) {
      form.append(renderGroup(group.title, fields.map(renderField)));
    }
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

  const id = `f-${field.key.replace(/\s+/g, '-')}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.append(document.createTextNode(fieldLabel(field)));

  if (field.ocr) {
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
    if (field.suggestions) attachSuggestions(input, id, field.suggestions, wrapper);
  }

  input.id = id;
  input.name = field.key;
  input.dataset.key = field.key;
  wrapper.append(input);

  // Any hand edit clears the "this was guessed" marker.
  input.addEventListener('input', () => markManual(field.key));
  return wrapper;
}

function attachSuggestions(input, id, values, wrapper) {
  const list = document.createElement('datalist');
  list.id = `${id}-options`;
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    list.append(option);
  }
  input.setAttribute('list', list.id);
  wrapper.append(list);
}

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

  wrapper.append(label, textarea);
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
    if (chip) chip.hidden = !auto.has(field.key);
  }

  const note = $(`#wine-form [data-key="${TASTING_NOTE_KEY}"]`);
  if (note) note.value = record[TASTING_NOTE_KEY] || '';
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

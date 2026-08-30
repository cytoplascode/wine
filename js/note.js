/* Turning a filled-in record into the markdown file and its filename.
 *
 * The frontmatter is written from the schema, in schema order, with every key
 * present whether or not it has a value — that is what the vault's fileClass
 * expects, and a Base query breaks on any drift. Pure: no DOM, no file system.
 */

import { WINE_FIELDS, composeName } from './schema.js';

const FALLBACK_NAME = 'Untitled wine';
const MAX_BASENAME = 120;

/** Characters no common filesystem accepts, plus the control range. */
const ILLEGAL = /[<>:\"/\\|?*\x00-\x1f]/g;

/**
 * A filename for the note, from the composed `Name`.
 * Accents survive — Obsidian handles them and the note title should read
 * properly — but path characters do not.
 */
export function noteBasename(record) {
  const cleaned = composeName(record)
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')       // a leading dot would hide the file
    .replace(/[. ]+$/, '')     // Windows drops trailing dots and spaces
    .slice(0, MAX_BASENAME)
    .trim();

  return cleaned || FALLBACK_NAME;
}

/**
 * The same name with accents folded away and anything still non-ASCII dropped.
 * Only for file systems that refuse to store the real thing.
 */
export function asciiBasename(base) {
  const folded = base
    .normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return folded || FALLBACK_NAME;
}

/**
 * First free name in the `base`, `base 2`, `base 3` sequence — the convention
 * Obsidian itself uses. `taken` is an async predicate over the basename.
 */
export async function uniqueBasename(base, taken) {
  if (!(await taken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error('Too many notes with that name');
}

const escapeYaml = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** One frontmatter line, honouring the field's emit rule and resting default. */
function emitField(field, record) {
  if (field.emit === 'literal') return `${field.key}: ${field.value}`;

  const raw = field.computed ? composeName(record) : record[field.key];
  const value = String(raw ?? '').trim() || field.default || '';

  if (!value) return `${field.key}:`;
  return field.emit === 'quoted'
    ? `${field.key}: "${escapeYaml(value)}"`
    : `${field.key}: ${value}`;
}

export function buildFrontmatter(record) {
  return WINE_FIELDS.map((field) => emitField(field, record)).join('\n');
}

/**
 * The whole note.
 *
 * `Label::` and `Food::` are inline Dataview fields under their headings, not
 * frontmatter. The raw OCR text is parked in an Obsidian `%% … %%` comment: it
 * is invisible in reading view and in Bases, but it is there when a guess turns
 * out to be wrong.
 */
export function buildNote({ record, basename, hasFood = false, ocrText = '' }) {
  const parts = [
    '---',
    buildFrontmatter(record),
    '---',
    '',
    '## Tasting note',
    (record.tastingNote || '').trim(),
    '',
    '## Label',
    `Label:: ![[${basename}.jpg]]`,
    '',
    '## Food',
    hasFood ? `Food:: ![[${basename} - food.jpg]]` : 'Food::',
    '',
  ];

  const raw = (ocrText || '').trim();
  if (raw) {
    parts.push(
      '%%',
      'Recognised label text, kept in case a field above needs correcting.',
      '',
      raw,
      '%%',
      '',
    );
  }

  return parts.join('\n');
}

export const labelFilename = (basename) => `${basename}.jpg`;
export const foodFilename = (basename) => `${basename} - food.jpg`;
export const noteFilename = (basename) => `${basename}.md`;

/* The `fileClass: Wine` schema.
 *
 * This is the single source of truth: the review form is generated from it and
 * the note's frontmatter is written from it, so the vault's field order,
 * spelling and defaults are defined in exactly one place.
 *
 * Two things here are deliberate and must not be "fixed":
 *   - `Appelation` is spelled with one l, matching the vault's existing
 *     fileClass. Correcting the spelling would break every Base query.
 *   - Every key is emitted on every note, even when empty, because that is how
 *     the template does it.
 *
 * `emit` decides how a value is serialised:
 *   literal — written verbatim, never quoted, never edited (fileClass)
 *   quoted  — "escaped string" when set, a bare `Key:` when empty
 *   bare    — written unquoted when set (numbers, dates), bare `Key:` when empty
 */

export const GROUPS = [
  { id: 'note', title: 'Tasting note' },
  { id: 'purchase', title: 'Purchase' },
  { id: 'rating', title: 'Rating' },
  { id: 'cellar', title: 'Cellar' },
];

export const TYPE_SUGGESTIONS = [
  'Red', 'White', 'Rosé', 'Orange', 'Sparkling', 'Dessert', 'Fortified',
];

export const WINE_FIELDS = [
  { key: 'fileClass', emit: 'literal', value: 'Wine' },
  { key: 'Name', emit: 'quoted', computed: true },

  { key: 'Winemaker', emit: 'quoted', group: 'main', type: 'text', ocr: true },
  { key: 'WineName', emit: 'quoted', group: 'main', type: 'text', ocr: true, label: 'Wine name' },
  { key: 'Vintage', emit: 'quoted', group: 'main', type: 'text', ocr: true, inputMode: 'numeric' },
  { key: 'Type', emit: 'quoted', group: 'main', type: 'text', ocr: true, suggestions: TYPE_SUGGESTIONS },
  { key: 'Varieties', emit: 'quoted', group: 'main', type: 'text', ocr: true },
  { key: 'Country', emit: 'quoted', group: 'main', type: 'text', ocr: true },
  { key: 'Region', emit: 'quoted', group: 'main', type: 'text', ocr: true },
  { key: 'Appelation', emit: 'quoted', group: 'main', type: 'text', ocr: true },
  { key: 'Vineyard', emit: 'quoted', group: 'main', type: 'text', ocr: true },
  { key: 'Style', emit: 'quoted', group: 'main', type: 'text' },

  { key: 'Price', emit: 'bare', group: 'purchase', type: 'number', step: '0.01' },
  { key: 'PurchaseSource', emit: 'quoted', group: 'purchase', type: 'text', label: 'Purchase source' },
  { key: 'PurchaseLink', emit: 'quoted', group: 'purchase', type: 'url', label: 'Purchase link' },
  { key: 'PurchaseCountry', emit: 'quoted', group: 'purchase', type: 'text', label: 'Purchase country' },

  // The template's resting value is the literal `--`, not an empty field.
  { key: 'Stars', emit: 'bare', group: 'rating', type: 'select', default: '--', options: ['--', '1', '2', '3', '4', '5'] },
  { key: 'ValueForMoney', emit: 'bare', group: 'rating', type: 'number', label: 'Value for money' },
  { key: 'Points', emit: 'bare', group: 'rating', type: 'number' },

  { key: 'Inventory', emit: 'bare', group: 'cellar', type: 'number', default: '0' },
  { key: 'Buy', emit: 'bare', group: 'cellar', type: 'number', default: '0' },
  { key: 'Buy date', emit: 'bare', group: 'cellar', type: 'date' },
  { key: 'Drink date', emit: 'bare', group: 'cellar', type: 'date' },
];

/** Fields the user can actually type into, in template order. */
export const EDITABLE_FIELDS = WINE_FIELDS.filter((f) => f.group);

/** Fields the OCR heuristics may populate. */
export const OCR_FIELDS = WINE_FIELDS.filter((f) => f.ocr).map((f) => f.key);

export const fieldLabel = (field) => field.label || field.key;

/** A blank record: every editable key present, at its template default. */
export function emptyRecord() {
  const record = {};
  for (const field of EDITABLE_FIELDS) record[field.key] = field.default || '';
  return record;
}

/**
 * Compose the `Name` property: "Winemaker - WineName - Vintage", skipping the
 * parts that are missing so an unknown cuvée cannot leave "X -  - 2019".
 */
export function composeName(record) {
  return [record.Winemaker, record.WineName, record.Vintage]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(' - ');
}

/* Which language packs recognition should use.
 *
 * All packs are vendored, so nothing here ever needs the network — but only the
 * chosen ones are downloaded into the offline cache, because shipping fifteen
 * megabytes to a phone that only ever scans Bordeaux would be rude.
 */

const STORAGE_KEY = 'label-scanner-languages';

/** `4.0.0_best_int` sizes, for the "what will this cost me" line in the UI. */
export const LANGUAGES = [
  { code: 'eng', label: 'English', mb: 2.8 },
  { code: 'fra', label: 'French', mb: 0.7 },
  { code: 'ita', label: 'Italian', mb: 1.6 },
  { code: 'spa', label: 'Spanish', mb: 2.0 },
  { code: 'por', label: 'Portuguese', mb: 1.3 },
  { code: 'deu', label: 'German', mb: 1.3 },
  { code: 'kat', label: 'Georgian', mb: 1.0 },
];

const CODES = new Set(LANGUAGES.map((l) => l.code));
const DEFAULT = ['eng', 'fra'];

/** Recognition slows down with each extra language, so this is a real ceiling. */
export const MAX_ACTIVE = 3;

export function getLanguages() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }

  const chosen = Array.isArray(stored) ? stored.filter((code) => CODES.has(code)) : [];
  return chosen.length ? chosen.slice(0, MAX_ACTIVE) : [...DEFAULT];
}

export function setLanguages(codes) {
  const clean = codes.filter((code) => CODES.has(code)).slice(0, MAX_ACTIVE);
  const next = clean.length ? clean : [...DEFAULT];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Private mode: the choice just will not survive a restart. */
  }
  return next;
}

/** What Tesseract wants: "eng+fra", in the order the packs were listed. */
export function toTesseractLangs(codes) {
  const order = LANGUAGES.map((l) => l.code);
  return [...codes].sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('+');
}

export const totalMegabytes = (codes) => LANGUAGES
  .filter((l) => codes.includes(l.code))
  .reduce((sum, l) => sum + l.mb, 0);

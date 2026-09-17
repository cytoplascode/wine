/* Which recognition engine to use.
 *
 * Two are vendored. PP-OCR (a text detector plus a recogniser, run by ONNX
 * Runtime on WebAssembly) reads the large display type on a label that
 * Tesseract discards, and is the default. Tesseract stays selectable: it
 * knows accents and non-Latin scripts through its language packs, which the
 * English PP-OCR recogniser does not.
 */

const STORAGE_KEY = 'label-scanner-engine';

export const ENGINES = [
  { code: 'ppocr', label: 'PP-OCR', mb: 15.7, hint: 'Reads large stylised type. Latin letters, no accents.' },
  { code: 'tesseract', label: 'Tesseract', mb: 0, hint: 'Language packs with accents and Georgian script.' },
];

const CODES = new Set(ENGINES.map((e) => e.code));
export const DEFAULT_ENGINE = 'ppocr';

export function getEngine() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  return CODES.has(stored) ? stored : DEFAULT_ENGINE;
}

export function setEngine(code) {
  const next = CODES.has(code) ? code : DEFAULT_ENGINE;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* Private mode: the choice just will not survive a restart. */
  }
  return next;
}

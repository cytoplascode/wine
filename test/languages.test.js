import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANGUAGES, MAX_ACTIVE, getLanguages, setLanguages, toTesseractLangs, totalMegabytes,
} from '../js/languages.js';

test('every pack the app offers is one the repository ships', () => {
  // Kept in step with vendor/tesseract/*.traineddata.gz by hand; if a code here
  // has no file, recognition fails at the worst possible moment.
  assert.deepEqual(
    LANGUAGES.map((l) => l.code).sort(),
    ['deu', 'eng', 'fra', 'ita', 'kat', 'por', 'spa'],
  );
});

test('Tesseract gets a plus-joined list in a stable order', () => {
  assert.equal(toTesseractLangs(['fra', 'eng']), 'eng+fra');
  assert.equal(toTesseractLangs(['kat', 'ita', 'eng']), 'eng+ita+kat');
  assert.equal(toTesseractLangs(['eng']), 'eng');
});

test('unknown codes are dropped rather than passed to the engine', () => {
  assert.deepEqual(setLanguages(['eng', 'klingon', 'fra']), ['eng', 'fra']);
});

test('the selection is capped, because each language costs time', () => {
  const chosen = setLanguages(['eng', 'fra', 'ita', 'spa', 'deu']);
  assert.equal(chosen.length, MAX_ACTIVE);
  assert.deepEqual(chosen, ['eng', 'fra', 'ita']);
});

test('an empty selection falls back rather than leaving no engine at all', () => {
  assert.deepEqual(setLanguages([]), ['eng', 'fra']);
});

test('with no storage available the defaults still work', () => {
  // Node has no localStorage, which is the same situation as a locked-down
  // private window: the app must still know what to load.
  assert.deepEqual(getLanguages(), ['eng', 'fra']);
});

test('the size shown to the user adds up the chosen packs', () => {
  const expected = LANGUAGES
    .filter((l) => ['eng', 'fra'].includes(l.code))
    .reduce((sum, l) => sum + l.mb, 0);
  assert.equal(totalMegabytes(['eng', 'fra']), expected);
  assert.equal(totalMegabytes([]), 0);
});

test('the engine choice defaults to PP-OCR and rejects unknown codes', async () => {
  const { ENGINES, DEFAULT_ENGINE, getEngine, setEngine } = await import('../js/engine.js');
  assert.deepEqual(ENGINES.map((e) => e.code), ['ppocr', 'tesseract']);
  assert.equal(DEFAULT_ENGINE, 'ppocr');
  // Node has no localStorage, the same situation as a locked-down browser:
  // the default answers, and a choice is still validated on the way through.
  assert.equal(getEngine(), 'ppocr');
  assert.equal(setEngine('tesseract'), 'tesseract');
  assert.equal(setEngine('bogus'), 'ppocr');
});

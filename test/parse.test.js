import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLabel, normalize, mergeWrappedLines, isNoise, levenshtein } from '../js/parse.js';

const NOW = new Date('2026-08-30T00:00:00Z');

/** Build lines with plausible geometry: `[text, height]`, stacked top to bottom. */
function layout(rows, gap = 30) {
  let top = 0;
  return rows.map(([text, height]) => {
    const line = { text, height, top };
    top += height + gap;
    return line;
  });
}

const parse = (rows, gap) => parseLabel({ lines: layout(rows, gap) }, NOW).fields;

/* ── Helpers ────────────────────────────────────────────────────────── */

test('normalize folds accents and punctuation but keeps apostrophes', () => {
  assert.equal(normalize('CHÂTEAU  LA-POMPE!'), 'chateau la pompe');
  assert.equal(normalize("Nero d'Avola"), "nero d'avola");
  assert.equal(normalize('Gewürztraminer'), 'gewurztraminer');
});

test('levenshtein counts single edits', () => {
  assert.equal(levenshtein('merlot', 'merlot'), 0);
  assert.equal(levenshtein('merlot', 'merlol'), 1);
  assert.equal(levenshtein('gewurztraminer', 'gewurztrarniner'), 2);
});

test('packaging boilerplate is recognised as noise', () => {
  assert.ok(isNoise('13,5% vol'));
  assert.ok(isNoise('750 ML'));
  assert.ok(isNoise('CONTAINS SULFITES'));
  assert.ok(isNoise('MIS EN BOUTEILLE AU CHÂTEAU'));
  assert.ok(!isNoise('CHÂTEAU LA POMPE'));
});

/* ── Line assembly ──────────────────────────────────────────────────── */

test('a wrapped name is rejoined, a nearby vintage is not swallowed', () => {
  const lines = [
    { text: 'CHÂTEAU LA', height: 50, top: 100 },
    { text: 'POMPE', height: 44, top: 156 },   // tight under it
    { text: '2018', height: 52, top: 220 },
  ];
  const merged = mergeWrappedLines(lines);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, 'CHÂTEAU LA POMPE');
  assert.equal(merged[1].text, '2018');
});

test('lines of very different size are left alone', () => {
  const merged = mergeWrappedLines([
    { text: 'GRAND VIN DE BORDEAUX', height: 17, top: 0 },
    { text: 'CHÂTEAU LA POMPE', height: 50, top: 20 },
  ]);
  assert.equal(merged.length, 2);
});

/* ── Vintage ────────────────────────────────────────────────────────── */

test('the vintage is read from a year on its own line', () => {
  assert.equal(parse([['CHÂTEAU LA POMPE', 40], ['2018', 50]]).Vintage, '2018');
});

test('a founding year is not mistaken for the vintage', () => {
  const fields = parse([
    ['DOMAINE DES ROCHES', 40],
    ['EST. 1885', 20],
    ['2019', 44],
  ]);
  assert.equal(fields.Vintage, '2019');
});

test('a label with only a founding year reports no vintage', () => {
  const fields = parse([['WEINGUT MÜLLER', 40], ['SINCE 1749', 18]]);
  assert.equal(fields.Vintage, undefined);
});

test('an implausible year is ignored', () => {
  assert.equal(parse([['LOT 2099', 20]]).Vintage, undefined);
  assert.equal(parse([['ANNO 1650', 20]]).Vintage, undefined);
});

/* ── Varieties ──────────────────────────────────────────────────────── */

test('grape names are read in the order printed', () => {
  const fields = parse([['MERLOT · CABERNET SAUVIGNON', 18]]);
  assert.equal(fields.Varieties, 'Merlot, Cabernet Sauvignon');
});

test('a mangled grape name is still matched', () => {
  // What Tesseract typically does to this word.
  assert.equal(parse([['GEWURZTRARNINER', 30]]).Varieties, 'Gewürztraminer');
});

test('a short grape name is matched exactly, not fuzzily', () => {
  assert.equal(parse([['GRAND VIN', 20]]).Varieties, undefined);
});

/* ── Appellation, country, region ───────────────────────────────────── */

test('a known appellation fills country and region too', () => {
  const fields = parse([['BAROLO DOCG', 30]]);
  assert.equal(fields.Appelation, 'Barolo');
  assert.equal(fields.Country, 'Italy');
  assert.equal(fields.Region, 'Piemonte');
});

test('the longest appellation wins', () => {
  assert.equal(parse([['CHIANTI CLASSICO DOCG', 24]]).Appelation, 'Chianti Classico');
});

test('the declared appellation outranks a place name used as a cuvée', () => {
  const fields = parse([
    ['CHÂTEAU LA POMPE', 44],
    ['Cuvée Saint-Julien', 28],
    ['APPELLATION MARGAUX CONTRÔLÉE', 19],
  ]);
  assert.equal(fields.Appelation, 'Margaux');
  assert.equal(fields.Region, 'Bordeaux');
});

test('an unlisted appellation is captured from the French formula', () => {
  const fields = parse([['Appellation Cheverny Contrôlée', 20]]);
  assert.equal(fields.Appelation, 'Cheverny');
});

test('country falls back to the words on the label', () => {
  const fields = parse([['BODEGAS ALTO', 40], ['PRODUCT OF SPAIN', 16]]);
  assert.equal(fields.Country, 'Spain');
});

/* ── Type ───────────────────────────────────────────────────────────── */

test('the type is taken from the label when it says so', () => {
  assert.equal(parse([['VINO ROSSO', 20]]).Type, 'Red');
  assert.equal(parse([['VIN BLANC', 20]]).Type, 'White');
  assert.equal(parse([['CHAMPAGNE BRUT', 20]]).Type, 'Sparkling');
});

test('the type falls back to the colour of the grapes', () => {
  assert.equal(parse([['MERLOT · CABERNET SAUVIGNON', 18]]).Type, 'Red');
  assert.equal(parse([['CHARDONNAY', 30]]).Type, 'White');
});

test('a mixed-colour blend leaves the type for the user', () => {
  assert.equal(parse([['CHARDONNAY MERLOT', 18]]).Type, undefined);
});

/* ── Producer and cuvée ─────────────────────────────────────────────── */

test('a naming word identifies the producer regardless of size', () => {
  const fields = parse([
    ['THE BIGGEST WORDS HERE', 46],
    ['Château La Pompe', 18],
  ]);
  assert.equal(fields.Winemaker, 'Château La Pompe');
});

test('a trailing naming word works too', () => {
  assert.equal(parse([['SOMETHING BIG', 40], ['Ridge Vineyards', 16]]).Winemaker, 'Ridge Vineyards');
});

test('without a naming word the largest unclaimed line is the producer', () => {
  const fields = parse([
    ['GRAND VIN DE BORDEAUX', 17],
    ['PENFOLDS', 50],
    ['2018', 52],
  ]);
  assert.equal(fields.Winemaker, 'PENFOLDS');
});

test('a bare appellation line is not offered as the producer', () => {
  const fields = parse([['CHAMPAGNE', 40], ['Brut Réserve', 20]]);
  assert.notEqual(fields.Winemaker, 'CHAMPAGNE');
});

/* ── The whole label ────────────────────────────────────────────────── */

test('a full label, exactly as the OCR pass returns it', () => {
  // Verbatim from running the app against the rendered fixture.
  const fields = parseLabel({
    lines: [
      { text: 'GRAND VIN DE BORDEAUX', height: 17, top: 300 },
      { text: 'CHATEAU LA', height: 50, top: 360 },
      { text: 'POMPE', height: 37, top: 420 },
      { text: 'Cuvée Saint-Julien', height: 28, top: 520 },
      { text: '2018', height: 52, top: 590 },
      { text: 'APPELLATION MARGAUX', height: 18, top: 680 },
      { text: 'CONTROLEE', height: 24, top: 706 },
      { text: 'MIS EN BOUTEILLE AU CHATEAU', height: 19, top: 770 },
      { text: 'MERLOT - CABERNET SAUVIGNON', height: 15, top: 820 },
      { text: 'PRODUCT OF FRANCE - 13,5% VOL - 750 ML', height: 16, top: 870 },
    ],
  }, NOW).fields;

  assert.equal(fields.Winemaker, 'CHATEAU LA POMPE');
  assert.equal(fields.WineName, 'Cuvée Saint-Julien');
  assert.equal(fields.Vintage, '2018');
  assert.equal(fields.Type, 'Red');
  assert.equal(fields.Varieties, 'Merlot, Cabernet Sauvignon');
  assert.equal(fields.Country, 'France');
  assert.equal(fields.Region, 'Bordeaux');
  assert.equal(fields.Appelation, 'Margaux');
});

test('an empty read produces no guesses rather than nonsense', () => {
  const { fields, auto } = parseLabel({ text: '', lines: [] }, NOW);
  assert.deepEqual(fields, {});
  assert.deepEqual(auto, []);
});

test('plain text without geometry still parses', () => {
  const { fields } = parseLabel({
    text: 'BODEGAS MUGA\nRIOJA\nRESERVA\n2016\nTEMPRANILLO',
  }, NOW);
  assert.equal(fields.Winemaker, 'BODEGAS MUGA');
  assert.equal(fields.Vintage, '2016');
  assert.equal(fields.Appelation, 'Rioja');
  assert.equal(fields.Country, 'Spain');
  assert.equal(fields.Varieties, 'Tempranillo');
});

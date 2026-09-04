import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyRecord, composeName } from '../js/schema.js';
import {
  noteBasename,
  asciiBasename,
  uniqueBasename,
  buildFrontmatter,
  buildNote,
  noteFilename,
  labelFilename,
  foodFilename,
} from '../js/note.js';

/** Exactly the template the vault already uses, with nothing filled in. */
const TEMPLATE_FRONTMATTER = `fileClass: Wine
Name:
Winemaker:
WineName:
Vintage:
Type:
Varieties:
Country:
Region:
Appelation:
Vineyard:
Style:
Price:
PurchaseSource:
PurchaseLink:
PurchaseCountry:
Stars: --
ValueForMoney:
Points:
Inventory: 0
Buy: 0
Buy date:
Drink date:
Coordinates:
Place:
Venue:`;

const filled = () => ({
  ...emptyRecord(),
  Winemaker: 'Château La Pompe',
  WineName: 'Cuvée Saint-Julien',
  Vintage: '2018',
  Type: 'Red',
  Varieties: 'Merlot, Cabernet Sauvignon',
  Country: 'France',
  Region: 'Bordeaux',
  Appelation: 'Margaux',
});

/* ── Frontmatter fidelity ───────────────────────────────────────────── */

test('an empty record reproduces the vault template exactly', () => {
  assert.equal(buildFrontmatter(emptyRecord()), TEMPLATE_FRONTMATTER);
});

test('the key order and spelling never change', () => {
  const keys = buildFrontmatter(filled()).split('\n').map((line) => line.split(':')[0]);
  assert.deepEqual(keys, [
    'fileClass', 'Name', 'Winemaker', 'WineName', 'Vintage', 'Type', 'Varieties',
    'Country', 'Region', 'Appelation', 'Vineyard', 'Style', 'Price',
    'PurchaseSource', 'PurchaseLink', 'PurchaseCountry', 'Stars', 'ValueForMoney',
    'Points', 'Inventory', 'Buy', 'Buy date', 'Drink date', 'Coordinates', 'Place', 'Venue',
  ]);
  // The vault spells it with one l; correcting it would break every Base query.
  assert.ok(keys.includes('Appelation'));
  assert.ok(!keys.includes('Appellation'));
});

test('values are quoted, and the resting defaults survive', () => {
  const frontmatter = buildFrontmatter(filled());
  assert.match(frontmatter, /^Winemaker: "Château La Pompe"$/m);
  assert.match(frontmatter, /^Vintage: "2018"$/m);
  assert.match(frontmatter, /^Varieties: "Merlot, Cabernet Sauvignon"$/m);
  assert.match(frontmatter, /^Stars: --$/m);
  assert.match(frontmatter, /^Inventory: 0$/m);
  assert.match(frontmatter, /^Buy: 0$/m);
});

test('the capture-context fields are quoted like any other text field', () => {
  const frontmatter = buildFrontmatter({
    ...emptyRecord(), Coordinates: '48.85660, 2.35220', Place: 'Paris, France', Venue: 'Bistro du Chef',
  });
  assert.match(frontmatter, /^Coordinates: "48\.85660, 2\.35220"$/m);
  assert.match(frontmatter, /^Place: "Paris, France"$/m);
  assert.match(frontmatter, /^Venue: "Bistro du Chef"$/m);
});

test('numbers and dates are written bare, not quoted', () => {
  const frontmatter = buildFrontmatter({
    ...emptyRecord(), Price: '24.5', Points: '92', 'Drink date': '2030-01-01',
  });
  assert.match(frontmatter, /^Price: 24\.5$/m);
  assert.match(frontmatter, /^Points: 92$/m);
  assert.match(frontmatter, /^Drink date: 2030-01-01$/m);
});

test('a cleared default falls back to the template value', () => {
  const frontmatter = buildFrontmatter({ ...emptyRecord(), Stars: '', Inventory: '' });
  assert.match(frontmatter, /^Stars: --$/m);
  assert.match(frontmatter, /^Inventory: 0$/m);
});

test('quotes and backslashes in a value are escaped', () => {
  const frontmatter = buildFrontmatter({ ...emptyRecord(), WineName: 'The "Big" C:\\Wine' });
  assert.match(frontmatter, /^WineName: "The \\"Big\\" C:\\\\Wine"$/m);
});

/* ── Name and filename ──────────────────────────────────────────────── */

test('Name joins winemaker, wine name and vintage', () => {
  assert.equal(composeName(filled()), 'Château La Pompe - Cuvée Saint-Julien - 2018');
  assert.match(buildFrontmatter(filled()), /^Name: "Château La Pompe - Cuvée Saint-Julien - 2018"$/m);
});

test('a missing wine name collapses instead of leaving an empty slot', () => {
  const record = { ...emptyRecord(), Winemaker: 'Penfolds', Vintage: '2016' };
  assert.equal(composeName(record), 'Penfolds - 2016');
  assert.equal(noteBasename(record), 'Penfolds - 2016');
});

test('the filename keeps accents but drops path characters', () => {
  assert.equal(
    noteBasename(filled()),
    'Château La Pompe - Cuvée Saint-Julien - 2018',
  );
  assert.equal(
    noteBasename({ ...emptyRecord(), Winemaker: 'A/B: C*D?', Vintage: '2020' }),
    'A B C D - 2020',
  );
});

test('a nameless bottle still gets a filename', () => {
  assert.equal(noteBasename(emptyRecord()), 'Untitled wine');
});

test('a leading dot cannot hide the file', () => {
  assert.equal(noteBasename({ ...emptyRecord(), Winemaker: '.hidden' }), 'hidden');
});

test('a very long name is truncated', () => {
  const record = { ...emptyRecord(), Winemaker: 'x'.repeat(300) };
  assert.ok(noteBasename(record).length <= 120);
});

test('the ASCII fallback folds accents without mangling the rest', () => {
  // Only used where a file system refuses non-ASCII names.
  assert.equal(
    asciiBasename('Château La Pompe - Cuvée Saint-Julien - 2018'),
    'Chateau La Pompe - Cuvee Saint-Julien - 2018',
  );
  assert.equal(asciiBasename('Müller-Thurgau - 2021'), 'Muller-Thurgau - 2021');
  assert.equal(asciiBasename('日本のワイン'), 'Untitled wine');
});

test('a name collision falls back to the Obsidian-style suffix', async () => {
  const existing = new Set(['Penfolds - 2016', 'Penfolds - 2016 2']);
  const name = await uniqueBasename('Penfolds - 2016', async (n) => existing.has(n));
  assert.equal(name, 'Penfolds - 2016 3');
});

test('a free name is used as it stands', async () => {
  assert.equal(await uniqueBasename('Free name', async () => false), 'Free name');
});

test('the three filenames share one basename', () => {
  const base = 'Penfolds - 2016';
  assert.equal(noteFilename(base), 'Penfolds - 2016.md');
  assert.equal(labelFilename(base), 'Penfolds - 2016.jpg');
  assert.equal(foodFilename(base), 'Penfolds - 2016 - food.jpg');
});

/* ── The body ───────────────────────────────────────────────────────── */

test('the body carries the headings and inline Dataview fields', () => {
  const note = buildNote({
    record: { ...filled(), tastingNote: 'Dusty, long finish.' },
    basename: 'Château La Pompe - Cuvée Saint-Julien - 2018',
    hasFood: true,
    ocrText: 'CHATEAU LA POMPE\n2018',
  });

  assert.ok(note.startsWith('---\nfileClass: Wine\n'));
  assert.match(note, /\n## Tasting note\nDusty, long finish\.\n/);
  assert.match(note, /\n## Label\nLabel:: !\[\[Château La Pompe - Cuvée Saint-Julien - 2018\.jpg\]\]\n/);
  assert.match(note, /\n## Food\nFood:: !\[\[Château La Pompe - Cuvée Saint-Julien - 2018 - food\.jpg\]\]\n/);
  assert.match(note, /%%\n[\s\S]*CHATEAU LA POMPE[\s\S]*%%/);
});

test('without a food photo the Food field is left empty for later', () => {
  const note = buildNote({ record: emptyRecord(), basename: 'X', hasFood: false });
  assert.match(note, /\n## Food\nFood::\n/);
});

test('with nothing recognised there is no comment block', () => {
  const note = buildNote({ record: emptyRecord(), basename: 'X', ocrText: '   ' });
  assert.ok(!note.includes('%%'));
});

test('an empty bottle still produces a complete, template-shaped note', () => {
  const note = buildNote({ record: emptyRecord(), basename: 'Untitled wine' });
  assert.equal(note, `---
${TEMPLATE_FRONTMATTER}
---

## Tasting note


## Label
Label:: ![[Untitled wine.jpg]]

## Food
Food::
`);
});

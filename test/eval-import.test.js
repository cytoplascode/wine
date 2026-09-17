import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, columnMap, toRows } from '../eval/import-winesensed.mjs';

test('parseCsv handles quotes, embedded commas and newlines', () => {
  const rows = parseCsv('id,name\n"a,b","line1\nline2"\nc,"say ""hi"""\n');
  assert.deepEqual(rows, [{ id: 'a,b', name: 'line1\nline2' }, { id: 'c', name: 'say "hi"' }]);
});

test('columnMap guesses common headers and honours overrides', () => {
  const map = columnMap(['Image', 'Producer', 'Name', 'Year', 'Region', 'Country', 'Grape Varieties', 'rating']);
  assert.equal(map.file, 'Image');
  assert.equal(map.winery, 'Producer');
  assert.equal(map.wine, 'Name');
  assert.equal(map.vintage, 'Year');
  assert.equal(map.grapes, 'Grape Varieties');
  assert.equal(columnMap(['pic', 'x'], 'pic=file,x=winery').winery, 'x');
});

test('toRows matches image ids to files present and normalises values', () => {
  const present = new Map([['abc', 'abc.jpg']]);
  const rows = toRows(
    [{ image: 'photos/abc.jpg', producer: ' Tezi ', year: '2022.0', grapes: ['Chinuri', 'Kisi'], region: 'nan' },
     { image: 'zzz', producer: 'Nope' }],
    { file: 'image', winery: 'producer', vintage: 'year', grapes: 'grapes', region: 'region' },
    present,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'abc.jpg');
  assert.equal(rows[0].winery, 'Tezi');
  assert.equal(rows[0].vintage, '2022');
  assert.equal(rows[0].grapes, 'Chinuri, Kisi');
  assert.equal(rows[0].region, null);
  assert.equal(rows[0].source, 'winesensed');
});

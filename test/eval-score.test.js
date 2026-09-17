import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokens, jaccard, nameSimilarity, listSimilarity, compareField, score, FIELD_MAP,
} from '../eval/score.mjs';

test('tokens fold accents, case and punctuation', () => {
  assert.deepEqual(tokens('Château Léoville-Barton!'), ['chateau', 'leoville', 'barton']);
});

test('jaccard is 1 for identical sets and 0 for disjoint', () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'a']), 1);
  assert.equal(jaccard(['a'], ['b']), 0);
  assert.equal(jaccard([], []), 1);
});

test('nameSimilarity credits containment', () => {
  // Plain Jaccard would be 0.5 here; containment lifts it to the threshold.
  assert.equal(nameSimilarity('Ausone', 'Château Ausone'), 0.6);
  assert.equal(nameSimilarity('Château Ausone', 'Chateau Ausone'), 1);
  assert.equal(nameSimilarity('Penfolds', ''), 0);
  assert.equal(nameSimilarity('', 'Penfolds'), null);
});

test('listSimilarity is order-insensitive over grape names', () => {
  assert.equal(listSimilarity('Grenache, Syrah', 'syrah / grenache'), 1);
  assert.ok(listSimilarity('Grenache, Syrah, Mourvèdre', 'Grenache, Syrah') > 0.6);
});

test('compareField: vintage is exact on the four-digit year', () => {
  assert.deepEqual(compareField('vintage', '2019', '2019'), { sim: 1, hit: true });
  assert.deepEqual(compareField('vintage', 2019, 'Vintage 2019'), { sim: 1, hit: true });
  assert.deepEqual(compareField('vintage', '2019', '2018'), { sim: 0, hit: false });
  assert.equal(compareField('vintage', null, '2019'), null, 'empty truth is unscored');
});

test('score reports per-field accuracy and the worst rows', () => {
  const rows = [
    { file: 'a.jpg', truth: { winery: 'Penfolds', vintage: '2016', grapes: 'Shiraz' },
      pred: { Winemaker: 'Penfolds', Vintage: '2016', Varieties: 'Shiraz' } },
    { file: 'b.jpg', truth: { winery: 'Tezi Winery', vintage: '2022', region: null },
      pred: { Winemaker: 'TEZ', Vintage: '2021' } },
  ];
  const s = score(rows);
  assert.equal(s.rows, 2);
  assert.equal(s.perField.winery.n, 2);
  assert.equal(s.perField.winery.hits, 1);
  assert.equal(s.perField.vintage.hits, 1);
  assert.equal(s.perField.region.n, 0, 'null truth is not scored');
  assert.equal(s.scoredFields, 5);
  assert.equal(s.worst[0].file, 'b.jpg');
  assert.equal(s.worst[0].misses.length, 2);
});

test('FIELD_MAP covers the app keys the parser can emit', () => {
  for (const appKey of Object.values(FIELD_MAP)) {
    assert.ok(['Winemaker', 'WineName', 'Vintage', 'Region', 'Country', 'Appelation', 'Varieties'].includes(appKey));
  }
});

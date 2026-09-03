import test from 'node:test';
import assert from 'node:assert/strict';

import { macroUri, buildPayload } from '../js/quickadd.js';

/* macroUri/buildPayload take the connection and the bottle explicitly rather
 * than reading localStorage themselves, which is what lets them run under
 * node --test. getConfig/setConfig, which do touch storage, are exercised by
 * hand instead, like vault.js's pick(). */

const config = { vault: 'My Vault', choice: 'Save wine' };

test('the link encodes spaces as %20, not the form-encoded +', () => {
  const uri = macroUri(config);
  assert.match(uri, /^obsidian:\/\/quickadd\?/);
  assert.match(uri, /vault=My%20Vault/);
  assert.match(uri, /choice=Save%20wine/);
  assert.doesNotMatch(uri, /\+/);
});

test('the link carries no data — that is what keeps it short', () => {
  // Everything rides on the clipboard precisely so an Android intent never
  // has to carry a note, let alone a photo.
  const uri = macroUri(config);
  assert.doesNotMatch(uri, /value-/);
  assert.ok(uri.length < 120);
});

test('the payload carries the note and a file per photo', () => {
  const payload = JSON.parse(buildPayload({
    notePath: 'wines/Château Ausone - 2015.md',
    content: '---\nfileClass: Wine\n---',
    photos: [
      { path: 'wines/Château Ausone - 2015.jpg', dataUri: 'data:image/jpeg;base64,AAA' },
      { path: 'wines/Château Ausone - 2015 - food.jpg', dataUri: 'data:image/jpeg;base64,BBB' },
    ],
  }));

  assert.equal(payload.v, 1);
  assert.deepEqual(payload.note, {
    path: 'wines/Château Ausone - 2015.md',
    content: '---\nfileClass: Wine\n---',
  });
  assert.deepEqual(payload.files.map((f) => f.path), [
    'wines/Château Ausone - 2015.jpg',
    'wines/Château Ausone - 2015 - food.jpg',
  ]);
  assert.equal(payload.files[1].data, 'data:image/jpeg;base64,BBB');
});

test('a bottle with no food photo carries just the one file', () => {
  const payload = JSON.parse(buildPayload({
    notePath: 'wines/X.md',
    content: 'note',
    photos: [{ path: 'wines/X.jpg', dataUri: 'data:image/jpeg;base64,AAA' }],
  }));
  assert.equal(payload.files.length, 1);
});

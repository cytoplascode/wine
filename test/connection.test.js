import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFolder } from '../js/connection.js';

/* getFolders/setFolders touch localStorage, so — like vault.js's pick() and
 * quickadd.js's getConfig/setConfig — they are exercised by hand rather than
 * under node --test. normalizeFolder is pure and is what both of them lean
 * on to turn a hand-typed field into a clean path, so that part is covered
 * here. */

test('slashes around and between segments are cleaned up', () => {
  assert.equal(normalizeFolder('/Wine/Bottles/'), 'Wine/Bottles');
  assert.equal(normalizeFolder('Wine//Bottles'), 'Wine/Bottles');
  assert.equal(normalizeFolder(' Wine / Bottles '), 'Wine/Bottles');
});

test('a flat name passes through unchanged', () => {
  assert.equal(normalizeFolder('wines'), 'wines');
});

test('blank input normalizes to the empty string', () => {
  assert.equal(normalizeFolder(''), '');
  assert.equal(normalizeFolder('   '), '');
  assert.equal(normalizeFolder(undefined), '');
});

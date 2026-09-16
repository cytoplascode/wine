import test from 'node:test';
import assert from 'node:assert/strict';

import { newArchiveId, ARCHIVE_LIMIT } from '../js/archive.js';

/* Storage-touching pieces (archiveBottle, listArchive, pruneOldest, and the
 * archive*  wrappers in idb.js) go through IndexedDB and stay browser-only —
 * the browser end-to-end is checked in the Playwright script alongside the
 * other stored-data tests. These are the pure halves. */

test('newArchiveId produces a distinct value on every call', () => {
  const a = newArchiveId();
  const b = newArchiveId();
  assert.notEqual(a, b);
  assert.match(a, /^a[a-z0-9]+$/);
});

test('ARCHIVE_LIMIT is a small round number a home-screen list can hold', () => {
  // Deliberately not zero (defeats the safety-net purpose) and not so large
  // that the card becomes unscannable — twenty is a couple of dinner
  // parties worth. Guard against an accidental drift here breaking the
  // "just in case" story.
  assert.ok(ARCHIVE_LIMIT >= 5 && ARCHIVE_LIMIT <= 50);
});

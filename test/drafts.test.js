import test from 'node:test';
import assert from 'node:assert/strict';

import { draftTitle, newDraftId } from '../js/drafts.js';

/* Storage-touching pieces (putDraft, listDrafts, removeDraft) go through
 * IndexedDB and stay browser-only, like vault.js's pick() and
 * quickadd.js's getConfig/setConfig. These are the pure halves. */

test('draftTitle joins the wine identity into one readable line', () => {
  assert.equal(
    draftTitle({ Winemaker: 'Château Ausone', WineName: 'Grand Cru', Vintage: '2015' }),
    'Château Ausone — Grand Cru — 2015',
  );
});

test('a missing part collapses cleanly instead of leaving an empty slot', () => {
  assert.equal(
    draftTitle({ Winemaker: 'Penfolds', WineName: '', Vintage: '2016' }),
    'Penfolds — 2016',
  );
});

test('a fully-empty record falls back to the untitled placeholder', () => {
  // A draft written before any OCR guess has come back still needs a name
  // in the list. It reads clearly as pending rather than as a real bottle.
  assert.equal(draftTitle({}), 'Untitled bottle');
  assert.equal(draftTitle(), 'Untitled bottle');
});

test('draftTitle trims stray whitespace around each part', () => {
  assert.equal(
    draftTitle({ Winemaker: '  Penfolds  ', WineName: '  Bin 389  ', Vintage: '2016' }),
    'Penfolds — Bin 389 — 2016',
  );
});

test('two draft IDs made back-to-back are still distinct', () => {
  // Prefixed with the timestamp so they sort in creation order; the random
  // tail keeps them apart when two land in the same millisecond, which is
  // exactly what the auto-save loop can produce on a fast phone.
  const a = newDraftId();
  const b = newDraftId();
  assert.notEqual(a, b);
  assert.match(a, /^d[a-z0-9]+$/);
});

/* A bottle in progress — the review screen's state, snapshot into
 * IndexedDB so a tap on New bottle, a lock screen, or a browser restart
 * doesn't lose it. Kept until the user explicitly saves to the vault
 * (which deletes it) or discards it by hand.
 *
 * A draft holds:
 *   - sourceBlob   the captured photo, before any crop or warp, so the
 *                  pencil-to-recrop workflow keeps working after reload.
 *   - flattenedBlob the warped label the vault would receive; kept
 *                  separately so resuming a draft can skip re-running the
 *                  warp until the user actually re-crops.
 *   - foodBlob     optional.
 *   - the OCR text, its per-line breakdown, the form values, the crop
 *     handles, the wrap angle, the capture date and location — everything
 *     needed to rebuild the review screen the way it looked at
 *     save-a-draft time.
 *
 * `title` is derived on write (from Winemaker/WineName/Vintage) so the
 * drafts list on the home screen doesn't have to reach into a record's
 * fields to render itself — a plain string is enough.
 */

import { draftPut, draftGet, draftDelete, draftAll } from './idb.js';

const UNTITLED = 'Untitled bottle';

/** Human-readable label for the drafts list. */
export function draftTitle({ Winemaker, WineName, Vintage } = {}) {
  const parts = [Winemaker, WineName, Vintage].map((s) => (s || '').trim()).filter(Boolean);
  return parts.length ? parts.join(' — ') : UNTITLED;
}

/** A fresh draft ID — monotonic (sort by it) and unique within one ms. */
export function newDraftId() {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Write or overwrite. Callers pass the snapshot; this stamps `updatedAt`
 *  and, on a first save, `createdAt`, then computes `title`. `id` is
 *  written into the record as well as being the store key, so a
 *  `getAll()`-style listing can identify each row without a second call
 *  for the keys. */
export async function putDraft(id, snapshot) {
  const now = Date.now();
  const existing = await draftGet(id);
  const record = {
    ...snapshot,
    id,
    title: draftTitle(snapshot.fields),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  await draftPut(id, record);
  return record;
}

export async function getDraft(id) {
  return draftGet(id);
}

export async function removeDraft(id) {
  await draftDelete(id);
}

/** All drafts, newest first — the order the home screen shows them in. */
export async function listDrafts() {
  const rows = (await draftAll()) || [];
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

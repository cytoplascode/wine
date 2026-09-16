/* A rolling backup of bottles the user has already sent to the vault.
 *
 * Obsidian, QuickAdd, and the folder-picker path each have their own ways of
 * failing quietly — a URI that never launched the app, a folder handle whose
 * permission lapsed, a clipboard payload that got binned by a background OS.
 * The app has no way to prove the note actually landed. So instead: every
 * successful send stamps a copy of the bottle here first. If a bottle turns
 * out to be missing from the vault, it is still on the phone.
 *
 * Cap: `ARCHIVE_LIMIT` rows. Anything older than that falls off — the archive
 * is a safety net for what just happened, not a photo library.
 *
 * Same schema as a draft (photos as blobs, form values, OCR text) plus a
 * `sentAt` timestamp. Reopening one restores the same review-screen state as
 * resuming a draft, so a re-send is a normal Save to vault away.
 */

import {
  archivePut, archiveGet, archiveDelete, archiveAll,
} from './idb.js';
import { draftTitle } from './drafts.js';

/** How many recent sends to keep. Twenty is a couple of dinner parties worth
 *  of bottles — enough that a save-then-realise-later still has the bottle
 *  waiting, few enough that the home-screen list stays scannable. */
export const ARCHIVE_LIMIT = 20;

/** A fresh archive ID. Prefixed with the timestamp in base-36 so a numeric
 *  sort matches send order, then a random suffix for uniqueness within one ms. */
export function newArchiveId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Store a bottle that just left. Assigns the id and the sentAt stamp, derives
 *  the title, then prunes any rows beyond the cap (oldest first). */
export async function archiveBottle(snapshot) {
  const id = newArchiveId();
  const record = {
    ...snapshot,
    id,
    title: draftTitle(snapshot.fields),
    sentAt: Date.now(),
  };
  await archivePut(id, record);
  await pruneOldest();
  return record;
}

/** Newest send first — the order the Recent card shows them in. */
export async function listArchive() {
  const rows = (await archiveAll()) || [];
  return rows.sort((a, b) => b.sentAt - a.sentAt);
}

export const getArchive = (id) => archiveGet(id);
export const removeArchive = (id) => archiveDelete(id);

/** Trim the archive to `ARCHIVE_LIMIT` rows, dropping the oldest. Called after
 *  each `archiveBottle`, but exported so tests and startup can reconcile a
 *  version that arrived with more rows than the current cap allows. */
export async function pruneOldest() {
  const rows = await listArchive();
  const drop = rows.slice(ARCHIVE_LIMIT);
  for (const row of drop) await archiveDelete(row.id);
  return drop.length;
}

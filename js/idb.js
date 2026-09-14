/* A very small IndexedDB wrapper.
 *
 * Three stores, in the same database:
 *   - `handles`  the vault's FileSystemDirectoryHandle between visits;
 *                keyed by a fixed string, structured-cloneable, holds one.
 *   - `drafts`   in-progress bottles the user hasn't sent to Obsidian yet.
 *                Photos live as Blobs (several MB each — localStorage would
 *                not take them), each row keyed by its own draft ID.
 *   - `shared`   a photo shared into the app from another app's share sheet.
 *                Written by the service worker's share-target handler, read
 *                by app.js on startup. One row, keyed 'pending'.
 *
 * Bumping DB_VERSION triggers `onupgradeneeded` which creates any missing
 * store; a phone that installed the app before a store existed picks it
 * up on next open without losing anything already saved.
 */

const DB_NAME = 'label-scanner';
const DB_VERSION = 3;
const HANDLES = 'handles';
const DRAFTS = 'drafts';
const SHARED = 'shared';

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
      if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS);
      if (!db.objectStoreNames.contains(SHARED)) db.createObjectStore(SHARED);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function run(store, mode, operation) {
  return openDatabase().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

/* ── handles: the vault directory ──────────────────────────────────── */

export const idbGet = (key) => run(HANDLES, 'readonly', (store) => store.get(key));
export const idbSet = (key, value) => run(HANDLES, 'readwrite', (store) => store.put(value, key));

/* ── drafts: bottles-in-progress ───────────────────────────────────── */

export const draftPut = (id, value) => run(DRAFTS, 'readwrite', (store) => store.put(value, id));
export const draftGet = (id) => run(DRAFTS, 'readonly', (store) => store.get(id));
export const draftDelete = (id) => run(DRAFTS, 'readwrite', (store) => store.delete(id));
export const draftAll = () => run(DRAFTS, 'readonly', (store) => store.getAll());

/* ── shared: a photo the OS handed us via the share sheet ──────────── */

export const sharedGet = () => run(SHARED, 'readonly', (store) => store.get('pending'));
export const sharedClear = () => run(SHARED, 'readwrite', (store) => store.delete('pending'));

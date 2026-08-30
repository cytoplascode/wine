/* The connection to the Obsidian vault folder.
 *
 * The folder is picked once and the handle is kept in IndexedDB. Chrome does
 * not necessarily carry the *permission* across sessions, though: on a later
 * visit `queryPermission` commonly answers 'prompt', and re-requesting it is
 * only allowed from a user gesture. That is the whole reason this reports state
 * rather than quietly re-asking — the UI has to be able to show a button.
 */

import { idbGet, idbSet } from './idb.js';

const HANDLE_KEY = 'vault-directory';
const MODE = { mode: 'readwrite' };

let handle = null;

export const isSupported = () => typeof window.showDirectoryPicker === 'function';

export const getVaultName = () => (handle ? handle.name : '');

/** Load the remembered folder, if there is one. Does not prompt. */
export async function restore() {
  if (!isSupported()) return null;
  try {
    handle = (await idbGet(HANDLE_KEY)) || null;
  } catch {
    handle = null;
  }
  return handle;
}

/**
 * Current access, without prompting:
 *   unsupported — this browser has no File System Access API
 *   none        — nothing chosen yet
 *   granted     — ready to write
 *   prompt      — remembered, but needs the user to confirm again
 *   denied      — refused
 */
export async function status() {
  if (!isSupported()) return 'unsupported';
  if (!handle) return 'none';
  if (typeof handle.queryPermission !== 'function') return 'granted';
  try {
    return await handle.queryPermission(MODE);
  } catch {
    return 'none';
  }
}

/** Show the folder picker. Must be called from a user gesture. */
export async function pick() {
  const picked = await window.showDirectoryPicker({
    id: 'obsidian-vault',
    mode: 'readwrite',
    startIn: 'documents',
  });

  handle = picked;
  await idbSet(HANDLE_KEY, picked);
  await requestPersistentStorage();
  return picked;
}

/** Re-ask for access to the folder already chosen. Needs a user gesture too. */
export async function reconnect() {
  if (!handle || typeof handle.requestPermission !== 'function') return 'none';
  return handle.requestPermission(MODE);
}

/* ── Writing ────────────────────────────────────────────────────────── */

/** Get (or create) a folder directly inside the connected vault. */
export async function ensureDirectory(name) {
  if (!handle) throw new Error('No vault is connected');
  return handle.getDirectoryHandle(name, { create: true });
}

export async function writeFile(directory, filename, data) {
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

export async function fileExists(directory, filename) {
  try {
    await directory.getFileHandle(filename);
    return true;
  } catch (err) {
    if (err.name === 'NotFoundError') return false;
    throw err;
  }
}

/**
 * What the home screen should say for a given access state. Pure, so the copy
 * and the branching can be tested without a browser.
 * Returns `{ dot, text, button }`; `button` is `[label, action]` or null.
 */
export function describe(state, name = '') {
  switch (state) {
    case 'unsupported':
      return {
        dot: 'warn',
        text: 'This browser cannot write into a folder, so saving will download the files instead.',
        button: null,
      };
    case 'granted':
      return {
        dot: 'ok',
        text: `Connected to “${name}”. Notes are written to its wines folder.`,
        button: ['Change vault', 'pick'],
      };
    case 'prompt':
      return {
        dot: 'warn',
        text: `Access to “${name}” needs confirming again after the restart.`,
        button: ['Reconnect vault', 'reconnect'],
      };
    case 'denied':
      return {
        dot: 'err',
        text: 'Access to the folder was refused. Pick it again to carry on.',
        button: ['Connect vault', 'pick'],
      };
    case 'none':
    default:
      return {
        dot: 'warn',
        text: 'No vault connected yet. Pick your vault, or a folder inside it.',
        button: ['Connect vault', 'pick'],
      };
  }
}

/**
 * Ask the browser not to evict our storage. Chrome grants this silently to
 * installed PWAs and declines elsewhere; either way it is advisory, so a
 * refusal is not an error.
 */
export async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

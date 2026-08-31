/* Which vault backend is currently in use — the folder picker, or Obsidian's
 * Local REST API. A plain preference, not a credential, so it lives in
 * localStorage rather than alongside the folder handle and API key in
 * IndexedDB. */

const MODE_KEY = 'label-scanner-vault-mode';

export const getMode = () => localStorage.getItem(MODE_KEY) || 'folder';

export function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

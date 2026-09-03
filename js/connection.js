/* Which vault backend is currently in use — the folder picker, or firing
 * Obsidian's QuickAdd plugin by URI. A plain preference, not a credential,
 * so it lives in localStorage rather than alongside any saved settings. */

const MODE_KEY = 'label-scanner-vault-mode';

export const getMode = () => localStorage.getItem(MODE_KEY) || 'folder';

export function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

/* Which vault backend is currently in use — the folder picker, or firing
 * Obsidian's QuickAdd plugin by URI. A plain preference, not a credential,
 * so it lives in localStorage rather than alongside any saved settings. */

const MODE_KEY = 'label-scanner-vault-mode';

export const getMode = () => localStorage.getItem(MODE_KEY) || 'folder';

export function setMode(mode) {
  localStorage.setItem(MODE_KEY, mode);
}

/* Where inside the vault notes and photos land. Both backends read this —
 * the folder picker walks it as nested directories, the QuickAdd parcel
 * carries it as part of each file's path — so it is stored once, independent
 * of which backend is in use. */

const FOLDERS_KEY = 'label-scanner-folders';
const DEFAULT_FOLDERS = { notes: 'wines', attachments: 'wines' };

/**
 * A folder path cleaned up for storage and for joining onto a filename: no
 * leading, trailing, doubled, or blank-segment slashes, whatever stray
 * spacing a hand-typed field arrives with.
 */
export function normalizeFolder(path) {
  return (path || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
}

export function getFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(FOLDERS_KEY));
    if (saved && saved.notes && saved.attachments) return saved;
  } catch {
    // fall through to the default
  }
  return DEFAULT_FOLDERS;
}

export function setFolders({ notes, attachments }) {
  const cleaned = {
    notes: normalizeFolder(notes) || DEFAULT_FOLDERS.notes,
    attachments: normalizeFolder(attachments) || DEFAULT_FOLDERS.attachments,
  };
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(cleaned));
  return cleaned;
}

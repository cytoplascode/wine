/* Writing the note and its images into the vault, or handing them to the
 * browser's downloads when this browser cannot write to a folder. */

import * as vault from './vault.js';
import * as quickadd from './quickadd.js';
import { getMode } from './connection.js';
import {
  noteBasename,
  asciiBasename,
  uniqueBasename,
  buildNote,
  noteFilename,
  labelFilename,
  foodFilename,
} from './note.js';

export const WINES_FOLDER = 'wines';

export class PermissionNeeded extends Error {
  constructor() {
    super('The vault needs reconnecting before saving');
    this.name = 'PermissionNeeded';
  }
}

/**
 * Save one bottle.
 * Returns `{ mode: 'vault' | 'download', path }` for the folder and download
 * paths, or `{ mode: 'quickadd', path, photos }` — see saveViaQuickAdd.
 */
export async function save({ record, labelBlob, foodBlob, ocrText }) {
  if (getMode() === 'quickadd' && quickadd.isConfigured()) {
    return saveViaQuickAdd({ record, labelBlob, foodBlob, ocrText });
  }

  const status = await vault.status();

  if (status === 'unsupported' || status === 'none') {
    return download({ record, labelBlob, foodBlob, ocrText });
  }
  // Re-requesting access needs a user gesture, so this hands the decision back
  // to the caller rather than trying and silently failing.
  if (status !== 'granted') throw new PermissionNeeded();

  const directory = await vault.ensureDirectory(WINES_FOLDER);
  const basename = await uniqueBasename(
    await usableBasename(directory, noteBasename(record)),
    (candidate) => vault.fileExists(directory, noteFilename(candidate)),
  );

  const markdown = buildNote({ record, basename, hasFood: Boolean(foodBlob), ocrText });

  await vault.writeFile(directory, labelFilename(basename), labelBlob);
  if (foodBlob) await vault.writeFile(directory, foodFilename(basename), foodBlob);
  // The note goes last, so a link can never point at an image that is not there.
  await vault.writeFile(directory, noteFilename(basename), markdown);

  const vaultName = vault.getVaultName();
  const prefix = vaultName ? `${vaultName}/` : '';
  return { mode: 'vault', path: `${prefix}${WINES_FOLDER}/${noteFilename(basename)}` };
}

/**
 * Fire the note straight into Obsidian — no prompt, since both the target
 * path and the content ride in as named values. The photos cannot follow
 * the same way (see quickadd.js), so this hands the caller a small worklist
 * instead of writing them itself: one entry per photo, each the blob to put
 * on the clipboard and the URI that opens Obsidian ready to receive it.
 */
function saveViaQuickAdd({ record, labelBlob, foodBlob, ocrText }) {
  const config = quickadd.getConfig();
  const basename = noteBasename(record);
  const markdown = buildNote({ record, basename, hasFood: Boolean(foodBlob), ocrText });
  const notePath = `${WINES_FOLDER}/${noteFilename(basename)}`;

  location.href = quickadd.noteUri(config, notePath, markdown);

  const photos = [
    { label: 'Label photo', blob: labelBlob, uri: quickadd.imageUri(config, `${WINES_FOLDER}/${labelFilename(basename)}`) },
  ];
  if (foodBlob) {
    photos.push({ label: 'Food photo', blob: foodBlob, uri: quickadd.imageUri(config, `${WINES_FOLDER}/${foodFilename(basename)}`) });
  }

  return { mode: 'quickadd', path: notePath, photos };
}

/**
 * Keep the accented name where the file system will take it, and fold it down
 * to ASCII only where it will not.
 *
 * A wine vault is full of "Château" and "Rioja Añejo", so stripping accents up
 * front would make every note title worse to avoid a problem most file systems
 * do not have. Instead, probe with a plain lookup: Chromium's origin-private
 * file system rejects non-ASCII names outright (TypeMismatchError), while a
 * real vault folder on Android or a desktop stores them happily.
 */
async function usableBasename(directory, preferred) {
  try {
    await vault.fileExists(directory, noteFilename(preferred));
    return preferred;
  } catch (err) {
    if (err.name !== 'TypeMismatchError' && err.name !== 'TypeError') throw err;
    return asciiBasename(preferred);
  }
}

/** Fallback for browsers without the File System Access API. */
function download({ record, labelBlob, foodBlob, ocrText }) {
  const basename = noteBasename(record);
  const markdown = buildNote({ record, basename, hasFood: Boolean(foodBlob), ocrText });

  saveBlob(new Blob([markdown], { type: 'text/markdown' }), noteFilename(basename));
  saveBlob(labelBlob, labelFilename(basename));
  if (foodBlob) saveBlob(foodBlob, foodFilename(basename));

  return { mode: 'download', path: noteFilename(basename) };
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

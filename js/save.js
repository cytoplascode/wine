/* Writing the note and its images into the vault, or handing them to the
 * browser's downloads when this browser cannot write to a folder. */

import * as vault from './vault.js';
import * as restVault from './rest-vault.js';
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
 * Returns `{ mode: 'vault' | 'download', path }`.
 */
export async function save({ record, labelBlob, foodBlob, ocrText }) {
  if (getMode() === 'rest' && restVault.isConfigured()) {
    return saveViaRest({ record, labelBlob, foodBlob, ocrText });
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
 * Obsidian's own filesystem has no trouble with accented names, so unlike the
 * folder backend this never needs the ASCII-folding probe — that exists only
 * for Chromium's own origin-private file system.
 */
async function saveViaRest({ record, labelBlob, foodBlob, ocrText }) {
  const config = restVault.getConfig();
  const basename = await uniqueBasename(
    noteBasename(record),
    (candidate) => restVault.fileExists(config, `${WINES_FOLDER}/${noteFilename(candidate)}`),
  );

  const markdown = buildNote({ record, basename, hasFood: Boolean(foodBlob), ocrText });

  await restVault.writeFile(config, `${WINES_FOLDER}/${labelFilename(basename)}`, labelBlob, 'image/jpeg');
  if (foodBlob) {
    await restVault.writeFile(config, `${WINES_FOLDER}/${foodFilename(basename)}`, foodBlob, 'image/jpeg');
  }
  // The note goes last, so a link can never point at an image that is not there.
  await restVault.writeFile(
    config,
    `${WINES_FOLDER}/${noteFilename(basename)}`,
    markdown,
    'text/markdown',
  );

  return { mode: 'vault', path: `${WINES_FOLDER}/${noteFilename(basename)}` };
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

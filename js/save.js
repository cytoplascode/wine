/* Writing the note and its images into the vault, or handing them to the
 * browser's downloads when this browser cannot write to a folder. */

import * as vault from './vault.js';
import * as quickadd from './quickadd.js';
import { getMode, getFolders } from './connection.js';
import { photoDataUri, CLIPBOARD_BUDGET } from './ui.js';
import {
  noteBasename,
  asciiBasename,
  uniqueBasename,
  buildNote,
  noteFilename,
  labelFilename,
  foodFilename,
} from './note.js';

export class PermissionNeeded extends Error {
  constructor() {
    super('The vault needs reconnecting before saving');
    this.name = 'PermissionNeeded';
  }
}

/**
 * Save one bottle.
 * Returns `{ mode: 'vault' | 'download', path }` for the folder and download
 * paths, or `{ mode: 'quickadd', path, sent, … }` — see saveViaQuickAdd.
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

  const { notes: notesFolder, attachments: attachmentsFolder } = getFolders();
  const directory = await vault.ensureDirectory(notesFolder);
  const attachmentsDirectory = attachmentsFolder === notesFolder
    ? directory
    : await vault.ensureDirectory(attachmentsFolder);

  const basename = await uniqueBasename(
    await usableBasename(directory, noteBasename(record)),
    (candidate) => vault.fileExists(directory, noteFilename(candidate)),
  );

  const markdown = buildNote({ record, basename, hasFood: Boolean(foodBlob), ocrText });

  await vault.writeFile(attachmentsDirectory, labelFilename(basename), labelBlob);
  if (foodBlob) await vault.writeFile(attachmentsDirectory, foodFilename(basename), foodBlob);
  // The note goes last, so a link can never point at an image that is not there.
  await vault.writeFile(directory, noteFilename(basename), markdown);

  const vaultName = vault.getVaultName();
  const prefix = vaultName ? `${vaultName}/` : '';
  return { mode: 'vault', path: `${prefix}${notesFolder}/${noteFilename(basename)}` };
}

/**
 * Hand the whole bottle over in one parcel: the note and every photo go onto
 * the clipboard as JSON, and one link runs the macro that unpacks it. The
 * photos share the clipboard's budget, so a bottle with a food photo squeezes
 * each a little harder than one without.
 *
 * Because the macro does the writing, at the paths named here, the photos get
 * exactly the filenames the note's own `Label::` and `Food::` embeds point at
 * — the same names the folder backend writes.
 *
 * The clipboard write can be refused if the tap that started this has already
 * expired, so the result says whether it landed; the caller offers a retry
 * rather than leaving the bottle half-sent.
 */
async function saveViaQuickAdd({ record, labelBlob, foodBlob, ocrText }) {
  const { notes: notesFolder, attachments: attachmentsFolder } = getFolders();
  const config = quickadd.getConfig();
  const basename = noteBasename(record);
  const markdown = buildNote({ record, basename, hasFood: Boolean(foodBlob), ocrText });
  const notePath = `${notesFolder}/${noteFilename(basename)}`;

  const blobs = [{ path: `${attachmentsFolder}/${labelFilename(basename)}`, blob: labelBlob }];
  if (foodBlob) blobs.push({ path: `${attachmentsFolder}/${foodFilename(basename)}`, blob: foodBlob });

  const share = Math.floor((CLIPBOARD_BUDGET - markdown.length) / blobs.length);
  const photos = [];
  let reduced = false;
  for (const entry of blobs) {
    const encoded = await photoDataUri(entry.blob, share);
    reduced = reduced || encoded.reduced;
    photos.push({ path: entry.path, dataUri: encoded.dataUri });
  }

  const payload = quickadd.buildPayload({ notePath, content: markdown, photos });
  const uri = quickadd.macroUri(config);

  try {
    await navigator.clipboard.writeText(payload);
  } catch {
    return { mode: 'quickadd', path: notePath, sent: false, payload, uri, reduced };
  }

  location.href = uri;
  return { mode: 'quickadd', path: notePath, sent: true, reduced };
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

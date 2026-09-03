/* Handing a whole bottle to Obsidian's QuickAdd plugin in one go — the only
 * channel that can reach a vault Android's folder picker cannot browse into
 * at all (its own "App Storage"), since Obsidian does the writing itself
 * once the link wakes it up. No permission on either side, and no server:
 * `obsidian://` is a plain OS-level hand-off.
 *
 * Everything travels on the clipboard rather than in the link. A URI cannot
 * carry an image, and on Android it cannot carry much of anything: the whole
 * thing crosses as an intent, with a size limit no one documents and every
 * phone enforces differently. Clipboard *text*, though, Obsidian's Android
 * WebView reads back happily — that much was tested rather than assumed,
 * after reading an image off the clipboard turned out to be impossible.
 *
 * So the link carries nothing but which choice to run, the clipboard carries
 * one JSON parcel with the note and both photos, and a single macro on the
 * other side unpacks it. One tap, one choice to set up, and — because the
 * script does the writing — the photos get exactly the filenames the note's
 * `Label::` and `Food::` embeds already point at.
 */

const CONFIG_KEY = 'label-scanner-quickadd-config';

/** { vault, choice } — both required to be usable. */
export function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY));
  } catch {
    return null;
  }
}

export function setConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function isConfigured() {
  const c = getConfig();
  return Boolean(c && c.vault && c.choice);
}

/**
 * The link that runs the macro. It carries no data at all — everything is on
 * the clipboard — so it stays short whatever the bottle.
 *
 * encodeURIComponent rather than URLSearchParams: the latter encodes a space
 * as `+`, the form-encoding convention, which a URI parser has no reason to
 * read back as a space. `%20` is what survives the trip.
 */
export function macroUri(config) {
  const pairs = [['vault', config.vault], ['choice', config.choice]];
  return `obsidian://quickadd?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

/**
 * The parcel the macro unpacks: the note, then a file per photo. Its shape is
 * a promise to the user script on the other side, so it is versioned — an
 * older script meeting a newer parcel should say so rather than guess.
 */
export function buildPayload({ notePath, content, photos }) {
  return JSON.stringify({
    v: 1,
    note: { path: notePath, content },
    files: photos.map((photo) => ({ path: photo.path, data: photo.dataUri })),
  });
}

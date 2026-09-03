/* Firing Obsidian's QuickAdd plugin by URI — the one channel that can reach
 * a vault Android's folder picker cannot browse into at all (its own "App
 * Storage"), since Obsidian handles the write itself once the URI wakes it
 * up. No permission needed on either side, and no server: `obsidian://` is
 * a plain OS-level hand-off.
 *
 * QuickAdd only skips its input prompt for a *named* value — a plain
 * unnamed `{{VALUE}}` always stops and asks, by design (confirmed against
 * the plugin itself, not assumed). Both values here are named, so both
 * links run without anything to tap.
 *
 * A URI cannot carry an image, and Obsidian's Android WebView cannot read
 * one off the clipboard either — both tested rather than guessed. What it
 * *can* read is clipboard text, so a photo crosses as a base64 data URI
 * put there by the caller, and the choice this fires is a macro whose user
 * script decodes it and writes the file at the path named here. That path
 * is why the note's `Label::` and `Food::` embeds can point at real
 * filenames: the script is told exactly what to call the file.
 *
 * There is no collision check here, unlike the folder backend — a URI is
 * one-way, with no way to ask Obsidian "does this file already exist"
 * first. Two notes with the same composed name will collide however the
 * choice itself is set to handle that.
 */

const CONFIG_KEY = 'label-scanner-quickadd-config';

/** { vault, noteChoice, imageChoice } — all three required to be usable. */
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
  return Boolean(c && c.vault && c.noteChoice && c.imageChoice);
}

function buildUri(vault, choice, values) {
  const pairs = [['vault', vault], ['choice', choice]];
  for (const [name, value] of Object.entries(values)) pairs.push([`value-${name}`, value]);
  // encodeURIComponent, not URLSearchParams — URLSearchParams encodes a
  // space as `+`, which Obsidian's URI parser has no reason to read back
  // as a space. `%20` is what actually survives the trip.
  return `obsidian://quickadd?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

/** Creates (or overwrites) the note in one shot — no prompt, both values named. */
export function noteUri(config, path, content) {
  return buildUri(config.vault, config.noteChoice, { filename: path, content });
}

/** Runs the macro that decodes the clipboard's data URI into this exact path. */
export function imageUri(config, path) {
  return buildUri(config.vault, config.imageChoice, { filename: path });
}

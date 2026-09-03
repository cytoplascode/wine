/* Firing Obsidian's QuickAdd plugin by URI — the one channel that can reach
 * a vault Android's folder picker cannot browse into at all (its own "App
 * Storage"), since Obsidian handles the write itself once the URI wakes it
 * up. No permission needed on either side, and no server: `obsidian://` is
 * a plain OS-level hand-off.
 *
 * QuickAdd only skips its input prompt for a *named* value — a plain
 * unnamed `{{VALUE}}` always opens the box, by design (confirmed against
 * the plugin itself, not assumed). That is the whole reason the note and
 * the photos work differently here: the note's Capture uses named `content`
 * and `filename` values, so it runs with nothing to tap. A photo's Capture
 * also takes a named `filename` — so it lands in the right note — but its
 * *content* has to stay a plain unnamed `{{VALUE}}`, on purpose, since that
 * is what forces the paste box open: nothing reads an image off the
 * clipboard without an actual paste gesture, so a photo always needs one.
 *
 * There is also no collision check here, unlike the folder and REST
 * backends — a URI is one-way, with no way to ask Obsidian "does this file
 * already exist" first. Two notes with the same composed name will collide
 * however the Capture choice itself is set to handle that.
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

/** Opens Obsidian with the target file already chosen; the paste itself is manual. */
export function imageUri(config, path) {
  return buildUri(config.vault, config.imageChoice, { filename: path });
}

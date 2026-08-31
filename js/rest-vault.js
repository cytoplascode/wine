/* The connection to Obsidian's Local REST API plugin — an alternative to the
 * folder picker for a vault Android will not let a browser reach directly
 * (its own "App Storage", say, rather than a normal shared folder). The
 * plugin runs a small HTTP server inside Obsidian itself and writes with
 * Obsidian's own storage access, so nothing here ever touches the
 * filesystem — the usual scoped-storage wall never comes up.
 *
 * The API key sits in IndexedDB in plain text, the same trust level this app
 * already gives a folder handle: fine for a single-user device, not for
 * anything shared.
 */

import { idbGet, idbSet } from './idb.js';

const CONFIG_KEY = 'vault-rest-config';

let config = null; // { host, port, https, apiKey }

export const getConfig = () => config;

/** Load the remembered connection, if there is one. Does not test it. */
export async function restore() {
  try {
    config = (await idbGet(CONFIG_KEY)) || null;
  } catch {
    config = null;
  }
  return config;
}

export const isConfigured = () => Boolean(config);

function baseUrl(c) {
  return `${c.https ? 'https' : 'http'}://${c.host}:${c.port}`;
}

function authHeader(c) {
  return { Authorization: `Bearer ${c.apiKey}` };
}

/**
 * Try a connection without saving it, so a typo never overwrites one that
 * already works. `/vault/` requires the API key, so a 401 here means
 * "reachable, wrong key" rather than "not reachable" — worth telling apart,
 * since one is a typo and the other is Obsidian not running at all.
 */
export async function test(candidate) {
  let response;
  try {
    response = await fetch(`${baseUrl(candidate)}/vault/`, { headers: authHeader(candidate) });
  } catch {
    return 'unreachable';
  }
  if (response.status === 401) return 'unauthorized';
  return response.ok ? 'ok' : 'unreachable';
}

/** Test the candidate connection, and remember it once it actually works. */
export async function connect(candidate) {
  const result = await test(candidate);
  if (result === 'ok') {
    config = candidate;
    await idbSet(CONFIG_KEY, candidate);
  }
  return result;
}

export async function disconnect() {
  config = null;
  await idbSet(CONFIG_KEY, null);
}

/* ── Writing ────────────────────────────────────────────────────────────
 *
 * These take the connection explicitly rather than reading the module-level
 * `config`, on purpose: it keeps the actual HTTP conversation free of
 * IndexedDB, which is what lets it run — and be tested — outside a browser.
 * `connect`/`disconnect` above are the only two functions that touch
 * storage. */

function vaultUrl(c, path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl(c)}/vault/${encoded}`;
}

/** A raw fetch failure (Obsidian closed, wrong host, no network) reads as an
 *  opaque "Failed to fetch" otherwise — worth naming what actually happened. */
async function request(c, path, options) {
  try {
    return await fetch(vaultUrl(c, path), options);
  } catch {
    throw new Error('Could not reach Obsidian — check it is open and the Local REST API server is on');
  }
}

export async function fileExists(c, path) {
  const response = await request(c, path, { headers: authHeader(c) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Obsidian answered ${response.status} checking ${path}`);
  return true;
}

export async function writeFile(c, path, data, contentType) {
  const response = await request(c, path, {
    method: 'PUT',
    headers: { ...authHeader(c), 'Content-Type': contentType },
    body: data,
  });
  if (!response.ok) throw new Error(`Obsidian answered ${response.status} writing ${path}`);
}

/**
 * What the vault card should say for a given connection state. Pure, so the
 * copy and the branching can be tested without a browser.
 */
export function describe(state, candidate = config) {
  switch (state) {
    case 'ok':
      return {
        dot: 'ok',
        text: `Connected to Obsidian at ${candidate.host}:${candidate.port}.`,
        button: ['Disconnect', 'disconnect'],
      };
    case 'unauthorized':
      return {
        dot: 'err',
        text: 'Obsidian answered, but refused the API key.',
        button: ['Try again', 'connect'],
      };
    case 'unreachable':
      return {
        dot: 'err',
        text: 'Could not reach Obsidian. Check it is open, on the same device, with the Local REST API server switched on.',
        button: ['Try again', 'connect'],
      };
    case 'none':
    default:
      return {
        dot: 'warn',
        text: 'Needs the Local REST API plugin enabled in Obsidian, with its API key below.',
        button: ['Connect', 'connect'],
      };
  }
}

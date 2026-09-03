import test from 'node:test';
import assert from 'node:assert/strict';

import { noteUri, imageUri } from '../js/quickadd.js';

/* noteUri/imageUri take the connection explicitly rather than reading
 * localStorage themselves — same reason as rest-vault.js's request
 * functions: it keeps the URI-building free of browser-only storage, which
 * is what lets it run under node --test. getConfig/setConfig, which do
 * touch localStorage, are exercised by hand instead, like vault.js's pick(). */

const config = { vault: 'My Vault', noteChoice: 'Note capture', imageChoice: 'Image capture' };

test('noteUri encodes spaces as %20, not the form-encoded +', () => {
  const uri = noteUri(config, 'wines/Test.md', 'hello');
  assert.match(uri, /vault=My%20Vault/);
  assert.match(uri, /choice=Note%20capture/);
  assert.doesNotMatch(uri, /\+/);
});

test('noteUri passes the path and content as named values', () => {
  const uri = noteUri(config, 'wines/Château Ausone - 2015.md', '---\nfoo: bar\n---');
  assert.match(uri, /value-filename=wines%2FCh%C3%A2teau%20Ausone%20-%202015\.md/);
  assert.match(uri, /value-content=---%0Afoo%3A%20bar%0A---/);
});

test('imageUri passes only the target path — content is deliberately not a named value', () => {
  const uri = imageUri(config, 'wines/Test.jpg');
  assert.match(uri, /choice=Image%20capture/);
  assert.match(uri, /value-filename=wines%2FTest\.jpg/);
  assert.doesNotMatch(uri, /value-content/);
});

test('both URIs target the obsidian://quickadd handler', () => {
  assert.match(noteUri(config, 'a.md', 'x'), /^obsidian:\/\/quickadd\?/);
  assert.match(imageUri(config, 'a.jpg'), /^obsidian:\/\/quickadd\?/);
});

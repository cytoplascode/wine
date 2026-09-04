import test from 'node:test';
import assert from 'node:assert/strict';

import { describe } from '../js/vault.js';

test('an unconnected vault offers to connect', () => {
  const card = describe('none');
  assert.equal(card.dot, 'warn');
  assert.deepEqual(card.button, ['Connect vault', 'pick']);
});

test('a working vault is named', () => {
  const card = describe('granted', 'MyVault');
  assert.equal(card.dot, 'ok');
  assert.match(card.text, /MyVault/);
  assert.deepEqual(card.button, ['Change vault', 'pick']);
});

test("a lapsed permission offers Reconnect rather than failing quietly", () => {
  // Chrome commonly answers 'prompt' on a later visit; re-requesting is only
  // allowed from a gesture, so this state must surface as a button.
  const card = describe('prompt', 'MyVault');
  assert.equal(card.dot, 'warn');
  assert.match(card.text, /MyVault/);
  assert.deepEqual(card.button, ['Reconnect vault', 'reconnect']);
});

test('a refusal is reported as an error, and recoverable', () => {
  const card = describe('denied', 'MyVault');
  assert.equal(card.dot, 'err');
  assert.deepEqual(card.button, ['Connect vault', 'pick']);
});

test('a browser without the API says so and hides the button', () => {
  const card = describe('unsupported');
  assert.equal(card.button, null);
  assert.match(card.text, /download/);
});

test('an unrecognised state degrades to the unconnected copy', () => {
  assert.deepEqual(describe('something-new'), describe('none'));
});

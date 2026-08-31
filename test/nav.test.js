import test from 'node:test';
import assert from 'node:assert/strict';

import { Nav } from '../js/nav.js';

/** Drive a Nav the way ui.js does: a jump is carried out by the browser, which
 *  comes back as a history event, so replay that here too. */
function app() {
  const nav = new Nav();
  const drawn = [];
  const go = (screen, arg) => {
    const plan = nav.go(screen, arg);
    if (plan.action === 'jump') {
      const target = nav.pop(nav.depth + plan.delta);
      if (target) drawn.push(target.screen);
      return plan;
    }
    drawn.push(screen);
    return plan;
  };
  const back = () => {
    const target = nav.pop(nav.depth - 1);
    if (target) drawn.push(target.screen);
    return target;
  };
  return { nav, drawn, go, back };
}

test('the first screen replaces, later ones push', () => {
  const { go } = app();
  assert.deepEqual(go('home'), { action: 'replace', depth: 0, screen: 'home', arg: undefined });
  assert.equal(go('capture', 'label').action, 'push');
  assert.equal(go('crop').action, 'push');
});

test('back walks the screens in the order they were opened', () => {
  const { go, back, drawn, nav } = app();
  go('home'); go('capture', 'label'); go('crop'); go('review');
  drawn.length = 0;

  back(); back(); back();
  assert.deepEqual(drawn, ['crop', 'capture', 'home']);
  assert.equal(nav.depth, 0);
});

test('back from the first screen has nowhere to go, so the app closes', () => {
  const { go, back } = app();
  go('home');
  assert.equal(back(), null, 'nothing to draw — the browser leaves the page');
});

test('going back to a visited screen unwinds instead of stacking a copy', () => {
  const { go, back, nav, drawn } = app();
  go('home'); go('capture', 'label'); go('crop'); go('review'); go('saved');
  drawn.length = 0;

  // "Done" on the saved screen.
  assert.deepEqual(go('home'), { action: 'jump', delta: -4 });
  assert.deepEqual(drawn, ['home']);
  assert.equal(nav.depth, 0);

  // …and one back press now leaves the app, rather than reopening the flow.
  assert.equal(back(), null);
});

test('the same screen with a different argument is a different screen', () => {
  const { go, back, drawn } = app();
  go('home'); go('capture', 'label'); go('crop'); go('review');
  drawn.length = 0;

  // Adding a food photo reopens the camera in its other mode, rather than
  // returning to the label camera and reusing its entry.
  assert.equal(go('capture', 'food').action, 'push');
  assert.deepEqual(go('review'), { action: 'jump', delta: -1 });
  assert.deepEqual(drawn, ['capture', 'review']);

  back();
  assert.equal(drawn.at(-1), 'crop', 'and back from review is still the crop screen');
});

test('arriving where you already are just redraws', () => {
  const { go, nav } = app();
  go('home'); go('capture', 'label');
  assert.deepEqual(go('capture', 'label'), { action: 'render', screen: 'capture', arg: 'label' });
  assert.equal(nav.stack.length, 2, 'and does not grow the stack');
});

test('somewhere new after going back drops the screens that were ahead', () => {
  const { go, nav } = app();
  go('home'); go('capture', 'label'); go('crop'); go('review');
  nav.pop(1);                                   // back to the camera

  assert.deepEqual(go('saved'), { action: 'push', depth: 2, screen: 'saved', arg: undefined });
  assert.deepEqual(nav.stack.map((e) => e.screen), ['home', 'capture', 'saved']);
});

test('a depth from outside the stack is clamped, not trusted', () => {
  const { go, nav } = app();
  go('home'); go('capture', 'label');

  nav.pop(0);
  assert.equal(nav.pop(99).screen, 'capture', 'clamped to the top');
  assert.equal(nav.pop(-3).screen, 'home', 'clamped to the bottom');
});

test('a history event that changes nothing draws nothing', () => {
  const { go, nav } = app();
  go('home'); go('capture', 'label');
  assert.equal(nav.pop(1), null, 'already at depth 1 — an overlay closing, say');
});

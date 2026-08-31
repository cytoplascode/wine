/* The screen stack behind the phone's back button.
 *
 * Pure on purpose: it touches no DOM and calls no history API, it just returns
 * the plan the caller should carry out. That is what makes the awkward cases
 * testable — returning to a screen already visited, arriving at the screen you
 * are already on, and a back press landing outside the stack.
 */

const same = (a, b) => (a ?? null) === (b ?? null);

export class Nav {
  constructor() {
    this.stack = [];
    this.depth = -1;
  }

  get current() { return this.stack[this.depth] || null; }

  /**
   * Plan a move to `screen`.
   *
   * A screen already on the stack is *returned to* rather than pushed again, so
   * "Done" on the saved screen unwinds all the way to home instead of burying a
   * second copy of it on top — and one more back press then leaves the app,
   * which is what a phone user expects. The same rule keeps the in-app back
   * arrows and the system back button in step: both walk the same stack.
   *
   * Returns one of:
   *   { action: 'replace', depth }  the first screen: no entry to push onto
   *   { action: 'push', depth }     somewhere new
   *   { action: 'jump', delta }     somewhere already visited; the resulting
   *                                 back/forward event drives `pop`
   *   { action: 'render' }          already there; just redraw it
   */
  go(screen, arg) {
    const at = this.stack.findIndex((e) => e.screen === screen && same(e.arg, arg));
    if (at === this.depth && at >= 0) return { action: 'render', screen, arg };
    // Leave `depth` alone: the jump's own history event is what moves it, and
    // moving it here would make that event look like a no-op.
    if (at >= 0) return { action: 'jump', delta: at - this.depth };

    this.stack = this.stack.slice(0, this.depth + 1);
    this.stack.push({ screen, arg });
    this.depth = this.stack.length - 1;
    return {
      action: this.depth === 0 ? 'replace' : 'push',
      depth: this.depth,
      screen,
      arg,
    };
  }

  /**
   * A back or forward press landed on `depth`. Returns the screen to draw, or
   * null when nothing moved — an out-of-range depth is clamped rather than
   * trusted, since it comes from a history entry the browser may have kept
   * across a reload.
   */
  pop(depth) {
    if (!this.stack.length) return null;
    const next = Math.min(Math.max(depth, 0), this.stack.length - 1);
    if (next === this.depth) return null;
    this.depth = next;
    return { ...this.stack[next], depth: next };
  }
}

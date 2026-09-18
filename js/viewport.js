/* How tall is the phone's screen, really?
 *
 * The app is a fixed frame, so its height has to match what the browser is
 * actually showing. Two things make that harder than it sounds on Android:
 *
 *  - Installed as a PWA the window is drawn edge to edge, and `100dvh` then
 *    includes the strip under the gesture navigation bar. Content placed
 *    there is covered by it — the footer buttons, in our case — and
 *    `env(safe-area-inset-bottom)` reports 0, so padding cannot rescue it.
 *  - A PWA starts briefly at full-screen height. The system bars are laid
 *    out a moment later and Chrome does not always re-fire a resize, so the
 *    viewport can stay stale for the whole session. Switching to another app
 *    and back forces the relayout, which is why doing that fixes it by hand.
 *
 * So the CSS takes the smaller of `100%` and `100dvh`, and this module
 * publishes `--app-h` as a further *cap* from what JavaScript can measure,
 * re-read on every event that follows a stale launch. Because the CSS uses
 * it inside a `min()`, a measurement that comes back too generous can only
 * ever be ignored, never make the frame taller.
 */

/** Everything that can tell us the height, smallest wins. */
function measure() {
  const heights = [window.innerHeight];
  if (window.visualViewport) heights.push(window.visualViewport.height);
  return Math.max(1, Math.min(...heights.filter((h) => h > 0)));
}

let applied = 0;

function apply() {
  const height = measure();
  // Sub-pixel churn on every scroll event would relayout the whole app.
  if (Math.abs(height - applied) < 1) return;
  applied = height;
  document.documentElement.style.setProperty('--app-h', `${height}px`);
}

export function startViewportWatch() {
  apply();

  for (const event of ['resize', 'orientationchange', 'pageshow']) {
    window.addEventListener(event, apply);
  }
  // Returning to the app is the moment a stale launch corrects itself.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) apply(); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', apply);
    window.visualViewport.addEventListener('scroll', apply);
  }

  // Catch-ups for the launch window itself, so the first correct height
  // arrives in the first second rather than when the user switches away.
  requestAnimationFrame(apply);
  setTimeout(apply, 250);
  setTimeout(apply, 1000);
}

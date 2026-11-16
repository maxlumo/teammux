// The app's OWN history.back() (board #111, leader note 20). A link in an HTML
// preview or the project page is a same-document fragment of its srcdoc; each
// click adds one joint-session-history entry, which the link router removes
// with history.back(). The app owns Back on Android and in the phone layout,
// so its one popstate router must never read that back() as a person's Back:
// the router marks it before calling, and the popstate router swallows exactly
// one event while the mark stands. Measured in rig Chromium and WebKit: no
// popstate reaches the app's window at all; the native WebViews are the
// owner's devices to check, which is why the guard exists.

let marked = 0;

/** Called right before the app's own history.back(); `until` bounds it (ms epoch). */
export function markOwnBack(until: number): void { marked = until; }

/** The link router saw the frame return (or gave up): the mark ends. */
export function clearOwnBack(): void { marked = 0; }

/** The popstate router asks first: true means "this one is ours", consumed. */
export function takeOwnBack(now = Date.now()): boolean {
  if (!marked || now > marked) { marked = 0; return false; }
  marked = 0;
  return true;
}

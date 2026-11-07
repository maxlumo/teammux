// The shell's height against the Android keyboard (board #56). Pure, so the
// rules are tested; App's keyboard effect is the only caller.

/**
 * The shell height for a native keyboard height `kbh` (CSS px, 0 = closed),
 * and the full height to remember. With the keyboard closed the full height IS
 * the window's current height: a larger value seen once (a rotation, split
 * screen, fullscreen) must not keep the shell taller than the screen, which
 * cut the composer and pushed the tab bar off the owner's phone. With it open,
 * the remembered full height less the keyboard: the full height, not the
 * window's current one, so a WebView that resized itself for the keyboard is
 * not subtracted from twice.
 */
export function nativeShellHeight(kbh: number, fullHeight: number, innerHeight: number): { height: number; fullHeight: number } {
  if (kbh <= 0) return { height: innerHeight, fullHeight: innerHeight };
  const full = Math.max(fullHeight, innerHeight);
  return { height: full - kbh, fullHeight: full };
}

/**
 * Undo a visual-viewport pan (board #56). An edge-to-edge WebView does not
 * resize for the keyboard: it pans the visual viewport to show the focused
 * input, and once the shell has shrunk to fit above the keyboard that pan
 * leaves the whole shell shifted up with the same gap under the composer.
 * `window.scrollTo(0, 0)` does not move a visual viewport inside a layout
 * viewport that cannot scroll (measured in Chromium); scrolling the shell's
 * own box into view does. True when it scrolled.
 */
export function unpanShell(
  vv: { offsetTop: number } | null | undefined,
  shell: { scrollIntoView(options: ScrollIntoViewOptions): void } | null | undefined,
): boolean {
  if (!vv || !shell || !(vv.offsetTop > 0)) return false;
  shell.scrollIntoView({ block: 'start', inline: 'nearest' });
  return true;
}

/**
 * Does this WebView resize the visual viewport for the keyboard itself (board
 * #56 round 2)? Android's "Understand window insets in WebView" (updated
 * 2026-10-28): from M139 it does, so the app sizing the shell from
 * MainActivity's native keyboard height as well would handle the keyboard
 * twice. Such a WebView takes the browser's visualViewport path, the one the
 * owner's phone browser shows right; an older one, or a user agent with no
 * Chrome version, keeps the native path.
 */
export function webviewSizesForKeyboard(userAgent: string): boolean {
  const major = Number((userAgent.match(/Chrome\/(\d+)/u) || [])[1]);
  return Number.isFinite(major) && major >= 139;
}

/**
 * Is the keyboard up, by the visual viewport against the CURRENT layout
 * viewport (board #56 round 3)? A WebView or browser that resizes the visual
 * viewport for the keyboard leaves `innerHeight` whole, so the difference is
 * the keyboard. A window that itself shrank (split screen, a rotation) shrinks
 * both, and is no keyboard. validator-2 measured the old rule, a remembered
 * maximum, reading a closed-keyboard window shrink 844 -> 640 as keyboard-open
 * and hiding the tab bar (WebView 144).
 */
export function viewportKeyboard(vvHeight: number, innerHeight: number, threshold: number): { open: boolean; kbHeight: number } {
  const kb = innerHeight - vvHeight;
  return kb > threshold ? { open: true, kbHeight: kb } : { open: false, kbHeight: 0 };
}

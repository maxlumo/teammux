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

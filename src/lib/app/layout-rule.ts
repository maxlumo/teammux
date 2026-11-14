// Auto's layout rule, pure (board #124; app-shell.md § Layout and input).
// `layout.svelte.ts` feeds it the live viewport; tests feed it the owner's screens.

/** The viewport's smallest side, in CSS px, from which Auto starts the desktop
 * layout: Android's own tablet rule (sw600dp), so it does not flip on rotation
 * and names no device's resolution. A foldable's outer screen is ≈360-430 on
 * that side (phone), its inner screen ≈640-880 (desktop; the owner's measured
 * 717 × 776). The ONE place the number lives (leader, #124 note 2); it stays a
 * hypothesis until the owner's own screens are read (Settings → About → Screen). */
export const PHONE_BELOW = 600;

/** Auto's ONE decision, pure: the phone layout when the screen's smallest side
 * is below `PHONE_BELOW`, and only on a screen that can be touched. A desktop
 * browser without touch keeps the desktop layout however its window is shaped
 * (its window's height is not a screen). */
export function autoPhone(width: number, height: number, touch: boolean): boolean {
  return touch && Math.min(width, height) < PHONE_BELOW;
}

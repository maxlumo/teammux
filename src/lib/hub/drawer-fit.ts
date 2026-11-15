// Board #132 (design record #131, leader's ruling 3): the Hub opens its drawer (Files,
// Terminal, Board) BESIDE the chat only when the chat keeps its head's minimum and the drawer
// its own; otherwise the drawer buttons open those pages, as the compact Hub already does.
//
// The variable is the available WIDTH, not the viewport's ratio or a breakpoint: at 776×717
// (a foldable's inner screen held landscape) every page fitted except Chat with its drawer
// open, because the grid let the chat column fall to 280 px while its head needs these
// minimums to keep the project name, its chevron, the path and the tools whole (measured in
// Chromium 148 on main 91538aff, #131 notes 1-2).

/** The chat head's minimum with a fine pointer (28 px tools). */
export const CHAT_HEAD_MIN_FINE = 324;
/** The chat head's minimum under a coarse pointer (44 px tools). */
export const CHAT_HEAD_MIN_COARSE = 414;
/** The drawer's own minimum: its SideHandle's clamp (Drawer.svelte, min 320). */
export const DRAWER_MIN = 320;

export const chatHeadMin = (coarse: boolean): number => (coarse ? CHAT_HEAD_MIN_COARSE : CHAT_HEAD_MIN_FINE);

/** Does the drawer fit beside the chat? `content` is the Hub's own width, `sidebar` the project
 * sidebar's width as it is now (0 collapsed). An unmeasured width claims no room. */
export function drawerFits({ content, sidebar, coarse }: { content: number; sidebar: number; coarse: boolean }): boolean {
  if (!(content > 0)) return false;
  return content - Math.max(0, sidebar) - chatHeadMin(coarse) >= DRAWER_MIN;
}

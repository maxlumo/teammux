/**
 * The hover card's ONE state (motion.md §2, board #86: "悬浮到 agent 卡片上，
 * 悬浮到侧边栏上的不同选项上等等，都动态给我展示一些信息"). A single fixed
 * card (`ui/HoverCard.svelte`, mounted once in App) shows whatever the
 * `hoverInfo` action last asked for; there is never a second tooltip
 * species, and a native `title` is removed wherever the card takes over.
 */
import type { AnchorRect } from './placement.ts';

export interface HoverLine { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' | 'accent' }
export interface HoverInfo {
  /** First line, the thing's name. */
  title?: string;
  /** One-line description under the title. */
  text?: string;
  /** label → value rows (state, model, path…). */
  lines?: HoverLine[];
  /** A quiet last line: a hint, a shortcut, an age. */
  note?: string;
}

interface Shown { anchor: AnchorRect; info: HoverInfo; align: 'left' | 'right'; live?: () => HoverInfo | null | undefined }

let shown = $state<Shown | null>(null);
/** When the last card hid — a hop between two neighbours reopens without the delay. */
let hiddenAt = 0;

export const hoverCard = {
  /** The card on screen. `info` is re-read through `live` (the action's
   * getter), so a card that is OPEN follows the state it describes (board
   * #323: the local server going from starting to embedded or failed). */
  get current(): Shown | null {
    if (!shown?.live) return shown;
    return { ...shown, info: shown.live() ?? shown.info };
  },
  show(anchor: AnchorRect, info: HoverInfo, align: 'left' | 'right' = 'left', live?: () => HoverInfo | null | undefined) {
    shown = { anchor, info, align, live };
  },
  hide() {
    if (shown) hiddenAt = Date.now();
    shown = null;
  },
  /** Whether the card on screen is the one this getter opened: the card closes itself (a key, a scroll,
   * a resize) without telling its opener, so a tap toggle asks here (board #124 note 26). */
  isShowing(live: (() => HoverInfo | null | undefined) | undefined): boolean { return !!live && shown?.live === live; },
  /** True right after a hide: the pointer is wandering between targets. */
  get warm(): boolean { return Date.now() - hiddenAt < 400; },
};

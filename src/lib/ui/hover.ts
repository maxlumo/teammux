/**
 * `use:hoverInfo={() => info}` — a rich hover card for an element (motion.md
 * §2, board #86). A mouse's dwell or a keyboard's focus opens it, in either
 * layout: a finger has no hover, and a long-press already means "menu"
 * (ui/longpress). Where the element has NO tap action of its own, its call
 * site says so (`{ get, tap: true }`) and under a coarse input a tap opens
 * the same card (board #124). Opens after a short
 * dwell (immediately when the pointer hops from a neighbouring card — the
 * reader is scanning), closes on leave, press, scroll, Escape and blur. The
 * getter runs at open time and again whenever what it reads changes while
 * the card is open, so the card always shows the CURRENT state.
 */
import { hoverCard, type HoverInfo } from './hover.svelte.ts';
import { anchorOf } from './placement.ts';
import { input } from '../app/layout.svelte.ts';
import { dwellFor } from './hover-dwell.ts';

export type HoverGetter = (() => HoverInfo | null | undefined) | null | undefined;
/** `{ get, tap: true }` for an element with NO tap action of its own (board #124,
 * leader notes 14-15): under a coarse input a tap opens the card hover opens, and
 * the next tap anywhere closes it. The call site declares it; it is never guessed. */
export type HoverSpec = HoverGetter | { get: HoverGetter; tap?: boolean };

const specOf = (s: HoverSpec): { get: HoverGetter; tap: boolean } =>
  typeof s === 'object' && s !== null && 'get' in s ? { get: s.get, tap: !!s.tap } : { get: s as HoverGetter, tap: false };

export function hoverInfo(node: HTMLElement, spec: HoverSpec) {
  let { get: getter, tap } = specOf(spec);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let open = false;
  let byTap = false;
  let mine: (() => HoverInfo | null | undefined) | undefined;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const away = (e: PointerEvent) => { if (!node.contains(e.target as Node)) hide(); };
  const hide = () => {
    clear();
    if (byTap) { byTap = false; document.removeEventListener('pointerdown', away, true); }
    if (open) { open = false; hoverCard.hide(); }
  };
  const show = () => {
    const info = getter?.();
    if (!info) return;
    const r = node.getBoundingClientRect();
    const align = r.left > window.innerWidth / 2 ? 'right' : 'left';
    open = true;
    const live = getter;
    mine = () => live?.();
    hoverCard.show(anchorOf(node), info, align, mine);
  };
  // A mouse's dwell or a keyboard's focus arms it, whatever the layout; a finger
  // never hovers (pointerType), so the layout is not asked (board #124).
  const arm = () => {
    if (!getter) return;
    clear();
    timer = setTimeout(show, dwellFor(hoverCard.warm));
  };
  const onEnter = (e: PointerEvent) => { if (e.pointerType === 'mouse') arm(); };
  // A lifted finger sends pointerleave before its click (board #124 note 26), which is not the pointer
  // moving away: a card the tap opened ignores it, so the next tap's click finds it open and closes it.
  const onLeave = (e: PointerEvent) => { if (byTap && e.pointerType !== 'mouse') return; hide(); };
  const onFocus = () => { if (node.matches(':focus-visible')) arm(); };
  const onDown = (e: PointerEvent) => { if (!(tap && input.coarse && e.pointerType !== 'mouse')) hide(); };
  // The tap opener: only where the call site said the tap is free, and only for a
  // finger; a second tap on it closes it, a tap elsewhere closes it (the capture
  // listener, the app's one outside-press rule for a light popover).
  const onTap = (e: MouseEvent) => {
    if (!tap || !input.coarse || (e as PointerEvent).pointerType === 'mouse') return;
    if (open && hoverCard.isShowing(mine)) { hide(); return; }
    hide(); // whatever this element still remembers of a card the card itself has closed
    show();
    if (open) { byTap = true; document.addEventListener('pointerdown', away, true); }
  };
  node.addEventListener('pointerenter', onEnter);
  node.addEventListener('pointerleave', onLeave);
  node.addEventListener('pointerdown', onDown);
  node.addEventListener('click', onTap);
  node.addEventListener('focus', onFocus);
  node.addEventListener('blur', hide);
  return {
    update(s: HoverSpec) { ({ get: getter, tap } = specOf(s)); },
    destroy() { hide(); node.removeEventListener('pointerenter', onEnter); node.removeEventListener('pointerleave', onLeave); node.removeEventListener('pointerdown', onDown); node.removeEventListener('click', onTap); node.removeEventListener('focus', onFocus); node.removeEventListener('blur', hide); },
  };
}

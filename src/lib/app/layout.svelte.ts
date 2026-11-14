// What the app SHOWS and what its INPUT can do: two definitions, one each
// (board #124, leader notes 9, 11; app-shell.md § Layout and input).
//
//   layout.phone   which layout is drawn: the phone UI (tab bar, sheets) or the
//                  desktop UI (rail, sidebars). The user's choice in Settings
//                  (Desktop, Mobile) wins; on Auto it follows the SCREEN.
//   input.coarse   whether the input is a finger: touch-sized targets, no
//                  hover (a hover card opens by tap where the tap is free).
//
// They used to be one flag, `isTouchDevice` = "has touch", so a foldable got
// the phone UI on its inner screen too, and a forced desktop layout on a
// touch screen was a combination no branch was written for (#123). Back is a
// third question with its own existing answer: the platform (`isAndroid`).
import { autoPhone } from './layout-rule.ts';

export type LayoutMode = 'auto' | 'desktop' | 'mobile';
const KEY = 'tmux_layout_mode';
const isValid = (v: unknown): v is LayoutMode => v === 'desktop' || v === 'mobile' || v === 'auto';
let initial: LayoutMode = 'auto';
try {
  const s = localStorage.getItem(KEY);
  if (isValid(s)) initial = s;
} catch {}
let mode = $state<LayoutMode>(initial);

const rawTouch =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);

// The viewport, followed live: a fold, an unfold, a rotation and a resized
// window all re-decide Auto without a reload.
let vw = $state(typeof window === 'undefined' ? 1280 : window.innerWidth);
let vh = $state(typeof window === 'undefined' ? 800 : window.innerHeight);
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { vw = window.innerWidth; vh = window.innerHeight; });
}

// A finger as the input: any pointer that is coarse (the CSS rule the app's
// touch-sized targets already use), else the touch capability itself.
const coarseQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(any-pointer: coarse)') : null;
let coarse = $state(coarseQuery ? coarseQuery.matches || rawTouch : rawTouch);
coarseQuery?.addEventListener?.('change', () => { coarse = coarseQuery.matches || rawTouch; });

export const layout = {
  /** Current mode: 'auto' | 'desktop' | 'mobile'. */
  get mode() {
    return mode;
  },
  /** Set and persist the mode. */
  set(v: LayoutMode) {
    if (!isValid(v)) return;
    mode = v;
    try {
      localStorage.setItem(KEY, v);
    } catch {}
  },
  /** The phone layout is drawn: the manual choice, else Auto's screen rule. */
  get phone() {
    if (mode === 'desktop') return false;
    if (mode === 'mobile') return true;
    return autoPhone(vw, vh, rawTouch || coarse);
  },
  /** True when the user explicitly forced desktop (split should ignore width). */
  get forceDesktop() {
    return mode === 'desktop';
  },
};

export const input = {
  /** The input is a finger: touch-sized targets, no hover (tap opens the card). */
  get coarse() {
    return coarse;
  },
};

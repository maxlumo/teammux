// When the Hub feed's turn rail is SHOWN (board #465, owner 2026-10-24 23:12: "不应该是
// 常驻显示的，应该是我在有手势或者在上下滚动的时候才动态出现的，如果停留一段时间就隐藏").
//
// Visibility is DERIVED (tenet 8), never declared: the rail is shown while any
// input is active, and for one dwell after the last of them ended. Two kinds of
// input, one timestamp:
//   - a PULSE (a scroll of the reader away from the tail) sets lastActive = now;
//   - a HOLD is a live fact for as long as it lasts (a probe is open, the band has
//     keyboard focus, a mouse is inside the rail's column). While any hold is on
//     the rail is shown; when the last one ends, lastActive = now, so the dwell is
//     counted from the END of the longest hold, never from when it began.
// "Never active" is null, not 0, so a clock that starts at 0 does not light it.
//
// One timer, here. The component renders a class from `onChange`; it owns no
// idle timer of its own (the dwell lives in app.css as --turn-rail-dwell).

export interface RailActivity {
  /** Any hold is on. */
  active: boolean;
  /** When the last pulse arrived or the last hold ended; null when there never was one. */
  lastActive: number | null;
}

/** The whole rule, pure. */
export const railVisible = ({ active, lastActive }: RailActivity, now: number, dwell: number): boolean =>
  active || (lastActive !== null && now - lastActive < dwell);

/** A CSS time (`1500ms`, `1.5s`) in milliseconds; NaN when it is not one. */
export function cssMilliseconds(value: string): number {
  const m = /^\s*(-?\d*\.?\d+)\s*(ms|s)\s*$/u.exec(value);
  return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : Number.NaN;
}

export type RailHold = 'probe' | 'focus' | 'entered';

export interface VisibilityEnv {
  /** The dwell in ms, read when a hide is scheduled (the CSS token is the one definition). */
  dwell: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  onChange: (shown: boolean) => void;
}

export function createRailVisibility(env: VisibilityEnv) {
  const now = env.now ?? (() => Date.now());
  const setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = env.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const holds = new Set<RailHold>();
  let lastActive: number | null = null;
  let shown = false;
  let timer: unknown = null;

  const stop = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const evaluate = () => {
    stop();
    const dwell = env.dwell();
    const next = railVisible({ active: holds.size > 0, lastActive }, now(), dwell);
    if (next !== shown) { shown = next; env.onChange(shown); }
    // Nothing to wait for while a hold is on (its end re-evaluates) or when already hidden.
    if (shown && holds.size === 0 && lastActive !== null) {
      timer = setTimer(() => { timer = null; evaluate(); }, Math.max(0, lastActive + dwell - now()));
    }
  };

  return {
    get shown() { return shown; },
    /** A scroll of the reader away from the tail. */
    nudge() { lastActive = now(); evaluate(); },
    /** A live fact starts or ends; its end starts the dwell. */
    hold(kind: RailHold, on: boolean) {
      if (on === holds.has(kind)) return;
      if (on) holds.add(kind);
      else { holds.delete(kind); lastActive = now(); }
      evaluate();
    },
    /** The reading context changed: the old pulse and timer decide nothing for the new one. */
    reset() { lastActive = null; evaluate(); },
    /** The rail's host is gone or closed: nothing is live and nothing is pending. */
    clear() { holds.clear(); lastActive = null; evaluate(); },
    dispose() { stop(); holds.clear(); lastActive = null; shown = false; },
  };
}

export type RailVisibility = ReturnType<typeof createRailVisibility>;

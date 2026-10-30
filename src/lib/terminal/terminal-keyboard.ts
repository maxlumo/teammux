const CSI_FINAL_KEYS: Record<string, string> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
};

const CSI_TILDE_KEYS: Record<string, number> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

const SS3_FUNCTION_KEYS: Record<string, string> = {
  F1: 'P',
  F2: 'Q',
  F3: 'R',
  F4: 'S',
};

function modifierParameter(event: KeyboardEvent): number {
  return 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0);
}

function printableKey(event: KeyboardEvent): string {
  if (event.key?.length === 1) return event.key;
  const letter = /^Key([A-Z])$/.exec(event.code || '');
  if (letter) return event.shiftKey ? letter[1]! : letter[1]!.toLowerCase();
  const digit = /^Digit([0-9])$/.exec(event.code || '');
  if (digit) return digit[1]!;
  return '';
}

function ctrlCharacter(key: string): string {
  if (!key || key.length !== 1) return '';
  const lower = key.toLowerCase();
  const code = lower.charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  if (key === ' ' || key === '@' || key === '`') return '\x00';
  if (key === '[' || key === '{') return '\x1b';
  if (key === '\\' || key === '|') return '\x1c';
  if (key === ']' || key === '}') return '\x1d';
  if (key === '^' || key === '~') return '\x1e';
  if (key === '_' || key === '?') return '\x1f';
  return '';
}

export function encodeTerminalShortcut(event: KeyboardEvent): string {
  if (event.metaKey || (!event.ctrlKey && !event.altKey)) return '';

  const modifier = modifierParameter(event);
  const final = CSI_FINAL_KEYS[event.key];
  if (final) return `\x1b[1;${modifier}${final}`;

  const tilde = CSI_TILDE_KEYS[event.key];
  if (tilde) return `\x1b[${tilde};${modifier}~`;

  const functionFinal = SS3_FUNCTION_KEYS[event.key];
  if (functionFinal) return `\x1b[1;${modifier}${functionFinal}`;

  const printable = printableKey(event);
  if (event.ctrlKey) {
    const control = ctrlCharacter(printable);
    if (control) return event.altKey ? `\x1b${control}` : control;
  }

  if (event.altKey && printable) return `\x1b${printable}`;
  if (event.altKey && event.key === 'Enter') return '\x1b\r';
  if (event.altKey && event.key === 'Backspace') return '\x1b\x7f';
  if (event.altKey && event.key === 'Tab') return '\x1b\t';
  return '';
}

// --- Double-tap (terminal-keyboard.md "Double-tap to open") -----------------
//
// Two CLEAN taps (the gesture machine classified both as `down` → release, not
// scroll / long-press / handle drag) within a short delay and a small distance
// open the keyboard. The pair rule is the app's ONE double-tap detector; it
// lives in ui/double-tap.ts beside longpress since board #484 (the Roster card
// uses it too) and is re-exported here for the terminal's own callers.

export { DOUBLE_TAP_MS, DOUBLE_TAP_SLOP_PX, createDoubleTapDetector } from '../ui/double-tap.ts';
export type { TapPoint, DoubleTapDetector } from '../ui/double-tap.ts';

// --- Ctrl one-shot (terminal-keyboard.md "The Ctrl one-shot expires") -------
//
// The shortcut bar's Ctrl arms a modifier for the NEXT letter typed on the
// system keyboard. It is a one-shot, not a latch: it releases when consumed,
// when tapped again, on pane switch, when the terminal loses focus, and — the
// part that was missing until 2026-09-03 — after CTRL_ONE_SHOT_MS on its own.

export const CTRL_ONE_SHOT_MS = 4000;

export interface OneShotModifier {
  readonly armed: boolean;
  /** Tap on the bar: arm (starting the expiry) or cancel. */
  toggle(): void;
  /** Release without consuming — pane switch, blur, teardown. Idempotent. */
  disarm(): void;
  /**
   * Route one typed string. A single letter becomes its C0 byte and releases
   * the modifier; anything else (digits, punctuation, multi-char IME commits,
   * paste) passes through untouched and leaves the arm alone.
   */
  apply(data: string): string;
}

export interface OneShotModifierOptions {
  ttlMs?: number;
  /** Reactive mirror for the template; called on every armed change. */
  onChange?: (armed: boolean) => void;
  /** Timer injection for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export function createOneShotCtrl(opts: OneShotModifierOptions = {}): OneShotModifier {
  const ttl = opts.ttlMs ?? CTRL_ONE_SHOT_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let armed = false;
  let timer: unknown = null;

  // One clock at most: clear before re-setting, so a stale expiry from an
  // earlier arm can never disarm a newer one.
  function set(next: boolean): void {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
    if (next) timer = setTimer(() => { timer = null; set(false); }, ttl);
    if (armed === next) return;
    armed = next;
    opts.onChange?.(armed);
  }

  return {
    get armed() {
      return armed;
    },
    toggle() {
      set(!armed);
    },
    disarm() {
      set(false);
    },
    apply(data) {
      if (!armed || data.length !== 1 || !/[a-z]/i.test(data)) return data;
      set(false);
      return String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
    },
  };
}

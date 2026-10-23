// The turn rail's INPUT PROTOCOL (board #461), apart from any DOM so every rule
// is a test. One owner of three kinds of intent:
//   hover  — a mouse/pen over the band: names a turn, nothing is held;
//   press  — one pointer's transaction (down .. up), MediaRange-shaped: it has
//            an id, a pointerId, and belongs to the generation it began in;
//   key    — the focused band's preview (Arrow/Home/End), no pointer at all.
// An intent only PREVIEWS. It never touches the reader's position or the
// anchor; the one way to a jump is commit(), which resolves the key against the
// CURRENT turns behind the host gate and the generation, then clears every
// intent BEFORE it asks the host to move, so a second release, click or Enter
// finds nothing to commit.
//
// The generation only moves forward and only by retire(), which the owner of a
// reading-context change CALLS at the change itself (a room selection, a new
// reading, a filter), never inferred from observed state: an effect watching a
// boolean cannot see A→B→A inside one flush, a counter cannot be fooled.
import { scrubDown, scrubIndex, scrubMove, stepTurn, turnsSig } from './hub-turns.ts';

export interface Rect { left: number; top: number; right: number; bottom: number }
export type Landing = 'moved' | 'in-view' | 'missing';
export type Source = 'press' | 'key' | 'row';

export interface RailHost {
  /** The loaded feed's turns, live. */
  turns(): readonly { key: string }[];
  /** The key of the turn the anchor currently selects, or ''. The rail only reads it. */
  current(): string;
  /** The host gate: shown, the room settled, two turns or more. */
  live(): boolean;
  /** The band's hit rectangle in client pixels, or null when it is not laid out. */
  band(): Rect | null;
  /** How far past the band's inner edge the fine scrub keeps slowing down. */
  reach(rect: Rect): number;
  /** The ONE jump. */
  jump(key: string): Landing;
  capture(pointerId: number): void;
  release(pointerId: number): void;
}

interface Intent {
  kind: 'hover' | 'press' | 'key';
  key: string;
  gen: number;
  sig: string;
  rect: Rect;
  pointerId?: number;
  q?: number;
  y?: number;
}

export interface RailView {
  open: boolean;
  /** The previewed turn's key ('' when closed). */
  key: string;
  kind: Intent['kind'] | null;
}

export interface PointerIn { id: number; type: string; x: number; y: number; button?: number }

const sameRect = (a: Rect, b: Rect): boolean =>
  Math.abs(a.left - b.left) <= 0.5 && Math.abs(a.right - b.right) <= 0.5
  && Math.abs(a.top - b.top) <= 0.5 && Math.abs(a.bottom - b.bottom) <= 0.5;

export function createTurnRail(host: RailHost, onchange: () => void = () => {}) {
  let gen = 0;
  let intent: Intent | null = null;
  /** Pointers whose transaction ended while the pointer is still down: their
   * remaining events (moves, the release, a trailing click) are not ours. */
  const dead = new Set<number>();

  const geom = (r: Rect) => ({ top: r.top, height: r.bottom - r.top, edge: r.right, reach: host.reach(r) });
  // The key string is rebuilt only when the turns array itself is replaced (a
  // poll hands a new array with the same keys), not on every pointer move.
  let memo: { turns: readonly { key: string }[]; sig: string } | null = null;
  const sig = () => {
    const turns = host.turns();
    if (memo?.turns !== turns) memo = { turns, sig: turnsSig(turns) };
    return memo.sig;
  };
  const indexOf = (key: string) => host.turns().findIndex((t) => t.key === key);

  /** The synchronous guard at the entry of every handler and of commit. */
  function admitted(i: Intent | null): i is Intent {
    if (!i || i.gen !== gen || !host.live()) return false;
    if (sig() !== i.sig) return false;
    const r = host.band();
    return !!r && sameRect(r, i.rect);
  }

  function set(next: Intent | null) {
    intent = next;
    onchange();
  }

  /** End an intent without a jump. A press's pointer may still be down, so its
   * remaining events are marked dead until its own terminal event. */
  function drop(markDead: boolean) {
    const i = intent;
    if (!i) return;
    if (i.kind === 'press' && i.pointerId !== undefined) {
      if (markDead) dead.add(i.pointerId);
      host.release(i.pointerId);
    }
    set(null);
  }

  function open(kind: 'hover' | 'key', index: number): void {
    const turns = host.turns(), rect = host.band();
    if (!rect || index < 0 || index >= turns.length) { if (intent) drop(false); return; }
    set({ kind, key: turns[index]!.key, gen, sig: sig(), rect });
  }

  const absoluteIndex = (y: number, rect: Rect) =>
    scrubIndex(scrubDown(y, host.turns().length, geom(rect)), host.turns().length);

  function commit(key: string, source: Source): Landing | null {
    const i = intent;
    if (!admitted(i)) { if (i) drop(true); return null; }
    if (source === 'press' ? i.kind !== 'press' : i.kind === 'press') return null;
    // A press and the keyboard commit the previewed turn; a popover row may be
    // the probed turn or the neighbour listed beside it.
    const at = indexOf(key), probed = indexOf(i.key);
    if (at < 0 || probed < 0 || (source === 'row' ? Math.abs(at - probed) > 1 : at !== probed)) {
      drop(true);
      return null;
    }
    const id = i.pointerId;
    set(null);                       // every intent is gone BEFORE the host moves
    if (id !== undefined) host.release(id);
    return host.jump(key);
  }

  return {
    /** Move the generation forward: the reading context this rail was
     * previewing is not the one on screen any more. */
    retire() {
      gen++;
      if (intent) drop(true);
    },
    get gen() { return gen; },
    view(): RailView {
      return intent ? { open: true, key: intent.key, kind: intent.kind } : { open: false, key: '', kind: null };
    },

    pointerMove(p: PointerIn) {
      if (dead.has(p.id) || !host.live()) return;
      const i = intent;
      if (i?.kind === 'press') {
        if (p.id !== i.pointerId) return;            // another finger can neither steer nor commit
        if (!admitted(i)) { drop(true); return; }     // the ground moved: no remap under the finger
        const turns = host.turns();
        const q = scrubMove(i.q!, p.y - i.y!, p.x, turns.length, geom(i.rect));
        const key = turns[scrubIndex(q, turns.length)]!.key;
        set({ ...i, q, y: p.y, key });
        return;
      }
      if (p.type === 'touch') return;                 // a touch has no hover
      const rect = host.band();
      if (!rect) { if (i) drop(false); return; }
      open('hover', absoluteIndex(p.y, rect));
    },

    pointerDown(p: PointerIn) {
      dead.delete(p.id);                              // a new press ends whatever that id left behind
      if (p.button !== undefined && p.button !== 0) return;
      if (intent?.kind === 'press') return;           // one transaction at a time
      const turns = host.turns(), rect = host.band();
      if (!host.live() || !rect || turns.length === 0) return;
      const q = scrubDown(p.y, turns.length, geom(rect));
      host.capture(p.id);
      set({ kind: 'press', key: turns[scrubIndex(q, turns.length)]!.key, gen, sig: sig(), rect, pointerId: p.id, q, y: p.y });
    },

    /** Returns the landing when the release committed a jump. */
    pointerUp(p: PointerIn): Landing | null {
      if (dead.delete(p.id)) return null;
      const i = intent;
      if (i?.kind !== 'press' || p.id !== i.pointerId) return null;
      if (!admitted(i)) { drop(false); return null; }
      return commit(i.key, 'press');
    },

    /** pointercancel: the system took the pointer. Nothing is sought. */
    pointerCancel(id: number) {
      dead.delete(id);
      if (intent?.kind === 'press' && intent.pointerId === id) drop(false);
    },

    /** lostpointercapture without our own release first: the press is over,
     * the pointer may still be down. */
    lostCapture(id: number) {
      if (intent?.kind === 'press' && intent.pointerId === id) drop(true);
    },

    /** The pointer left both the band and the popover. */
    leave() { if (intent?.kind === 'hover') set(null); },

    /** A press anywhere else closes a preview; it never steals focus. */
    outsidePress() { if (intent && intent.kind !== 'press') set(null); },

    /** A click on a popover row (mouse). */
    rowClick(key: string): Landing | null {
      if (!intent || intent.kind === 'press') return null;
      return commit(key, 'row');
    },

    /** The band got keyboard focus the way a keyboard gives it. */
    focus() {
      if (!host.live() || intent) return;
      const turns = host.turns();
      const cur = indexOf(host.current());
      open('key', cur >= 0 ? cur : turns.length - 1);
    },

    blur() { if (intent?.kind === 'key') set(null); },

    /** Returns true when the key is the rail's, so the host stops it scrolling the feed. */
    key(name: string, repeat = false): boolean {
      const handled = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'Escape'];
      if (!handled.includes(name)) return false;
      if (name === 'Escape') {
        if (!intent) return false;
        drop(true);
        return true;
      }
      if (!host.live()) return true;
      if (intent?.kind === 'press') return true;      // a held pointer owns the rail
      const turns = host.turns();
      if (intent && !admitted(intent)) { drop(false); }
      if (name === 'Enter' || name === ' ') {
        if (repeat) return true;
        if (intent) commit(intent.key, 'key');
        else {
          const cur = indexOf(host.current());
          open('key', cur >= 0 ? cur : turns.length - 1);
        }
        return true;
      }
      const from = intent ? indexOf(intent.key) : indexOf(host.current());
      if (name === 'Home') open('key', 0);
      else if (name === 'End') open('key', turns.length - 1);
      else open('key', stepTurn(turns.length, from, name === 'ArrowUp' ? -1 : 1));
      return true;
    },

    dispose() { gen++; if (intent) drop(true); dead.clear(); },
  };
}

export type TurnRail = ReturnType<typeof createTurnRail>;

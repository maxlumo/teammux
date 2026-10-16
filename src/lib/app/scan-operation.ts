// The lifetime of one QR scan (board #403, review round 2). A scan is an
// OPERATION with an owner, registered synchronously at the tap, before any
// await, and distinct from whether its preview is visible: a camera permission
// prompt, a plugin load and a getUserMedia call are all part of it long before
// anything is on screen. Back, the background, Cancel, a second tap and the
// owner form's teardown all end it, and an ended operation can neither return
// text nor clear or fill its successor: every step that comes back from an await
// asks `op.ended` first.
//
// "Ended" is a promise to the person ("nothing from this will arrive"), and the
// resources it held are released by what registered them with `onEnd`: the
// camera, the plugin, the stream. Ending runs those once.

export interface ScanOp {
  /** Who asked: only that form's teardown ends it. */
  readonly owner: string;
  readonly ended: boolean;
  /** Run `release` when the operation ends (at once if it already has). */
  onEnd(release: () => void): void;
  /** End the operation, handing back `text` (null: nothing was scanned). Once. */
  end(text?: string | null): void;
}

export class ScanHost {
  #current: ScanOp | null = null;
  readonly #changed: (op: ScanOp | null) => void;

  constructor(changed: (op: ScanOp | null) => void = () => {}) {
    this.#changed = changed;
  }

  get current(): ScanOp | null { return this.#current; }

  /** Register a new operation, ending the one in progress with nothing. */
  begin(owner: string): { op: ScanOp; result: Promise<string | null> } {
    this.#current?.end(null);
    let resolve!: (text: string | null) => void;
    const result = new Promise<string | null>((done) => { resolve = done; });
    const releases: Array<() => void> = [];
    let ended = false;
    const host = this;
    const op: ScanOp = {
      owner,
      get ended() { return ended; },
      onEnd(release) {
        if (ended) release(); else releases.push(release);
      },
      end(text = null) {
        if (ended) return;
        ended = true;
        host.#current = null;       // an ended operation is never the successor: begin() ends the old one first
        host.#changed(null);
        for (const release of releases.splice(0)) { try { release(); } catch { /* one release failing must not keep the others */ } }
        resolve(text);
      },
    };
    this.#current = op;
    this.#changed(op);
    return { op, result };
  }

  /** Back, the background, Cancel: end whatever is running. */
  end(): void { this.#current?.end(null); }

  /** The owner form went away. */
  endOwner(owner: string): void {
    if (this.#current?.owner === owner) this.#current.end(null);
  }
}

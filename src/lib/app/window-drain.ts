// The window's drain scheduler (board #335 ③b; reviewer P1-3 on 9c1f757c).
//
// The window — the one place a question can be asked or a focus handed over
// — owes work that must wait for the window to be free: a handover first,
// then an orphan's ask. App's `drain` does that work; THIS decides WHEN it
// runs and when it never runs again:
//
// - `schedule()` runs the drain on its own turn, once, whoever asked (a
//   walk ending, a lease released, Retry unblocking): the operation whose
//   end freed the window finishes its own continuation first — the walk's
//   answer reaches the caller that asked and that caller commits — before
//   the queue is looked at (P2 on e0dafe3c). One timer; a second ask while
//   it is pending is the same ask.
// - `lease()` holds the window for an operation outside the switch module
//   (an activation from its mint to its `done`, a candidate from open to
//   close). The release is idempotent and schedules the drain.
// - `end()` is the shell's end: nothing owed is done any more. A timer still
//   pending is cleared and does not run; a release landing late (a
//   candidate's close in the teardown, an activation's `finally` after the
//   root is gone, the switch module's `onidle`) schedules nothing; a
//   schedule after the end is refused. This is the third phase the App
//   harness could not order (reviewer 00:13 on 1125b5f4: the fake layer's
//   clearTimeout always ran after the late schedule) — `window-drain.test.ts`
//   pins it here, on the real scheduler, not on a copy.
//
// App is the only user; it uses this ONE instance for every ask, lease and
// the end, so the ordering proved here is the ordering it has.

export interface WindowDrain {
  /** Run the drain on its own turn; one timer, whoever asked; nothing after the end. */
  schedule(): void;
  /** Hold the window; the returned release is idempotent and schedules the drain. */
  lease(): () => void;
  /** Leases in flight (an activation or a candidate). */
  readonly leases: number;
  /** The shell has ended: no drain is scheduled or run any more. */
  readonly ended: boolean;
  /** End: clears a pending drain and refuses every later schedule. Idempotent. */
  end(): void;
}

export function createWindowDrain(drain: () => void): WindowDrain {
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let ended = false;
  let leases = 0;
  const schedule = () => {
    if (ended || timer) return;
    timer = setTimeout(() => {
      timer = 0;
      if (ended) return;
      drain();
    }, 0);
  };
  return {
    schedule,
    lease() {
      leases++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases--;
        schedule();
      };
    },
    get leases() { return leases; },
    get ended() { return ended; },
    end() {
      ended = true;
      if (timer) clearTimeout(timer);
      timer = 0;
    },
  };
}

// The ONE limit on file transfers in flight (board #134; owner 2026-11-16: '下载的时候，如果同时多个文件下载上传
// 之类的 控制并发数量 比如3 避免太多了异常。可以在设置里设定最大并发数量'). Every download (save-file.ts) and every
// upload (http-upload.ts) acquires a slot before it mints or opens anything that expires (a signed URL, an
// upload session) and releases it when it ends, whichever way. Pure: no DOM, no runes, no timers; the app's
// one instance and its setting live in transfers.svelte.ts.

/** A transfer gave up while it waited for a slot (its signal aborted): it never started. `reason` is the
 * signal's reason, so a server switch's SUSPEND reads the same as it does mid-transfer. */
export class TransferWaitCancelled extends Error {
  reason: unknown;
  constructor(reason: unknown) { super('cancelled while waiting'); this.reason = reason; }
}

export interface TransferSlots {
  /** Resolves with this transfer's release once a slot is free (at once while one is); FIFO. Rejects with
   * TransferWaitCancelled if `signal` aborts first, and that transfer leaves the line without a slot. */
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** A slot now, or null when the transfer would have to wait (nobody is let past the line). The caller
   * that gets null says it is waiting and then calls `acquire`. */
  tryAcquire(): (() => void) | null;
  /** A new limit, applied now: a higher one starts waiting transfers at once, a lower one never stops a
   * running one (new ones wait until fewer run). A value that is not a number is ignored. */
  setLimit(limit: number): void;
  readonly limit: number;
  readonly running: number;
  readonly waiting: number;
}

const whole = (n: number) => Math.max(1, Math.floor(n));

export function createTransferSlots(initial: number): TransferSlots {
  let limit = Number.isFinite(initial) ? whole(initial) : 1;
  let running = 0;
  const line: { start: () => void }[] = [];

  function pump() {
    while (running < limit && line.length) line.shift()!.start();
  }
  function grant(): () => void {
    running += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      running -= 1;
      pump();
    };
  }

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(new TransferWaitCancelled(signal.reason));
      if (running < limit && !line.length) return Promise.resolve(grant());
      return new Promise((resolve, reject) => {
        const entry = {
          start: () => { signal?.removeEventListener('abort', leave); resolve(grant()); },
        };
        const leave = () => {
          const at = line.indexOf(entry);
          if (at >= 0) line.splice(at, 1);
          reject(new TransferWaitCancelled(signal?.reason));
        };
        signal?.addEventListener('abort', leave, { once: true });
        line.push(entry);
      });
    },
    tryAcquire() {
      return running < limit && !line.length ? grant() : null;
    },
    setLimit(next) {
      if (!Number.isFinite(next)) return;
      limit = whole(next);
      pump();
    },
    get limit() { return limit; },
    get running() { return running; },
    get waiting() { return line.length; },
  };
}

// Board #107: the client half of an ask (board #106; docs/design-docs/features/asks.md,
// hub-feed.md § An ask is a bubble with its options). The room's ask rows, read from the
// server and repainted from what it answers; the chat's AskCard draws them, and ticket 2b's
// dashboard reuses both. Nothing here parses a message body: the row is the structure.
import type { AskClose, AskRow } from '../core/ws-api.ts';

/** A room message that is an ask: the server stores it with kind `ask`. */
export function isAsk(m: { kind?: unknown } | null | undefined): boolean {
  return m?.kind === 'ask';
}

/** The ask a closing line belongs to: its derived id is `ask:<seq>:close` (asks.md). */
export function closingSeq(m: { id?: unknown } | null | undefined): number | null {
  const hit = /^ask:(\d+):close$/u.exec(String(m?.id ?? ''));
  return hit ? Number(hit[1]) : null;
}

/** Where the asker is now, for "Discuss in chat" (leader's agreement on #107): a LIVE
 * managed agent of the room gets Reply armed; a declared-STOPPED one is refused by the one
 * reply entry (#490); one that is no agent of the room any more is GONE: no Reply, the card
 * says so, nothing restarts or queues. */
export type AskerState = 'live' | 'stopped' | 'gone';
export function askerState(name: string, agents: readonly { name: string; managed?: boolean }[], stopped: readonly string[]): AskerState {
  if (stopped.includes(name)) return 'stopped';
  return agents.some((a) => a.managed && a.name === name) ? 'live' : 'gone';
}

/** What the delivery path did with the closing line, in the card's words, BESIDE the
 * decision (never merged into it). `found` is typed or held for the asker (the server does
 * not tell the two apart); `unknown`/`unchecked` could not be confirmed. */
export type DeliveryWord = 'sent' | 'stopped' | 'gone' | 'unconfirmed';
export function deliveryWord(d: string | null | undefined): DeliveryWord | null {
  switch (d) {
    case null: case undefined: case '': return null;
    // `found` is typed into the asker's pane OR held until its turn ends or it restarts
    // (asks.md): handed to the delivery path, not a receipt (reviewer R2).
    case 'found': return 'sent';
    case 'stopped': return 'stopped';
    case 'gone': return 'gone';
    default: return 'unconfirmed';
  }
}

type Api = {
  hubAskList: (session: string, all?: boolean) => Promise<{ asks: AskRow[] }>;
  hubAskAnswer: (session: string, seq: number, option?: string, text?: string) => Promise<AskClose>;
  hubAskDismiss: (session: string, seq: number) => Promise<AskClose>;
};

/** The ONE merge of a newer read into a row this client holds: forward only (asks.md: open
 * until ONE act closes it). A closed row never turns open again, and within a closed row a
 * known delivery is never replaced by none (the server closes and pushes before it writes
 * delivery, so a snapshot can say answered with no delivery yet); a different, real
 * delivery does replace it (#107 F1, leader ruling). */
export function mergeAsk(seen: AskRow | undefined, next: AskRow): AskRow {
  if (!seen || seen.state === 'open') return next;
  if (next.state === 'open') return seen;
  return next.delivery == null && seen.delivery != null ? { ...next, delivery: seen.delivery } : next;
}

/** An answered or dismissed ask whose delivery the server has not recorded yet (a withdrawn
 * one is the asker's own act and delivers nothing). */
export type AskDraft = { text: string; tried?: string };

export const noDeliveryYet = (r: AskRow): boolean => (r.state === 'answered' || r.state === 'dismissed') && r.delivery == null;
const NULL_READS = 3;

/** One room's asks by seq. A read belongs to the room it was asked for: a late answer for a
 * room no longer shown is dropped (the #335 rule). */
export class AskBook {
  rows = $state<Record<number, AskRow>>({});
  /** The refusal a close got, per ask (`already answered at HH:MM`), until the next one. */
  refused = $state<Record<number, string>>({});
  busy = $state<Record<number, boolean>>({});
  /** Why a close never reached the server (the transport failed), per ask, until one lands. */
  errors = $state<Record<number, string>>({});
  /** The room's list was read (true), or its last read failed (`failed`): a missing row
   * then means the ask could not be loaded, never that the message is no ask. */
  loaded = $state(false);
  failed = $state(false);
  /** Asks a read begun knowing of them returned WITHOUT: these could not be loaded. An ask
   * the feed shows before any such read answered is only pending (#107 F5). */
  missing = $state<Record<number, boolean>>({});
  #asked = new Set<number>();
  /** The person's unsent words and the option they last tried, per ask (round 5): the
   * STORE's, so a card that unmounts (a socket loss clears the capability) comes back with
   * them; cleared once that ask's close lands, by anyone; dropped on a room change. */
  drafts = $state<Record<number, AskDraft>>({});
  /** One reconcile in flight; per closed row, the full reads made while its delivery was unknown. */
  #reconciling = false;
  #nullReads: Record<number, number> = {};
  #session = '';
  #gen = 0;
  #api: Api;
  constructor(api: Api) {
    this.#api = api;
  }

  /** Read the room's asks (every one: a closed ask still renders its outcome). */
  async load(session: string, expect: number[] = []): Promise<void> {
    if (session !== this.#session) {
      this.#session = session;
      this.rows = {};
      this.refused = {};
      this.busy = {};
      this.errors = {};
      this.drafts = {};
      this.missing = {};
      this.#asked = new Set();
      this.#nullReads = {};
      this.loaded = false;
      this.failed = false;
    }
    const gen = ++this.#gen;
    for (const seq of expect) this.#asked.add(seq);
    try {
      const { asks } = await this.#api.hubAskList(session, true);
      if (gen !== this.#gen || session !== this.#session) return;
      // A close is final (asks.md: open until ONE act closes it): a read that began before a
      // close landed carries the older open row, and never reopens what this client saw closed.
      const next: Record<number, AskRow> = {};
      for (const a of asks ?? []) next[a.seq] = mergeAsk(this.rows[a.seq], a);
      this.#setRows(next);
      const missing = { ...this.missing };
      for (const seq of this.#asked) if (!next[seq]) missing[seq] = true;
      this.missing = missing;
      this.#asked = new Set();
      this.loaded = true;
      this.failed = false;
    } catch {
      // A failed read keeps what was shown; the next push or open reads again.
      if (gen === this.#gen && session === this.#session) { this.failed = true; this.#asked = new Set(); }
    }
  }

  /** Bring loaded rows up to the room at one of its ordinary read boundaries (the feed poll, the
   * first read after a reconnect, the page shown again; reviewer R1). The steady state is ONE
   * read of the open set (the server filters it in SQL); a full read, the room-opening one, only
   * while a row needs it: a loaded-open ask the open set no longer lists (a missed close), an
   * answered or dismissed row with no delivery yet (the server records it after the close's
   * push; at most NULL_READS full reads per row), or a last read that failed. One in flight; a
   * read for another room, or one a newer load superseded, lands nowhere. */
  async reconcile(session: string): Promise<void> {
    if (this.#reconciling) return;
    this.#reconciling = true;
    try {
      if (session !== this.#session || !this.loaded || this.failed) { await this.load(session); return; }
      const gen = this.#gen;
      let open: AskRow[];
      try {
        open = (await this.#api.hubAskList(session, false)).asks ?? [];
      } catch {
        if (gen === this.#gen && session === this.#session) this.failed = true;
        return;
      }
      if (gen !== this.#gen || session !== this.#session) return;
      const listed = new Set(open.map((a) => a.seq));
      const rows = { ...this.rows };
      for (const a of open) rows[a.seq] = mergeAsk(rows[a.seq], a);
      this.#setRows(rows);
      const unknown = Object.values(rows).filter((r) => noDeliveryYet(r) && (this.#nullReads[r.seq] ?? 0) < NULL_READS);
      const missed = Object.values(rows).some((r) => r.state === 'open' && !listed.has(r.seq));
      if (!missed && !unknown.length) return;
      for (const r of unknown) this.#nullReads[r.seq] = (this.#nullReads[r.seq] ?? 0) + 1;
      await this.load(session);
    } finally {
      this.#reconciling = false;
    }
  }

  /** A draft belongs to an OPEN ask this store holds: for a closed or unknown one it is a no-op,
   * so no caller (a card re-rendered after another client's close) can restore it. */
  setDraft(seq: number, draft: AskDraft): void {
    if (this.rows[seq]?.state !== 'open') return;
    const cur = this.drafts[seq];
    if (cur && cur.text === draft.text && cur.tried === draft.tried) return;
    if (!draft.text && !draft.tried) { if (!cur) return; const next = { ...this.drafts }; delete next[seq]; this.drafts = next; return; }
    this.drafts = { ...this.drafts, [seq]: draft };
  }

  /** The ONE place rows are replaced: a row that is no longer open takes its draft with it. */
  #setRows(rows: Record<number, AskRow>): void {
    this.rows = rows;
    const done = Object.keys(this.drafts).map(Number).filter((seq) => rows[seq] && rows[seq].state !== 'open');
    if (!done.length) return;
    const next = { ...this.drafts };
    for (const seq of done) delete next[seq];
    this.drafts = next;
  }

  /** Read the room's asks if the feed shows one this book has no row for and no read has
   * yet answered for (one read at a time); null when nothing needs reading. */
  ensure(session: string, seqs: number[]): Promise<void> | null {
    const same = session === this.#session;
    const want = seqs.filter((s) => !same || (!this.rows[s] && !this.missing[s] && !this.#asked.has(s)));
    return want.length ? this.load(session, want) : null;
  }

  #apply(session: string, out: AskClose): void {
    if (session !== this.#session) return;
    this.#setRows({ ...this.rows, [out.ask.seq]: mergeAsk(this.rows[out.ask.seq], out.ask) });
    const refused = { ...this.refused };
    if (out.applied) delete refused[out.ask.seq];
    else refused[out.ask.seq] = out.refused ?? '';
    this.refused = refused;
  }

  /** True when the server answered (applied or refused); false when the call itself failed,
   * which is recorded in `errors` so the card keeps the person's words and says so. */
  async #close(seq: number, call: () => Promise<AskClose>): Promise<boolean> {
    const session = this.#session;
    this.busy = { ...this.busy, [seq]: true };
    // A settlement writes ONLY its own ask's error, on the map as it is now: a snapshot taken
    // before the await would erase another ask's newer result (code-quality.md § 1.4).
    const settle = (why?: string) => {
      if (session !== this.#session) return;
      const errors = { ...this.errors };
      if (why === undefined) delete errors[seq]; else errors[seq] = why;
      this.errors = errors;
    };
    try {
      this.#apply(session, await call());
      settle();
      return true;
    } catch (e) {
      settle(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      const busy = { ...this.busy };
      delete busy[seq];
      this.busy = busy;
    }
  }

  answer(seq: number, option?: string, text?: string): Promise<boolean> {
    const session = this.#session;
    return this.#close(seq, () => this.#api.hubAskAnswer(session, seq, option, text));
  }

  dismiss(seq: number): Promise<boolean> {
    const session = this.#session;
    return this.#close(seq, () => this.#api.hubAskDismiss(session, seq));
  }
}

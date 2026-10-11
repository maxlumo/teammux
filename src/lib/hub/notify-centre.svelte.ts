// The notification centre (board #322, owner 2026-10-09: "我经常听到「嘟嘟」的
// 通知了，但是都不知道是哪个窗口的提示…在整个界面设置一个通知中心，让我能看到到底
// 提示了什么…方便我快速定位到回复我的那条具体消息").
//
// A BOUNDED INDEX of alerts, not a second chat history: the room is the one
// record of what was said, and each entry here only names a message in it
// (room + seq + id) with a one-line excerpt to recognise it by. So:
// - Clearing removes entries only; it says nothing about whether any room is
//   read (the room's read mark is hubPrefs.seen, moved only by reading).
// - Viewing one entry never moves a room's read mark.
// - An entry is viewed when its jump landed on the message, or when its room
//   was read past it (markRoomRead), so a read room never leaves unviewed
//   alerts behind; a message that arrived while the reader was at that
//   room's visible tail is recorded already viewed.
// - The 50-entry cap evicts the oldest ENTRIES; a room's unread state is
//   unaffected (that is hub_unread's job).
// - It knows only what this running client received: nothing arrives while
//   the app is closed (notifications.md, the running-client limit).
//
// Per server: the list lives in `tmux_hub_alerts`, one of servers.ts
// RESIDENT_KEYS, in each server's own slot, and each runtime builds its own
// log over its server's store. Entries also carry the server id, and a
// jump request carries it too, so a late jump cannot act on another server.
import type { FeedMsg, NewsKind } from './notifications.ts';

export const ALERTS_KEY = 'tmux_hub_alerts';
export const CENTRE_CAP = 50;

export interface Alert {
  /** `room|id` — one entry per message. */
  key: string;
  server: string;
  room: string;
  session: string;
  project: string;
  seq: number;
  id: string;
  ts: number;
  from: string;
  /** `to` names the human (#289): emphasised, and the To-me filter's set. */
  toHuman: boolean;
  kind: NewsKind;
  excerpt: string;
  viewed: boolean;
  /** Why the last jump did not land (shown on the row; cleared on success). */
  failed?: string;
}

export interface JumpRequest { alert: Alert; n: number }

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Whether a stored entry is still a bell entry (board #334, `bellKind`):
 * a list written before #334 also held agent↔agent replies and unaddressed
 * notes. They are dropped on load; no room's read mark moves. */
export const bellEntry = (a: Pick<Alert, 'kind' | 'toHuman'>): boolean => a.kind === 'finished' || a.toHuman === true;

function read(storage: Store | null): Alert[] {
  try {
    const raw = JSON.parse(storage?.getItem(ALERTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((a) => a && typeof a.key === 'string' && typeof a.room === 'string' && bellEntry(a)).slice(0, CENTRE_CAP) : [];
  } catch { return []; }
}

/** Pure: the list after recording `alert` — newest first, one per key (a
 * second record of the same message keeps the first's viewed state unless the
 * new one is viewed), capped. Returns the same array when nothing changed. */
export function withAlert(list: readonly Alert[], alert: Alert, cap = CENTRE_CAP): Alert[] {
  const prev = list.find((a) => a.key === alert.key);
  if (prev && (prev.viewed || !alert.viewed)) return list as Alert[];
  const next = [{ ...alert, viewed: alert.viewed || !!prev?.viewed }, ...list.filter((a) => a.key !== alert.key)];
  next.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  return next.slice(0, cap);
}

/** Pure: every entry of `session` at or below `seq` is viewed. */
export function readThrough(list: readonly Alert[], session: string, seq: number): Alert[] {
  if (!list.some((a) => a.session === session && !a.viewed && a.seq > 0 && a.seq <= seq)) return list as Alert[];
  return list.map((a) => (a.session === session && !a.viewed && a.seq > 0 && a.seq <= seq ? { ...a, viewed: true, failed: undefined } : a));
}

export function alertOf(m: FeedMsg & { seq?: number; room?: string; to?: unknown }, ctx: {
  server: string; room: string; session: string; project: string; kind: NewsKind; viewed: boolean; excerpt: string;
}): Alert {
  const id = String(m.id ?? `${m.from ?? ''}:${m.ts ?? 0}`);
  return {
    key: `${ctx.room}|${id}`, server: ctx.server, room: ctx.room, session: ctx.session, project: ctx.project,
    seq: Number(m.seq) || 0, id, ts: m.ts ?? Date.now(), from: m.from ?? '',
    toHuman: Array.isArray(m.to) && m.to.includes('human'), kind: ctx.kind, excerpt: ctx.excerpt, viewed: ctx.viewed,
  };
}

// Two owners, because two kinds of state live here (board #335 ②a-4, the
// same split hub-prefs needed):
//
//   the LIST is per SERVER. It lives in `tmux_hub_alerts`, one of servers.ts
//     RESIDENT_KEYS, and every entry already carries its `server`. It belongs to
//     a runtime (②b-2-1); the `reload()` that existed because a switch
//     re-pointed the live key is gone with the module instance.
//   the SURFACE is per WINDOW. There is one bell, one popover and one jump
//     request in flight, however many servers are on screen — a second
//     anchor would mean two popovers fighting over the same corner, and a
//     per-server jump counter would let two requests both believe they are
//     current.
//
// The union — one bell counting both servers — is a projection over the logs,
// which is ②a-5's business, not a second list here.
//
// Wired per runtime since ②b-2-1: each runtime's `ServerState` holds a
// `createCentre(createAlertLog(storage))`, and there is no module instance of
// a log. That storage is the server's own store (②b-4).

/** A held alert list moving from server `from` to `to` — an identity merge
 * folded `from` into `to` while the app was blocked (board #335 ③a, reviewer
 * P1-4): every alert that named `from` names `to`, so the canonical centre
 * can open it. Alerts naming any other server are left alone; anything that
 * is not this key, or does not parse, is returned as it came. */
export function rebindAlerts(key: string, value: string, from: string, to: string): string {
  if (key !== ALERTS_KEY) return value;
  try {
    const list = JSON.parse(value);
    if (!Array.isArray(list)) return value;
    return JSON.stringify(list.map((a) => (a && typeof a === 'object' && a.server === from ? { ...a, server: to } : a)));
  } catch { return value; }
}

/** One SERVER's alert list. */
export interface AlertLog {
  readonly items: readonly Alert[];
  readonly unviewed: number;
  record(alert: Alert): void;
  markRoomRead(session: string, seq: number): void;
  viewed(key: string): void;
  failed(key: string, reason: string): void;
  clear(): void;
}

export function createAlertLog(storage: Store | null): AlertLog {
  const state = $state({ items: read(storage) });

  function save(next: Alert[]) {
    if (next === state.items) return;
    state.items = next;
    try { storage?.setItem(ALERTS_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }

  return {
    get items(): readonly Alert[] { return state.items; },
    get unviewed(): number { return state.items.filter((a) => !a.viewed).length; },
    record(alert) { save(withAlert(state.items, alert)); },
    markRoomRead(session, seq) { save(readThrough(state.items, session, seq)); },
    viewed(key) { save(state.items.map((a) => (a.key === key ? { ...a, viewed: true, failed: undefined } : a))); },
    failed(key, reason) { save(state.items.map((a) => (a.key === key ? { ...a, failed: reason } : a))); },
    clear() { save([]); },
  };
}

/** The ONE bell, popover and jump request of this window. */
export interface CentreSurface {
  /** The popover's anchor: whichever control opened it (rail bell, Hub
   * header). */
  readonly anchor: HTMLElement | null;
  toggle(trigger: HTMLElement): void;
  close(): void;
  /** A request for the Hub to open an entry's message; `n` makes a newer
   * request supersede an older one still in flight. */
  readonly jump: JumpRequest | null;
  requestJump(alert: Alert): void;
  isCurrent(n: number): boolean;
  /** The request `n` is done (landed, failed, or invalidated): it is never
   * replayed. A newer request is left alone. */
  consume(n: number): void;
  /** A switch invalidates anything aimed at the server being left: the
   * popover closes and a jump in flight is dropped. */
  reset(): void;
}

export function createCentreSurface(): CentreSurface {
  const state = $state({ open: null as HTMLElement | null, jump: null as JumpRequest | null });
  let jumps = 0;
  return {
    get anchor() { return state.open; },
    toggle(trigger) { state.open = state.open === trigger ? null : trigger; },
    close() { state.open = null; },
    get jump(): JumpRequest | null { return state.jump; },
    requestJump(alert) { state.jump = { alert, n: ++jumps }; },
    isCurrent(n) { return state.jump?.n === n; },
    consume(n) { if (state.jump?.n === n) state.jump = null; },
    reset() { state.jump = null; state.open = null; },
  };
}

/** This window's one surface: every server's centre shares it. */
export const centreSurface = createCentreSurface();

/**
 * One server's centre: ITS alert log, behind the shape every consumer always
 * read, plus this window's ONE surface (board #335 ②b-2-1). Each runtime's
 * `ServerState` holds one; the log goes away with the runtime, and the
 * surface — the bell, the popover, the jump in flight — stays the window's.
 */
export function createCentre(log: AlertLog, surface: CentreSurface = centreSurface) {
  return {
    get items(): readonly Alert[] { return log.items; },
    get unviewed(): number { return log.unviewed; },
    record(alert: Alert) { log.record(alert); },
    markRoomRead(session: string, seq: number) { log.markRoomRead(session, seq); },
    viewed(key: string) { log.viewed(key); },
    failed(key: string, reason: string) { log.failed(key, reason); },
    clear() { log.clear(); },
    get anchor() { return surface.anchor; },
    toggle(trigger: HTMLElement) { surface.toggle(trigger); },
    close() { surface.close(); },
    get jump(): JumpRequest | null { return surface.jump; },
    requestJump(alert: Alert) { surface.requestJump(alert); },
    isCurrent(n: number) { return surface.isCurrent(n); },
    consume(n: number) { surface.consume(n); },
  };
}
export type Centre = ReturnType<typeof createCentre>;

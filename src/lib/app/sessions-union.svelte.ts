// The Terminal sidebar's sessions union source (board #335 ③c-3).
//
// The same shape as the Hub's (`hub-union.svelte.ts`): each tree's Sessions
// page PUBLISHES the list its own server answered — tmux's order, which IS
// that server's rule, so the union has no comparator and concatenates the
// slices in saved order — and the focused page renders every OTHER included
// server's sessions as a tagged SELECTOR under its own. Choosing one is not a
// terminal here: it is "focus that server, open the pane there" (D3: a split
// stays within one tree; the sidebar is the union selector). Panes, kill and
// search stay this server's; a foreign session carries only what a selector
// needs — its name, window count, whether it is attached, and its first pane
// as the target to open.
//
// A slice is keyed by the runtime that published it (a replaced runtime
// inherits nothing) and withdrawn with the tree. `missing` names included
// servers that have not published, so the view can say so.
import { SvelteMap } from 'svelte/reactivity';
import type { ServerId, PaneRef } from './refs.ts';
import { paneRef } from './refs.ts';
import { unionRows, type ServerSlice, type UnionRow } from './server-union.ts';

/** One foreign session as the selector shows it. */
export interface SessionPick {
  name: string;
  windows: number;
  attached: boolean;
  /** The pane to open when picked: `session:window.pane` of its first pane,
   * or '' when the server reported none (the row then only focuses). */
  target: string;
}

export type SessionUnionRow = UnionRow<SessionPick, PaneRef>;

export interface SessionsUnion {
  publish(owner: object, id: ServerId, sessions: readonly SessionPick[]): void;
  withdraw(owner: object): void;
  /** Every included server's sessions in saved order, EXCLUDING `except`
   * (the focused server, whose own list the page already shows). */
  rows(included: readonly { id: ServerId; name: string }[], except: ServerId): { rows: SessionUnionRow[]; missing: ServerId[] };
}

export function createSessionsUnion(): SessionsUnion {
  const slices = new SvelteMap<object, { id: ServerId; sessions: readonly SessionPick[] }>();
  return {
    publish(owner, id, sessions) { slices.set(owner, { id, sessions }); },
    withdraw(owner) { slices.delete(owner); },
    rows(included, except) {
      const byId = new Map<ServerId, readonly SessionPick[]>();
      for (const { id, sessions } of slices.values()) byId.set(id, sessions);
      const others = included.filter((s) => s.id !== except);
      const serverSlices: ServerSlice<SessionPick>[] = others.map((s, order) => {
        const sessions = byId.get(s.id);
        return { serverId: s.id, name: s.name, order, ok: !!sessions, items: sessions ?? [] };
      });
      // The tag follows the WHOLE included set (the rule in server-tag.ts),
      // not how many foreign servers there are: with two included servers the
      // one foreign section is still named.
      return unionRows<SessionPick, PaneRef>(serverSlices, {
        ref: (serverId, s) => paneRef(serverId, s.name, s.target || `${s.name}:`),
        showSource: included.length > 1,
      });
    },
  };
}

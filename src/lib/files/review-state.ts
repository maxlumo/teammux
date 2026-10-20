// Board #434: what review comments keep in memory about ONE server, on that
// server's runtime state (`app/server-state.ts`), so a server switch takes it
// away with the runtime and two servers never share a key:
//
// - `notes`: unsaved comment text per (project_id, path[, annotation id]),
//   kept across a file switch for the page's life (delta 2 P1-C);
// - `intents`: per project id, how many explicit recipient choices the Hub
//   has seen (delta 3 P1-C). Keyed by the stable id, so a rename keeps the
//   count; a late automatic recipient is applied only while it is unchanged;
// - `composers`: the Hub instances bound to this server, each with the room
//   it shows, so a feedback block lands in the LIVE composer when its room is
//   open and in that room's stored draft otherwise.
//
// Memory only: a webview reload ends every request these guard.

import { appendDraft, type NoteDraft } from './review-ui.ts';

export interface Composer {
  /** The room (session) the Hub shows now. */
  session(): string;
  /** Append `block` to the composer text being edited; `auto` says the
   * automatic recipient may be applied (nobody chose since the capture). */
  append(block: string, auto: boolean): void;
}

export interface ReviewState {
  notes: Map<string, NoteDraft>;
  intents: Map<string, number>;
  composers: Set<Composer>;
}

export function createReviewState(): ReviewState {
  return { notes: new Map(), intents: new Map(), composers: new Set() };
}

/** Every explicit recipient choice (a name, All, a team, the empty
 * record-only choice) bumps its project's generation. */
export function bumpRecipientIntent(state: ReviewState, projectId: string | undefined): void {
  if (projectId) state.intents.set(projectId, (state.intents.get(projectId) ?? 0) + 1);
}

export function recipientIntent(state: ReviewState, projectId: string): number {
  return state.intents.get(projectId) ?? 0;
}

/** A Hub's composer joins its server's state while mounted. */
export function registerComposer(state: ReviewState, composer: Composer): () => void {
  state.composers.add(composer);
  return () => { state.composers.delete(composer); };
}

/**
 * Land a feedback block ONCE in the room `session` (already resolved from the
 * captured project id): into the live composer of a Hub showing that room,
 * or else appended to that room's stored draft as it is at this moment.
 * Nothing is sent. Returns where it went.
 */
export function landFeedback(
  state: ReviewState,
  prefs: { draft(session: string): string; setDraft(session: string, text: string): void },
  req: { projectId: string; session: string; block: string; intent: number },
): 'live' | 'draft' {
  const auto = recipientIntent(state, req.projectId) === req.intent;
  const live = [...state.composers].find((c) => c.session() === req.session);
  if (live) { live.append(req.block, auto); return 'live'; }
  prefs.setDraft(req.session, appendDraft(prefs.draft(req.session), req.block));
  return 'draft';
}

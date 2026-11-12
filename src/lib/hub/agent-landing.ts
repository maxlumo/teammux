/** The Dashboard's two landings in the Hub (board #109): the agent row's "show only this
 * agent" and the ask card's Discuss (Reply armed). One wait and one set of rules for both
 * (S6, S9, T5; leader notes 23, 50, 76, 80, 85). Pure: the Hub feeds it what it sees and
 * applies what it answers through its own writers (the filter writer, the reply entry). */

export interface Landing {
  /** The room it was made for, and that room's selection generation at the time: the
   * owner. A → B → A is a NEW visit of A, so the old landing is void even if no effect saw
   * the room change. */
  session: string;
  gen: number;
  /** Has the Hub been on screen and in focus since the landing came? Only then is losing
   * either a focus move that voids it; a landing handed to a tree still coming forward is
   * not voided by its arrival. */
  seen: boolean;
  /** What it does: filter by this agent, or Discuss this message (by id). */
  agent?: string;
  discuss?: string;
}

/** What the Hub sees now: the room shown and its selection generation, whether it is in
 * focus and on screen, the names of the room's managed agents, and whether the room's
 * roster has ANSWERED in this visit. */
export interface LandingView {
  room: string;
  gen: number;
  here: boolean;
  roster: readonly string[];
  rosterKnown: boolean;
}

/** A select request makes an agent landing when it names an agent; a newer one replaces it. */
export function landingFor(req: { session?: string; agent?: string }, selected: string, gen: number): Landing | null {
  return req.agent ? { session: req.session || selected, gen, seen: false, agent: req.agent } : null;
}

/** A Discuss that landed on message `id`: it waits for the room's roster to be KNOWN, since
 * who is live, stopped or gone is not known before it. */
export function discussFor(session: string, id: string, gen: number): Landing {
  return { session, gen, seen: false, discuss: id };
}

/** One step: the next landing (the same object when nothing changed) and the landing to
 * apply, if it is time. Leaving the room, a new visit of it, or losing focus or the screen
 * after holding it voids it. When it is ready (the roster names the agent; the roster is
 * known, for Discuss) it applies if the Hub is here now and is dropped if not. Never
 * replayed on a return. */
export function stepLanding(l: Landing | null, v: LandingView): { next: Landing | null; apply?: Landing } {
  if (!l) return { next: null };
  if (l.session !== v.room || l.gen !== v.gen || (!v.here && l.seen)) return { next: null };
  const ready = l.agent !== undefined ? v.roster.includes(l.agent) : v.rosterKnown;
  if (ready) return v.here ? { next: null, apply: l } : { next: null };
  return { next: v.here && !l.seen ? { ...l, seen: true } : l };
}

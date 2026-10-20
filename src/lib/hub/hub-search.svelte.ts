// The Hub search box's request lifecycle (board #432, design revisions 1-2).
//
// One object, one GENERATION counter, and these rules, all executable here:
//  - Every change that makes the current answer wrong (the query, the scope,
//    closing, a project switch) bumps `gen` SYNCHRONOUSLY, at the input. The
//    debounce only delays SENDING the new request; it never delays the
//    invalidation of the old one, so there is no window in which an old answer
//    can land in a panel that already shows a newer query.
//  - An answer is applied only if its generation is still current and the box
//    is still open. A stale answer is dropped: it neither fills nor clears.
//  - A failure keeps the previous successful rows with the label of the query
//    they answered; it is `error`, which is not "no matches" (`empty`).
//  - Nothing here knows about the DOM, the jump, or which room is selected:
//    `ask` closes over those, so the lifecycle can be tested alone.
import { newestFirst, normalizeQuery, SEARCH_MAX_TERMS, searchTerms, type SearchHit } from './hub-search.ts';

export type SearchScope = 'room' | 'all';
/** idle: nothing asked (an empty query) · pending: asked, rows shown are the
 * previous answer's · ok · empty: asked and really nothing matched · error. */
export type SearchStatus = 'idle' | 'pending' | 'ok' | 'empty' | 'error';
/** What the rows on screen answered: shown beside them while they are not the
 * current query's, so an old success is never read as this one. */
export interface SearchLabel { query: string; scope: SearchScope; agent: string }
export interface SearchAsk { terms: string[]; scope: SearchScope; agent: string; limit: number }
export interface SearchDeps {
  ask(req: SearchAsk): Promise<{ messages: SearchHit[]; more?: boolean }>;
  /** Debounce before a typed query is sent, ms. */
  delay?: number;
  limit?: number;
  /** Called every time the answer or anything the box started becomes wrong
   * (a new generation): the Hub cancels the jump the box owns here, so a late
   * answer cannot move the room (board #432 review). */
  stale?: () => void;
}

export function createHubSearch(deps: SearchDeps) {
  const delay = deps.delay ?? 250;
  const limit = deps.limit ?? 50;
  const state = $state({
    open: false,
    query: '',
    scope: 'room' as SearchScope,
    /** The reading filter's agent (the Hub's one `filterAgent`): who the search
     * is from, or '' for everyone. */
    agent: '',
    status: 'idle' as SearchStatus,
    rows: [] as SearchHit[],
    /** Older hits exist behind the rows. */
    more: false,
    label: null as SearchLabel | null,
    error: '',
    /** A line about the last jump (it could not land); cleared by the next input. */
    notice: '',
  });
  let gen = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const isCurrent = (g: number): boolean => state.open && g === gen;

  function bump(): number {
    gen += 1;
    if (timer) { clearTimeout(timer); timer = null; }
    deps.stale?.();
    return gen;
  }

  function clearAnswer() {
    state.status = 'idle';
    state.rows = [];
    state.more = false;
    state.label = null;
    state.error = '';
  }

  async function send(g: number, terms: string[], scope: SearchScope, agent: string, query: string) {
    if (g !== gen || !state.open) return;
    let res: { messages: SearchHit[]; more?: boolean };
    try {
      res = await deps.ask({ terms, scope, agent, limit });
    } catch (e) {
      if (g !== gen || !state.open) return;
      state.status = 'error';
      state.error = e instanceof Error ? e.message : String(e);
      return;
    }
    if (g !== gen || !state.open) return;
    const hits = Array.isArray(res?.messages) ? res.messages : [];
    state.rows = newestFirst(hits);
    state.more = res?.more === true;
    state.label = { query, scope, agent };
    state.status = hits.length ? 'ok' : 'empty';
    state.error = '';
  }

  /** Ask for the current query and scope. `now` skips the debounce (a retry, a
   * scope change: nothing was typed, so there is nothing to wait for). */
  function run(now: boolean) {
    const g = bump();
    const terms = searchTerms(state.query);
    if (!terms.length) { clearAnswer(); return; }
    if (terms.length > SEARCH_MAX_TERMS) {
      // Said, not sent: the server would refuse it. The rows of the last answer stay, labelled.
      state.status = 'error';
      state.error = 'too-many';
      return;
    }
    state.status = 'pending';
    const { scope, agent } = state;
    const query = normalizeQuery(state.query);
    if (now || delay <= 0) { void send(g, terms, scope, agent, query); return; }
    timer = setTimeout(() => { timer = null; void send(g, terms, scope, agent, query); }, delay);
  }

  function close() {
    bump();
    state.open = false;
    state.query = '';
    state.notice = '';
    clearAnswer();
  }

  return {
    get open() { return state.open; },
    get query() { return state.query; },
    get scope() { return state.scope; },
    get agent() { return state.agent; },
    get status() { return state.status; },
    get rows() { return state.rows; },
    get more() { return state.more; },
    get label() { return state.label; },
    get error() { return state.error; },
    get notice() { return state.notice; },
    /** The label to show beside the rows, or null when they answer the
     * current query and scope. */
    get stale(): SearchLabel | null {
      const l = state.label;
      if (!l) return null;
      return l.query === normalizeQuery(state.query) && l.scope === state.scope && l.agent === state.agent && state.status !== 'pending' && state.status !== 'error' ? null : l;
    },
    /** The generation a caller captures before an async step (a jump). */
    get gen() { return gen; },
    isCurrent,
    show(agent = '') { if (!state.open) { bump(); state.open = true; state.query = ''; state.scope = 'room'; state.agent = agent; state.notice = ''; clearAnswer(); } },
    close,
    /** The Hub is going away or has been hidden: nothing may outlive it. */
    dispose: close,
    setQuery(q: string) {
      state.query = q;
      state.notice = '';
      run(false);
    },
    setScope(scope: SearchScope) {
      if (state.scope === scope) return;
      state.scope = scope;
      state.notice = '';
      run(true);
    },
    /** The filter changed because the USER changed it (a card's double-click, the
     * token's x, Back): the question is a different one. It invalidates at once,
     * like a typed word, and asks again when there is something to ask. */
    setAgent(agent: string) {
      if (state.agent === agent) return;
      state.agent = agent;
      state.notice = '';
      if (state.open) run(true); else bump();
    },
    /** The filter changed because the jump this box started cleared it (openAt
     * clears a reading filter that would hide the target). Nothing the box asked
     * is wrong yet, so there is no new generation: the rows stay, labelled with
     * the agent they answered. Only the Hub calls this, and only for that one
     * verified jump; every other change is `setAgent`. */
    adoptAgent(agent: string) { state.agent = agent; },
    retry() { if (state.open) run(true); },
    /** Enter: send now, no debounce. */
    submit() { if (state.open) run(true); },
    /** A jump from a row could not land: said in the panel, which stays open.
     * Only for the generation that started it. */
    fail(g: number, reason: string) { if (isCurrent(g)) state.notice = reason; },
  };
}

export type HubSearch = ReturnType<typeof createHubSearch>;

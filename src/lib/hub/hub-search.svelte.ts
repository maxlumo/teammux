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
import { mergeFiles, newestFirst, normalizeQuery, SEARCH_MAX_TERMS, searchTerms, type FileHit, type SearchHit, type SearchMode } from './hub-search.ts';

export type SearchScope = 'room' | 'all';
/** idle: nothing asked (an empty query) · pending: asked, rows shown are the
 * previous answer's · ok · empty: asked and really nothing matched · error. */
export type SearchStatus = 'idle' | 'pending' | 'ok' | 'empty' | 'error';
/** What the rows on screen answered: shown beside them while they are not the
 * current query's, so an old success is never read as this one. */
export interface SearchLabel { query: string; scope: SearchScope; agent: string; mode: SearchMode }
export interface SearchAsk { terms: string[]; scope: SearchScope; agent: string; limit: number }
/** A Files page: `before` is the cursor of the page before it (null = the newest). */
export interface FilesAsk extends SearchAsk { before: number | null }
export interface FilesAnswer { files: FileHit[]; next: number | null; scanned: number }
export interface SearchDeps {
  ask(req: SearchAsk): Promise<{ messages: SearchHit[]; more?: boolean }>;
  /** The Files mode's request (board #432): the files the messages mention. */
  askFiles?(req: FilesAsk): Promise<FilesAnswer>;
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
    /** What the list is: messages that match, or the files they mention. */
    mode: 'messages' as SearchMode,
    /** The reading filter's agent (the Hub's one `filterAgent`): who the search
     * is from, or '' for everyone. */
    agent: '',
    status: 'idle' as SearchStatus,
    rows: [] as SearchHit[],
    /** Older hits exist behind the rows. */
    more: false,
    /** Files mode: the files so far, the cursor to older ones (null = the history is read), and how
     * many messages the pages read. */
    files: [] as FileHit[],
    next: null as number | null,
    scanned: 0,
    /** The generation the Files rows on screen answered. They are the CURRENT question's only while
     * it equals `gen`; before that they are the last answer, shown labelled, and not a place to
     * continue from. */
    answerGen: 0,
    /** `gen`, readable by the template: whether the rows are the current question's is drawn. */
    current: 0,
    /** An older page is being fetched / the last attempt at one failed. */
    loadingOlder: false,
    olderFailed: false,
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
    state.current = gen;
    if (timer) { clearTimeout(timer); timer = null; }
    state.loadingOlder = false;
    state.olderFailed = false;
    deps.stale?.();
    return gen;
  }

  function clearAnswer() {
    state.status = 'idle';
    state.rows = [];
    state.more = false;
    state.files = [];
    state.next = null;
    state.scanned = 0;
    state.answerGen = 0;
    state.olderFailed = false;
    state.label = null;
    state.error = '';
  }

  async function send(g: number, terms: string[], scope: SearchScope, agent: string, query: string, mode: SearchMode) {
    if (g !== gen || !state.open) return;
    try {
      if (mode === 'files') {
        const res = await deps.askFiles!({ terms, scope, agent, limit, before: null });
        if (g !== gen || !state.open) return;
        const files = Array.isArray(res?.files) ? res.files : [];
        state.files = files;
        state.next = typeof res?.next === 'number' ? res.next : null;
        state.scanned = Number(res?.scanned) || 0;
        state.answerGen = g;
        state.olderFailed = false;
        state.label = { query, scope, agent, mode };
        // A page can be empty and still have older messages behind it (the scan cap): `next` says so.
        state.status = files.length ? 'ok' : 'empty';
        state.error = '';
        return;
      }
      const res = await deps.ask({ terms, scope, agent, limit });
      if (g !== gen || !state.open) return;
      const hits = Array.isArray(res?.messages) ? res.messages : [];
      state.rows = newestFirst(hits);
      state.more = res?.more === true;
      state.label = { query, scope, agent, mode };
      state.status = hits.length ? 'ok' : 'empty';
      state.error = '';
    } catch (e) {
      if (g !== gen || !state.open) return;
      state.status = 'error';
      state.error = (e as { code?: string } | null)?.code === 'files-unsupported' ? 'files-unsupported' : e instanceof Error ? e.message : String(e);
    }
  }

  /** Ask for the current query and scope. `now` skips the debounce (a retry, a
   * scope change: nothing was typed, so there is nothing to wait for). */
  function run(now: boolean) {
    const g = bump();
    const terms = searchTerms(state.query);
    // Files mode needs no word: with none it lists every file (an agent token alone lists that agent's).
    if (!terms.length && state.mode === 'messages') { clearAnswer(); return; }
    if (terms.length > SEARCH_MAX_TERMS) {
      // Said, not sent: the server would refuse it. The rows of the last answer stay, labelled.
      state.status = 'error';
      state.error = 'too-many';
      return;
    }
    state.status = 'pending';
    const { scope, agent, mode } = state;
    const query = normalizeQuery(state.query);
    if (now || delay <= 0) { void send(g, terms, scope, agent, query, mode); return; }
    timer = setTimeout(() => { timer = null; void send(g, terms, scope, agent, query, mode); }, delay);
  }

  function close() {
    bump();
    state.open = false;
    state.query = '';
    state.mode = 'messages';
    state.notice = '';
    clearAnswer();
  }

  return {
    get open() { return state.open; },
    get query() { return state.query; },
    get scope() { return state.scope; },
    get mode() { return state.mode; },
    get files() { return state.files; },
    get next() { return state.next; },
    get scanned() { return state.scanned; },
    get loadingOlder() { return state.loadingOlder; },
    get olderFailed() { return state.olderFailed; },
    /** Older messages can be read for the question that is on screen. */
    get canOlder() { return state.open && state.mode === 'files' && state.next !== null && state.answerGen === state.current && !state.loadingOlder; },
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
    show(agent = '') { if (!state.open) { bump(); state.open = true; state.query = ''; state.scope = 'room'; state.mode = 'messages'; state.agent = agent; state.notice = ''; clearAnswer(); } },
    close,
    /** The Hub is going away or has been hidden: nothing may outlive it. */
    dispose: close,
    setQuery(q: string) {
      state.query = q;
      state.notice = '';
      run(false);
    },
    /** Messages or Files: a different question, so the other list's rows go at once. */
    setMode(mode: SearchMode) {
      if (state.mode === mode || (mode === 'files' && !deps.askFiles)) return;
      bump();
      state.mode = mode;
      state.notice = '';
      clearAnswer();
      run(true);
    },
    /** Files mode: the next page of OLDER messages, folded into the rows. It is the SAME question,
     * so it keeps the generation; anything that changes the question drops its answer. */
    async loadOlder() {
      const at = state.next;
      // Only the CURRENT question's own cursor: after a word, a scope or an agent change the rows on
      // screen are the previous answer's, and their cursor belongs to that question, not this one.
      if (!state.open || state.mode !== 'files' || at === null || state.loadingOlder || !deps.askFiles || !state.label || state.answerGen !== gen) return;
      const g = gen;
      const { scope, agent } = state.label;
      const terms = searchTerms(state.label.query);
      state.loadingOlder = true;
      state.olderFailed = false;
      try {
        const res = await deps.askFiles({ terms, scope, agent, limit, before: at });
        if (g !== gen || !state.open) return;
        // A cursor that does not move back would read the same page for ever: a broken server, said as a failure.
        if (typeof res?.next === 'number' && res.next >= at) throw new Error('cursor did not advance');
        state.files = mergeFiles(state.files, Array.isArray(res?.files) ? res.files : []);
        state.next = typeof res?.next === 'number' ? res.next : null;
        state.scanned += Number(res?.scanned) || 0;
        state.status = state.files.length ? 'ok' : 'empty';
      } catch {
        if (g !== gen || !state.open) return;
        state.olderFailed = true;
      } finally {
        if (g === gen) state.loadingOlder = false;
      }
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

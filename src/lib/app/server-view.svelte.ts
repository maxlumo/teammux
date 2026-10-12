// What the WINDOW holds about one server-bound tree (board #335 ③a): where
// its navigation stands, the requests aimed at it, and the callbacks its pages
// registered. The server's own memory (drafts, read marks, Files' record) is
// `ServerState`; this is the shell's side of the same tree.
//
// Every bound member has its own (③a-4): a tree that is not in focus keeps
// its panes, its split and its Back chain, its pages register into ITS view,
// and the window dispatches Back, reselect, immersive and its shortcuts to
// the focused view only (reviewer P1-B on the ③ plan). A view belongs to a
// runtime handle, like its `ServerState`, and is handed over with it when
// identity repair hands the state over (a same-machine merge).
//
// A class with rune fields rather than a `$state({...})` object: `navRestored`
// holds a runtime HANDLE, and a deep proxy over a handle breaks the one thing
// it is for — identity (the reason App's `scopeRuntime` is `$state.raw`). The
// registered callbacks are raw for the same reason: a function is called, not
// observed.
import type { PaneRef, SessionRef } from './refs.ts';

/** `{ serverId, ... , n }`: a request that names the tree it is for. */
type Landing = { serverId: string; n: number; [k: string]: unknown } | null;
type Back = (() => boolean) | null;

export class ServerView {
  /** The Terminal page's pane, and the one the Files page follows. */
  termPane = $state<PaneRef | null>(null);
  /** The session the Files and Board pages are on. */
  filesRef = $state<SessionRef | null>(null);
  /** Split screen: 1 is the single-pane path. */
  splitLayout = $state(1);
  splitCells = $state<{ id: number; pane: PaneRef | null }[]>([]);
  activeCellId = $state<number | null>(null);
  /** Requests aimed at this tree's pages (App.landingFor delivers them). */
  filesNavReq = $state<Landing>(null);
  boardIssueReq = $state<Landing>(null);
  agentsEditReq = $state<Landing>(null);
  /** A project this tree's Hub should select (③c-2: a union row of this
   * server picked while another was focused). */
  hubSelectReq = $state<Landing>(null);
  /** Where a cross-page jump from the chat came from: Back at the target's
   * floor returns there. */
  jumpedFrom = $state<string | null>(null);
  /** The runtime whose navigation has been restored; the saved-state effect
   * waits for it (board #335 ②b-2). */
  navRestored = $state.raw<unknown>(null);
  /** Does this tree's server have the Hub (`probed` once it answered)? */
  hubState = $state({ available: false, probed: false });
  /** Back chains and reselects the pages registered. */
  filesGoBack = $state.raw<Back>(null);
  hubGoBack = $state.raw<Back>(null);
  agentsGoBack = $state.raw<Back>(null);
  boardGoBack = $state.raw<Back>(null);
  sessionsGoBack = $state.raw<Back>(null);
  pageReselect: Record<string, (() => void) | undefined> = {};
  /** Files' reading mode asks for the whole screen (board #226). */
  filesImmersive = $state(false);
  /** The Terminal page's own elements, which the window's sidebar motion and
   * focus shortcuts reach through the FOCUSED view (③a-4). */
  termPageEl = $state.raw<HTMLElement | null>(null);
  termSideEl = $state.raw<HTMLElement | null>(null);

  /** The strings every consumer and the wire want, derived from the refs: a
   * serverId never reaches a `target` or `session` argument (②b-2). */
  get terminalTarget(): string { return this.termPane?.target ?? ''; }
  get terminalSession(): string { return this.termPane?.session ?? ''; }
  get filesSession(): string { return this.filesRef?.session ?? ''; }
  /** What SplitView takes: the strings tmux resolves. */
  get splitViewCells() {
    return this.splitCells.map((c) => ({ id: c.id, target: c.pane?.target ?? '', session: c.pane?.session ?? '' }));
  }
}

export function createServerView(): ServerView {
  return new ServerView();
}

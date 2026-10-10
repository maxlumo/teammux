// Hub display preferences — the chat feed's detail level (owner ask:
// configurable in Settings, reachable from the Hub itself — the project
// title's menu carries the three levels; the old cycle control was dead code).
// Three levels, each a superset of the last:
//   chat   — messages only (what people SAID)
//   status — + status declarations and lifecycle notifications
//   tools  — + individual tool calls ("Edit src/lib.rs")
// Delivery receipts and undelivered-line reports are NOT levelled: they are
// about a message the user sent, so feedBlocks() surfaces them at every level.
// A FACTORY plus one default instance (board #335 ②a-4). Two kinds of state
// live here and they do NOT have the same owner:
//
//   per SERVER — the per-project maps (lead, read mark, draft, drawer, roster
//     disclosure) and which project was open. They are keyed by tmux session
//     NAME, and `app` on one server is not `app` on another. Each RUNTIME has
//     its own instance (`app/server-state.ts`, ②b-2-1), built once that
//     server is current — so a switch re-reads nothing: the next server's
//     instance is a new one.
//   per PERSON and WINDOW — the feed level, the tool-row cap and the sidebar
//     collapse. Scoping those would give the same human a different app
//     depending on which machine they are looking at.
//
// So the factory takes its STORAGE, and ②b hands each runtime a store scoped
// to its server (`app/server-store.ts`), which rewrites exactly the resident
// keys and passes the person's preferences through. That is what makes the
// split above a property of the storage view rather than of a second code
// path here.
//
// Wired per runtime since ②b-2-1: there is no module instance of the
// per-server half any more, and each runtime's store is its server's own
// (②b-4).
import { draftUpdate, STEPS_ROWS, clampStepsRows, type SeenMark } from './hub.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const FEED_LEVEL_KEY = 'tmux_hub_feed_level';
const LEAD_KEY = 'tmux_hub_lead';
const SEEN_KEY = 'tmux_hub_seen';
// Which project's conversation was open. "Where I left off" is a project, not
// just a tab: reopening the app on somebody else's chat is the same jolt as
// landing on the wrong tab (owner, 2026-08-19).
const PROJECT_KEY = 'tmux_hub_project';
// An unsent message belongs to the project it was being written to. Switching
// projects with a half-typed line in the box used to carry that line into
// somebody else's conversation, and a reload threw it away (owner, 2026-08-19:
// "前端消息框的消息应该和项目绑定 … 正在输入的内容刷新也还在").
const DRAFT_KEY = 'tmux_hub_drafts';
// How many tool rows a folded group shows before its body scrolls. A number,
// not a level: the right cap depends on the screen and the reader (owner,
// 2026-08-24: "工具调用最大显示的行数应该也变成一个可配置的参数").
const STEPS_ROWS_KEY = 'tmux_hub_steps_rows';
// Which drawer partition a project had open ('' = closed). The drawer is part
// of "where I left off" in a room (board #23, owner: "chat的右侧边栏打开哪个
// 的状态前端帮我记住，这样我切换不同的 project 回来原来的视图还在"):
// switching projects and returning restores the same partition, and a room
// where it was closed comes back closed.
const DRAWER_KEY = 'tmux_hub_drawer';
// The desktop sidebar's collapse (board #174): ONE app-wide switch, not a
// per-project one — where the project list is, is a property of the window.
const SIDEBAR_KEY = 'tmux_hub_sidebar';
// Roster disclosure belongs to the project, like its drawer view (#168).
const ROSTER_EXPANDED_KEY = 'tmux_hub_roster_expanded';
export type FeedLevel = 'chat' | 'status' | 'tools';
const drawerValid = (v: string) => v === 'term' || v === 'files' || v === 'board';

const valid = (v: string | null): v is FeedLevel => v === 'chat' || v === 'status' || v === 'tools';

/** The per-PROJECT keys, i.e. per server (board 315): servers.ts parks them
 * under the leaving server's id on a switch. A test pins the two lists. */
export const HUB_SERVER_KEYS = [PROJECT_KEY, DRAFT_KEY, SEEN_KEY, LEAD_KEY, DRAWER_KEY, ROSTER_EXPANDED_KEY];

/**
 * The PERSON's and the WINDOW's Hub preferences, which have exactly ONE owner
 * however many servers are on screen (reviewer P1, 2026-10-09).
 *
 * Giving each server's `createHubPrefs` its own `$state` for these looked
 * right — they are stored unprefixed, so every scoped store reads and writes
 * the same key — but a shared KEY is not shared STATE: with A and B both live,
 * changing the feed level on A left B's copy stale until something rebuilt it.
 * A test that creates B after A's writes cannot see that, which is how it got
 * through.
 *
 * So these three live here, and `createHubPrefs` delegates to this owner
 * rather than keeping a copy. The per-project maps stay per instance: those
 * ARE per server.
 */
export interface AppPrefs {
  readonly feedLevel: FeedLevel;
  setFeedLevel(v: FeedLevel): void;
  /** The desktop primary sidebar is collapsed (board #174) — SHELL-wide: the
   * Hub's, the Terminal page's and the Board's sidebars and the system-status
   * bar all read it (board #200). false = open. */
  readonly sidebarCollapsed: boolean;
  setSidebarCollapsed(v: boolean): void;
  /** Tool-lane cap: how many rows a folded tool group shows before it scrolls. */
  readonly stepsRows: number;
  setStepsRows(v: number): void;
}

export function createAppPrefs(storage: Store): AppPrefs {
  const stored = storage.getItem(FEED_LEVEL_KEY);
  const state = $state({
    // Tools are the default now that a run of them folds into one collapsible
    // row: the reason to hide them was the wall of one-liners, not the content.
    feedLevel: (valid(stored) ? stored : 'tools') as FeedLevel,
    sidebarCollapsed: storage.getItem(SIDEBAR_KEY) === '1',
    // Tool-lane cap in rows; the stored value passes the same clamp as the
    // setter so an old or hand-edited entry cannot render a broken lane.
    stepsRows: clampStepsRows(storage.getItem(STEPS_ROWS_KEY) ?? STEPS_ROWS),
  });
  return {
    get feedLevel() { return state.feedLevel; },
    setFeedLevel(v) {
      state.feedLevel = v;
      storage.setItem(FEED_LEVEL_KEY, v);
    },
    get sidebarCollapsed() { return state.sidebarCollapsed; },
    setSidebarCollapsed(v) {
      state.sidebarCollapsed = v;
      storage.setItem(SIDEBAR_KEY, v ? '1' : '0');
    },
    get stepsRows() { return state.stepsRows; },
    setStepsRows(v) {
      state.stepsRows = clampStepsRows(v);
      storage.setItem(STEPS_ROWS_KEY, String(state.stepsRows));
    },
  };
}

/** The one owner. Every runtime's hub prefs delegate to THIS. */
export const appPrefs = createAppPrefs(localStorage);

export function createHubPrefs(storage: Store, prefs: AppPrefs = appPrefs) {
  const readMap = <T,>(key: string): Record<string, T> => {
    try {
      const raw = JSON.parse(storage.getItem(key) ?? '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  };

  const state = $state({
    // Per project (tmux session): who the composer addresses by default. Survives
    // reloads because "who am I talking to" is part of where the user left off.
    leads: readMap<string>(LEAD_KEY),
    // Per project: the newest message timestamp the user has actually seen.
    seen: readMap<number | SeenMark>(SEEN_KEY),
    // The project whose conversation was open, restored if it still exists.
    project: storage.getItem(PROJECT_KEY) ?? '',
    // Per project: the message being written but not yet sent.
    drafts: readMap<string>(DRAFT_KEY),
    // Per project: the drawer partition that was open ('' / absent = closed).
    drawers: readMap<string>(DRAWER_KEY),
    rosterExpanded: readMap<boolean>(ROSTER_EXPANDED_KEY),
  });


  return {
    /** The person's and the window's preferences, from their ONE owner — not
     * a copy, so two servers on screen cannot disagree about them. */
    get feedLevel() { return prefs.feedLevel; },
    setFeedLevel(v: FeedLevel) { prefs.setFeedLevel(v); },
    get sidebarCollapsed() { return prefs.sidebarCollapsed; },
    setSidebarCollapsed(v: boolean) { prefs.setSidebarCollapsed(v); },
    get stepsRows() { return prefs.stepsRows; },
    setStepsRows(v: number) { prefs.setStepsRows(v); },
    /** The conversation that was open, '' when none was ever chosen. The caller
     * verifies it still exists — a project can be deleted between two visits. */
    get project() { return state.project; },
    setProject(session: string) {
      state.project = session;
      if (session) storage.setItem(PROJECT_KEY, session);
      else storage.removeItem(PROJECT_KEY);
    },
    /** Follow a project onto its new tmux session name: the per-project prefs are
     * keyed by that name, so a rename would otherwise silently drop the room's
     * lead and its read marker. */
    renameSession(from: string, to: string) {
      if (!from || !to || from === to) return;
      for (const map of [state.leads, state.seen, state.drafts, state.drawers, state.rosterExpanded] as Record<string, unknown>[]) {
        if (from in map) {
          map[to] = map[from];
          delete map[from];
        }
      }
      storage.setItem(LEAD_KEY, JSON.stringify(state.leads));
      storage.setItem(SEEN_KEY, JSON.stringify(state.seen));
      storage.setItem(DRAFT_KEY, JSON.stringify(state.drafts));
      storage.setItem(DRAWER_KEY, JSON.stringify(state.drawers));
      storage.setItem(ROSTER_EXPANDED_KEY, JSON.stringify(state.rosterExpanded));
      if (state.project === from) this.setProject(to);
    },
    /** The remembered recipient for a project: an agent's name, ALL_TARGET
     * for every managed agent, `''` when the
     * user chose the ROOM (no recipient — record only), `null` when nobody has
     * chosen yet and `pickLead` should seat a lead. The empty string is a real
     * choice here, not "unset" (review C, 2026-09-03): storing it as an absent
     * key made the next roster poll re-seat a lead the user had just dismissed. */
    lead(session: string): string | null { return state.leads[session] ?? null; },
    setLead(session: string, name: string) {
      state.leads[session] = name;
      storage.setItem(LEAD_KEY, JSON.stringify(state.leads));
    },
    /** Forget the choice for a project — back to "nobody chose". */
    clearLead(session: string) {
      if (!(session in state.leads)) return;
      delete state.leads[session];
      storage.setItem(LEAD_KEY, JSON.stringify(state.leads));
    },
    /** Where the reader has read to, per project: the last read message's seq
     * and ts (board #322 — seq, because two messages can share a millisecond).
     * A legacy mark (a bare ts number, before #322) reads as seq 0, so the
     * unread summary falls back to ts until the next markSeen upgrades it. It
     * drives the unread cues, so it survives a reload and is parked per server. */
    seen(session: string): SeenMark {
      const v = state.seen[session];
      if (typeof v === 'number') return { seq: 0, ts: v };
      return { seq: Number(v?.seq) || 0, ts: Number(v?.ts) || 0 };
    },
    setSeen(session: string, mark: SeenMark) {
      state.seen[session] = { seq: mark.seq, ts: mark.ts };
      storage.setItem(SEEN_KEY, JSON.stringify(state.seen));
    },
    /** The drawer partition a project had open — 'term' | 'files' | 'board',
     * '' when it was closed (or the stored value is not a partition we have). */
    drawer(session: string) {
      const v = state.drawers[session] ?? '';
      return drawerValid(v) ? v : '';
    },
    setDrawer(session: string, view: string) {
      if (!session) return;
      if (view) state.drawers[session] = view;
      else delete state.drawers[session];   // closed leaves no row behind
      storage.setItem(DRAWER_KEY, JSON.stringify(state.drawers));
    },
    /** Missing entries retain the compact roster; only an explicit true expands it. */
    rosterExpanded(session: string): boolean { return !!session && state.rosterExpanded[session] === true; },
    setRosterExpanded(session: string, expanded: boolean): void {
      if (!session) return;
      if (expanded) state.rosterExpanded[session] = true;
      else delete state.rosterExpanded[session];
      storage.setItem(ROSTER_EXPANDED_KEY, JSON.stringify(state.rosterExpanded));
    },
    /** The unsent message for a project, '' when there is none. */
    draft(session: string) { return state.drafts[session] ?? ''; },
    /** Remember (or forget) what is in the composer. Called as the user types, so
     * it stays a single JSON write and an empty draft REMOVES its key rather than
     * storing '' — otherwise every project ever visited would leave a row. */
    setDraft(session: string, text: string) {
      const next = draftUpdate(state.drafts, session, text);
      if (next === state.drafts) return;   // nothing changed, nothing to write
      state.drafts = next;
      storage.setItem(DRAFT_KEY, JSON.stringify(next));
    },
  };
}

export type HubPrefs = ReturnType<typeof createHubPrefs>;

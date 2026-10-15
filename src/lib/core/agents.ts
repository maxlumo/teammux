// Known coding-agent CLIs that tmux-mobile treats as "AI sessions".
// Adding a new agent = one entry here + the matching icon in /assets/.
// Icons are lobehub-style AVATARS (visible on light AND dark themes):
// @lobehub/icons is React-only and its static packages ship no avatar
// files, so we compose them ourselves as static SVGs — circle filled with
// the brand's AVATAR_BACKGROUND + the official mark scaled by
// AVATAR_ICON_MULTIPLE (constants from @lobehub/icons es/<Name>/style.js,
// MIT). White-background avatars get a hairline ring so they read on
// light surfaces.
//
// WHICH agent a pane runs is not decided here (board #260). The server
// derives it once per pane from the pane's processes (`TmuxPane::agent`,
// `agents::detect_processes`) and every listing carries the backend name;
// this table only turns that name into a tag and an icon. The client used to
// run its own matcher over command + pane_title + child argv, and a title is
// a label nothing resets: a shell where grok had exited kept the title
// "grok" and wore grok's icon.

export interface Agent {
  tag: string;
  icon: string;
  iconSize: number;
}
// Minimal pane shape the agent readers need; real panes (ws.ts TmuxPane)
// satisfy it, and so do partial objects in tests.
export type PaneLike = {
  /** Backend name the server derived from the pane's processes; absent = no agent. */
  agent?: string | null;
  current_command?: string;
  window_name?: string;
} | null | undefined;

export const AGENTS: Agent[] = [
  { tag: 'Kimi',     icon: '/assets/kimi.svg',     iconSize: 14 },
  { tag: 'Kiro',     icon: '/assets/kiro.svg',     iconSize: 14 },
  { tag: 'Claude',   icon: '/assets/claude.svg',   iconSize: 14 },
  { tag: 'Codex',    icon: '/assets/codex.svg',    iconSize: 14 },
  { tag: 'Grok',     icon: '/assets/grok.svg',     iconSize: 14 },
  { tag: 'OpenClaw', icon: '/assets/openclaw.svg', iconSize: 14 },
  { tag: 'OMP',      icon: '/assets/omp.svg',      iconSize: 14 },
];

// ── The server's backend list (board #130) ──────────────────────────────
// The backends this server can spawn, with their resource names, come from
// `backends_list` once per connection (App.svelte fetches it beside probeHub
// on every connect/reconnect success and hands it here).
// `null` = not fetched yet, or an OLDER server without the method: every
// reader below falls back to the client's last hand-kept list, frozen at the
// shape that pre-#130 servers had. The detection-only CLI (openclaw) is
// never in the server list — recognised in panes, not spawned — so its
// avatar stays in the fallback switch on purpose; kimi joined the served
// list with board #224 and keeps its fallback row for older servers.
export interface BackendInfo {
  name: string;
  /** Avatar path, `/assets/<name>.svg`. */
  icon: string;
  /** Colour token NAME, `--backend-<name>` (values live in app.css). */
  color: string;
  /** Reasoning-effort levels the CLI accepts; '' (default) is the editor's. */
  efforts: string[];
  /** Whether a definition may choose queue|steer (board #245): only where
   * the switch was measured. Absent on older servers, which offer none. */
  input_modes?: boolean;
  /** The mode a NEW definition on this backend starts in (board #336: kiro
   * steers). Absent on older servers: queue. */
  default_input_mode?: 'queue' | 'steer';
  /** Whether a RUNNING session can switch queue|steer (board #271: kiro's
   * Ctrl+S). Absent on older servers, which offer no switch. */
  input_mode_toggle?: boolean;
}
/**
 * One SERVER's backend list (board #335 ②a-4).
 *
 * The list is the answer of one machine: which CLIs it has installed, what
 * efforts they accept, whether their input mode can be switched. Two servers
 * give two answers, so this is a record per server rather than per app — and
 * `setServedBackends(null)` existed only because a switch invalidated the one
 * record there was.
 *
 * What stays module-level is what the CLIENT ships: the frozen pre-#130
 * fallback lists and the avatar switch. Those describe this build, not any
 * server, so they belong to no instance.
 *
 * Each runtime's state bundle holds its own (board #335 ②b-3,
 * `ServerState.backends`): a page reads it from its scope, a pure helper
 * takes it as a parameter, and a switch drops it with the runtime instead of
 * resetting a module variable.
 */
export interface BackendCatalog {
  /** The server answered. An empty list counts as "not answered": a present
   * but empty one tells us nothing, and every reader falls back. */
  set(list: BackendInfo[] | null): void;
  /** Called whenever the list is (re)set, so a page that is already open can
   * re-read it: the list arrives on connect, possibly after the page
   * rendered (board #245). Returns the unsubscribe. */
  onChange(fn: () => void): () => void;
  /** Whether this server's list has arrived — "no switch" is only a verdict
   * then. */
  known(): boolean;
  /** Backend names a registry agent can run on, in the server's order. */
  spawnable(): string[];
  /** The backend an absent field means — the server's first entry. */
  defaultBackend(): string;
  /** The effort levels a backend's editor offers ('' default is added by the
   * caller). */
  efforts(backend: string | null | undefined): readonly string[];
  /** Whether this backend's editor offers queue|steer (board #245). Server
   * truth only: no fallback list, so an older server offers nothing. */
  switchesInputMode(backend: string | null | undefined): boolean;
  /** The mode a new draft on this backend starts in (board #336). Server
   * truth only, like `switchesInputMode`: queue with no list. */
  defaultInputMode(backend: string | null | undefined): 'queue' | 'steer';
  /** Whether a RUNNING agent of this backend can switch queue|steer (#271).
   * Server truth only, like `switchesInputMode`. */
  togglesInputMode(backend: string | null | undefined): boolean;
  /** The backend's colour token NAME (`--backend-x`), or null. */
  colorToken(backend: string | null | undefined): string | null;
  /** The backend's avatar icon: this server's answer first, then what the
   * client ships. Null for a backend we have no avatar for. */
  icon(backend: string | null | undefined): string | null;
}

export function createBackendCatalog(): BackendCatalog {
  let served: BackendInfo[] | null = null;
  const listeners = new Set<() => void>();
  const of = (backend: string | null | undefined): BackendInfo | null => {
    const key = (backend ?? '').toLowerCase();
    return served?.find((b) => b.name === key) ?? null;
  };
  return {
    set(list) {
      served = Array.isArray(list) && list.length > 0 ? list : null;
      for (const fn of listeners) fn();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    known: () => served !== null,
    spawnable: () => served?.map((b) => b.name) ?? FALLBACK_BACKENDS,
    // No `this`: a page destructures the catalog it read from its scope.
    defaultBackend: () => (served?.map((b) => b.name) ?? FALLBACK_BACKENDS)[0] ?? FALLBACK_BACKENDS[0]!,
    efforts: (backend) => of(backend)?.efforts ?? FALLBACK_EFFORTS[backend ?? ''] ?? [],
    switchesInputMode: (backend) => of(backend)?.input_modes === true,
    defaultInputMode: (backend) => of(backend)?.default_input_mode === 'steer' ? 'steer' : 'queue',
    togglesInputMode: (backend) => of(backend)?.input_mode_toggle === true,
    colorToken: (backend) => of(backend)?.color ?? null,
    icon: (backend) => of(backend)?.icon ?? shippedIcon(backend),
  };
}

// Pre-#130 servers: the list the client validated against by hand. Frozen —
// a new backend appears through the server's list, not here. Module-level
// because it describes what THIS BUILD shipped, not what any server serves.
const FALLBACK_BACKENDS = ['kiro', 'claude', 'codex', 'grok', 'omp'];
const FALLBACK_EFFORTS: Record<string, string[]> = {
  kiro: ['low', 'medium', 'high', 'xhigh', 'max'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  grok: ['low', 'medium', 'high', 'xhigh'],
};



/** Backend id → the backend's avatar icon, for agent AVATARS (roster cards,
 * registry rows, presets): the logo says which CLI an agent runs on at a
 * glance, where a colored initial said nothing (owner, 2026-08-21: "agent的
 * icon可以用backend的logo，不用字母了"). A catalog's `icon` asks its server's
 * list first and falls back here.
 *
 * The avatars this build ships: the older-server fallback plus the
 * detection-only CLIs. The detection-only openclaw is never in a server's
 * list — recognised in panes, not spawned — so its avatar stays here on
 * purpose; kimi joined the served list with board #224 and keeps its row for
 * older servers. */
function shippedIcon(backend: string | null | undefined): string | null {
  switch ((backend ?? '').toLowerCase()) {
    case 'kiro': return '/assets/kiro.svg';
    case 'claude': return '/assets/claude.svg';
    case 'codex': return '/assets/codex.svg';
    case 'grok': return '/assets/grok.svg';
    case 'kimi': return '/assets/kimi.svg';
    case 'omp': return '/assets/omp.svg';
    case 'openclaw': return '/assets/openclaw.svg';
    default: return null;
  }
}

/** The AGENTS entry for a backend name (`kiro`, `codex`…) — a pane's
 * server-derived `agent`, or a backend stored on a slot. */
export function agentByBackend(backend: string | null | undefined): Agent | null {
  if (!backend) return null;
  const key = backend.toLowerCase();
  return AGENTS.find((a) => a.tag.toLowerCase() === key) ?? null;
}

// Agent entry for a pane (or null): the server's verdict, read, never re-derived.
export function paneAgent(p: PaneLike): Agent | null {
  return agentByBackend(p?.agent);
}

export function paneChipLabel(p: PaneLike, fallback = ''): string {
  if (paneAgent(p)) return '';
  return p?.current_command || p?.window_name || fallback;
}

// Convenience: "is this pane running an AI CLI?"
export function paneIsAgent(p: PaneLike): boolean {
  return paneAgent(p) !== null;
}

// Convenience: "does any pane in this session run an AI CLI?" Requires the
// caller to have already fetched panes[sessionName].
export function sessionHasAgent(panes: PaneLike[] | null | undefined): boolean {
  return Array.isArray(panes) && panes.some(paneIsAgent);
}

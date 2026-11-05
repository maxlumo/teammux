// Backend readiness, the page's half (board #492 phase 2): the pure reading of
// a `backends_check` answer — which status dot a fact wears, which words say
// it, and which fix hint goes with its reason. The server decides every fact
// (backends/readiness.rs); nothing here guesses one. agents-overview.md §
// "Backend readiness" holds the contract.
import { BACKENDS_CHECK } from '../core/login-caps.ts';

/** Whether the server can run the check, from its login answer: `unknown`
 * while there is no authenticated answer (a reconnect), which is not `absent`. */
export type CapState = 'present' | 'absent' | 'unknown';

export function capState(caps: string[] | undefined): CapState {
  if (!Array.isArray(caps)) return 'unknown';
  return caps.includes(BACKENDS_CHECK) ? 'present' : 'absent';
}

/** The last DEFINITE answer per runtime handle, so a reconnect (caps
 * undefined) neither hides a section the server has nor flashes one it lacks. */
const lastKnown = new WeakMap<object, 'present' | 'absent'>();

export function noteCap(runtime: object, state: CapState): void {
  if (state !== 'unknown') lastKnown.set(runtime, state);
}

/** THE shown-predicate (contract P1-B): the desktop category and the phone's
 * Settings row both read it. Known present: shown. Known absent: no entry.
 * Unknown: what was last known, and shown when nothing was (unknown is not no). */
export function backendsShown(runtime: object, state: CapState): boolean {
  if (state !== 'unknown') return state === 'present';
  return lastKnown.get(runtime) !== 'absent';
}

export type Installed = { state?: string; path?: string | null; version?: string | null; reason?: string | null };
export type SetUp = { state?: string; basis?: string; via?: string | null; missing?: string[]; reason?: string | null };
export type Answers = { state?: string; count?: number | null; reason?: string | null };
export type BackendRow = { name: string; program?: string; installed?: Installed; set_up?: SetUp; answers?: Answers };

/** A fact's status dot, in the ONE dot language (hub.ts stateDotColor): a
 * good fact is at rest, a fact a person must act on is the "waiting" amber,
 * anything not decided is the neutral grey. Text always says it too. */
export function factDot(state: string | undefined): 'idle' | 'waiting' | 'shell' {
  if (state === 'present' || state === 'yes') return 'idle';
  if (state === 'missing' || state === 'no') return 'waiting';
  return 'shell';
}

/** Every reason code the server writes (readiness.rs `reason_text`), to its
 * i18n key. Codes the server groups share a key, the way its text does. An
 * unknown code gets the fallback and is never read as "missing". */
const REASON_KEY: Record<string, string> = {
  not_found: 'backendsReasonNotFound',
  version_timeout: 'backendsReasonVersionTimeout',
  version_exit: 'backendsReasonVersionExit',
  version_unreadable: 'backendsReasonVersionUnreadable',
  version_not_found: 'backendsReasonVersionNotRun',
  version_spawn_failed: 'backendsReasonVersionNotRun',
  version_lost: 'backendsReasonVersionNotRun',
  no_tmux: 'backendsReasonNoTmux',
  baseline_incomplete: 'backendsReasonBaselineIncomplete',
  shell_unsupported: 'backendsReasonShellUnsupported',
  helper_missing: 'backendsReasonHelperMissing',
  scratch_failed: 'backendsReasonScratchFailed',
  probe_timeout: 'backendsReasonProbeTimeout',
  probe_failed: 'backendsReasonProbeFailed',
  probe_lost: 'backendsReasonProbeLost',
  probe_protocol: 'backendsReasonProbeProtocol',
  config_unreadable: 'backendsReasonConfigUnreadable',
  config_invalid: 'backendsReasonConfigInvalid',
  config_absent: 'backendsReasonConfigAbsent',
  config_not_regular: 'backendsReasonConfigNotRegular',
  config_too_large: 'backendsReasonConfigTooLarge',
  invalid_env_name: 'backendsReasonInvalidEnvName',
  aws_chain: 'backendsReasonAwsChain',
  unrecognised_provider: 'backendsReasonUnrecognisedProvider',
  credential_store_unverified: 'backendsReasonCredentialStore',
  test_only: 'backendsReasonTestOnly',
  check_timeout: 'backendsReasonCheckTimeout',
  // Not a row reason: the server's whole-check answer when its worker failed.
  check_failed: 'backendsReasonCheckFailed',
  not_signed_in: 'backendsReasonNotSignedIn',
  cli_not_found: 'backendsReasonCliNotFound',
  cli_spawn_failed: 'backendsReasonCliSpawnFailed',
  cli_timeout: 'backendsReasonCliTimeout',
  cli_exit: 'backendsReasonCliExit',
  cli_unreadable: 'backendsReasonCliUnreadable',
  cli_bad_answer: 'backendsReasonCliUnreadable',
  cli_overflow: 'backendsReasonCliUnreadable',
  cli_lost: 'backendsReasonCliLost',
  path_unreadable: 'backendsReasonPathUnreadable',
  env_unset: 'backendsReasonEnvUnset',
  no_auth: 'backendsReasonNoAuth',
  first_run: 'backendsReasonFirstRun',
  empty_catalogue: 'backendsReasonEmptyCatalogue',
  needs_zsh: 'backendsReasonNeedsZsh',
};
export const REASON_CODES = Object.keys(REASON_KEY);

export function reasonKey(code: string | null | undefined): string {
  return (code && REASON_KEY[code]) || 'backendsReasonUnknown';
}

/** A fix hint ONLY where the fix is known from code (orchestrator 07:13,
 * reviewer CLEAR 07:29). Each names the SERVER as what to change. No hint for
 * not_signed_in, aws_chain, config_*, invalid_env_name, cli_* or an unknown
 * code: the reason text alone is all that is known. */
const HINT_KEY: Record<string, string> = {
  not_found: 'backendsFixNotFound',
  env_unset: 'backendsFixEnvUnset',
  no_tmux: 'backendsFixNoTmux',
  test_only: 'backendsFixTestOnly',
  check_timeout: 'backendsFixCheckTimeout',
  path_unreadable: 'backendsFixPathUnreadable',
};

export function hintKey(code: string | null | undefined): string | null {
  return (code && HINT_KEY[code]) || null;
}

/** A row's fix hints, once each, in fact order (installed, set up, answers):
 * kiro's set up and answers are both `test_only`, and one "Press Test" says it. */
export function rowHints(row: BackendRow): { key: string; program: string; names: string[] }[] {
  const seen = new Set<string>();
  const out: { key: string; program: string; names: string[] }[] = [];
  for (const fact of [row.installed, row.set_up, row.answers]) {
    const key = hintKey(fact?.reason);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, program: row.program ?? row.name, names: (fact as SetUp | undefined)?.missing ?? [] });
  }
  return out;
}

/** A row the server asks to be Tested: only an explicit Test can decide it
 * (today kiro, whose whoami writes its own state). Derived from the answer,
 * never from a backend name. */
export function testable(row: BackendRow): boolean {
  return row.set_up?.reason === 'test_only' || row.answers?.reason === 'test_only';
}

/** A `backends_check` Refresh answer, validated at the door: rows with a
 * name, or null for an answer this page cannot read. */
export function readRefresh(answer: unknown): { backends: BackendRow[]; baseline: string | null } | null {
  const a = answer as { backends?: unknown; baseline?: unknown } | null;
  if (!a || !Array.isArray(a.backends)) return null;
  const backends = a.backends.filter((b): b is BackendRow => !!b && typeof (b as BackendRow).name === 'string');
  return { backends, baseline: typeof a.baseline === 'string' ? a.baseline : null };
}

/** A Test answer for `name`, or null. */
export function readTest(answer: unknown, name: string): { set_up: SetUp; answers: Answers } | null {
  const t = (answer as { test?: { name?: unknown; set_up?: SetUp; answers?: Answers } } | null)?.test;
  if (!t || t.name !== name || !t.set_up || !t.answers) return null;
  return { set_up: t.set_up, answers: t.answers };
}

// ── A reply is not a result (reviewer P1-A on d7c6ab54) ───────────────────
// The server answers a check that could not run INSIDE a normal reply
// (readiness.rs `refresh_timed_out` / `test_timed_out`: every fact unknown,
// `check_timeout`; a panicked worker: `{error: "check_failed"}`), so "the
// RPC resolved" says nothing about whether new facts were found. Each fact's
// reason class does.

/** Reasons that say the CHECK could not decide, not a fact about the
 * backend: the whole check, the login-shell probe, or the CLI's own check
 * giving no DEFINITE answer, whether it never answered or failed or wrote
 * something this check cannot read (`cli_exit`, `cli_unreadable`,
 * `cli_bad_answer`, `cli_overflow`: reviewer P1-A residual on b19f703b, a
 * Test fact is new only when the CLI gave a definite answer). `first_run`,
 * `test_only`, `aws_chain` and the like are what this check CAN say, never
 * a failure; a present/missing/yes/no state is news whatever its reason. */
const NOT_RUN = new Set([
  'check_timeout', 'check_failed', 'no_tmux', 'baseline_incomplete', 'shell_unsupported', 'helper_missing',
  'scratch_failed', 'probe_timeout', 'probe_failed', 'probe_lost', 'probe_protocol',
  'cli_not_found', 'cli_spawn_failed', 'cli_timeout', 'cli_lost',
  'cli_exit', 'cli_unreadable', 'cli_bad_answer', 'cli_overflow',
]);

type Fact = { state?: string; reason?: string | null };
/** A fact definite enough to keep through a later check that could not run. */
const definite = (fact: Fact | undefined) => fact?.state === 'present' || fact?.state === 'missing' || fact?.state === 'yes' || fact?.state === 'no';
/** This fact is "the check could not run", not news. */
export function notRun(fact: Fact | undefined): boolean {
  return !fact || (!definite(fact) && !!fact.reason && NOT_RUN.has(fact.reason));
}

/** A fact on screen. One that a later check could not renew keeps its own
 * time and says why it was not renewed. */
export type Kept = { at: number; reason: string };
export type ShownRow = BackendRow & {
  installed?: Installed & { kept?: Kept }; set_up?: SetUp & { kept?: Kept }; answers?: Answers & { kept?: Kept };
};
const FACTS = ['installed', 'set_up', 'answers'] as const;

/** One fact of a new answer over the one on screen (shown since `prevAt`):
 * a fact the new check could not decide never replaces a definite one;
 * every other new fact, a negative one included, does. */
export function mergeFact(prev: (Fact & { kept?: Kept }) | undefined, next: Fact | undefined, prevAt: number) {
  if (notRun(next) && prev && definite(prev)) {
    return { ...prev, kept: { at: prev.kept?.at ?? prevAt, reason: next?.reason ?? 'check_failed' } };
  }
  return next;
}

export function mergeRow(prev: ShownRow | undefined, next: BackendRow, prevAt: number): ShownRow {
  const out: Record<string, unknown> = { ...next };
  for (const k of FACTS) out[k] = mergeFact(prev?.[k], next[k], prevAt);
  return out as ShownRow;
}

/** The reason code a Refresh answer is NOT a result, or null when it is one:
 * the server's error, or not one fact found (the whole-check timeout is that:
 * every fact `check_timeout`, and its baseline names it). */
export function refreshFailed(answer: unknown): string | null {
  const err = (answer as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return err;
  const read = readRefresh(answer);
  if (!read) return null;
  const facts = read.backends.flatMap((b) => FACTS.map((k) => b[k] as Fact | undefined));
  if (facts.length && facts.every(notRun)) return read.baseline ?? facts[0]?.reason ?? 'check_failed';
  return null;
}

/** The reason code a Test answer is NOT a result, or null: the server's
 * error, or neither fact decided (it timed out; its probe or the CLI never answered). */
export function testFailed(answer: unknown, name: string): string | null {
  const err = (answer as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return err;
  const read = readTest(answer, name);
  if (!read) return null;
  if (notRun(read.set_up) && notRun(read.answers)) return read.set_up.reason ?? read.answers.reason ?? 'check_failed';
  return null;
}

/** HH:MM, local, for "Showing the result from …". */
export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Availability and groups (board #7) ──────────────────────────────────
// The SERVER decides both (`registry_list`: projects::registry::annotate over
// readiness::unavailable); every place that lists agents to spawn reads them
// here, so the Agents page and the pickers cannot disagree with each other
// or with `tmm registry list`.

export type Availability = { state?: string; reason?: string | null; missing?: string[] };
type Listed = { name: string; backend: string; group?: string; availability?: Availability };

/** The harness defaults and the custom agents, each in the server's order;
 * null for an older server that names no group (its flat list stays). */
export function agentGroups<T extends Listed>(defs: T[]): { defaults: T[]; custom: T[] } | null {
  if (!defs.some((d) => typeof d.group === 'string')) return null;
  return { defaults: defs.filter((d) => d.group === 'default'), custom: defs.filter((d) => d.group !== 'default') };
}

/** Why this agent cannot start on this server, or null. Only the server's
 * `unavailable` greys: `unknown` (no report yet) and `available` never do. */
export function unavailableOf(def: Listed): { reason: string | null; missing: string[] } | null {
  const a = def.availability;
  if (a?.state !== 'unavailable') return null;
  return { reason: a.reason ?? null, missing: Array.isArray(a.missing) ? a.missing : [] };
}

/** The words for an unavailable agent (colour is never the only signal). */
export function unavailableText(def: Listed, t: (key: string) => string): string {
  const why = unavailableOf(def);
  if (!why) return '';
  const reason = t(reasonKey(why.reason));
  const key = why.missing.length ? 'agentsUnavailableMissing' : 'agentsUnavailable';
  return t(key).replace('{program}', def.backend).replace('{names}', why.missing.join(', ')).replace('{reason}', reason);
}

/** The words for a team the server found unavailable (board #7 round 1):
 * it names the member whose harness cannot run here, or '' when the team can
 * start or nothing is known. The server decides (`teams_list`, the same one
 * rule); a start of such a team is refused whole by the server too. */
export function teamUnavailableText(team: { availability?: Availability & { member?: string; backend?: string } }, t: (key: string) => string): string {
  const a = team.availability;
  if (a?.state !== 'unavailable') return '';
  const missing = Array.isArray(a.missing) ? a.missing : [];
  const key = missing.length ? 'teamsUnavailableMissing' : 'teamsUnavailable';
  return t(key).replace('{member}', a.member ?? '').replace('{program}', a.backend ?? '')
    .replace('{names}', missing.join(', ')).replace('{reason}', t(reasonKey(a.reason)));
}

/** Board #7 round 2 (reviewer 08:57; orchestrator D2: "the page updates when
 * it lands"). A list read before the server's first readiness check says
 * `unknown`; the server has started that one check. If any listed agent or
 * team is unknown this waits for it through `ask` (backends_check {first}:
 * joined, never a second probe) and resolves true, so the caller re-lists
 * ONCE; false when nothing was unknown, there is no `ask` (an older server),
 * or the wait failed. The caller asks at most once per page and runtime, so a
 * check that keeps failing never loops. */
export async function settleAvailability(rows: { availability?: Availability }[], ask: (() => Promise<unknown>) | undefined): Promise<boolean> {
  if (!ask || !rows.some((r) => r?.availability?.state === 'unknown')) return false;
  try { await ask(); return true; } catch { return false; }
}

/** The wait settleAvailability uses: `backends_check {first: true}` through
 * the runtime's one `backendsCheck` wrapper (one declaration per RPC), or
 * undefined when the API has none (a test double, an older client). */
export function firstReport(api: { backendsCheck?: (arg?: string | { first: true }) => Promise<unknown> } | undefined): (() => Promise<unknown>) | undefined {
  const check = api?.backendsCheck;
  return check ? () => check({ first: true }) : undefined;
}

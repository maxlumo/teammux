// Group verbs on the roster's All button and on a team name (board #258).
//
// Owner, 2026-09-28 03:08: "右键点击 所有 agent 按钮或者 team 名字，应该也有选项卡，
// 比如可以一键重启全部，停止全部等等功能". A group verb is the per-agent verb run
// once per member: the same RPC an agent card's menu already calls, looped
// client-side, so there is no second server route to drift from the first.
// Which verbs a group offers, and which ask first, is decided here, purely.

import { ALL_TARGET, busyTargetsFor, targetMembers, targetTeam, teamRoot } from './hub-composer.ts';

interface ScopeAgent {
  name: string;
  managed: boolean;
  team?: string | null;
  /** In its team by a runtime join (board #382), not by the definition. */
  joined?: boolean;
  state?: string;
}

/** The members of a group target (`all` or `team:<root>`), split by what can
 * be done to them. `stopped` are the room's stopped agent identities; for a
 * team they count only when `stoppedTeams` (hub_agents' map, name → team
 * path) puts them in it. */
export interface GroupScope {
  live: string[];
  busy: string[];
  stopped: string[];
  /** Live members a TEAM restart leaves as they are (board #382): the ones
   * that joined at runtime. A team restart aligns the team with its
   * definition, which does not list them; a team stop still stops them. */
  kept: string[];
}

export function groupScope(
  target: string,
  agents: readonly ScopeAgent[],
  stopped: readonly string[],
  stoppedTeams: Readonly<Record<string, string>> = {},
): GroupScope {
  const team = targetTeam(target);
  const live = targetMembers(target, agents);
  const busy = busyTargetsFor(target, agents);
  const idle = target === ALL_TARGET
    ? [...stopped]
    : team ? stopped.filter((name) => teamRoot(stoppedTeams[name]) === team) : [];
  const kept = team ? agents.filter((a) => a.joined && live.includes(a.name)).map((a) => a.name) : [];
  return { live, busy, stopped: idle, kept };
}

export type GroupVerb = 'interrupt' | 'restart' | 'start' | 'stop';

export interface GroupAction {
  verb: GroupVerb;
  /** Who it runs on, captured when the menu is built. */
  names: string[];
  /** Ask first: a stop always does (it closes windows); a restart only when
   * it would cut a running turn. */
  confirm: boolean;
  danger: boolean;
}

/** The verbs in the menu's order — rising consequence, destructive last (the
 * agent menu's rule, owner 2026-08-25). A verb with nobody to act on is not
 * offered at all. Remove is never a group verb: it deletes homes, and stays
 * a per-agent decision. */
export function groupActions(scope: GroupScope): GroupAction[] {
  const out: GroupAction[] = [];
  const kept = scope.kept ?? [];
  const restart = scope.live.filter((name) => !kept.includes(name));
  if (scope.busy.length) out.push({ verb: 'interrupt', names: scope.busy, confirm: false, danger: false });
  if (restart.length) out.push({ verb: 'restart', names: restart, confirm: scope.busy.some((name) => restart.includes(name)), danger: false });
  if (scope.stopped.length) out.push({ verb: 'start', names: scope.stopped, confirm: false, danger: false });
  if (scope.live.length) out.push({ verb: 'stop', names: scope.live, confirm: true, danger: true });
  return out;
}

/** Run one verb over its members, all at once. Every member is tried once;
 * a failure never stops the others and a success is never retried. Returns
 * the names that failed, in member order. */
export async function runGroup(names: readonly string[], one: (name: string) => Promise<unknown>): Promise<string[]> {
  const results = await Promise.allSettled(names.map((name) => one(name)));
  return names.filter((_name, i) => results[i]!.status === 'rejected');
}

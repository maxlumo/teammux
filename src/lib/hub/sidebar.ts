import { paneAgent, type BackendCatalog } from '../core/agents.ts';
import type { TmuxPane } from '../core/ws.ts';
import type { ProjectRow } from '../projects/projects.ts';
import { occurrenceKeys } from './hub.ts';
import { agentNames } from './names.ts';

export type SidebarPane = Pick<TmuxPane,
  'session' | 'window' | 'window_name' | 'active' | 'current_command' | 'agent'>;

interface RowAgent {
  icon: string | null;
  name: string;
  state: string;
  /** Identity for a keyed {#each}: the name plus its occurrence, so two windows
   * with one name (tmux auto-names each after its command) stay two chips, and
   * renumbering windows keeps every key (#120). */
  key: string;
}

/** Live rows show every active agent window; closed rows show every declared
 * agent slot. No cap (board #261): the chips wrap, and a row that hid its
 * fifth agent behind a hover count read as if that agent were not there
 * (owner, 2026-09-28: tmux-mobile's archivist, blog's two last members). */
export function rowAgents(row: ProjectRow, panes: readonly SidebarPane[], agentStates: Readonly<Record<string, string>>, catalog: Pick<BackendCatalog, 'icon'>): RowAgent[] {
  const chips: Omit<RowAgent, 'key'>[] = [];
  if (row.live) {
    const seen = new Set<number>();
    for (const p of panes) {
      if (p.session !== row.project.session || !p.active || seen.has(p.window)) continue;
      seen.add(p.window);
      const agent = paneAgent(p);
      if (!agent) continue;
      chips.push({
        icon: agent.icon, name: p.window_name,
        state: agentStates[`${row.project.session}:${p.window_name}`] ?? 'idle',
      });
    }
  } else {
    for (const s of row.slots ?? []) {
      if (s.kind === 'agent') chips.push({ icon: catalog.icon(s.command), name: s.window_name, state: '' });
    }
  }
  // Keys and states stay physical; only the shown name is the label (#69).
  const keys = occurrenceKeys(chips.map((chip) => chip.name));
  const names = agentNames(row.labels);
  return chips.map((chip, i) => ({ ...chip, name: names.shown(chip.name), key: keys[i]! }));
}

/** Hover counts the roster split into live and stopped. */
export function rowAgentCounts(row: ProjectRow, panes: readonly SidebarPane[]) {
  const declared = (row.slots ?? []).filter((x) => String(x.kind ?? '').toLowerCase() === 'agent').map((x) => x.window_name);
  if (!row.live) return { live: 0, stopped: declared.length };
  const running = new Set<string>();
  for (const p of panes) {
    if (p.session === row.project.session && p.active && paneAgent(p)) running.add(p.window_name);
  }
  return { live: running.size, stopped: declared.filter((n) => !running.has(n)).length };
}

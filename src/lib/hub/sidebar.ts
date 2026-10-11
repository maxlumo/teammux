import { paneAgent, type BackendCatalog } from '../core/agents.ts';
import type { TmuxPane } from '../core/ws.ts';
import type { ProjectRow } from '../projects/projects.ts';

export type SidebarPane = Pick<TmuxPane,
  'session' | 'window' | 'window_name' | 'active' | 'current_command' | 'agent'>;

interface RowAgent {
  icon: string | null;
  name: string;
  state: string;
}

/** Live rows show every active agent window; closed rows show every declared
 * agent slot. No cap (board #261): the chips wrap, and a row that hid its
 * fifth agent behind a hover count read as if that agent were not there
 * (owner, 2026-09-28: tmux-mobile's archivist, blog's two last members). */
export function rowAgents(row: ProjectRow, panes: readonly SidebarPane[], agentStates: Readonly<Record<string, string>>, catalog: Pick<BackendCatalog, 'icon'>): RowAgent[] {
  if (row.live) {
    const out: RowAgent[] = [];
    const seen = new Set<number>();
    for (const p of panes) {
      if (p.session !== row.project.session || !p.active || seen.has(p.window)) continue;
      seen.add(p.window);
      const agent = paneAgent(p);
      if (!agent) continue;
      out.push({
        icon: agent.icon, name: p.window_name,
        state: agentStates[`${row.project.session}:${p.window_name}`] ?? 'idle',
      });
    }
    return out;
  }
  return (row.slots ?? [])
    .filter((s) => s.kind === 'agent')
    .map((s) => ({ icon: catalog.icon(s.command), name: s.window_name, state: '' }));
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

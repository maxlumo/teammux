/**
 * An agent's names as the server sends them (board #21, the UI of #20): its
 * PHYSICAL name (`agent`: window, home, every key the client holds), its
 * current `label` and its previous labels (`aliases`), which still reach it.
 *
 * The client never computes a label. It only APPLIES the server's table —
 * `hub_agents.labels`, refreshed by its poll and patched by the
 * `agent_renamed` push — through the same two readings as the server's
 * `address::Names`: `resolve` (any name an agent has or had → its physical
 * name, at every place a typed name is checked) and `shown` (any of them →
 * the current label, at every place a name is displayed). Every key the
 * client keeps (recipient, lead, filter, managed names, board values) stays
 * physical.
 */
export interface AgentLabel {
  agent: string;
  label: string;
  aliases: string[];
}

export interface Names {
  /** The physical name `name` addresses: itself unless it is a label or a previous label. */
  resolve(name: string): string;
  /** What is shown for `name`: its agent's current label, else itself. */
  shown(name: string): string;
  /** The names besides its label that still reach `agent` (its physical name when it has a label, and its previous labels). */
  others(agent: string): string[];
}

const isLabel = (r: unknown): r is AgentLabel => {
  const o = r as Partial<AgentLabel> | null;
  return !!o && typeof o.agent === 'string' && typeof o.label === 'string' && Array.isArray(o.aliases) && o.aliases.every((a) => typeof a === 'string');
};

/** The wire table as `Names`; a malformed row is skipped, an absent table maps nothing. */
export function agentNames(rows: unknown): Names {
  const table = Array.isArray(rows) ? rows.filter(isLabel) : [];
  const of = (name: string) => table.find((l) => l.agent === name || l.label === name || l.aliases.includes(name));
  return {
    resolve: (name) => of(name)?.agent ?? name,
    shown: (name) => of(name)?.label ?? name,
    others: (agent) => {
      const l = table.find((r) => r.agent === agent);
      if (!l) return [];
      return [...(l.label !== l.agent ? [l.agent] : []), ...l.aliases];
    },
  };
}

/** The table after one `agent_renamed {agent, label, aliases}` push: that
 * agent's row replaced (or added), the rest as they were. Pure. */
export function patchNames(rows: readonly AgentLabel[], renamed: AgentLabel): AgentLabel[] {
  const row = { agent: renamed.agent, label: renamed.label, aliases: [...renamed.aliases] };
  return rows.some((r) => r.agent === renamed.agent) ? rows.map((r) => (r.agent === renamed.agent ? row : r)) : [...rows, row];
}

/** No labels: every name is its own (an older server, a room not read yet). */
export const NO_LABELS: Names = agentNames([]);

/** The words the server refuses as a label in any case (names.rs
 * `label_allowed`: address.rs `is_routing_word`, plus the system's sender
 * `tmm`). The rename dialog says them as you type; the server stays the
 * judge. names.test.ts reads both Rust functions and fails if they differ. */
export const RESERVED_LABELS: readonly string[] = ['all', 'human', 'tmm'];

/** A row the sidebar shows by label: a project and, when the server could
 * read it, that project's label table (`project_list`, board #69). */
interface LabelledRow { project: { id: string; session: string }; labels?: AgentLabel[] }

/** A list answer's rows, each without a table (its labels could not be read,
 * or an older server) keeping the one last known for its project: a failed
 * read never erases known labels (code-quality.md, validator S2 on #69).
 * `prev` is every row the client knew, working list and archive alike, so a
 * project that moves between them keeps its table (validator, round 1). */
export function keepLabels<T extends LabelledRow>(prev: readonly T[], next: T[]): T[] {
  return next.map((row) => {
    if (row.labels) return row;
    const known = prev.find((p) => p.project.id === row.project.id)?.labels;
    return known ? { ...row, labels: known } : row;
  });
}

/** One `agent_renamed` push applied to the Hub's label state: the open
 * rooms' tables (`labelsBy`, keyed by session) and the sidebar's rows, so a
 * rename in a project that is not open re-labels its row at once (#69). */
export function applyRename<T extends LabelledRow>(state: { labelsBy: Record<string, AgentLabel[]>; rows: T[]; trash: T[] }, renamed: AgentLabel & { session: string }) {
  const relabel = (list: T[]) => list.map((row) => (row.project.session === renamed.session ? { ...row, labels: patchNames(row.labels ?? [], renamed) } : row));
  return {
    labelsBy: { ...state.labelsBy, [renamed.session]: patchNames(state.labelsBy[renamed.session] ?? [], renamed) },
    rows: relabel(state.rows),
    trash: relabel(state.trash),
  };
}

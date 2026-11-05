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

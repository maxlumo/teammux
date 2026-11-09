// Agent labels for pages outside the Hub (board #91): the Terminal page's
// window tabs and the Sessions page's search read a renamed agent by its
// label through the SAME table and reading as the Hub and the sidebar
// (names.ts, #20/#69): each project's `project_list` labels, patched in
// place by each `agent_renamed` push. Every key stays physical.
import { agentNames, patchNames, NO_LABELS, type AgentLabel, type Names } from './names.ts';
import type { AgentRenamed } from '../core/connection.ts';

interface LabelRuntime {
  /** The server this runtime talks to: the `ws-reconnected` event names it. */
  id?: string;
  api?: { projectList?: () => Promise<{ projects?: { project: { session: string }; labels?: AgentLabel[] }[] }> };
  connection?: {
    addAgentRenamedListener?: (cb: (r: AgentRenamed) => void) => void;
    removeAgentRenamedListener?: (cb: (r: AgentRenamed) => void) => void;
  };
}

/** One server's label tables by session, kept current: read once from
 * `project_list` (and again by `refresh`), patched by every `agent_renamed`.
 * Call during a component's init (it owns two effects). A read that fails
 * keeps the tables it had: a failed read never erases known labels (#69). */
export function watchLabels(runtime: LabelRuntime): { names(session: string): Names; refresh(): void } {
  // Maps, never plain objects (board #91 round 4, reviewer note 32): a
  // session or agent may be named like a prototype key ("constructor" is a
  // valid name), and a plain object reads such a key as inherited.
  let bySession = $state.raw<Map<string, AgentLabel[]>>(new Map());
  // Newer wins PER AGENT (board #91 rounds 1-2, validator notes 7 and 13,
  // orchestrator notes 9 and 14): every write to an agent's row, a push or
  // the START of a read, takes the next number; a read that lands later
  // applies to every agent of its sessions except one written since it began
  // (that agent keeps its newer row). So a list answer resolving after a
  // rename keeps the rename AND brings in the session's other labels. Plain,
  // not reactive: it orders writes, it is never shown.
  let seq = 0;
  const wrote = new Map<string, Map<string, number>>();
  const stamp = (session: string, agent: string) => wrote.get(session)?.get(agent) ?? 0;
  const mark = (session: string, agent: string, n: number) => {
    let m = wrote.get(session);
    if (!m) wrote.set(session, (m = new Map()));
    m.set(agent, n);
  };
  const read = () => {
    const ask = runtime.api?.projectList?.();
    if (!ask || typeof ask.then !== 'function') return;
    const started = ++seq;
    ask.then((r) => {
      const next = new Map(bySession);
      for (const p of r?.projects ?? []) {
        if (!p.labels) continue;
        const s = p.project.session;
        const current = bySession.get(s) ?? [];
        // A newer row wins over this read's; this read wins over older ones.
        const newer = current.filter((row) => stamp(s, row.agent) > started);
        const fromRead = p.labels.filter((row) => stamp(s, row.agent) <= started);
        next.set(s, [...fromRead, ...newer.filter((n) => !fromRead.some((f) => f.agent === n.agent))]);
        for (const row of fromRead) mark(s, row.agent, started);
      }
      bySession = next;
    }).catch(() => {});
  };
  $effect(() => { read(); });
  // A cache fed only by pushes goes stale across a disconnect (board #91
  // round 3, reviewer note 23, orchestrator note 24): it re-reads on the SAME
  // reconnect door the Terminal and Sessions pages already refresh their
  // panes on, the app's `ws-reconnected` for THIS server, through the same
  // read (newer wins per agent; a failed read keeps what was known).
  $effect(() => {
    if (typeof window === 'undefined') return;
    const onReconnected = (e: Event) => { if ((e as CustomEvent).detail?.serverId === runtime.id) read(); };
    window.addEventListener('ws-reconnected', onReconnected);
    return () => window.removeEventListener('ws-reconnected', onReconnected);
  });
  $effect(() => {
    const onRenamed = (r: AgentRenamed) => {
      mark(r.session, r.agent, ++seq);
      bySession = new Map(bySession).set(r.session, patchNames(bySession.get(r.session) ?? [], r));
    };
    runtime.connection?.addAgentRenamedListener?.(onRenamed);
    return () => runtime.connection?.removeAgentRenamedListener?.(onRenamed);
  });
  return {
    names: (session) => { const rows = bySession.get(session); return rows ? agentNames(rows) : NO_LABELS; },
    refresh: read,
  };
}

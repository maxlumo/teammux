/**
 * The Agents editor's working copy, per server (board #124, validator note 28, leader note 29). The editor
 * has two hosts: the desktop's Agents page and the phone's Settings guest, and a fold or an unfold moves it
 * from one to the other. A working copy kept inside the component died with it, so it lives here, in the
 * server's state (memory only, like the review notes' drafts), and BOTH hosts read it.
 *
 * Who may write: the OWNER, the instance that last adopted or wrote it (the host on screen). A host kept
 * mounted and hidden (Settings keeps an opened guest) holds a stale copy; it never writes, and when it is
 * shown again it adopts the newer revision. Cleared only by a save or a discard (the owner closing its
 * editor writes `null`).
 */
export type AgentsDraftKind = 'agent' | 'team' | 'skill' | 'mcp' | 'global';
export interface AgentsDraft {
  kind: AgentsDraftKind;
  /** The working copy, a plain snapshot (never a component's live proxy). */
  value: unknown;
  creating: boolean;
  /** The fingerprint it is dirty against. */
  original: string;
  /** An agent that is a harness default lives under Backends, not Agents. */
  harness: boolean;
}
export interface AgentsDraftStore {
  readonly held: AgentsDraft | null;
  readonly rev: number;
  readonly owner: object | null;
  /** The owner's new working copy (or `null`); returns the new revision. */
  write(by: object, draft: AgentsDraft | null): number;
  /** `by` is now the host on screen; returns the revision it holds. */
  adopt(by: object): number;
}

export function createAgentsDraft(): AgentsDraftStore {
  let held = $state<AgentsDraft | null>(null); // read by copy (JSON) in the editor, never edited in place
  let rev = $state(0);
  let owner: object | null = null;
  return {
    get held() { return held; },
    get rev() { return rev; },
    get owner() { return owner; },
    write(by, draft) { held = draft; owner = by; return ++rev; },
    adopt(by) { owner = by; return rev; },
  };
}

/** The phone's Settings section an editor of this draft lives in. */
export function sectionOfDraft(d: Pick<AgentsDraft, 'kind' | 'harness'>): string {
  return d.kind === 'agent' ? (d.harness ? 'backends' : 'agents') : d.kind === 'team' ? 'teams'
    : d.kind === 'skill' ? 'skills' : d.kind === 'mcp' ? 'mcp' : 'agents';
}
/** The desktop page's category for it. */
export function categoryOfDraft(d: Pick<AgentsDraft, 'kind' | 'harness'>): string {
  return d.kind === 'global' ? 'global' : sectionOfDraft(d);
}

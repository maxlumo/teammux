import type { RegAgent, RegSkill, TeamMember } from '../core/ws.ts';

export type AgentDraft = Omit<RegAgent, 'skills' | 'mcp'> & {
  skillSel: string[]; mcpSel: string[]; mcpExtra: unknown[];
};
export type TeamDraft = {
  name: string; description: string;
  members: (Omit<TeamMember, 'agent'> & { agent?: AgentDraft | null; expanded: boolean })[];
};
export type ConfigDraft =
  | { kind: 'agent'; value: AgentDraft }
  | { kind: 'team'; value: TeamDraft }
  | { kind: 'skill'; value: RegSkill }
  | { kind: 'mcp'; value: { name: string; defText: string } }
  | { kind: 'global'; value: { text: string; max_bytes: number; loading: boolean; failed?: boolean } };

function agentPayload(value: AgentDraft): RegAgent {
  return {
    name: value.name.trim(), backend: value.backend, model: value.model.trim(),
    effort: value.effort ?? '',
    // Saved as the draft holds it (board #245, validator 19:33): a payload
    // that consulted the capability list rewrote a saved steer to queue
    // whenever that list had not arrived. Only an explicit backend change in
    // the editor resets it; the server stays the authority.
    input_mode: value.input_mode === 'steer' ? 'steer' : 'queue',
    omp_tools: value.omp_tools === true,
    system: value.system,
    skills: JSON.stringify(value.skillSel), mcp: JSON.stringify([...value.mcpSel, ...value.mcpExtra]),
  };
}

/** The same payload defines dirty state and the write, never UI-only fields. */
export function configPayload(draft: ConfigDraft) {
  switch (draft.kind) {
    case 'agent': return agentPayload(draft.value);
    case 'team': return {
      name: draft.value.name.trim(), description: draft.value.description.trim(),
      members: JSON.stringify(draft.value.members.map(m => ({
        name: m.team ? '' : m.name.trim(), base: m.team ? '' : m.base, team: m.team ?? '', role: m.role.trim(),
        model: m.base && !m.team ? (m.model ?? '').trim() : '', effort: m.base && !m.team ? (m.effort ?? '') : '',
        // A derived member's input-mode override (#254): '' = the base's.
        input_mode: m.base && !m.team ? (m.input_mode ?? '') : '',
        agent: m.base || m.team || !m.agent ? null : {
          ...agentPayload(m.agent), name: m.name.trim(),
        },
      }))),
    };
    case 'skill': return { name: draft.value.name.trim(), source: draft.value.source.trim(), description: draft.value.description };
    case 'mcp': return { name: draft.value.name.trim(), def: JSON.stringify(JSON.parse(draft.value.defText)) };
    case 'global': return { text: draft.value.text };
  }
}

export function configFingerprint(draft: ConfigDraft | null): string {
  if (!draft) return '';
  try { return JSON.stringify(configPayload(draft)); }
  catch {
    // Invalid JSON is still unsaved work; format-only edits of valid JSON are not.
    return JSON.stringify(draft.value);
  }
}

export function configValid(draft: ConfigDraft | null, isNew: boolean): boolean {
  if (!draft) return false;
  switch (draft.kind) {
    case 'agent': return !!draft.value.name.trim() && !!draft.value.backend;
    case 'team': return !!draft.value.name.trim() && draft.value.members.length > 0
      && draft.value.members.every(m => !!m.team || (!!m.name.trim() && (!!m.base || !!m.agent)));
    case 'skill': return draft.value.source !== 'builtin' && !!draft.value.source.trim()
      && (isNew || !!draft.value.name.trim());
    case 'mcp':
      if (!draft.value.name.trim()) return false;
      try { JSON.parse(draft.value.defText); return true; } catch { return false; }
    case 'global': return !draft.value.loading && !draft.value.failed
      && new TextEncoder().encode(draft.value.text.trim()).length <= draft.value.max_bytes;
  }
}

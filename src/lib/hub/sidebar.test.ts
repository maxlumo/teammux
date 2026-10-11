import assert from 'node:assert/strict';
import test from 'node:test';
import { rowAgentCounts, rowAgents } from './sidebar.ts';
import { createBackendCatalog } from '../core/agents.ts';

/** An unanswered catalog: the faces this build ships (board #335 ②b-3). */
const catalog = createBackendCatalog();
import type { SidebarPane } from './sidebar.ts';
import type { ProjectRow, Slot } from '../projects/projects.ts';

const slot = (name: string, ord: number, command = 'kiro'): Slot => ({
  ord, window_name: name, cwd: '/alpha', kind: 'agent', command,
  auto_run: true, first_seen_at: 1,
});
const row: ProjectRow = {
  project: {
    id: 'alpha', name: 'Alpha', session: 'alpha', path: '/alpha',
    adopted: false, autostart: false, archived: false, created_at: 1,
  },
  live: true,
  slots: ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'].map((name, i) => slot(name, i)),
};
const pane = (name: string, window: number, overrides: Partial<SidebarPane> = {}): SidebarPane => ({
  session: 'alpha', window, window_name: name, active: true,
  current_command: 'kiro-cli', agent: 'kiro', ...overrides,
});
const live = row.slots.slice(0, 5).map((s) => pane(s.window_name, s.ord));

test('live chips keep every active agent window in input order and exclude shells (#261)', () => {
  const panes = [
    pane('other', 10, { session: 'elsewhere' }),
    pane('inactive', 11, { active: false }),
    pane('shell', 12, { current_command: 'bash', agent: undefined }),
    live[0]!, pane('duplicate', 0), ...live.slice(1),
  ];
  const chips = rowAgents(row, panes, { 'alpha:alice': 'working', 'alpha:bob': 'waiting' }, catalog);
  assert.deepEqual(chips.map((a) => [a.name, a.state]), [
    ['alice', 'working'], ['bob', 'waiting'], ['carol', 'idle'], ['dave', 'idle'], ['erin', 'idle'],
  ]);
  assert.ok(chips.every((a) => a.icon === '/assets/kiro.svg'));
});

test('renumbering windows does not change name-keyed chip states (#120)', () => {
  const states = { 'alpha:alice': 'working', 'alpha:0': 'failed' };
  const before = rowAgents(row, live, states, catalog);
  const after = rowAgents(row, live.map((p) => ({ ...p, window: p.window + 100 })), states, catalog);
  assert.deepEqual(after, before);
  assert.equal(after[0]!.state, 'working');
});

test('closed chips list every declared agent with its backend and no live state (#261)', () => {
  const closed = {
    ...row, live: false,
    slots: [
      { ...slot('shell', 0), kind: 'shell' as const },
      slot('alice', 1, 'codex'), slot('unknown', 2, 'unknown'),
      slot('carol', 3), slot('dave', 4), slot('erin', 5),
    ],
  };
  assert.deepEqual(rowAgents(closed, live, { 'alpha:alice': 'working' }, catalog), [
    { name: 'alice', icon: '/assets/codex.svg', state: '' },
    { name: 'unknown', icon: null, state: '' },
    { name: 'carol', icon: '/assets/kiro.svg', state: '' },
    { name: 'dave', icon: '/assets/kiro.svg', state: '' },
    { name: 'erin', icon: '/assets/kiro.svg', state: '' },
  ]);
});

test('hover counts all live names and missing slots; the chips show every live one', () => {
  const panes = [
    ...live, live[0]!, pane('shell', 90, { current_command: 'bash', agent: undefined }),
    pane('frank', 5, { active: false }), pane('elsewhere', 0, { session: 'other' }),
  ];
  assert.equal(rowAgents(row, panes, {}, catalog).length, 5);
  assert.deepEqual(rowAgentCounts(row, panes), { live: 5, stopped: 1 });
  assert.deepEqual(rowAgentCounts(row, [...panes, pane('ad-hoc', 91)]), { live: 6, stopped: 1 });
});

test('a closed project counts declarations even when stale panes remain', () => {
  assert.deepEqual(rowAgentCounts({ ...row, live: false }, live), { live: 0, stopped: 6 });
  assert.deepEqual(rowAgentCounts({ ...row, slots: [] }, []), { live: 0, stopped: 0 });
});

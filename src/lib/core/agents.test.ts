import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENTS, agentByBackend, paneAgent, paneChipLabel } from './agents.ts';

// Board #260: WHICH agent a pane runs is the server's verdict (`agent`,
// derived from the pane's processes — agents.rs owns the matcher and its
// word-boundary / shallowest-wins tests). The client reads it and never
// re-derives it from labels: the owner's tmux-mobile:1 was a zsh whose title
// still said "grok" after grok exited, and the old client matcher over
// command + title + child argv painted it as grok.
test('a pane is an agent only by the server verdict, never by its labels', () => {
  // A variable, not a literal: a real pane carries pane_title too.
  const ownerCase = { current_command: 'zsh', pane_title: 'grok', window_name: 'zsh' };
  assert.equal(paneAgent(ownerCase), null);
  assert.equal(paneAgent({ current_command: 'kiro-cli-chat', window_name: 'codex' }), null);
  assert.equal(paneAgent({ current_command: 'zsh', agent: 'grok' })?.tag, 'Grok');
  assert.equal(paneAgent({ current_command: 'node', agent: 'codex' })?.tag, 'Codex');
  assert.equal(paneAgent({ agent: null }), null);
  assert.equal(paneAgent(null), null);
});

test('every backend the server can name has a tag and an icon', () => {
  // The detection table's rows: the six spawnable backends + detection-only openclaw.
  for (const backend of ['kiro', 'claude', 'codex', 'grok', 'omp', 'kimi', 'openclaw']) {
    const agent = agentByBackend(backend);
    assert.ok(agent, backend);
    assert.equal(agent.icon, `assets/${backend}.svg`, 'relative to the page (#517)');
  }
  assert.equal(agentByBackend('Kiro')?.tag, 'Kiro', 'case-insensitive, like a stored slot backend');
  assert.equal(agentByBackend('vim'), null);
  assert.equal(agentByBackend(''), null);
});

test('the client carries no matcher of its own', () => {
  // One definition (tenet 8): a regex table here would be a second answer.
  for (const a of AGENTS) assert.equal('match' in a, false, a.tag);
  const source = readFileSync(new URL('./agents.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /export function (detectAgent|paneText)\b/u);
});

test('recognized agent panes use icon-only chip labels', () => {
  for (const agent of ['kiro', 'codex', 'claude']) {
    assert.equal(paneChipLabel({ current_command: 'node', agent }, '0.0'), '');
  }
});

test('ordinary panes keep their process or fallback label', () => {
  assert.equal(paneChipLabel({ current_command: 'zsh' }, '0.0'), 'zsh');
  assert.equal(paneChipLabel({ window_name: 'logs' }, '0.0'), 'logs');
  assert.equal(paneChipLabel({}, '0.0'), '0.0');
});

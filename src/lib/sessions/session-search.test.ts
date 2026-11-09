import test from 'node:test';
import assert from 'node:assert/strict';
import { paneMatches } from './session-search.ts';
import { agentNames, NO_LABELS } from '../hub/names.ts';

// Board #91 (orchestrator S1): sound-factory's kiro-2 was renamed "ops".
const names = agentNames([{ agent: 'kiro-2', label: 'ops', aliases: [] }]);
const kiro2 = { window_name: 'kiro-2', current_command: 'kiro-cli', current_path: '/work/sf' };

test('the Sessions search finds a renamed agent by its label and still by its window name (#91)', () => {
  assert.equal(paneMatches(kiro2, 'OPS', names), true, 'by the label, any case');
  assert.equal(paneMatches(kiro2, 'kiro-2', names), true, 'by the physical name');
  assert.equal(paneMatches(kiro2, 'ops', NO_LABELS), false, 'no label table: no label match');
  assert.equal(paneMatches({ window_name: 'shell', current_command: 'zsh' }, 'ops', names), false, 'an unlabelled window is unchanged');
  assert.equal(paneMatches(kiro2, 'kiro', names, 'kiro'), true, 'the agent tag as before');
  assert.equal(paneMatches(kiro2, '', names), true);
});

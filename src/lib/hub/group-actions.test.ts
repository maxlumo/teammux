import assert from 'node:assert/strict';
import test from 'node:test';
import { groupActions, groupScope, runGroup } from './group-actions.ts';

type Agent = { name: string; managed: boolean; team: string | null; joined?: boolean; state: string };
const agents: Agent[] = [
  { name: 'lead', managed: true, team: 'squad', state: 'running' },
  { name: 'dev', managed: true, team: 'squad/sub', state: 'idle' },
  { name: 'solo', managed: true, team: null, state: 'waiting' },
  { name: 'other', managed: true, team: 'ops', state: 'idle' },
  { name: 'shell', managed: false, team: null, state: 'shell' },
];
const stopped = ['qa', 'loner', 'ops2'];
const stoppedTeams = { qa: 'squad/sub', ops2: 'ops' };
const verbs = (target: string, a = agents, s = stopped) =>
  groupActions(groupScope(target, a, s, stoppedTeams)).map((x) => `${x.verb}:${x.names.join(',')}:${x.confirm ? 'ask' : 'go'}`);

test('All covers every managed agent and every stopped identity (#258)', () => {
  assert.deepEqual(verbs('all'), [
    'interrupt:lead,solo:go',
    'restart:lead,dev,solo,other:ask',
    'start:qa,loner,ops2:go',
    'stop:lead,dev,solo,other:ask',
  ]);
});

test('a team covers only its members, nested sub-teams included, stopped ones by their recipe team', () => {
  assert.deepEqual(verbs('team:squad'), [
    'interrupt:lead:go',
    'restart:lead,dev:ask',
    'start:qa:go',
    'stop:lead,dev:ask',
  ]);
  assert.deepEqual(verbs('team:ops'), ['restart:other:go', 'start:ops2:go', 'stop:other:ask']);
});

// Board #382 (orchestrator's ruling): an agent that JOINED a team at runtime
// is in the team, so a team stop stops it; a team restart aligns the team
// with its definition, which does not list it, so the restart leaves it.
test('a team stop includes a joined agent; a team restart leaves it as it is (#382)', () => {
  const joined = [...agents, { name: 'helper', managed: true, team: 'squad', joined: true, state: 'running' }];
  assert.deepEqual(verbs('team:squad', joined), [
    'interrupt:lead,helper:go',
    'restart:lead,dev:ask',
    'start:qa:go',
    'stop:lead,dev,helper:ask',
  ]);
  const onlyHelperBusy = joined.map((a) => ({ ...a, state: a.name === 'helper' ? 'running' : 'idle' }));
  assert.ok(verbs('team:squad', onlyHelperBusy).includes('restart:lead,dev:go'), 'a busy joiner is not a reason to ask: the restart does not touch it');
  assert.deepEqual(verbs('team:squad', [{ name: 'helper', managed: true, team: 'squad', joined: true, state: 'idle' }], []), ['stop:helper:ask'],
    'only joiners running: nothing to restart');
  assert.ok(verbs('all', joined).includes('restart:lead,dev,solo,other,helper:ask'), 'All is not a team: it restarts everyone');
});

test('a restart asks only when it would cut a turn; a stop always asks', () => {
  const idle = agents.map((a) => ({ ...a, state: 'idle' }));
  assert.deepEqual(verbs('all', idle, []), ['restart:lead,dev,solo,other:go', 'stop:lead,dev,solo,other:ask']);
});

test('a verb with nobody to act on is not offered', () => {
  assert.deepEqual(verbs('all', [], ['qa']), ['start:qa:go'], 'all stopped: only Start stopped');
  assert.deepEqual(verbs('team:none', agents, stopped), [], 'an unknown team has no verbs');
  const acts = groupActions(groupScope('all', agents, []));
  assert.ok(!acts.some((a) => (a.verb as string) === 'remove'), 'remove is never a group verb');
  assert.equal(acts.find((a) => a.verb === 'stop')?.danger, true);
});

test('runGroup tries every member once and reports only the failures, in order', async () => {
  const calls: string[] = [];
  const failed = await runGroup(['a', 'b', 'c', 'd'], async (name) => {
    calls.push(name);
    if (name === 'b' || name === 'd') throw new Error(`no ${name}`);
  });
  assert.deepEqual(failed, ['b', 'd']);
  assert.deepEqual(calls.sort(), ['a', 'b', 'c', 'd'], 'a failure does not stop the others; nothing is retried');
  assert.deepEqual(await runGroup([], async () => {}), []);
});

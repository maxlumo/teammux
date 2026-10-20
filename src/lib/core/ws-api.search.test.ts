// The wire shape of hub_search as the UI really sends it (board #432, review). The Hub's own
// tests mock the api function and so assert the arguments BEFORE this wrapper; this one runs
// the real wrapper into a fake transport and reads the final RPC params, which is where a
// forgotten field (`from`, once) silently turned an agent-scoped search into everyone's.
import test from 'node:test';
import assert from 'node:assert/strict';
const { createWsApi } = await import('./ws-api.ts');

function wire() {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const api = createWsApi({ call: async (method: string, params: Record<string, unknown>) => { sent.push({ method, params }); return { messages: [] }; } } as never);
  return { api, sent };
}

test('hubSearch puts every option on the wire, and only the ones that are set (#432)', async () => {
  const { api, sent } = wire();
  await api.hubSearch('proj', ['deploy', 'staging'], { all: true, global: true, from: 'bob', limit: 20 });
  assert.deepEqual(sent.at(-1), { method: 'hub_search', params: { session: 'proj', grep: ['deploy', 'staging'], all: true, global: true, from: 'bob', limit: 20 } });
  await api.hubSearch('proj', ['x']);
  assert.deepEqual(sent.at(-1)!.params, { session: 'proj', grep: ['x'] }, 'the defaults stay off the wire: any term, this room, everyone');
  await api.hubSearch('proj', ['x'], { from: '' });
  assert.equal('from' in sent.at(-1)!.params, false, 'a blank sender is no filter, not a filter on the empty name');
});

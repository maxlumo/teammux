// Board #451: the six definition calls go only to a server whose CURRENT login says `mcp_masked`.
// An older server answers mcp_list / registry_list / teams_list WITH the MCP values (into a
// textarea) and would store "<set>" as a literal, so the real wrapper refuses before sending.
import test from 'node:test';
import assert from 'node:assert/strict';
const { createWsApi } = await import('./ws-api.ts');

function wire(initial: string[] | undefined) {
  let caps = initial;
  const sent: string[] = [];
  const api = createWsApi({
    call: async (method: string) => { sent.push(method); return {}; },
    getCaps: () => caps,
    whenCaps: () => (caps ? Promise.resolve(caps) : Promise.reject(new Error('late'))),
  } as never);
  return { api, sent, switchTo: (next: string[] | undefined) => { caps = next; } };
}

const six = (api: ReturnType<typeof createWsApi>) => [
  ['mcp_list', () => api.mcpList()],
  ['mcp_save', () => api.mcpSave({ name: 's', def: '{}' })],
  ['registry_list', () => api.registryList()],
  ['registry_save', () => api.registrySave({ name: 'a', backend: 'kiro', model: '', effort: '', system: '', skills: '[]', mcp: '[]' } as never)],
  ['teams_list', () => api.teamsList()],
  ['teams_save', () => api.teamsSave({ name: 't', description: '', members: '[]' } as never)],
] as const;

test('an older server is sent none of the six definition calls (#451)', async () => {
  for (const caps of [[], ['board_dispatch', 'spawn_join', 'agent_team', 'hub_files']]) {
    const { api, sent } = wire(caps);
    for (const [method, run] of six(api)) {
      await assert.rejects(run, (e: any) => e.code === 'server_too_old' && /shows MCP secrets/u.test(e.message), method);
    }
    assert.deepEqual(sent, [], 'nothing was sent');
  }
});

test('a server that says mcp_masked is asked, and a switch to one that does not is refused at the next call (#451)', async () => {
  const { api, sent, switchTo } = wire(['mcp_masked']);
  for (const [, run] of six(api)) await run();
  assert.deepEqual(sent, six(api).map(([m]) => m));
  switchTo([]);
  await assert.rejects(() => api.mcpList(), (e: any) => e.code === 'server_too_old', 'the cap is the CURRENT connection\'s');
  assert.equal(sent.length, 6);
  switchTo(undefined);
  await assert.rejects(() => api.registryList(), (e: any) => e.code === 'login_pending', 'an unanswered login is a wait, never a yes');
  assert.equal(sent.length, 6);
});

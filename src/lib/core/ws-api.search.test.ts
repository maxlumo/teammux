// The wire shape of hub_search as the UI really sends it (board #432, review). The Hub's own
// tests mock the api function and so assert the arguments BEFORE this wrapper; this one runs
// the real wrapper into a fake transport and reads the final RPC params, which is where a
// forgotten field (`from`, once) silently turned an agent-scoped search into everyone's.
import test from 'node:test';
import assert from 'node:assert/strict';
const { createWsApi } = await import('./ws-api.ts');

function wire(answer: unknown = { messages: [] }, caps: string[] | null = ['hub_files']) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const api = createWsApi({
    call: async (method: string, params: Record<string, unknown>) => { sent.push({ method, params }); return answer; },
    getCaps: () => caps ?? undefined,
    whenCaps: () => (caps ? Promise.resolve(caps) : Promise.reject(new Error('late'))),
  } as never);
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

const page = { files: [], next: null, scanned: 0 };
test('hubFiles asks the same door with files on, and puts the cursor on the wire only when there is one (#432 Files mode)', async () => {
  const { api, sent } = wire(page);
  await api.hubFiles('proj', ['spec'], { all: true, global: true, from: 'bob', limit: 20, before: 77 });
  assert.deepEqual(sent.at(-1), { method: 'hub_search', params: { session: 'proj', grep: ['spec'], files: true, all: true, global: true, from: 'bob', limit: 20, before_seq: 77 } });
  await api.hubFiles('proj', []);
  assert.deepEqual(sent.at(-1)!.params, { session: 'proj', grep: [], files: true }, 'no words is allowed here, and the defaults stay off the wire');
  await api.hubSearch('proj', ['x']);
  assert.equal('files' in sent.at(-1)!.params, false, 'a message search never asks for files');
});

const row0 = { path: 'a.md', line: null, col: null, room: 'r', id: 'i', seq: 1, ts: 1, from: 'k', count: 1 };
test('a server that predates Files mode answers with messages: that is "cannot", never an empty list (#432 review)', async () => {
  for (const [label, answer] of [
    ['messages', { messages: [], more: false }],
    ['no cursor', { files: [], scanned: 1 }],
    ['no count', { files: [], next: null }],
    ['a cursor that is not a number', { files: [], next: 'x', scanned: 1 }],
    ['files that are not rows', { files: [{ nope: 1 }], next: null, scanned: 1 }],
    ['a row with no path', { files: [{ ...row0, path: '' }], next: null, scanned: 1 }],
    ['a row that was never mentioned', { files: [{ ...row0, count: 0 }], next: null, scanned: 1 }],
    ['a row with a fractional seq', { files: [{ ...row0, seq: 1.5 }], next: null, scanned: 1 }],
    ['a negative cursor', { files: [], next: -3, scanned: 1 }],
    ['a zero cursor', { files: [], next: 0, scanned: 1 }],
    ['a negative count of messages read', { files: [], next: null, scanned: -1 }],
    ['nothing', null],
  ] as const) {
    const { api } = wire(answer);
    await assert.rejects(() => api.hubFiles('proj', []), (e: any) => e.code === 'files-unsupported' && /does not list files/u.test(e.message), label);
  }
  const row = { path: 'a.md', line: null, col: null, room: 'r', id: 'i', seq: 1, ts: 1, from: 'k', count: 1 };
  const ok = await wire({ files: [row], next: 12, scanned: 3 }).api.hubFiles('proj', []);
  assert.deepEqual([ok.files.length, ok.next, ok.scanned], [1, 12, 3], 'a real page passes untouched');
  assert.equal((await wire(page).api.hubFiles('proj', [])).files.length, 0, 'and a real empty page is an empty list');
});

test('Files needs the server to SAY it can: an older one is refused before anything is sent, on the empty query too (#432 validator P1)', async () => {
  // The previous release refuses an EMPTY grep as a bad request before it looks at `files`, and answers a
  // worded one with messages: neither can be told from the answer alone, so the login's caps decide.
  for (const [label, caps] of [['no caps at all (an older server)', []], ['other caps only', ['board_dispatch', 'spawn_join', 'agent_team']]] as const) {
    for (const grep of [[], ['docs']]) {
      const { api, sent } = wire(page, [...caps]);
      await assert.rejects(() => api.hubFiles('proj', grep), (e: any) => e.code === 'files-unsupported' && /lacks `hub_files`/u.test(e.message), `${label}, grep ${JSON.stringify(grep)}`);
      assert.deepEqual(sent, [], `${label}: nothing was sent`);
    }
  }
  const { api, sent } = wire(page, ['board_dispatch', 'hub_files']);
  await api.hubFiles('proj', []);
  assert.equal(sent.length, 1, 'a server that says it can is asked once');
  // A login that has not answered is a wait, not a no: after the wait it is the ordinary "login pending", not "cannot".
  const pending = wire(page, null);
  await assert.rejects(() => pending.api.hubFiles('proj', [], {}), (e: any) => e.code === 'login_pending');
  assert.deepEqual(pending.sent, []);
});

test('Files waits for the login that has not answered yet, and goes by what it then says (#432 validator P1)', async () => {
  let caps: string[] | undefined;
  const waiters: ((c: string[]) => void)[] = [];
  const sent: string[] = [];
  const api = createWsApi({
    call: async (method: string) => { sent.push(method); return page; },
    getCaps: () => caps,
    whenCaps: () => (caps ? Promise.resolve(caps) : new Promise<string[]>((res) => { waiters.push(res); })),
  } as never);
  const asking = api.hubFiles('proj', []);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, [], 'nothing is sent while the login is unanswered');
  caps = ['hub_files'];
  for (const w of waiters.splice(0)) w(caps);
  assert.equal((await asking).files.length, 0);
  assert.deepEqual(sent, ['hub_search'], 'and once it says it can, it is asked once');
  caps = undefined;
  const older = api.hubFiles('proj', []);
  await new Promise((r) => setTimeout(r, 5));
  caps = [];
  for (const w of waiters.splice(0)) w([]);
  await assert.rejects(() => older, (e: any) => e.code === 'files-unsupported', 'an older server that answers its login is a "cannot", with nothing sent');
  assert.deepEqual(sent, ['hub_search']);
});

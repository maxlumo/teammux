// The search box's request lifecycle (board #432, design revisions 1-2): what
// is current, what a late answer does, and that a failure is not "no matches".
import test from 'node:test';
import assert from 'node:assert/strict';
// The store is a runes module; outside the compiler $state is the value itself.
(globalThis as any).$state = (value: unknown) => value;
const { createHubSearch } = await import('./hub-search.svelte.ts');

const hit = (n: number, over: Record<string, unknown> = {}) => ({ id: `m${n}`, seq: n, ts: n * 1000, from: 'kiro', room: 'proj:a', body: `body ${n}`, ...over });
type Reply = { messages: ReturnType<typeof hit>[]; more?: boolean };

/** An `ask` the test answers by hand, in any order. `stale` counts the generations the Hub is told about. */
function rig(options: { delay?: number; stale?: () => void } = {}) {
  const asked: { terms: string[]; scope: string; agent: string; limit: number; resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  const search = createHubSearch({
    delay: options.delay ?? 0,
    ...(options.stale ? { stale: options.stale } : {}),
    ask: (req) => new Promise<Reply>((resolve, reject) => { asked.push({ ...req, resolve, reject }); }),
  });
  return { search, asked };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('an empty query asks nothing and shows no rows', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('   ');
  await tick();
  assert.equal(asked.length, 0);
  assert.equal(search.status, 'idle');
  assert.deepEqual(search.rows, []);
});

test('a query is sent as its terms, the answer is listed newest first and labelled', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('  deploy   staging ');
  assert.equal(search.status, 'pending');
  await tick();
  assert.deepEqual([asked.length, asked[0]!.terms, asked[0]!.scope, asked[0]!.limit], [1, ['deploy', 'staging'], 'room', 50]);
  asked[0]!.resolve({ messages: [hit(1), hit(2), hit(3)], more: true });
  await tick();
  assert.equal(search.status, 'ok');
  assert.deepEqual(search.rows.map((r) => r.id), ['m3', 'm2', 'm1'], 'the server answers oldest first; the list is newest first');
  assert.equal(search.more, true);
  assert.deepEqual(search.label, { query: 'deploy staging', scope: 'room', agent: '' });
  assert.equal(search.stale, null, 'these rows answer the current query');
});

test('really nothing matched is "empty", which is not an error', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('zzz');
  await tick();
  asked[0]!.resolve({ messages: [] });
  await tick();
  assert.equal(search.status, 'empty');
  assert.equal(search.error, '');
});

test('answers arriving out of order: only the current query’s lands', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('a');
  await tick();
  search.setQuery('ab');
  await tick();
  assert.equal(asked.length, 2);
  asked[1]!.resolve({ messages: [hit(2)] });
  await tick();
  asked[0]!.resolve({ messages: [hit(9)] });   // the older question answers last
  await tick();
  assert.deepEqual(search.rows.map((r) => r.id), ['m2'], 'the stale answer is dropped, not merged and not applied');
  assert.equal(search.label?.query, 'ab');
});

test('the old request is invalidated AT THE INPUT, before the new one is even sent (debounce only delays sending)', async () => {
  const { search, asked } = rig({ delay: 40 });
  search.show();
  search.setQuery('first');
  await tick(60);
  assert.equal(asked.length, 1);
  search.setQuery('second');                    // typed; its request is still waiting out the debounce
  asked[0]!.resolve({ messages: [hit(1)] });    // the first answer arrives inside that window
  await tick(5);
  assert.deepEqual(search.rows, [], 'the old answer must not land in the new query’s panel');
  assert.equal(search.status, 'pending');
  await tick(60);
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[1]!.terms, ['second']);
});

test('typing again inside the debounce sends one request, for the last text', async () => {
  const { search, asked } = rig({ delay: 40 });
  search.show();
  search.setQuery('d');
  search.setQuery('de');
  search.setQuery('dep');
  await tick(80);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0]!.terms, ['dep']);
});

test('a failure keeps the previous success and says which query it answered; it is not "no matches"', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('deploy');
  await tick();
  asked[0]!.resolve({ messages: [hit(1), hit(2)] });
  await tick();
  search.setQuery('deploy staging');
  await tick();
  assert.equal(search.status, 'pending');
  assert.deepEqual(search.stale, { query: 'deploy', scope: 'room', agent: '' }, 'while pending the rows are the previous answer’s, and labelled so');
  asked[1]!.reject(new Error('boom'));
  await tick();
  assert.equal(search.status, 'error');
  assert.equal(search.error, 'boom');
  assert.deepEqual(search.rows.map((r) => r.id), ['m2', 'm1'], 'the old rows stay');
  assert.deepEqual(search.stale, { query: 'deploy', scope: 'room', agent: '' }, 'and keep the label of the query they answered');
  search.retry();
  await tick();
  assert.equal(asked.length, 3, 'retry asks again, no debounce');
  asked[2]!.resolve({ messages: [hit(2)] });
  await tick();
  assert.equal(search.status, 'ok');
  assert.equal(search.stale, null);
  assert.deepEqual(search.rows.map((r) => r.id), ['m2']);
});

test('an emptied query clears the rows', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('x');
  await tick();
  asked[0]!.resolve({ messages: [hit(1)] });
  await tick();
  search.setQuery('');
  assert.equal(search.status, 'idle');
  assert.deepEqual(search.rows, []);
  assert.equal(search.label, null);
});

test('closing drops an answer in flight; reopening starts empty and the late answer cannot fill it', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('x');
  await tick();
  const before = search.gen;
  search.close();
  assert.notEqual(search.gen, before, 'closing is itself a new generation: a jump that started before cannot report into whatever opens next');
  search.show();
  asked[0]!.resolve({ messages: [hit(1)] });
  await tick();
  assert.deepEqual(search.rows, []);
  assert.equal(search.query, '');
  assert.equal(search.status, 'idle');
  // And an answer that arrives while it is closed lands nowhere.
  search.setQuery('y');
  await tick();
  search.close();
  asked[1]!.resolve({ messages: [hit(2)] });
  await tick();
  assert.deepEqual(search.rows, []);
});

test('the scope is part of the request: switching it asks at once for every room, and the old rows wait labelled', async () => {
  const { search, asked } = rig({ delay: 500 });
  search.show();
  search.setQuery('x');
  search.submit();
  await tick();
  asked[0]!.resolve({ messages: [hit(1)] });
  await tick();
  search.setScope('all');
  await tick();
  assert.equal(asked.length, 2, 'no debounce: nothing was typed');
  assert.equal(asked[1]!.scope, 'all');
  assert.deepEqual(search.stale, { query: 'x', scope: 'room', agent: '' });
  asked[1]!.resolve({ messages: [hit(2, { room: 'proj:b' })] });
  await tick();
  assert.deepEqual(search.label, { query: 'x', scope: 'all', agent: '' });
  search.setScope('all');
  await tick();
  assert.equal(asked.length, 2, 'the same scope again is not a new request');
});

test('a jump that could not land is said in the panel, only for the generation that asked, and the next input clears it', async () => {
  const { search } = rig();
  search.show();
  const g = search.gen;
  search.fail(g, 'Message no longer in the room');
  assert.equal(search.notice, 'Message no longer in the room');
  search.setQuery('x');
  assert.equal(search.notice, '', 'typing moves on');
  const old = search.gen;
  search.setQuery('xy');                                    // a new generation
  search.fail(old, 'late');
  assert.equal(search.notice, '', 'a jump of an earlier generation writes nothing');
  assert.equal(search.isCurrent(old), false);
  assert.equal(search.isCurrent(search.gen), true);
  search.close();
  assert.equal(search.isCurrent(search.gen), false, 'a closed box has no current generation');
});

test('the agent is part of the request: a user’s change invalidates at once and asks again; the jump’s own clear is only adopted (#432)', async () => {
  let stales = 0;
  const { search, asked } = rig({ stale: () => { stales += 1; } });
  search.show('kiro');
  search.setQuery('deploy');
  await tick();
  assert.equal(asked[0]!.agent, 'kiro', 'the request carries the filter');
  asked[0]!.resolve({ messages: [hit(1)] });
  await tick();
  assert.deepEqual(search.label, { query: 'deploy', scope: 'room', agent: 'kiro' });
  const before = stales;

  // The user changes the agent: a new generation (the Hub cancels the jump it owns), and a new question.
  search.setAgent('bob');
  assert.ok(stales > before, 'the Hub is told the question changed');
  await tick();
  assert.equal(asked.length, 2);
  assert.equal(asked[1]!.agent, 'bob');
  asked[1]!.resolve({ messages: [hit(2)] });
  await tick();
  assert.equal(search.stale, null);

  // The jump’s own clear: adopted, no generation, no request; the rows stay and say who they were from.
  const gen = search.gen;
  const stalesBefore = stales;
  search.adoptAgent('');
  assert.equal(search.gen, gen, 'no new generation');
  assert.equal(stales, stalesBefore, 'the Hub is not told');
  await tick();
  assert.equal(asked.length, 2, 'nothing is asked');
  assert.deepEqual(search.stale, { query: 'deploy', scope: 'room', agent: 'bob' });
  assert.equal(search.agent, '');
});

test('every new generation tells the Hub, so a jump the box owns can be cancelled; a hidden Hub disposes the box with its timer (#432)', async () => {
  let stales = 0;
  // Count the timers the box leaves running: a stale one is harmless (the generation guards it) but
  // "nothing may outlive the hidden Hub" is a statement about timers too.
  const live = new Set<unknown>();
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  (globalThis as any).setTimeout = (fn: () => void, ms?: number) => { const id: unknown = realSet(() => { live.delete(id); fn(); }, ms); live.add(id); return id; };
  (globalThis as any).clearTimeout = (id: unknown) => { live.delete(id); realClear(id as any); };
  try {
  const { search, asked } = rig({ delay: 40, stale: () => { stales += 1; } });
  search.show();
  const afterShow = stales;
  search.setQuery('a');
  assert.ok(stales > afterShow, 'typing');
  const t1 = stales;
  search.setScope('all');
  assert.ok(stales > t1, 'a scope change');
  search.setQuery('abc');                                   // a request waits out the debounce
  const t2 = stales;
  assert.equal(live.size, 1, 'one debounce timer is waiting');
  search.dispose();
  assert.ok(stales > t2, 'disposing');
  assert.equal(search.open, false);
  assert.equal(live.size, 0, 'the pending debounce timer was cleared, not merely outvoted by the generation');
  await tick(80);
  assert.equal(asked.some((a) => a.terms.includes('abc')), false, 'and nothing is sent after dispose');
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
});

test('more words than the server takes are said, not sent; the last answer stays (#432 review)', async () => {
  const { search, asked } = rig();
  search.show();
  search.setQuery('deploy');
  await tick();
  asked[0]!.resolve({ messages: [hit(1)] });
  await tick();
  search.setQuery(Array.from({ length: 33 }, (_, n) => `w${n}`).join(' '));
  await tick();
  assert.equal(asked.length, 1, 'no request for a query the server would refuse');
  assert.equal(search.status, 'error');
  assert.equal(search.error, 'too-many');
  assert.deepEqual(search.rows.map((r) => r.id), ['m1'], 'the last answer stays, labelled');
  search.setQuery(Array.from({ length: 32 }, (_, n) => `w${n}`).join(' '));
  await tick();
  assert.equal(asked.length, 2, 'the cap itself is a normal query');
});

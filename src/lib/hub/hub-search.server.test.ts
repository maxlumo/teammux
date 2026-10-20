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
  assert.deepEqual(search.label, { query: 'deploy staging', scope: 'room', agent: '', mode: 'messages' });
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
  assert.deepEqual(search.stale, { query: 'deploy', scope: 'room', agent: '', mode: 'messages' }, 'while pending the rows are the previous answer’s, and labelled so');
  asked[1]!.reject(new Error('boom'));
  await tick();
  assert.equal(search.status, 'error');
  assert.equal(search.error, 'boom');
  assert.deepEqual(search.rows.map((r) => r.id), ['m2', 'm1'], 'the old rows stay');
  assert.deepEqual(search.stale, { query: 'deploy', scope: 'room', agent: '', mode: 'messages' }, 'and keep the label of the query they answered');
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
  assert.deepEqual(search.stale, { query: 'x', scope: 'room', agent: '', mode: 'messages' });
  asked[1]!.resolve({ messages: [hit(2, { room: 'proj:b' })] });
  await tick();
  assert.deepEqual(search.label, { query: 'x', scope: 'all', agent: '', mode: 'messages' });
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
  assert.deepEqual(search.label, { query: 'deploy', scope: 'room', agent: 'kiro', mode: 'messages' });
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
  assert.deepEqual(search.stale, { query: 'deploy', scope: 'room', agent: 'bob', mode: 'messages' });
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

// ── Files mode (board #432) ─────────────────────────────────────────────────

const file = (path: string, over: Record<string, unknown> = {}) => ({ path, line: null, col: null, room: 'proj:a', id: `i-${path}`, seq: 1, ts: 1000, from: 'kiro', count: 1, source: null, ...over });
type FilesReply = { files: ReturnType<typeof file>[]; next: number | null; scanned: number };

/** A rig with both doors; `askFiles` is answered by hand, in any order. */
function filesRig(options: { delay?: number } = {}) {
  const messages: { terms: string[] }[] = [];
  const asked: { terms: string[]; scope: string; agent: string; limit: number; before: number | null; resolve: (r: FilesReply) => void; reject: (e: Error) => void }[] = [];
  const search = createHubSearch({
    delay: options.delay ?? 0,
    ask: (req) => { messages.push(req); return Promise.resolve({ messages: [hit(1), hit(2)] }); },
    askFiles: (req) => new Promise<FilesReply>((resolve, reject) => { asked.push({ ...req, resolve, reject }); }),
  });
  return { search, asked, messages };
}

test('Files mode needs no word: switching to it asks at once for every file, and the Messages rows go (#432)', async () => {
  const { search, asked, messages } = filesRig();
  search.show();
  search.setQuery('deploy');
  await tick();
  assert.equal(messages.length, 1);
  assert.deepEqual(search.rows.map((r) => r.id), ['m2', 'm1'], 'Messages had an answer');
  search.setMode('files');
  assert.equal(search.mode, 'files');
  assert.deepEqual([search.rows, search.label], [[], null], 'the other list’s rows and label are gone at once');
  assert.equal(search.status, 'pending');
  await tick();
  assert.deepEqual([asked.length, asked[0]!.terms, asked[0]!.before, asked[0]!.limit], [1, ['deploy'], null, 50], 'the words narrow the paths');
  asked[0]!.resolve({ files: [file('/a.md', { count: 3 })], next: 41, scanned: 12 });
  await tick();
  assert.deepEqual([search.status, search.files.map((f) => f.path), search.next, search.scanned], ['ok', ['/a.md'], 41, 12]);
  assert.deepEqual(search.label, { query: 'deploy', scope: 'room', agent: '', mode: 'files' });
  // No word at all still lists the files.
  search.setQuery('');
  await tick();
  assert.deepEqual([asked.length, asked[1]!.terms], [2, []], 'an empty query is a valid Files request');
  // Back to Messages: the files go, and an empty query asks nothing. Files again: nothing of the first answer is shown while it waits.
  search.setMode('messages');
  search.setMode('files');
  assert.deepEqual([search.files, search.next, search.scanned, search.status], [[], null, 0, 'pending'], 'a new Files question does not start from the old answer');
  asked[2]!.resolve({ files: [], next: null, scanned: 0 });
  await tick();
  search.setMode('messages');
  assert.deepEqual([search.files, search.next, search.scanned, search.status], [[], null, 0, 'idle']);
  await tick();
  assert.equal(asked.length, 3);
  assert.equal(messages.length, 1);
});

test('an agent token with no words lists that agent’s files, and a mode switch is a new question for a stale answer (#432)', async () => {
  const { search, asked } = filesRig();
  search.show('kiro');
  search.setMode('files');
  await tick();
  assert.deepEqual([asked[0]!.terms, asked[0]!.agent], [[], 'kiro']);
  // The user leaves Files before the answer lands: it may not fill the Messages list.
  search.setMode('messages');
  asked[0]!.resolve({ files: [file('/late.md')], next: null, scanned: 1 });
  await tick();
  assert.deepEqual([search.files, search.status, search.label], [[], 'idle', null]);
});

test('an older page keeps the question, folds into the rows with summed counts and moves the cursor (#432)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [file('/a.md', { count: 2, ts: 9 }), file('x.rs', { count: 1 })], next: 40, scanned: 100 });
  await tick();
  const g = search.gen;
  const older = search.loadOlder();
  assert.equal(search.loadingOlder, true);
  void search.loadOlder();               // a second press while one is in flight asks nothing
  await tick();
  assert.equal(asked.length, 2);
  assert.equal(asked[1]!.before, 40, 'the cursor of the previous page');
  asked[1]!.resolve({ files: [file('/a.md', { count: 3, ts: 2 }), file('y.rs')], next: null, scanned: 50 });
  await older;
  assert.deepEqual(search.files.map((f) => [f.path, f.count, f.ts]), [['/a.md', 5, 9], ['x.rs', 1, 1000], ['y.rs', 1, 1000]]);
  assert.deepEqual([search.next, search.scanned, search.loadingOlder, search.gen], [null, 150, false, g], 'the same generation: it is the same question');
  await search.loadOlder();
  assert.equal(asked.length, 2, 'no cursor, no request');
});

test('an older page that arrives after the question changed is dropped, and a failed one keeps the rows and says so (#432)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [file('/a.md')], next: 7, scanned: 10 });
  await tick();
  const older = search.loadOlder();
  search.setQuery('spec');                // a new word: a new generation
  assert.equal(search.loadingOlder, false, 'the invalidation clears the pending flag at once');
  await tick();
  asked[1]!.resolve({ files: [file('/old.md')], next: 3, scanned: 99 });
  await older;
  assert.deepEqual(search.files.map((f) => f.path), ['/a.md'], 'the old question’s page did not land');
  assert.equal(search.scanned, 10);
  asked[2]!.resolve({ files: [file('/spec.md')], next: 5, scanned: 4 });
  await tick();
  const failing = search.loadOlder();
  await tick();
  asked[3]!.reject(new Error('down'));
  await failing;
  assert.deepEqual([search.files.map((f) => f.path), search.olderFailed, search.loadingOlder, search.status, search.next], [['/spec.md'], true, false, 'ok', 5], 'rows kept, cursor kept, retryable');
  void search.loadOlder();
  await tick();
  assert.equal(search.olderFailed, false, 'a retry clears the failure line');
});

test('an older page whose cursor does not move back is a failure, not an endless list (#432 review)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [file('/a.md')], next: 40, scanned: 10 });
  await tick();
  const older = search.loadOlder();
  await tick();
  asked[1]!.resolve({ files: [file('/b.md')], next: 40, scanned: 10 });     // the same cursor again
  await older;
  assert.deepEqual([search.olderFailed, search.files.map((f) => f.path), search.next, search.scanned], [true, ['/a.md'], 40, 10], 'nothing merged, retryable');
});

test('a page with no file can still have older messages behind it; the box says so by the cursor, not by "no files" (#432)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [], next: 12, scanned: 5000 });
  await tick();
  assert.deepEqual([search.status, search.files.length, search.next, search.scanned], ['empty', 0, 12, 5000]);
  const older = search.loadOlder();
  await tick();
  asked[1]!.resolve({ files: [file('/found.md')], next: null, scanned: 20 });
  await older;
  assert.deepEqual([search.status, search.files.map((f) => f.path)], ['ok', ['/found.md']]);
});

test('Files mode is only offered where its request exists, and closing returns the box to Messages (#432)', async () => {
  const bare = createHubSearch({ delay: 0, ask: () => Promise.resolve({ messages: [] }) });
  bare.show();
  bare.setMode('files');
  assert.equal(bare.mode, 'messages', 'no Files door: no Files mode');
  const { search } = filesRig();
  search.show();
  search.setMode('files');
  search.close();
  search.show();
  assert.equal(search.mode, 'messages');
});

test('too many words are refused in Files mode too, without a request (#432)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [file('/a.md')], next: null, scanned: 1 });
  await tick();
  search.setQuery(Array.from({ length: 33 }, (_, n) => `w${n}`).join(' '));
  await tick();
  assert.equal(asked.length, 1);
  assert.deepEqual([search.status, search.error, search.files.length], ['error', 'too-many', 1], 'the rows stay, labelled');
});

test('the rows of a question that has been replaced cannot be continued: their cursor belongs to the old question (#432 review P1-A)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [file('/a.md')], next: 9, scanned: 100 });
  await tick();
  assert.equal(search.canOlder, true, 'the answer on screen is the current question’s');
  search.setQuery('b');                         // B is asked; A's rows stay on screen, labelled
  await tick();
  assert.equal(asked.length, 2);
  assert.deepEqual([search.canOlder, search.next, search.status], [false, 9, 'pending'], 'A’s cursor is still there, and not offered');
  await search.loadOlder();
  assert.equal(asked.length, 2, 'no request: A’s next page is not B’s');
  asked[1]!.resolve({ files: [file('/b.md')], next: 4, scanned: 7 });
  await tick();
  assert.deepEqual([search.files.map((f) => f.path), search.next, search.scanned, search.canOlder], [['/b.md'], 4, 7, true]);
  const older = search.loadOlder();
  await tick();
  assert.deepEqual([asked[2]!.terms, asked[2]!.before], [['b'], 4], 'B’s own cursor, with B’s words');
  asked[2]!.resolve({ files: [file('/b2.md')], next: null, scanned: 3 });
  await older;
  assert.deepEqual([search.files.map((f) => f.path), search.scanned], [['/b.md', '/b2.md'], 10]);
});

test('when the new question fails, the old rows stay and cannot be continued either; a scope or an agent change counts as a new question (#432 review P1-A)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [file('/a.md')], next: 9, scanned: 100 });
  await tick();
  search.setQuery('b');
  await tick();
  asked[1]!.reject(new Error('down'));
  await tick();
  assert.deepEqual([search.status, search.files.map((f) => f.path), search.canOlder], ['error', ['/a.md'], false], 'labelled old rows, and no way to read on from them');
  await search.loadOlder();
  assert.equal(asked.length, 2);
  assert.equal(search.status, 'error', 'a stale page did not wipe the error');
  search.setQuery('');                          // back to the empty question: asked again
  await tick();
  asked[2]!.resolve({ files: [file('/c.md')], next: 5, scanned: 1 });
  await tick();
  assert.equal(search.canOlder, true);
  for (const change of [() => search.setScope('all'), () => search.setAgent('bob')]) {
    const before: number = asked.length;
    change();
    assert.equal(search.canOlder, false, 'a changed scope or sender is another question');
    assert.equal(asked.length, before + 1, 'and it is asked at once');
    await search.loadOlder();
    assert.equal(asked.length, before + 1, 'the old rows’ cursor was not used');
    asked[before]!.resolve({ files: [file('/d.md')], next: 2, scanned: 1 });
    await tick();
    assert.equal(search.canOlder, true, 'the new answer is the current one again');
  }
});

test('a server that cannot list files is said as that, keeps the old rows, and offers no Retry (#432 review P1-D)', async () => {
  const { search, asked } = filesRig();
  search.show();
  search.setMode('files');
  await tick();
  asked[0]!.resolve({ files: [file('/a.md')], next: null, scanned: 1 });
  await tick();
  search.setQuery('x');
  await tick();
  asked[1]!.reject(Object.assign(new Error('this server does not list files'), { code: 'files-unsupported' }));
  await tick();
  assert.deepEqual([search.status, search.error, search.files.map((f) => f.path)], ['error', 'files-unsupported', ['/a.md']], 'a code, not a message, and the last good rows kept');
});

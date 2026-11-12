// Board #107: an ask in the chat. With the server's `asks` capability its bubble is the
// AskCard drawn from the ROW; without it, or before/without a row, the plain body (an older
// client's view), and a missing row after a read says it could not be loaded. Discuss goes
// through Hub's one reply entry for a live or stopped asker, and never for a gone one.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { feedBlocks } from './hub.ts';

const compiled = compileMount(new URL('./Feed.svelte', import.meta.url), []);
const body = '@human [ask] Which layout?\nA · own row (recommended)\nB · disk to the card';
const msg = { id: 'q7', seq: 7, ts: 100, from: 'lead', to: ['human'], kind: 'ask', body };
const row = {
  seq: 7, room: 'proj:p', ts: 100, asker: 'lead', question: 'Which layout?', options: [{ key: 'A', label: 'own row' }, { key: 'B', label: 'disk to the card' }],
  recommend: 'A', issue: null, state: 'open', closed_seq: null, closed_at: null, answer_key: null, said: null, closing: null, delivery: null,
};
const book = (patch: Record<string, unknown> = {}) => ({ rows: { 7: row }, refused: {}, busy: {}, loaded: true, failed: false, answer: () => {}, dismiss: () => {}, ...patch });

async function mount(context: TestContext, props: Record<string, unknown>) {
  const blocks = feedBlocks([msg], [], 'chat', (n) => n);
  const app = await (await compiled).mount(context, {
    props: { selected: 'p', roomReady: true, visible: true, blocks, managedNames: ['lead'],
      agents: [{ name: 'lead', window: 0, managed: true, agent: 'kiro', state: 'idle' }], ...props },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [],
  });
  for (let i = 0; i < 4; i++) await app.flush();
  return app;
}

test('without the asks capability an ask is the plain message: no card, no controls', async (context) => {
  const app = await mount(context, { asks: null });
  try {
    assert.equal(app.document.querySelector('.ask-card'), null);
    assert.match(app.document.querySelector('.m-body')!.textContent!, /\[ask\] Which layout\?/u, 'the composed body, as an older client');
  } finally { await app.close(); }
});

test('with the capability the bubble is the card from the row; a click in it never opens the message row', async (context) => {
  const app = await mount(context, { asks: book() });
  try {
    const card = app.document.querySelector<HTMLElement>('.bubble .ask-card')!;
    assert.ok(card, 'the card');
    assert.ok(!app.document.querySelector('.m-body')!.textContent!.includes('[ask]'), 'never the composed body');
    card.click(); await app.flush();
    assert.equal(app.document.querySelectorAll('.m-acts').length, 0, 'reading the card is not a tap on the message');
  } finally { await app.close(); }
});

test('a missing row is never "no ask": until a read for it answers, the plain body; after a read that missed it or a failed one, the body and a note', async (context) => {
  for (const [patch, note] of [[{ rows: {}, loaded: false }, false], [{ rows: {}, loaded: true }, false], [{ rows: {}, loaded: true, missing: { 7: true } }, true], [{ rows: {}, loaded: false, failed: true }, true]] as const) {
    const app = await mount(context, { asks: book(patch) });
    try {
      assert.equal(app.document.querySelector('.ask-card'), null, 'no controls without a row');
      assert.match(app.document.querySelector('.m-body')!.textContent!, /\[ask\]/u);
      assert.equal(!!app.document.querySelector('.ask-missing'), note, JSON.stringify(patch));
    } finally { await app.close(); }
  }
});

test('Discuss in chat: a live and a stopped asker go to Hub\'s reply entry (#490 decides), a gone one does not', async (context) => {
  for (const [props, called] of [
    [{}, true],
    [{ stopped: ['lead'] }, true],
    [{ agents: [] }, false],
  ] as const) {
    const asked: unknown[] = [];
    const app = await mount(context, { asks: book(), ondiscuss: (m: unknown) => asked.push(m), ...props });
    try {
      const discuss = [...app.document.querySelectorAll<HTMLButtonElement>('.ask-acts button')].find((b) => b.textContent?.trim() === 'Discuss in chat')!;
      discuss.click(); await app.flush();
      assert.equal(asked.length, called ? 1 : 0, JSON.stringify(props));
      if (called) assert.equal((asked[0] as { id: string }).id, 'q7', 'the ask\'s own message is quoted');
    } finally { await app.close(); }
  }
});

test('two clients answer one ask: the second is refused and its card repaints with the winner (#107 AC2)', async (context) => {
  (globalThis as any).$state ??= (v: unknown) => v;
  const { AskBook } = await import('./asks.svelte.ts');
  let stored: any = { ...row };
  const close = (patch: Record<string, unknown>) => {
    if (stored.state !== 'open') return { applied: false, refused: 'already answered at 08:41', ask: stored };
    stored = { ...stored, ...patch, closed_at: 1_800_000_060_000, delivery: 'found' };
    return { applied: true, ask: stored };
  };
  const api = {
    hubAskList: async () => ({ asks: [stored] }),
    hubAskAnswer: async (_s: string, _q: number, option?: string) => close({ state: 'answered', answer_key: option, said: option === 'A' ? 'A · own row' : 'B · disk to the card' }),
    hubAskDismiss: async () => close({ state: 'dismissed', said: 'dismissed: I will not answer this' }),
  };
  const books = [new AskBook(api), new AskBook(api)];
  await Promise.all(books.map((b) => b.load('p')));
  const view = (b: InstanceType<typeof AskBook>) => ({ rows: b.rows, refused: b.refused, busy: b.busy, loaded: b.loaded, failed: b.failed, answer: (s: number, o?: string, t?: string) => b.answer(s, o, t), dismiss: (s: number) => b.dismiss(s) });
  // The other client answers first (A); this client's card still shows the ask open.
  await books[0]!.answer(7, 'A');
  const app = await mount(context, { asks: view(books[1]!) });
  try {
    assert.equal(app.document.querySelector('.ask-state'), null, 'still open here');
    const b = [...app.document.querySelectorAll<HTMLButtonElement>('.ask-opt button')].find((x) => x.textContent?.trim() === 'B · disk to the card')!;
    b.click();
    await Promise.resolve(); await new Promise((r) => setImmediate(r));
    await app.setProps({ asks: view(books[1]!) });
    assert.equal(app.document.querySelector('.ask-state')?.textContent, 'Answered');
    assert.equal(app.document.querySelector('.ask-said')?.textContent, 'A · own row', 'repainted with the winner');
    assert.equal(app.document.querySelectorAll('.ask-card button').length, 0, 'no live controls once closed');
    assert.equal(app.document.querySelector('[role="alert"]')?.textContent, 'already answered at 08:41', 'the loser is told');
    assert.equal(stored.answer_key, 'A', 'one close on the server');
  } finally { await app.close(); }
});

test('a failed refresh after a good read keeps the card and its controls, and says it could not refresh (leader note 14 F3b)', async (context) => {
  const app = await mount(context, { asks: book({ failed: true }) });
  try {
    assert.ok(app.document.querySelector('.ask-card'), 'the last loaded row stays');
    assert.ok(app.document.querySelectorAll('.ask-card button').length > 0, 'its controls stay: the answer call is the arbiter');
    assert.equal(app.document.querySelector('.ask-stale')?.textContent, 'Could not refresh this question.');
    assert.equal(app.document.querySelector('.ask-missing'), null);
  } finally { await app.close(); }
});

test('no row and a failed read: the plain body, no controls, could not be loaded (F3a)', async (context) => {
  const app = await mount(context, { asks: book({ rows: {}, loaded: false, failed: true }) });
  try {
    assert.equal(app.document.querySelector('.ask-card'), null);
    assert.match(app.document.querySelector('.bubble')?.textContent ?? '', /Which layout\?/u);
    assert.equal(app.document.querySelector('.ask-missing')?.textContent, 'This question could not be loaded.');
  } finally { await app.close(); }
});

// Board #107 round 5 (validator-2 notes 73-75, leader ruling): a socket loss clears the login's
// capabilities, so the card unmounts mid-call; the draft lives in the STORE, so the card that
// comes back after the reconnect still holds the words and the option it tried.
test('a capability drop mid-call loses no draft: the words, the tried option and "Not sent" come back with the card (#107 round 5)', async (context) => {
  (globalThis as any).$state ??= (v: unknown) => v;
  const { AskBook } = await import('./asks.svelte.ts');
  let fail: (e: Error) => void = () => {};
  const book = new AskBook({
    hubAskList: async () => ({ asks: [row] }),
    hubAskAnswer: () => new Promise((_ok, no) => { fail = no; }),
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  const view = () => ({ rows: book.rows, refused: book.refused, busy: book.busy, errors: book.errors, drafts: book.drafts, loaded: book.loaded, failed: book.failed, missing: book.missing,
    answer: (s: number, o?: string, t?: string) => book.answer(s, o, t), dismiss: (s: number) => book.dismiss(s), setDraft: (s: number, d: { text: string; tried?: string }) => book.setDraft(s, d) });
  const app = await mount(context, { asks: view() });
  try {
    const ta = app.document.querySelector('textarea')!;
    ta.value = 'only for desktop'; ta.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.ask-opt button')][1]!.click();
    await app.flush();
    await app.setProps({ asks: null });           // the socket dropped: no capability, no card
    assert.equal(app.document.querySelector('.ask-card'), null);
    fail(new Error('connection lost')); await new Promise((r) => setImmediate(r));
    await app.setProps({ asks: view() });         // reconnected: the capability is back
    for (let i = 0; i < 3; i++) await app.flush();
    assert.equal(app.document.querySelector<HTMLTextAreaElement>('.ask-card textarea')?.value, 'only for desktop', 'the words are still there');
    const marked = [...app.document.querySelectorAll('.ask-opt button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent?.trim());
    assert.deepEqual(marked, ['B · disk to the card'], 'the option it tried is still marked');
    assert.equal(app.document.querySelector('.ask-card [role="alert"]')?.textContent, 'Not sent: connection lost');
  } finally { await app.close(); }
});

test('a mounted card never republishes its draft once another client\'s close lands (#107 round 5 guard)', async (context) => {
  (globalThis as any).$state ??= (v: unknown) => v;
  const { AskBook } = await import('./asks.svelte.ts');
  let rows: any[] = [row];
  const book = new AskBook({
    hubAskList: async (_s: string, all = true) => ({ asks: rows.filter((r) => all || r.state === 'open') }),
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  const view = () => ({ rows: book.rows, refused: book.refused, busy: book.busy, errors: book.errors, drafts: book.drafts, loaded: book.loaded, failed: book.failed, missing: book.missing,
    answer: () => {}, dismiss: () => {}, setDraft: (s: number, d: { text: string; tried?: string }) => book.setDraft(s, d) });
  const app = await mount(context, { asks: view() });
  try {
    const ta = app.document.querySelector('textarea')!;
    ta.value = 'half a thought'; ta.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    assert.equal(JSON.stringify(book.drafts[7]), JSON.stringify({ text: 'half a thought' }), 'the card published its words');
    rows = [{ ...row, state: 'answered', said: 'A · own row', closed_at: 2, delivery: 'found' }];   // closed elsewhere
    await book.reconcile('p');
    assert.equal(book.drafts[7], undefined, 'the close cleared it');
    await app.setProps({ asks: view() }); for (let i = 0; i < 3; i++) await app.flush();
    assert.equal(app.document.querySelector('.ask-state')?.textContent, 'Answered');
    assert.equal(book.drafts[7], undefined, 'the re-rendered card did not write it back');
  } finally { await app.close(); }
});

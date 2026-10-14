import assert from 'node:assert/strict';
import test from 'node:test';
import { feedBlocks, ELIDE } from './hub.ts';
import type { HubActivityEvent } from '../core/ws.ts';
import { renderHarness, RENDER_TIMEOUT_MS } from '../test/ssr.ts';

// One warm server for the whole render tier (board #178): the environment
// and the svelte runtime are built at import, outside this suite's timer.
const h = await renderHarness();

test('Feed renders direct rows, safe rich content, complete capped tools and the original empty slot', { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Feed = (await h.load('/src/lib/hub/Feed.svelte')).default;
  const { render } = h;
  const { createRawSnippet } = await h.load('svelte');
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'working' },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle' },
  ];
  const messages = [
    { id: 'q', ts: 1, from: 'human', body: '@alice ' + 'A long question. '.repeat(400) },
    { id: 'note', ts: 2, from: 'human', body: 'A room-only record.' },
    { id: 'reply', ts: 3, from: 'alice',
      body: '**Result** $x^2$ [source](/source.ts) [bad](javascript:alert(1))\n\n![chart](/chart.png)' },
    { id: 'board', ts: 4, from: 'alice', body: '[tmm] board #7 todo → doing — Feed extraction' },
  ];
  const events: HubActivityEvent[] = Array.from({ length: 26 }, (_, i) => ({
    id: i + 1, ts: 10 + i, window: i % 2 ? 'bob' : 'alice',
    kind: 'tool' as const, tool: 'Read', text: `source-${i}.ts`,
  }));
  // The input half (board #172): the 601-char notice that stopped
  // mid-sentence in the owner's screenshot, and a short delivery that fits.
  const longNotice = '[tmm chat 2026-09-11 08:00] claude: [board #168 reply] Composer agent strip — ' + 'the strip replaces the chip. '.repeat(20).trimEnd() + '. Reply on the issue with `tmm board note 168 "..."`.';
  events.push(
    { id: 90, ts: 40, window: 'bob', kind: 'prompt', text: longNotice },
    { id: 91, ts: 41, window: 'alice', kind: 'prompt', text: '[tmm chat 2026-09-11 08:01] human: [board #7] Feed extraction: status todo → doing' },
  );
  const blocks = feedBlocks(messages, events, 'tools', (name) => name);
  const emptyFeed = createRawSnippet(() => ({ render: () => '<div class="empty">Empty fixture</div>' }));
  const view = (props: Record<string, unknown> = {}) => h.fragment(render(Feed, { props: {
    selected: 'fixture', roomReady: true, blocks, agents, managedNames: ['alice', 'bob'],
    stepsRows: 5, following: false, newBelow: true, emptyFeed, ...props,
  } }).body as string);
  const tree = view();
  assert.equal(tree.children.length, 1);
  assert.ok(tree.firstElementChild?.classList.contains('feed-wrap'));
  const feed = tree.querySelector('.feed')!;
  for (const row of tree.querySelectorAll('.msg,.sysline,.day-sep')) assert.equal(row.parentElement, feed);
  for (const lane of tree.querySelectorAll('.steps')) assert.ok(lane.parentElement?.matches('.msg > .bubble'), 'every run sits in an agent bubble (#298)');
  assert.equal(tree.querySelectorAll('[data-ask]').length, 2);
  assert.equal(tree.querySelectorAll('.m-unfold').length, 2, 'the long ask and the long prompt fold; nothing else does');
  // A prompt row folds its TEXT through elideTail — a visible `……` and the
  // same unfold control as a bubble — instead of clipping silently.
  const prompts = tree.querySelectorAll('.prompt');
  assert.equal(prompts.length, 2);
  const longRow = prompts[0]!;
  const longBody = longRow.querySelector('.p-body')!.textContent ?? '';
  assert.ok(longBody.endsWith(ELIDE), `the folded prompt ends with the marker: ${longBody.slice(-20)}`);
  assert.ok(longBody.length < longNotice.length, 'folded means shorter');
  assert.ok(longRow.querySelector('.m-unfold'), 'the way to the whole prompt');
  // The reply notice wears the board dialect: chip + badge, marker gone.
  assert.equal(longRow.querySelector('.p-chip')?.textContent, '#168');
  assert.ok(longRow.querySelector('.p-badge'), 'a reply notice carries the badge');
  assert.ok(!longBody.includes('[board #168 reply]'), 'the marker never renders as text');
  assert.equal(prompts[1]!.querySelector('.p-badge'), null, 'a plain board delivery has no badge');
  const shortBody = prompts[1]!.querySelector('.p-body')!.textContent ?? '';
  assert.ok(shortBody.includes('Feed extraction: status todo → doing'), 'a short prompt renders whole');
  assert.equal(prompts[1]!.querySelector('.m-unfold'), null, 'nothing to unfold when it fits');
  assert.ok(tree.querySelector('.m-state.note .note-dot'));
  assert.ok(tree.querySelector('.katex'));
  // The sender's runtime rides beside its name, from the live row (#292).
  assert.equal(tree.querySelector('.m-head .m-runtime')?.textContent, 'kiro');
  assert.ok(tree.querySelector('.m-body strong'));
  assert.ok(tree.querySelector('a[href="/source.ts"]'));
  assert.equal(tree.querySelector('a[href^="javascript:"]'), null);
  assert.equal(tree.querySelector('.ci-ref')?.textContent, '/chart.png', 'client image loading retains the exact reference');
  assert.ok(tree.querySelector('.sys-jump'));
  // alice is working: her run is open and capped; bob's stopped run is folded (#298).
  assert.equal(tree.querySelectorAll('.s-body.capped').length, 1);
  assert.equal(tree.querySelectorAll('.step').length, 13, 'the cap is a viewport, not data loss: all 13 of alice\u2019s calls');
  assert.equal(tree.querySelectorAll('.steps:not(.open)').length, 1, 'the idle lane folds');
  assert.equal(tree.querySelectorAll('.s-live.live-dot').length, 1);
  assert.ok(tree.querySelector('.to-tail.news'));
  const empty = view({ blocks: [] }).querySelector('.empty')!;
  assert.ok(empty.parentElement?.classList.contains('feed'), 'the parent snippet introduces no row wrapper');
  assert.ok(view({ blocks: [], roomReady: false }).querySelector('.sk-feed[aria-hidden="true"]'));
});


test('a sent /command renders as the sender bubble, whole, name in inline code (#264)', { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Feed = (await h.load('/src/lib/hub/Feed.svelte')).default;
  const { render } = h;
  const { createRawSnippet } = await h.load('svelte');
  // The owner's case (2026-09-28): a long /goal that the capsule cut off.
  const args = '你看一下 ../260928-eks-gpu-training 这里有可用的 gpu eks 集群，你准备好数据后，可以在 eks 上进行数据处理，以及先跑通一个 初始的实验，注意用验证集验证效果 *not bold* ' + '然后把结果整理成报告，'.repeat(12) + '<b>x</b>';
  // (Long enough to exceed the render tier's default budget, 3 lines × 80 units.)
  const messages = [
    { id: 'g', ts: 1, from: 'human', body: `[tmm] /goal ${args} → kiro` },
    { id: 'm', ts: 2, from: 'human', body: '[tmm] /compact → lead, dev' },
    { id: 's', ts: 3, from: 'human', body: '[tmm] stopped dev' },
  ];
  const blocks = feedBlocks(messages, [], 'chat', (n) => n);
  const tree = h.fragment(render(Feed, { props: {
    selected: 'fixture', roomReady: true, blocks, agents: [], managedNames: ['kiro', 'lead', 'dev'],
    stepsRows: 5, following: false, newBelow: false,
    emptyFeed: createRawSnippet(() => ({ render: () => '<div></div>' })),
  } }).body as string);
  const bubbles = tree.querySelectorAll('.msg.me');
  assert.equal(bubbles.length, 2, 'both commands are the sender bubble, even at the chat level');
  assert.equal(tree.querySelector('.sysline'), null, 'the lifecycle line is hidden at chat level; no command capsule');
  const goal = bubbles[0]!.querySelector('.m-body p')!;
  assert.equal(goal.querySelector('.m-to')?.textContent, '@kiro');
  assert.equal(goal.querySelector('code')?.textContent, '/goal');
  // A long command folds like a long message (owner, 2026-09-28 16:35: one
  // /goal filled the phone screen): recipients and name stay, the arguments
  // are cut at the budget, and the unfold control is the way to the rest.
  assert.ok(goal.textContent!.endsWith('……'), 'the arguments are folded');
  assert.ok(args.startsWith(goal.textContent!.replace(/^@kiro \/goal /u, '').replace(/……$/u, '')), 'the start of the arguments, as text');
  assert.ok(!goal.textContent!.includes('<b>x</b>'), 'the tail is cut');
  assert.equal(goal.querySelector('b,em'), null, 'arguments are data, not markdown or HTML');
  assert.ok(bubbles[0]!.querySelector('.m-unfold'), 'a long command folds');
  assert.ok(!goal.textContent!.includes('```'), 'no markdown fence repair on plain arguments');
  const fan = bubbles[1]!.querySelector('.m-body p')!;
  assert.deepEqual([...fan.querySelectorAll('.m-to')].map((n) => n.textContent), ['@lead', '@dev'], 'fan-out lists every target like a message does');
  assert.equal(fan.querySelector('code')?.textContent, '/compact');
  assert.equal(bubbles[1]!.querySelector('.m-unfold'), null, 'a short command has nothing to unfold');
  // Validator 16:49: an argument-less command to many long recipients has
  // nothing to unfold — its recipients and name are never folded.
  const eight = Array.from({ length: 8 }, (_, k) => `agent${k}1234567890`);
  const bare = h.fragment(render(Feed, { props: {
    selected: 'fixture', roomReady: true, agents: [], managedNames: eight,
    blocks: feedBlocks([{ id: 'c', ts: 1, from: 'human', body: `[tmm] /compact → ${eight.join(', ')}` }], [], 'chat', (n) => n),
    stepsRows: 5, following: false, newBelow: false,
    emptyFeed: createRawSnippet(() => ({ render: () => '<div></div>' })),
  } }).body as string);
  assert.equal(bare.querySelectorAll('.msg.me .m-to').length, 8, 'every recipient shows');
  assert.equal(bare.querySelector('.msg.me .m-unfold'), null, 'no Expand that would change nothing');
  assert.ok(!bare.querySelector('.msg.me .m-body p')!.textContent!.includes('……'));
  // No receipt → no ring: a hollow ring would promise an echo most commands
  // never send.
  assert.equal(bubbles[1]!.querySelector('.m-state'), null);
  // The echo names the command's message (the server's receipt row): the
  // bubble is delivered and the echo is not an INPUT row.
  const acked = feedBlocks(messages, [
    { id: 1, ts: 5, window: 'kiro', kind: 'prompt', via: 'app', text: `goal ${args}`, deliveries: [{ id: 9, msg: 'g' }] },
  ], 'tools', (n) => n);
  const ackTree = h.fragment(render(Feed, { props: {
    selected: 'fixture', roomReady: true, blocks: acked, agents: [], managedNames: ['kiro', 'lead', 'dev'],
    stepsRows: 5, following: false, newBelow: false,
    emptyFeed: createRawSnippet(() => ({ render: () => '<div></div>' })),
  } }).body as string);
  assert.ok(ackTree.querySelectorAll('.msg.me')[0]!.querySelector('.m-state.ok'), 'the settled command wears the check');
  assert.equal(ackTree.querySelector('.prompt'), null, 'its echo is consumed, not a duplicate INPUT row');
});


test('every valid @ in a bubble is marked, an invalid one is not, in both directions (#273)', { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Feed = (await h.load('/src/lib/hub/Feed.svelte')).default;
  const { createRawSnippet } = await h.load('svelte');
  const roster = ['architect', 'engineer', 'data', 'evaluator', 'reviewer'];
  const messages = [
    // The owner's 08:01 sample, plus a removed agent and an email.
    { id: 'm', ts: 1, from: 'human', body: '@architect @engineer @data @evaluator @reviewer 哈喽，lab 团队你们好。\n\n@ghost and a@b.com stay plain; `@data` in code too.' },
    { id: 'r', ts: 2, from: 'architect', body: 'Plan ready — @data owns G1, @human please confirm.' },
  ];
  const tree = h.fragment(h.render(Feed, { props: {
    selected: 'fixture', roomReady: true, agents: [], managedNames: roster,
    blocks: feedBlocks(messages, [], 'chat', (n) => n),
    stepsRows: 5, following: false, newBelow: false,
    emptyFeed: createRawSnippet(() => ({ render: () => '<div></div>' })),
  } }).body as string);
  const marked = (sel: string) => [...tree.querySelectorAll(`${sel} .m-to`)].map((n) => n.textContent);
  assert.deepEqual(marked('.msg.me'), roster.map((n) => `@${n}`), 'all five, and nothing else');
  assert.deepEqual(marked('.msg:not(.me)'), ['@data', '@human'], "an agent's bubble reads the same way");
  assert.equal(tree.querySelector('.msg.me code')?.textContent, '@data', 'the code span keeps its text, unmarked');
});


test("an agent's /command is ITS bubble, not the human's (#274)", { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Feed = (await h.load('/src/lib/hub/Feed.svelte')).default;
  const { createRawSnippet } = await h.load('svelte');
  const messages = [
    { id: 'a', ts: 1, from: 'lead', body: '[tmm] /compact → dev' },
    { id: 'h', ts: 2, from: 'human', body: '[tmm] /clear → lead' },
  ];
  const tree = h.fragment(h.render(Feed, { props: {
    selected: 'fixture', roomReady: true, agents: [], managedNames: ['lead', 'dev'],
    blocks: feedBlocks(messages, [], 'chat', (n) => n),
    stepsRows: 5, following: false, newBelow: false,
    emptyFeed: createRawSnippet(() => ({ render: () => '<div></div>' })),
  } }).body as string);
  const bubbles = [...tree.querySelectorAll('.msg')];
  assert.equal(bubbles.length, 2);
  assert.ok(!bubbles[0]!.classList.contains('me'), 'the agent sent it: an incoming bubble');
  assert.equal(bubbles[0]!.querySelector('.m-head .m-who')?.textContent?.trim(), 'lead', 'named by its sender');
  assert.equal(bubbles[0]!.querySelector('.bubble .m-head'), null, 'from outside the bubble (#292)');
  assert.equal(bubbles[0]!.querySelector('.m-runtime'), null, 'no live row, no runtime label');
  assert.equal(bubbles[0]!.querySelector('.m-to')?.textContent, '@dev');
  assert.equal(bubbles[0]!.querySelector('code')?.textContent, '/compact');
  assert.ok(bubbles[1]!.classList.contains('me'), "the human's command is still the human's own bubble");
});

test('a run its reply ended rides in that reply, folded; a run still going stands alone, open (#295)', { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Feed = (await h.load('/src/lib/hub/Feed.svelte')).default;
  const { createRawSnippet } = await h.load('svelte');
  const agents = [
    { name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' },
    { name: 'ops', window: 1, managed: true, agent: 'codex', state: 'working' },
  ];
  const tool = (ts: number, window: string, text: string) => ({ id: ts, ts, window, kind: 'tool' as const, tool: 'Read', text });
  const tree = h.fragment(h.render(Feed, { props: {
    selected: 'fixture', roomReady: true, agents, managedNames: ['dev', 'ops'],
    blocks: feedBlocks([{ id: 'r', ts: 30, from: 'dev', body: 'fixed it' }],
      [tool(10, 'dev', 'a.rs'), tool(20, 'dev', 'b.rs'), tool(25, 'ops', 'c.rs')], 'tools', (n) => n),
    stepsRows: 5, following: false, newBelow: false,
    emptyFeed: createRawSnippet(() => ({ render: () => '<div></div>' })),
  } }).body as string);
  const reply = tree.querySelector('.msg:has(.m-body)')!;
  const carried = reply.querySelector('.bubble > .steps')!;
  assert.ok(carried, 'the run is inside the reply\u2019s bubble, one card');
  assert.ok(reply.querySelector('.bubble > .steps + .m-body'), 'between the header and the words');
  assert.equal(carried.classList.contains('open'), false, 'folded by default: the answer is there');
  assert.equal(carried.querySelector('.s-head')?.getAttribute('aria-expanded'), 'false');
  assert.equal(carried.querySelector('.s-who'), null, 'the bubble already names who');
  assert.equal(carried.querySelector('.s-live'), null, 'a finished run never pulses');
  assert.match(carried.querySelector('.s-count')?.textContent ?? '', /2/u);
  // ops is still working and has no reply: its own bubble (#298), open, live.
  const lanes = [...tree.querySelectorAll('.feed > .msg:not(:has(.m-body)) > .bubble > .steps')];
  assert.equal(lanes.length, 1);
  assert.ok(lanes[0]!.classList.contains('open'));
  assert.ok(lanes[0]!.querySelector('.s-live.live-dot'));
  assert.equal(tree.querySelectorAll('.steps').length, 2, 'two runs, one list markup each');
});

test('a human message with a picture folds behind Expand with an [Image] line; an agent\u2019s picture stays in the strip (#372)', { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Feed = (await h.load('/src/lib/hub/Feed.svelte')).default;
  const { render } = h;
  const { createRawSnippet } = await h.load('svelte');
  const img = (n: number) => `![](/work/fixture/.tmm/uploads/p${n}-12345678.webp)`;
  const messages = [
    { id: 'one', ts: 1, from: 'human', body: `short words\n${img(1)}` },
    { id: 'two', ts: 2, from: 'human', body: `${img(2)}\n${img(3)}` },
    { id: 'plain', ts: 3, from: 'human', body: 'just words' },
    { id: 'agent', ts: 4, from: 'dev', body: `look\n${img(4)}` },
  ];
  const tree = h.fragment(render(Feed, { props: {
    selected: 'fixture', roomReady: true, agents: [{ name: 'dev', window: 0, managed: true, agent: 'kiro', state: 'idle' }], managedNames: ['dev'],
    blocks: feedBlocks(messages, [], 'chat', (n) => n), stepsRows: 5, following: false, newBelow: false,
    emptyFeed: createRawSnippet(() => ({ render: () => '<div></div>' })),
  } }).body as string);
  const row = (id: string) => [...tree.querySelectorAll('.msg')][['one', 'two', 'plain', 'agent'].indexOf(id)]!;
  for (const id of ['one', 'two']) {
    assert.ok(row(id).querySelector('.m-unfold'), `${id}: the picture folds like a long text and opens with the same control`);
    assert.equal(row(id).querySelector('.shots'), null, `${id}: no strip until it is expanded`);
  }
  assert.equal(row('one').querySelector('.m-imgs')?.textContent, '[Image]');
  assert.equal(row('one').querySelector('.m-body')?.textContent?.includes('short words'), true, 'the words stay');
  assert.equal(row('two').querySelector('.m-imgs')?.textContent, '[Image] ×2', 'an image-only message says how many');
  assert.equal(row('plain').querySelector('.m-unfold'), null, 'words that fit have nothing to unfold');
  assert.equal(row('plain').querySelector('.m-imgs'), null);
  assert.ok(row('agent').querySelector('.shots'), 'an agent\u2019s picture is not folded: it is never pinned');
  assert.equal(row('agent').querySelector('.m-unfold'), null);
  assert.equal(row('agent').querySelector('.m-imgs'), null);
});

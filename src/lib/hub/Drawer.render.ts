import assert from 'node:assert/strict';
import test from 'node:test';
import { renderHarness, RENDER_TIMEOUT_MS } from '../test/ssr.ts';

// One warm server for the whole render tier (board #178): the environment
// and the svelte runtime are built at import, outside this suite's timer.
const h = await renderHarness();

test('Drawer renders its original window list, real partitions and single head', { timeout: RENDER_TIMEOUT_MS }, async () => {
  const Drawer = (await h.load('/src/lib/hub/Drawer.svelte')).default;
  const { render } = h;
  const agents = [
    { name: 'alice', window: 0, agent: 'kiro', managed: true, state: 'working' },
    { name: 'loose', window: 1, agent: 'claude', managed: false, state: 'idle' },
    { name: 'shell', window: 2, agent: null, managed: false, state: 'idle' },
    { name: 'notes', window: 3, agent: null, managed: false, state: 'idle' },
  ];
  const view = (props: Record<string, unknown> = {}) => h.fragment(render(Drawer, { props: {
    selected: 'fixture', agents, stateLabel: (state: string) => state,
    ...props,
  } }).body as string);
  const empty = view();
  assert.equal(empty.children.length, 1);
  assert.equal(empty.firstElementChild?.tagName, 'SECTION');
  assert.equal(empty.querySelectorAll('.drawer-head').length, 1);
  assert.ok(empty.querySelector('.side-handle.on-left'));
  assert.ok(empty.querySelector('.term-body .empty'));
  // #320: the project's shell (the first non-agent window) leads the bar and
  // is never folded; the other non-agent window hides behind +1.
  const pills = [...empty.querySelectorAll('.win-pill:not(.more)')].map((b) => b.textContent?.trim());
  assert.deepEqual(pills, ['2:shell', '0:alice', '1:loosedirect']);
  assert.equal(empty.querySelector('.win-pill.more')?.textContent?.trim(), '+1');
  assert.equal(empty.querySelector('.direct-tag')?.textContent, 'direct');
  assert.ok(empty.querySelector('.win-pill .live-dot'));
  // Board #338: the head carries no roster count ("N · M running"); the
  // pills' live dots are the running cue (stateIsLive, one definition — board
  // #179). Running, legacy working and waiting agents all render, and none of
  // them brings the count back.
  const live = view({ agents: [
    { name: 'devops', window: 5, agent: 'codex', managed: true, state: 'running' },
    { name: 'builder', window: 6, agent: 'claude', managed: true, state: 'waiting' },
    { name: 'legacy', window: 7, agent: 'kiro', managed: true, state: 'working' },
  ] });
  assert.equal(live.querySelector('.d-count'), null, 'the head shows no running count');
  assert.ok(!/running/u.test(live.querySelector('.drawer-head')?.textContent ?? ''), 'and no "N running" text in any form');
  assert.deepEqual([...live.querySelectorAll('.win-pill .live-dot')].map((d) => d.parentElement?.textContent?.trim()), ['5:devops', '7:legacy'], 'live dots: running and legacy working, not waiting (#179)');
  assert.equal(empty.querySelector('.win-pill')?.getAttribute('aria-pressed'), 'false');
  const commands = empty.querySelectorAll('.drawer-head .command-button');
  assert.equal(commands.length, 2, '#166: maximize and close share the command owner');
  assert.equal(commands[1]?.getAttribute('aria-label'), 'Close');
  assert.equal(view({ winsExpanded: true }).querySelectorAll('.win-pill:not(.more)').length, 4);
  const selectedShell = view({ termTarget: 'fixture:2.0' });
  assert.ok(selectedShell.querySelector('.win-pill.cur')?.textContent?.includes('2:shell'));
  assert.equal(selectedShell.querySelector('.win-pill.cur')?.getAttribute('aria-pressed'), 'true');
  assert.equal(selectedShell.querySelector('.win-pill.more')?.textContent?.trim(), '+1');
  assert.ok(selectedShell.querySelector('.xterm-wrap'), 'the real Terminal markup is embedded');
  const files = view({ drawerView: 'files' });
  assert.ok(files.querySelector('.term-body.off'));
  assert.ok(files.querySelector('.files-body'));
  assert.equal(files.querySelector('.board-body'), null);
  const board = view({ drawerView: 'board' });
  assert.ok(board.querySelector('.board-body .board-root'));
  assert.equal(board.querySelector('.board-body .page-head'), null, 'the real Board keeps its embedded head gate');
  assert.equal(board.querySelectorAll('.drawer-head').length, 1);
});

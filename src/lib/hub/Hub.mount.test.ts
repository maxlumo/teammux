import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

let compilation: ReturnType<typeof compileMount> | undefined;
const compiledHub = () => compilation ??= compileMount(new URL('./Hub.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
], { serverScope: true });

/** Everyone lives at the head of the EXPANDED roster (#204): expand first when needed. */
async function allButton(app: { document: Document; flush: () => Promise<void> }): Promise<HTMLButtonElement> {
  let button = app.document.querySelector<HTMLButtonElement>('.all-choice button');
  if (!button) {
    app.document.querySelector<HTMLButtonElement>('.roster-toggle button')!.click();
    await app.flush();
    button = app.document.querySelector<HTMLButtonElement>('.all-choice button');
  }
  return button!;
}

function roomFixture() {
  const pushed = new Set<unknown>();
  return {
    pushed,
    rpc: {
      projectList: async () => ({ projects: [{
        project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/fixture' },
        live: true, slots: [],
      }] }),
      listSessionsWithPanes: async () => ({ panes: [] }),
      hubRooms: async () => ({ rooms: {}, states: {} }),
      hubUnread: async () => ({ rooms: {} }),
      hubRead: async () => ({ rooms: {} }),
      registryList: async () => ({ agents: [] }),
      teamsList: async () => ({ teams: [] }),
      hubAgents: async () => ({ agents: [
        { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' },
        { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle' },
      ] }),
      hubLog: async () => ({ messages: [], has_more: false }),
      hubActivity: async () => ({ events: [], has_more: false }),
      addTeamMessageListener: (fn: unknown) => { pushed.add(fn); },
      removeTeamMessageListener: (fn: unknown) => { pushed.delete(fn); },
      // The login answer of a server that can do everything the Hub asks of
      // one (board #384: the Move items read it); a test of an older server
      // overrides it.
      getCaps: () => ['board_dispatch', 'spawn_join', 'agent_team'],
      onCaps: () => undefined,
    },
  };
}

test('saved all restores through a fresh mount and room revisit without delivering (#171)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  let saved = JSON.stringify({ fixture: 'all', other: '' });
  for (let reload = 0; reload < 2; reload++) {
    const app = await fixture.mount(context, {
      props: { visible: true },
      setup(window) {
        window.Element.prototype.getAnimations = () => [];
        window.localStorage.setItem('tmux_hub_project', 'fixture');
        window.localStorage.setItem('tmux_hub_lead', saved);
      },
      modules: [{
        ...rpc,
        projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
          project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
        })) }),
        hubPost: () => assert.fail('restoring a destination must not post'),
        hubCommand: () => assert.fail('restoring a destination must not execute a command'),
        hubAgentInterrupt: () => assert.fail('restoring a destination must not interrupt'),
      }],
    });
    try {
      for (let i = 0; i < 12 && app.document.querySelectorAll('.acard:not(.add)').length < 2; i++) await app.flush();
      const input = app.document.querySelector<HTMLTextAreaElement>('.c-input')!;
      assert.equal(input.placeholder, 'Message every agent…', 'a fresh client restores broadcast');
      for (const room of ['other', 'fixture']) {
        app.document.querySelector<HTMLElement>(`[aria-label="${room}"] .proj-pick`)!.click();
        for (let i = 0; i < 12 && app.document.querySelector('.h1-text')?.textContent !== room; i++) await app.flush();
      }
      assert.equal(input.placeholder, 'Message every agent…', 'cached room restore keeps broadcast');
      await app.advance(10000);
      assert.equal(input.placeholder, 'Message every agent…', 'roster polling does not reseat a lead');
      saved = app.window.localStorage.getItem('tmux_hub_lead')!;
      assert.deepEqual(JSON.parse(saved), { fixture: 'all', other: '' });
    } finally { await app.close(); }
  }
});

test('a saved team target survives a cold mount until the fresh roster judges it (#241)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle', since: 20, team: 'review' },
    { name: 'charlie', window: 2, managed: true, agent: 'codex', state: 'idle', since: 5, team: 'review' },
  ];
  let answered = false;
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_hub_lead', JSON.stringify({ fixture: 'team:review' }));
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: [{
        project: { id: 'fixture', name: 'fixture', session: 'fixture', path: '/fixture' }, live: true, slots: [],
      }] }),
      hubAgents: async () => { answered = true; return { agents }; },
    }],
  });
  const lead = () => JSON.parse(app.window.localStorage.getItem('tmux_hub_lead') ?? '{}').fixture;
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.roster-cluster.team-lit'); i++) await app.flush();
    assert.ok(answered, 'the fresh roster answered');
    assert.equal(lead(), 'team:review', 'a cold entry does not overwrite the stored team before the roster answers');
    assert.ok(app.document.querySelector('.roster-cluster[data-team="review"].team-lit'), 'the refreshed client restores the team');
    agents.splice(1);
    await app.advance(5000);
    assert.equal(lead(), '', 'an answered roster with no members forgets the team');
  } finally { await app.close(); }
});

const selectedCard = (document: Document) =>
  document.querySelector('.all-choice [aria-pressed="true"]') ? 'all'
    : document.querySelector('.agent-select[aria-pressed="true"]')?.closest<HTMLElement>('.acard')?.dataset.agent ?? '';
const stripCard = (document: Document, name: string) =>
  document.querySelector<HTMLElement>(`.acard[data-agent="${name}"]`)!;
/** #205: Stop stands on the dot only while the card is hovered (fine pointer) or its interrupt is pending. */
type HoverApp = { document: Document; window: { Event: typeof Event }; flush: () => Promise<void> };
const hoverCard = async (app: HoverApp, name: string) => {
  const event = new app.window.Event('pointerenter', { bubbles: false });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  stripCard(app.document, name).dispatchEvent(event);
  await app.flush();
};
const unhoverCard = async (app: HoverApp, name: string) => {
  stripCard(app.document, name).dispatchEvent(new app.window.Event('pointerleave', { bubbles: false }));
  await app.flush();
};

test('process Stop keeps a failed confirmation retryable and pending Back cannot peel its parent (#167)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  let back!: () => boolean;
  let reject!: (error: Error) => void;
  let calls = 0;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, mobile: true, onGoBack: (fn: typeof back) => back = fn },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{ ...rpc, hubAgentStop: () => ++calls === 1 ? new Promise((_, no) => reject = no) : Promise.resolve({}) }],
  });
  try {
    for (let i = 0; i < 12 && !stripCard(app.document, 'alice'); i++) await app.flush();
    stripCard(app.document, 'alice').querySelector('.agent-select')!
      .dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
    await app.flush();
    const stop = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find(button => button.textContent?.trim() === 'Stop')!;
    assert.ok(stop); stop.click(); await app.flush();
    const confirm = app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!;
    confirm.click(); confirm.click(); await app.flush();
    assert.equal(calls, 1);
    assert.equal(back(), true); await app.flush();
    assert.equal(app.document.querySelector('.sidebar.open'), null, 'pending Back does not reach the sidebar floor');
    assert.ok(app.document.querySelector('[role=alertdialog]'));
    reject(new Error('Denied'));
    for (let i = 0; i < 5; i++) await app.flush();
    assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Denied/);
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(calls, 2);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('project archive retry resumes after the successful close, not before it (#167)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const calls: string[] = [];
  let archives = 0;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{ ...rpc,
      projectDown: async (id: string) => { calls.push(`close:${id}`); return {}; },
      projectArchive: async (id: string) => {
        calls.push(`archive:${id}`);
        if (++archives === 1) throw new Error('Archive unavailable');
        return {};
      },
    }],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.proj-row'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.proj-row .row-menu')!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find(button => button.textContent?.trim() === 'Delete')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Archive unavailable/);
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.deepEqual(calls, ['close:fixture', 'archive:fixture', 'archive:fixture']);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('a successful process Stop with a failed refresh retries only the read (#167)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  let stopped = 0, reads = 0, failRefresh = true;
  let finishRead!: (value: unknown) => void;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{ ...rpc,
      projectList: async () => {
        reads++;
        if (stopped && failRefresh) throw new Error('Read unavailable');
        return stopped ? new Promise(yes => finishRead = yes) : rpc.projectList();
      },
      hubAgentStop: async () => { stopped++; return {}; },
    }],
  });
  try {
    for (let i = 0; i < 12 && !stripCard(app.document, 'alice'); i++) await app.flush();
    stripCard(app.document, 'alice').querySelector('.agent-select')!
      .dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
    await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find(button => button.textContent?.trim() === 'Stop')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'the mutation succeeded');
    const error = app.document.querySelector('.action-read-error');
    assert.match(error?.textContent ?? '', /Read unavailable/);
    const before = reads;
    failRefresh = false;
    error!.querySelector<HTMLButtonElement>('button')!.click();
    await app.flush();
    const retry = app.document.querySelector<HTMLButtonElement>('.action-read-error button');
    assert.ok(retry, 'the error and retry command stay while the read is pending');
    assert.equal(retry.getAttribute('aria-label'), 'Refresh');
    assert.equal(retry.disabled, true);
    retry.click();
    finishRead(await rpc.projectList());
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(stopped, 1);
    assert.ok(reads > before);
    assert.equal(app.document.querySelector('.action-read-error'), null);
  } finally { await app.close(); }
});

test('permanent project purge has the same pending and failed-confirmation boundary (#167)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  let back!: () => boolean, reject!: (error: Error) => void, calls = 0;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, onGoBack: (fn: typeof back) => back = fn },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{ ...rpc,
      projectList: async () => ({ projects: [
        { project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/fixture' }, live: true, slots: [] },
        ...(calls > 1 ? [] : [{ project: { id: 'old', name: 'Old', session: 'old', path: '/old', archived: true }, live: false, slots: [] }]),
      ] }),
      projectDelete: () => ++calls === 1 ? new Promise((_, no) => reject = no) : Promise.resolve({}),
    }],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.trash-bar'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.trash-bar')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.trash-row .t-act.danger')!.click(); await app.flush();
    const button = app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!;
    button.click(); button.click(); await app.flush();
    assert.equal(calls, 1);
    assert.equal(back(), true); await app.flush();
    assert.ok(app.document.querySelector('[role=alertdialog]'));
    reject(new Error('Purge denied'));
    for (let i = 0; i < 5; i++) await app.flush();
    assert.match(app.document.querySelector('[role=alertdialog] [role=alert]')?.textContent ?? '', /Purge denied/);
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(calls, 2);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('a second completed Hub mutation gets a newer refresh and old snapshots cannot overwrite it (#167)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const stopped: string[] = [];
  const projects: ((value: unknown) => void)[] = [], rosters: ((value: unknown) => void)[] = [];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{ ...rpc,
      projectList: () => stopped.length ? new Promise(yes => projects.push(yes)) : rpc.projectList(),
      hubAgents: () => stopped.length ? new Promise(yes => rosters.push(yes)) : rpc.hubAgents(),
      hubAgentStop: async (_session: string, name: string) => { stopped.push(name); return {}; },
    }],
  });
  try {
    for (let i = 0; i < 12 && !stripCard(app.document, 'alice'); i++) await app.flush();
    for (const name of ['alice', 'bob']) {
      stripCard(app.document, name).querySelector('.agent-select')!
        .dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
      await app.flush();
      [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
        .find(button => button.textContent?.trim() === 'Stop')!.click(); await app.flush();
      app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
      for (let i = 0; i < 5; i++) await app.flush();
    }
    assert.deepEqual(stopped, ['alice', 'bob']);
    // One read of a kind in flight (core/poll.ts, #444): the second mutation's
    // refresh does not start beside the first; it is ONE follow-up read once
    // the pending one has answered, so it still sees the second stop.
    assert.equal(projects.length, 1, 'the second refresh waits for the pending read (#444)');
    assert.equal(rosters.length, 1);
    projects[0]!(await rpc.projectList()); rosters[0]!(await rpc.hubAgents());
    for (let i = 0; i < 5; i++) await app.flush();
    assert.equal(projects.length, 2, 'a newer mutation cannot lose its refresh behind an older one');
    assert.equal(rosters.length, 2, 'one follow-up roster read, not dropped and not doubled');
    const latest = await rpc.projectList();
    latest.projects[0]!.project.name = 'Fresh project';
    projects[1]!(latest); rosters[1]!({ agents: [] });
    for (let i = 0; i < 5; i++) await app.flush();
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'Fresh project');
    assert.equal(app.document.querySelectorAll('.agent-select').length, 0, 'old roster cannot resurrect stopped agents');
  } finally { await app.close(); }
});

// ── Board #444: one read of a kind in flight per room, owned by the read ────
// A held answer stands in for a stalled phone link. The roster read is counted
// per room; `hold` keeps the next answers pending until the test releases them.
async function heldRoster(context: TestContext, holdFirst = false) {
  const { rpc, pushed } = roomFixture();
  const calls: { room: string; answer: (agents: unknown[]) => void; fail: (message: string) => void }[] = [];
  let hold = holdFirst;
  const roster = (state: string) => [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state }];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{ ...rpc,
      projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
        project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
      })) }),
      hubAgents: (room: string) => hold
        ? new Promise((yes, no) => calls.push({ room, answer: (agents) => yes({ agents }), fail: (message) => no(new Error(message)) }))
        : (calls.push({ room, answer: () => {}, fail: () => {} }), Promise.resolve({ agents: roster('idle') })),
      hubAgentStop: async () => ({}),
    }],
  });
  const settle = async () => { for (let i = 0; i < 8; i++) await app.flush(); };
  const held = (room = 'fixture') => calls.filter((c) => c.room === room);
  const push = (body: string) => {
    const message = app.window.JSON.parse(JSON.stringify({ id: body, seq: 9, room: 'proj:fixture', from: 'alice', ts: Date.now(), body }));
    for (const listener of pushed) (listener as (m: unknown) => void)(message);
  };
  const room = async (name: string) => {
    app.document.querySelector<HTMLElement>(`[aria-label="${name}"] .proj-pick`)!.click();
    for (let i = 0; i < 20 && app.document.querySelector('.h1-text')?.textContent !== name; i++) await app.flush();
    assert.equal(app.document.querySelector('.h1-text')?.textContent, name);
  };
  const stop = async (name: string) => {
    stripCard(app.document, name).querySelector('.agent-select')!
      .dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
    await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find((button) => button.textContent?.trim() === 'Stop')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    await settle();
  };
  return { app, calls, held, settle, push, roster, room, stop, setHold: (v: boolean) => { hold = v; } };
}

test('a pending roster read survives hide -> show: the new timer does not read beside it (#444)', { timeout: 60000 }, async context => {
  const h = await heldRoster(context);
  try {
    await h.settle();
    const before = h.held().length;
    h.setHold(true);
    await h.app.advance(5000); await h.settle();
    assert.equal(h.held().length, before + 1, 'the tick asked once and the answer is held');
    await h.app.setProps({ visible: false });
    await h.app.setProps({ visible: true });
    await h.app.advance(5000); await h.settle();
    await h.app.advance(5000); await h.settle();
    assert.equal(h.held().length, before + 1, 'hidden and shown again, still one read in flight');
    h.setHold(false);
    h.held().at(-1)!.answer(h.roster('running')); await h.settle();
    await h.app.advance(5000); await h.settle();
    assert.equal(h.held().length, before + 2, 'the first tick after the answer reads again');
  } finally { await h.app.close(); }
});

test('the first roster read of a room is not doubled by the first tick (#444)', { timeout: 60000 }, async context => {
  const h = await heldRoster(context, true);
  try {
    for (let i = 0; i < 20 && !h.held().length; i++) await h.app.flush();
    assert.equal(h.held().length, 1, 'entering the room asked once');
    await h.app.advance(5000); await h.settle();
    await h.app.advance(5000); await h.settle();
    assert.equal(h.held().length, 1, 'ticks during the first read send nothing');
    h.setHold(false);
    h.held()[0]!.answer(h.roster('idle')); await h.settle();
    assert.ok(stripCard(h.app.document, 'alice'), 'the first answer renders');
    assert.equal(h.held().length, 1, 'and no tick was queued behind it');
  } finally { await h.app.close(); }
});

test('a push during a pending roster read gets ONE follow-up read after it, never a second at once (#444)', { timeout: 60000 }, async context => {
  const h = await heldRoster(context);
  try {
    await h.settle();
    const before = h.held().length;
    h.setHold(true);
    await h.app.advance(5000); await h.settle();
    assert.equal(h.held().length, before + 1);
    h.push('first'); await h.app.advance(300); await h.settle();
    h.push('second'); await h.app.advance(300); await h.settle();
    assert.equal(h.held().length, before + 1, 'the pushes do not read beside the pending one');
    h.held().at(-1)!.answer(h.roster('idle')); await h.settle();
    assert.equal(h.held().length, before + 2, 'the turn edge is not dropped: one follow-up read, after the answer');
    h.held().at(-1)!.answer(h.roster('running')); await h.settle();
    assert.equal(h.held().length, before + 2, 'not doubled');
    assert.ok(stripCard(h.app.document, 'alice')?.querySelector('.live-dot'), 'the follow-up answer is the one on screen');
  } finally { await h.app.close(); }
});

test('a project switch reads the new room at once, beside the old room\'s pending read (#444)', { timeout: 60000 }, async context => {
  const h = await heldRoster(context);
  try {
    await h.settle();
    h.setHold(true);
    await h.app.advance(5000); await h.settle();
    assert.equal(h.held('fixture').length >= 1 && h.calls.at(-1)!.room, 'fixture', 'fixture\'s tick is held');
    const otherBefore = h.held('other').length;
    h.app.document.querySelector<HTMLElement>('[aria-label="other"] .proj-pick')!.click();
    for (let i = 0; i < 20 && h.app.document.querySelector('.h1-text')?.textContent !== 'other'; i++) await h.app.flush();
    assert.equal(h.held('other').length, otherBefore + 1, 'the new room does not wait behind the old room\'s read');
  } finally { await h.app.close(); }
});

test('a queued roster read retires when its room is left: the new room keeps ONE read in flight (#444 review P1-A residual)', { timeout: 60000 }, async context => {
  const h = await heldRoster(context);
  try {
    await h.settle();
    h.setHold(true);
    await h.app.advance(5000); await h.settle();
    const fixtureHeld = h.held('fixture').length;
    h.push('turn edge'); await h.app.advance(300); await h.settle();   // fixture's follow-up, queued
    assert.equal(h.held('fixture').length, fixtureHeld, 'queued, not read beside');
    await h.room('other');
    assert.equal(h.held('other').length, 1, 'other\'s first read starts at once');
    const total = h.calls.length;
    h.held('fixture').at(-1)!.answer(h.roster('idle')); await h.settle();
    assert.equal(h.calls.length, total, 'fixture\'s queued read retired: no hub_agents for other under fixture\'s key');
    await h.app.advance(5000); await h.settle();
    assert.equal(h.held('other').length, 1, 'other still has exactly one read in flight');
    h.held('other')[0]!.answer(h.roster('running')); await h.settle();
    assert.ok(stripCard(h.app.document, 'alice')?.querySelector('.live-dot'), 'other\'s own answer is the one on screen');
  } finally { await h.app.close(); }
});

test('A -> B -> A: the queued read of A runs for A once A is back, and only once (#444 review P1-A residual)', { timeout: 60000 }, async context => {
  const h = await heldRoster(context);
  try {
    await h.settle();
    h.setHold(true);
    await h.app.advance(5000); await h.settle();
    const before = h.held('fixture').length;
    h.push('turn edge'); await h.app.advance(300); await h.settle();
    await h.room('other');
    await h.room('fixture');                                              // the entry joins the queued read
    assert.equal(h.held('fixture').length, before, 'back in A, still one read of A in flight');
    h.held('fixture').at(-1)!.answer(h.roster('idle')); await h.settle();
    assert.equal(h.held('fixture').length, before + 1, 'ONE follow-up read of A');
    h.held('fixture').at(-1)!.answer(h.roster('running')); await h.settle();
    assert.equal(h.held('fixture').length, before + 1, 'not doubled');
    assert.ok(stripCard(h.app.document, 'alice')?.querySelector('.live-dot'));
  } finally { await h.app.close(); }
});

test('a read queued when the Hub goes away is never sent (#444 review P1-A residual)', { timeout: 60000 }, async context => {
  const h = await heldRoster(context);
  await h.settle();
  h.setHold(true);
  await h.app.advance(5000); await h.settle();
  h.push('turn edge'); await h.app.advance(300); await h.settle();
  const total = h.calls.length;
  await h.app.close();
  h.held('fixture').at(-1)!.answer(h.roster('idle'));
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r));
  assert.equal(h.calls.length, total, 'the old tree asked nothing after it ended');
});

for (const order of ['refresh first', 'push first']) {
  test(`a refresh after an action still shows its failure when a push shares the read (${order}, #444 review P1-B)`, { timeout: 60000 }, async context => {
    const h = await heldRoster(context);
    try {
      await h.settle();
      h.setHold(true);
      await h.app.advance(5000); await h.settle();                        // a roster read is pending
      const before = h.held('fixture').length;
      if (order === 'push first') { h.push('turn edge'); await h.app.advance(300); await h.settle(); await h.stop('alice'); }
      else { await h.stop('alice'); h.push('turn edge'); await h.app.advance(300); await h.settle(); }
      assert.equal(h.held('fixture').length, before, 'the refresh and the push are queued behind the pending read');
      h.held('fixture').at(-1)!.answer(h.roster('idle')); await h.settle();
      assert.equal(h.held('fixture').length, before + 1, 'they share ONE follow-up read');
      h.held('fixture').at(-1)!.fail('link dropped'); await h.settle();
      assert.match(h.app.document.querySelector('.action-read-error')?.textContent ?? '', /refreshing failed: link dropped/u,
        'the refresh after the action reports the failure; the push did not turn it into a success');
    } finally { await h.app.close(); }
  });
}

async function characterize(context: TestContext, fixture: Awaited<ReturnType<typeof compileMount>>) {
  const { pushed, rpc } = roomFixture();
  const app = await fixture.mount(context, {
    props: { visible: true },
    modules: [rpc],
  });
  try {
    for (let i = 0; i < 10 && app.document.querySelectorAll('.acard:not(.add)').length < 2; i++) {
      await app.flush();
    }
    const allBtn = await allButton(app);
    const card = (name: string) => {
      const found = name === 'all' ? allBtn
        : stripCard(app.document, name)?.querySelector<HTMLButtonElement>('.agent-select');
      assert.ok(found, `${name} is rendered by the real Hub`);
      return found;
    };
    const click = async (name: string) => {
      card(name).dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
      await app.flush();
    };
    const recipient = () => selectedCard(app.document);

    assert.equal(recipient(), 'alice');
    await click('bob');
    assert.equal(recipient(), 'bob');
    await click('bob');
    assert.equal(recipient(), 'bob', "#196: a second tap on the recipient's card is not a deselect");
    const menu = app.document.querySelector('[role=menu]');
    assert.ok(menu, "…it opens the card's menu");
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')].map(b => b.textContent!.trim());
    assert.equal(items[0], 'Record only', 'Record only leads, as it does for All (#168)');
    assert.ok(!items.includes('Talk to'), 'no offer to talk to the one already addressed');
    menu.querySelector<HTMLButtonElement>('.menu-item')!.click();
    await app.flush();
    assert.equal(recipient(), '', 'Record only is how a card is deselected now');
    assert.equal(app.document.querySelector('[role=menu]'), null);
    await click('all');
    assert.equal(recipient(), 'all');
    await click('alice');
    assert.equal(recipient(), 'alice');
    await app.advance(260);
    assert.equal(app.document.querySelector('.a-menu, .to-chip, .to-menu, .int-pill'), null,
      '#168 retires the delayed menu, recipient popup and send arm whole');
    const roster = app.document.querySelector('.roster')!;
    const composer = app.document.querySelector('.composer')!;
    assert.ok(roster.compareDocumentPosition(composer) & app.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(pushed.size, 1);
  } finally {
    await app.close();
  }
  assert.equal(pushed.size, 0, 'unmount releases the real push subscription');
}

test('the real Hub strip selects one destination and deselects to record-only without a tap timer', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  // Repeat the same characterization, not extra scenarios: fresh realm and
  // cleanup must work with a reused bundle, and their cost is measured apart.
  const times = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await characterize(context, fixture);
    times.push((performance.now() - start).toFixed(1));
  }
  context.diagnostic(`client compile ${fixture.compileMs.toFixed(1)}ms; fresh-DOM runs ${times.join(', ')}ms; RSS ${(process.memoryUsage().rss / 1024 ** 2).toFixed(1)}MiB; peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)}MiB`);
});

test('a pending attachment blocks Enter until the real Hub can send the complete body', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const started = performance.now();
  const { pushed, rpc } = roomFixture();
  const uploads: Array<{ path: string; body: string }> = [];
  const posts: Array<{ session: string; body: string }> = [];
  let releaseUpload!: () => void;
  const upload = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const app = await fixture.mount(context, {
    props: { visible: true },
    modules: [{
      ...rpc,
      fsMkdir: async () => ({}),
      fsUpload: async (path: string, body: string) => {
        if (path.endsWith('/.gitignore')) return {};
        uploads.push({ path, body });
        await upload;
        return {};
      },
      hubPost: async (session: string, body: string) => { posts.push({ session, body }); return {}; },
    }],
  });
  try {
    for (let i = 0; i < 10 && selectedCard(app.document) !== 'alice'; i++) {
      await app.flush();
    }
    assert.equal(selectedCard(app.document), 'alice');
    const input = app.document.querySelector<HTMLTextAreaElement>('.c-input')!;
    const picker = app.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const send = app.document.querySelector<HTMLButtonElement>('.composer-actions > button:last-child')!;
    input.value = 'Inspect ';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    input.setSelectionRange(input.value.length, input.value.length);
    const file = new app.window.File(['payload'], 'report.txt', { type: 'text/plain' });
    Object.defineProperty(picker, 'files', { value: [file] });
    picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    for (let i = 0; i < 10 && !uploads.length; i++) await app.flush();
    assert.equal(uploads.length, 1, 'the actual stageFiles pipeline reached the deferred upload');
    assert.equal(uploads[0]!.body, 'cGF5bG9hZA==');
    assert.equal(send.disabled, true);
    const enter = async () => {
      input.dispatchEvent(new app.window.KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true,
      }));
      await app.flush();
    };
    await enter();
    assert.deepEqual(posts, [], 'Enter must not leak the text while its attachment is uploading');

    releaseUpload();
    for (let i = 0; i < 10 && send.disabled; i++) await app.flush();
    assert.equal(send.disabled, false);
    assert.equal(input.value, 'Inspect [file:1]');
    await enter();
    assert.deepEqual(posts, [{ session: 'fixture', body: `@alice Inspect ${uploads[0]!.path}` }]);
    assert.equal(input.value, '');
    assert.equal(app.document.querySelectorAll('.pend-chip').length, 0);
  } finally {
    releaseUpload();
    await app.close();
  }
  assert.equal(pushed.size, 0);
  context.diagnostic(`attachment scenario after shared compilation ${(performance.now() - started).toFixed(1)}ms`);
});

test('the local Hub Back callback peels ContextMenu before palette and stops at the compact floor', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const started = performance.now();
  const { rpc } = roomFixture();
  let back: () => boolean = () => assert.fail('Hub has not registered Back');
  let registrations = 0;
  const app = await fixture.mount(context, {
    props: {
      visible: true, mobile: true,
      onGoBack: (fn: () => boolean) => { back = fn; registrations++; },
    },
    modules: [{ ...rpc, modelsList: async () => ({ models: [] }) }],
  });
  try {
    for (let i = 0; i < 10 && selectedCard(app.document) !== 'alice'; i++) {
      await app.flush();
    }
    assert.equal(selectedCard(app.document), 'alice');
    const historyLength = app.window.history.length;
    const published = back;
    const input = app.document.querySelector<HTMLTextAreaElement>('.c-input')!;
    input.value = '/';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    assert.ok(app.document.querySelector('.cmd-menu'));
    stripCard(app.document, 'alice').querySelector('.agent-select')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
    await app.flush();
    assert.ok(app.document.querySelector('.ctx'));

    assert.equal(back(), true);
    await app.flush();
    assert.equal(app.document.querySelector('.ctx'), null, 'ContextMenu is peeled first');
    assert.ok(app.document.querySelector('.cmd-menu'), 'palette survives the first Back');
    assert.equal(back(), true);
    await app.flush();
    assert.equal(app.document.querySelector('.cmd-menu'), null);
    assert.equal(back(), true);
    await app.flush();
    assert.ok(app.document.querySelector('.sidebar.open'));
    assert.equal(back(), false);
    assert.equal(back(), false);
    assert.ok(app.document.querySelector('.sidebar.open'), 'the floor never closes itself');
    assert.equal(back, published);
    assert.equal(registrations, 1, 'state changes do not publish another callback');
    assert.equal(app.window.history.length, historyLength, 'local dispatch never pushes browser history');

    app.document.querySelector<HTMLElement>('.side-scrim')!.click();
    stripCard(app.document, 'alice').querySelector('.agent-select')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
    await app.flush();
    assert.ok(app.document.querySelector('.ctx'), 'leave a live layer for the unmount check');
  } finally {
    await app.close();
  }
  assert.equal(back(), false, 'the disposed Hub has no registered layers');
  context.diagnostic(`Back scenario after shared compilation ${(performance.now() - started).toFixed(1)}ms`);
});

test('Hub Sidebar keeps row identity, free restore, confirmed purge and the compact floor', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const started = performance.now();
  const { rpc } = roomFixture();
  const row = (session: string, name: string, archived = false) => ({
    project: { id: `p-${session}`, session, name, path: `/${session}`, archived },
    live: !archived, slots: [],
  });
  const rows = [row('fixture', 'Fixture'), row('other', 'Other'), row('archived', 'Archived', true)];
  const operations: Array<{ method: string; id: string; archived?: boolean }> = [];
  let back: () => boolean = () => assert.fail('Back is not registered');
  const app = await fixture.mount(context, {
    props: { visible: true, mobile: true, onGoBack: (fn: () => boolean) => { back = fn; } },
    setup(window) {
      // Svelte's keyed-list bookkeeping queries animations; jsdom does not
      // render any. Chromium separately verifies the actual flip motion.
      window.Element.prototype.getAnimations = () => [];
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: rows }),
      projectDown: async (id: string) => {
        operations.push({ method: 'down', id });
        rows.find((r) => r.project.id === id)!.live = false;
        return {};
      },
      projectArchive: async (id: string, archived: boolean) => {
        operations.push({ method: 'archive', id, archived });
        rows.find((r) => r.project.id === id)!.project.archived = archived;
        return {};
      },
      projectDelete: async (id: string) => {
        operations.push({ method: 'purge', id });
        rows.splice(rows.findIndex((r) => r.project.id === id), 1);
        return {};
      },
    }],
  });
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 12 && !predicate(); i++) await app.flush();
    assert.ok(predicate(), 'the expected reactive state settled');
  };
  const click = async (selector: string) => {
    const target = app.document.querySelector<HTMLElement>(selector);
    assert.ok(target, selector);
    target.click();
    await app.flush();
  };
  const menuAction = async (label: string) => {
    const target = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find((button) => button.textContent?.trim() === label);
    assert.ok(target, label);
    target.click();
    await app.flush();
  };
  try {
    await waitFor(() => app.document.querySelectorAll('.proj-row').length === 2);
    assert.equal(back(), true);
    await app.flush();
    assert.ok(app.document.querySelector('.sidebar.open'));
    await click('[aria-label="Other"] .proj-pick');
    await waitFor(() => app.document.querySelector('.h1-text')?.textContent === 'Other');
    assert.equal(app.document.querySelector('.sidebar.open'), null, 'selection closes the compact sheet');
    assert.equal(back(), true);
    await app.flush();
    await click('[aria-label="Fixture"] .proj-pick');
    await waitFor(() => app.document.querySelector('.h1-text')?.textContent === 'Fixture');
    assert.equal(back(), true);
    await app.flush();
    assert.equal(back(), false, 'the open list is still the floor');

    await click('[aria-label="Other"] .row-menu');
    assert.equal(app.document.querySelector('.ctx-who')?.textContent, 'Other');
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'Fixture');
    await menuAction('Close');
    const closeTitle = app.document.querySelector('.dlg[role=alertdialog] h2')?.textContent;
    await click('.dlg[role=alertdialog] .primary');
    await waitFor(() => app.document.querySelector('.dlg[role=alertdialog]') === null);
    assert.deepEqual(operations, [{ method: 'down', id: 'p-other' }],
      'the non-selected row action must not target the selected project');
    assert.ok(closeTitle?.includes('Other'));
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'Fixture');

    await click('.trash-bar');
    await click('.trash-row .t-act:not(.danger)');
    await waitFor(() => app.document.querySelector('[aria-label="Archived"]') !== null);
    assert.equal(app.document.querySelector('.dlg[role=alertdialog]'), null, 'restore is not a destructive confirmation');
    assert.deepEqual(operations.at(-1), { method: 'archive', id: 'p-archived', archived: false });
    await click('[aria-label="Archived"] .row-menu');
    await menuAction('Delete');
    await click('.dlg[role=alertdialog] .primary');
    await waitFor(() => app.document.querySelector('.trash-row') !== null);
    assert.deepEqual(operations.at(-1), { method: 'archive', id: 'p-archived', archived: true });
    await click('.trash-row .t-act.danger');
    assert.equal(operations.some((op) => op.method === 'purge'), false);
    assert.ok(app.document.querySelector('.dlg[role=alertdialog] h2')?.textContent?.includes('Archived'));
    await click('.dlg[role=alertdialog] .primary');
    await waitFor(() => app.document.querySelector('.trash-row') === null);
    assert.deepEqual(operations.at(-1), { method: 'purge', id: 'p-archived' });
  } finally {
    await app.close();
  }
  context.diagnostic(`Sidebar scenario after shared compilation ${(performance.now() - started).toFixed(1)}ms`);
});

test('a confirmation consumes Escape without also closing the earlier-mounted Hub drawer (#155)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    modules: [{
      ...rpc,
      fsCwd: async () => ({ path: '/fixture' }),
      fsList: async () => ({ entries: [] }),
      getPrefs: async () => ({}),
      getBookmarks: async () => ({ bookmarks: [] }),
      gitCmd: async () => ({ code: 1 }),
    }],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.h1-text'); i++) await app.flush();
    const files = [...app.document.querySelectorAll<HTMLButtonElement>('.page-head button')]
      .find(button => button.getAttribute('aria-label') === 'Files');
    assert.ok(files);
    files.click();
    for (let i = 0; i < 12 && !app.document.querySelector('.drawer .file-list'); i++) await app.flush();
    assert.ok(app.document.querySelector('.drawer'));
    app.document.querySelector<HTMLButtonElement>('.drawer [aria-label="New item"]')!.click();
    await app.flush();
    const origin = app.document.querySelector<HTMLInputElement>('.drawer .new-item input')!;
    origin.focus();
    app.document.querySelector<HTMLButtonElement>('.row-menu')!.click();
    await app.flush();
    app.document.activeElement!.dispatchEvent(new app.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    await app.flush();
    assert.equal(app.document.querySelector('.ctx'), null);
    assert.ok(app.document.querySelector('.drawer'), '#164: a focused project menu cannot close the Files drawer below it');
    app.document.querySelector<HTMLButtonElement>('.row-menu')!.click();
    await app.flush();
    const close = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find(button => button.textContent?.trim() === 'Close');
    assert.ok(close);
    close.click();
    await app.flush();
    assert.ok(app.document.querySelector('[aria-modal="true"]'));
    app.document.activeElement!.dispatchEvent(new app.window.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }));
    await app.flush();
    assert.equal(app.document.querySelector('[aria-modal="true"]'), null);
    assert.ok(app.document.querySelector('.drawer'), 'the underlying capture handler yields to the modal');
    assert.equal(app.document.activeElement, origin, '#164: menu-to-confirm transfers the live focus origin');
  } finally { await app.close(); }
});

test('Roster ContextMenu filters without selecting and a stopped surface never resumes on tap', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const started = performance.now();
  const { rpc } = roomFixture();
  const restarts: Array<[string, string]> = [];
  let resumed = false;
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      // The stopped card leaves a keyed list; jsdom has no active animations.
      window.Element.prototype.getAnimations = () => [];
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: [{
        project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/fixture' },
        live: true, slots: [{ window_name: 'paused', kind: 'agent', command: 'codex' }],
      }] }),
      hubAgents: async () => ({ agents: [
        ...(await rpc.hubAgents()).agents,
        ...(resumed ? [{ name: 'paused', window: 2, managed: true, agent: 'codex', state: 'idle' }] : []),
      ] }),
      hubAgentRestart: async (session: string, name: string) => {
        restarts.push([session, name]); resumed = true; return {};
      },
    }],
  });
  try {
    for (let i = 0; i < 10 && !app.document.querySelector('.acard.off'); i++) await app.flush();
    const off = app.document.querySelector<HTMLElement>('.acard.off')!;
    assert.ok(off);
    off.querySelector<HTMLButtonElement>('.agent-select')!.click();
    await app.flush();
    assert.deepEqual(restarts, []);
    assert.equal(app.document.querySelector('.ctx-who')?.textContent, 'paused');
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await app.flush();
    assert.equal(app.document.querySelector('.ctx'), null);
    off.querySelector<HTMLButtonElement>('.agent-select')!.click();
    await app.flush();
    const restart = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find((button) => button.textContent?.includes('Resume'))!;
    assert.ok(restart);
    restart.click();
    for (let i = 0; i < 10 && app.document.querySelector('.acard.off'); i++) await app.flush();
    assert.deepEqual(restarts, [['fixture', 'paused']]);
    assert.equal(app.document.querySelector('.acard.off'), null);
    const bob = [...app.document.querySelectorAll<HTMLElement>('.acard')]
      .find((card) => card.querySelector('.a-name')?.textContent === 'bob')!;
    assert.ok(bob);
    const recipientBeforeFilter = selectedCard(app.document);
    for (const shouldFilter of [true, false]) {
      bob.querySelector('.agent-select')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
      await app.flush();
      const filter = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
        .find((button) => /Only its messages|Show everything/.test(button.textContent ?? ''))!;
      assert.ok(filter);
      filter.click();
      await app.flush();
      assert.equal(!!app.document.querySelector('.cards.filtering'), shouldFilter);
      assert.equal(selectedCard(app.document), recipientBeforeFilter, 'filtering never changes delivery');
    }
  } finally {
    await app.close();
  }
  context.diagnostic(`Roster scenario after shared compilation ${(performance.now() - started).toFixed(1)}ms`);
});

// Composer extraction characterization: use the same compiled Hub and RPC door.
// Clipboard events are synthetic; native insertion and geometry belong to Chromium.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// jsdom has no layout. `overflowing` gives the roster strip a single row that
// needs more than its width — measured, as a browser does, only in the
// single-row form (#266: the disclosure exists only then).
async function composerFixture(context: TestContext, extra: Record<string, (...args: any[]) => unknown> = {}, mobile = false, storage: Record<string, string> = {}, overflowing = false) {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const app = await fixture.mount(context, {
    props: { visible: true, mobile },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      // A rendered message measures text; jsdom has no canvas (#340 tests render some).
      window.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(window.performance, 'now', { value: () => window.Date.now() });
      for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
      if (overflowing) {
        const width = (el: Element, single: number) =>
          el.classList.contains('cards') ? (el.classList.contains('expanded') ? 300 : single) : 0;
        Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return width(this, 300); } });
        Object.defineProperty(window.HTMLElement.prototype, 'scrollWidth', { get() { return width(this, 640); } });
      }
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
        project: { id: session, name: session, session, path: `/${session}` },
        live: true, slots: [],
      })) }),
      modelsList: async () => ({ models: ['test-model'] }),
      fsMkdir: async () => ({}),
      ...extra,
    }],
  });
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 20 && !predicate(); i++) await app.flush();
    assert.ok(predicate(), 'composer state settled');
  };
  await wait(() => selectedCard(app.document) === 'alice');
  const input = app.document.querySelector<HTMLTextAreaElement>('.c-input')!;
  const send = app.document.querySelector<HTMLButtonElement>('.composer-actions > button:last-child')!;
  const text = async (value: string) => {
    input.value = value;
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
  };
  const key = async (key: string, options: KeyboardEventInit = {}) => {
    const event = new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    input.dispatchEvent(event);
    await app.flush();
    return event.defaultPrevented;
  };
  const room = async (name: string) => {
    app.document.querySelector<HTMLElement>(`[aria-label="${name}"] .proj-pick`)!.click();
    await wait(() => app.document.querySelector('.h1-text')?.textContent === name);
  };
  const to = async (name: string) => {
    const target = name === 'everyone' ? 'all' : name === 'note' ? '' : name;
    const current = selectedCard(app.document);
    if (current === target) return;
    if (!target) {
      // Record only is reached through the menu — All's (#168) and, since #196,
      // a named card's too: a second click on the recipient opens it.
      const opener = current === 'all' ? await allButton(app)
        : stripCard(app.document, current)?.querySelector<HTMLButtonElement>('.agent-select');
      opener!.click();
      await app.flush();
      [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
        .find(button => button.textContent?.trim() === 'Record only')!.click();
      await app.flush();
      return;
    }
    const button = target === 'all' ? await allButton(app)
      : stripCard(app.document, target || current)?.querySelector<HTMLButtonElement>('.agent-select');
    assert.ok(button, name);
    button.click();
    await app.flush();
  };
  const paste = async (files: File[], words = '') => {
    const event = new app.window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      files, items: [], getData: (type: string) => type === 'text/plain' ? words : '',
    } });
    input.dispatchEvent(event);
    await app.flush();
    return event.defaultPrevented;
  };
  return { ...app, input, send, text, key, room, to, wait, paste };
}

test('Composer keeps readline caret, palette, room drafts and all three destinations', { timeout: 60000 }, async (context) => {
  const posts: Array<[string, string]> = [];
  const app = await composerFixture(context, {
    hubPost: async (session: string, body: string) => { posts.push([session, body]); return {}; },
  });
  try {
    app.input.focus();
    await app.text('one two');
    app.input.setSelectionRange(4, 4);
    assert.equal(await app.key('k', { ctrlKey: true }), true);
    assert.equal(String(app.input.value), 'one ');
    assert.equal(app.input.selectionStart, 4, 'caret lands after Svelte writes the value');
    await app.room('other');
    await app.key('y', { ctrlKey: true });
    assert.equal(String(app.input.value), 'two', 'kill buffer survives project switches');
    await app.room('fixture');
    assert.equal(String(app.input.value), 'one ', 'draft restored from the leaving room');
    await app.text('/');
    await app.key('Tab');
    assert.notEqual(app.input.value, '/');
    assert.equal(app.document.activeElement, app.input);
    assert.equal(app.input.selectionStart, app.input.value.length);
    await app.text('hello');
    assert.equal(await app.key('Enter', { shiftKey: true }), false);
    assert.equal(await app.key('Enter', { isComposing: true }), false);
    assert.deepEqual(posts, []);
    await app.key('Enter');
    await app.wait(() => posts.length === 1);
    await app.to('everyone');
    await app.text('broadcast');
    app.send.click();
    await app.wait(() => posts.length === 2);
    await app.to('note');
    await app.text('record');
    app.send.click();
    await app.wait(() => posts.length === 3);
    assert.deepEqual(posts, [['fixture', '@alice hello'], ['fixture', '@all broadcast'], ['fixture', 'record']]);
    await app.room('other');
    await app.room('fixture');
    assert.equal(selectedCard(app.document), '', 'an explicit room recipient persists');
  } finally { await app.close(); }
});

test('body mentions mark cards without replacing the selected delivery target (#168)', { timeout: 60000 }, async (context) => {
  const posts: string[] = [];
  const app = await composerFixture(context, {
    hubPost: async (_session: string, body: string) => { posts.push(body); return {}; },
  });
  try {
    await app.text('@bob Review the change.');
    assert.equal(selectedCard(app.document), 'alice');
    assert.equal(stripCard(app.document, 'bob').querySelector('.agent-mention')?.textContent, '@');
    app.send.click();
    await app.wait(() => posts.length === 1);
    assert.deepEqual(posts, ['@alice @bob Review the change.']);
    await app.to('note');
    await app.text('@all Report progress.');
    for (const name of ['alice', 'bob']) {
      assert.equal(stripCard(app.document, name).querySelector('.agent-mention')?.textContent, '@');
    }
    assert.equal(selectedCard(app.document), '');
    app.send.click();
    await app.wait(() => posts.length === 2);
    assert.equal(posts[1], '@all Report progress.');
  } finally { await app.close(); }
});

test('desktop double-click focuses an agent and toggles its reading filter without a delay (#173)', { timeout: 60000 }, async (context) => {
  const app = await composerFixture(context);
  const double = async () => {
    const button = stripCard(app.document, 'bob').querySelector<HTMLButtonElement>('.agent-select')!;
    for (const [type, detail] of [['click', 1], ['click', 2], ['dblclick', 2]] as const) {
      button.dispatchEvent(new app.window.MouseEvent(type, { detail, bubbles: true, cancelable: true }));
      await app.flush();
    }
  };
  try {
    assert.equal(selectedCard(app.document), 'alice');
    await double();
    assert.equal(selectedCard(app.document), 'bob');
    assert.ok(app.document.querySelector('.cards.filtering'));
    assert.ok(stripCard(app.document, 'bob').classList.contains('filtered'));
    await double();
    assert.equal(selectedCard(app.document), 'bob');
    assert.equal(app.document.querySelector('.cards.filtering'), null);
    assert.equal(stripCard(app.document, 'bob').classList.contains('filtered'), false);
  } finally { await app.close(); }
});

test('the reading filter ends when its agent leaves the room, not when it stops (#241)', { timeout: 60000 }, async (context) => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle', since: 5 },
  ];
  let slots = [{ window_name: 'bob', kind: 'agent', command: 'codex' }];
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents }),
    projectList: async () => ({ projects: [{
      project: { id: 'fixture', name: 'fixture', session: 'fixture', path: '/fixture' }, live: true, slots,
    }] }),
  });
  try {
    const button = stripCard(app.document, 'bob').querySelector<HTMLButtonElement>('.agent-select')!;
    for (const [type, detail] of [['click', 1], ['click', 2], ['dblclick', 2]] as const) {
      button.dispatchEvent(new app.window.MouseEvent(type, { detail, bubbles: true, cancelable: true }));
      await app.flush();
    }
    assert.ok(app.document.querySelector('.cards.filtering'));
    agents.pop();
    await app.advance(5000);
    assert.ok(stripCard(app.document, 'bob').classList.contains('filtered'), 'a stopped identity is still in the room and keeps its filter');
    slots = [];
    await app.advance(25000);
    assert.equal(app.document.querySelector('[data-agent="bob"]'), null, 'removed: no card left to carry the mode');
    assert.equal(app.document.querySelector('.cards.filtering'), null, 'the feed returns to everyone instead of filtering by an invisible card');
  } finally { await app.close(); }
});

test('typing @ offers the room\'s agents in the slash palette; Enter inserts, Escape dismisses (#242)', { timeout: 60000 }, async (context) => {
  const posts: string[] = [];
  const app = await composerFixture(context, { hubPost: async (_s: string, body: string) => { posts.push(body); return {}; } });
  const options = () => [...app.document.querySelectorAll('.cmd-menu .cmd-opt .cmd-name')].map((n) => n.textContent);
  try {
    await app.text('ask @');
    assert.deepEqual(options(), ['@alice', '@bob', '@all'], 'managed agents, then everyone');
    await app.text('ask @b');
    assert.deepEqual(options(), ['@bob']);
    assert.equal(await app.key('Enter'), true, 'Enter accepts the candidate, it does not send');
    assert.equal(app.input.value, 'ask @bob ');
    assert.deepEqual(posts, []);
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'a finished mention closes the list');
    await app.text('ask @bob and @');
    assert.ok(app.document.querySelector('.cmd-menu'));
    assert.equal(await app.key('Escape'), true);
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'Escape dismisses without touching the text');
    assert.equal(app.input.value, 'ask @bob and @');
    await app.text('/compact @b');
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'a slash-command line offers no names');
    await app.text('@alice /compact @b');
    assert.equal(app.document.querySelector('.cmd-menu'), null);
    await app.text('mail me@b');
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'an address never opens it');
    await app.text('@a');
    app.document.querySelector<HTMLButtonElement>('.cmd-opt:last-child')!.click();
    await app.flush();
    assert.equal(app.input.value, '@all ', 'a tap accepts too');
  } finally { await app.close(); }
});

// Board #398. Owner: "按 tab 补全了一个，这时这个命令后边还没有空格，按回车就发不上去，
// 要这时也能够按回车". Enter accepts an item only when accepting changes the
// text; an item already typed falls through to what Enter does with no list.
test('Enter accepts a completion only when it changes the text; a finished item sends, on every palette (#398)', { timeout: 60000 }, async (context) => {
  const posts: string[] = [], commands: string[] = [];
  const app = await composerFixture(context, {
    // The owner's list: the longer id first, so exact-first ranking is exercised.
    modelsList: async () => ({ models: ['claude-opus-5.5', 'claude-opus-5'] }),
    hubAgents: async () => ({ agents: [
      { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' },
      { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle' },
      { name: 'bobby', window: 2, managed: true, agent: 'codex', state: 'idle' },
    ] }),
    hubPost: async (_s: string, body: string) => { posts.push(body); return {}; },
    hubCommand: async (_s: string, name: string, command: string) => { commands.push(`${name}:${command}`); return {}; },
  });
  const options = () => [...app.document.querySelectorAll('.cmd-menu .cmd-opt .cmd-name')].map((n) => n.textContent);
  const settle = async (n: number) => { for (let i = 0; i < 8 && commands.length + posts.length < n; i++) await app.flush(); };
  try {
    // The models arrive once the argument stage is open.
    await app.text('/model ');
    await app.wait(() => options().includes('claude-opus-5'));

    // A partial argument: Enter completes it, as today.
    await app.text('/model claude-op');
    assert.equal(await app.key('Enter', { isComposing: true }), false, 'an IME composition Enter on a partial neither accepts');
    assert.equal(app.input.value, '/model claude-op');
    assert.deepEqual(commands, [], 'nor sends');
    assert.equal(await app.key('Enter'), true, 'a partial is completed');
    assert.equal(app.input.value, '/model claude-opus-5.5');
    assert.deepEqual(commands, [], 'and not sent');
    // The owner's state: the completed argument, no trailing space. The list
    // whose one item is what was typed is closed, and Enter sends.
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'a finished final argument closes the list');
    assert.equal(await app.key('Enter'), true);
    await settle(1);
    assert.deepEqual(commands, ['alice:/model claude-opus-5.5'], 'Enter sends what Tab or Enter completed');

    // Tab, then Enter: the same.
    await app.text('/model claude-opus-5.');
    await app.key('Tab');
    assert.equal(app.input.value, '/model claude-opus-5.5');
    assert.equal(await app.key('Enter'), true);
    await settle(2);
    assert.equal(commands.at(-1), 'alice:/model claude-opus-5.5', 'Tab then Enter sends (slash argument)');

    // Typed exactly, with a longer one still offered: the exact item leads
    // (it is listed second), the list stays, and Enter sends what was typed.
    await app.text('/model claude-opus-5');
    assert.deepEqual(options(), ['claude-opus-5', 'claude-opus-5.5'], 'an exact match ranks first');
    assert.equal(await app.key('Enter', { isComposing: true }), false, 'an IME composition Enter is never a send');
    assert.equal(commands.length, 2);
    assert.equal(app.input.value, '/model claude-opus-5', 'nor an accept');
    assert.equal(await app.key('Enter'), true);
    await settle(3);
    assert.equal(commands.at(-1), 'alice:/model claude-opus-5', 'Enter sends the typed id, not the longer one');
    // Arrowing down to the longer one makes Enter a change again.
    await app.text('/model claude-opus-5');
    await app.key('ArrowDown');
    assert.equal(await app.key('Enter'), true);
    assert.equal(app.input.value, '/model claude-opus-5.5', 'the selected longer item is accepted');
    assert.equal(commands.length, 3);

    // A typed command that takes arguments: Enter opens its list, as today.
    await app.text('/model');
    assert.equal(await app.key('Enter'), true);
    assert.equal(app.input.value, '/model ', 'the space, and its argument list');
    assert.ok(app.document.querySelector('.cmd-menu'));
    assert.equal(commands.length, 3, 'not sent');
    // A command with no arguments: completing adds only the space, so it sends.
    await app.text('/comp');
    await app.key('Tab');
    assert.equal(app.input.value, '/compact ');
    assert.equal(await app.key('Enter'), true);
    await settle(4);
    assert.equal(commands.at(-1), 'alice:/compact', 'Tab then Enter sends (slash command)');
    await app.text('/compact');
    assert.equal(await app.key('Enter'), true);
    await settle(5);
    assert.equal(commands.at(-1), 'alice:/compact', 'a typed no-argument command sends');

    // Mentions: the typed name with a longer one still offered.
    await app.text('ask @bob');
    assert.deepEqual(options(), ['@bob', '@bobby']);
    assert.equal(await app.key('Enter'), true);
    await settle(6);
    assert.deepEqual(posts, ['@alice ask @bob'], 'a typed mention sends');
    await app.text('ask @bo');
    await app.key('Tab');
    assert.equal(app.input.value, 'ask @bob ');
    assert.equal(await app.key('Enter'), true);
    await settle(7);
    assert.deepEqual(posts, ['@alice ask @bob', '@alice ask @bob'], 'Tab then Enter sends (mention)');
    await app.text('ask @bobb');
    assert.equal(await app.key('Enter'), true);
    assert.equal(app.input.value, 'ask @bobby ', 'a partial mention is still completed');
    assert.equal(posts.length, 2);
  } finally { await app.close(); }
});

// Review P1-A on 1b9af621: whether a command opens an argument level is its
// DECLARATION, not whether its values are cached. grok's /model takes only
// fetched model ids, so a cold composer has no list to show for `/model `.
test('a typed command that declares arguments opens them before its values load; the fetch does not wait for a list (#398 review P1-A)', { timeout: 60000 }, async (context) => {
  const commands: string[] = [];
  const asks: string[] = [];
  let answer: (models: string[]) => void = () => {};
  let fail: () => void = () => {};
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents: [
      { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' },
      { name: 'gro', window: 1, managed: true, agent: 'grok', state: 'idle' },
    ] }),
    modelsList: (backend: string) => { asks.push(backend); return new Promise((resolve, reject) => {
      answer = (models) => resolve({ models });
      fail = () => reject(new Error('down'));
    }); },
    hubCommand: async (_s: string, name: string, command: string) => { commands.push(`${name}:${command}`); return {}; },
  });
  const options = () => [...app.document.querySelectorAll('.cmd-menu .cmd-opt .cmd-name')].map((n) => n.textContent);
  try {
    await app.to('gro');
    assert.equal(selectedCard(app.document), 'gro');
    asks.length = 0;
    // Pasted whole, the cache cold, the fetch held.
    await app.text('/model');
    assert.deepEqual(options(), ['/model'], 'the typed command stays listed');
    assert.ok(asks.includes('grok'), 'and the models are asked for');
    assert.equal(await app.key('Enter'), true, 'Enter takes the argument level');
    assert.equal(app.input.value, '/model ');
    for (let i = 0; i < 4; i++) await app.flush();
    assert.deepEqual(commands, [], 'nothing was sent before the models loaded');
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'no list yet: there is nothing to show');
    // A failed answer: still nothing sent; the next keystroke asks again.
    fail();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.deepEqual(commands, []);
    const before = asks.length;
    await app.text('/model g');
    assert.ok(asks.length > before, 'a failed fetch is asked for again by the next keystroke');
    // The models arrive: the argument list opens and completes.
    answer(['grok-5', 'grok-5-fast']);
    await app.wait(() => options().includes('grok-5'));
    assert.deepEqual(options(), ['grok-5', 'grok-5-fast']);
    assert.equal(await app.key('Enter'), true, 'a partial is completed');
    assert.equal(app.input.value, '/model grok-5');
    assert.equal(await app.key('Enter'), true);
    for (let i = 0; i < 8 && !commands.length; i++) await app.flush();
    assert.deepEqual(commands, ['gro:/model grok-5'], 'and the finished argument sends');
  } finally { await app.close(); }
});

// Review P2-B on 1b9af621: two names (or two values) that differ only in case
// are two different things, so the same spelling leads another case of it.
test('the same spelling leads another case of it: a typed @bob or argument is sent, never rewritten (#398 review P2-B)', { timeout: 60000 }, async (context) => {
  const posts: string[] = [], commands: string[] = [];
  const app = await composerFixture(context, {
    modelsList: async () => ({ models: ['Test-Model', 'test-model'] }),
    hubAgents: async () => ({ agents: [
      { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' },
      { name: 'Bob', window: 1, managed: true, agent: 'codex', state: 'idle' },
      { name: 'bob', window: 2, managed: true, agent: 'codex', state: 'idle' },
    ] }),
    hubPost: async (_s: string, body: string) => { posts.push(body); return {}; },
    hubCommand: async (_s: string, name: string, command: string) => { commands.push(`${name}:${command}`); return {}; },
  });
  const options = () => [...app.document.querySelectorAll('.cmd-menu .cmd-opt .cmd-name')].map((n) => n.textContent);
  try {
    await app.text('ask @');
    assert.deepEqual(options().slice(0, 3), ['@alice', '@Bob', '@bob'], 'Bob is listed before bob');
    await app.text('ask @bob');
    assert.deepEqual(options(), ['@bob', '@Bob'], 'the typed spelling leads');
    assert.equal(await app.key('Enter'), true);
    for (let i = 0; i < 8 && !posts.length; i++) await app.flush();
    assert.deepEqual(posts, ['@alice ask @bob'], 'Enter sends @bob, never @Bob');
    await app.text('/model ');
    await app.wait(() => options().includes('test-model'));
    await app.text('/model test-model');
    assert.deepEqual(options(), ['test-model', 'Test-Model'], 'slash arguments too');
    assert.equal(await app.key('Enter'), true);
    for (let i = 0; i < 8 && !commands.length; i++) await app.flush();
    assert.deepEqual(commands, ['alice:/model test-model']);
  } finally { await app.close(); }
});

test('on the phone a finished item\'s Enter is what Enter is with no list; Tab and a partial\'s Enter still complete (#398)', { timeout: 60000 }, async (context) => {
  const commands: string[] = [];
  const app = await composerFixture(context, {
    modelsList: async () => ({ models: ['claude-opus-5.5', 'claude-opus-5'] }),
    hubCommand: async (_s: string, name: string, command: string) => { commands.push(`${name}:${command}`); return {}; },
  }, true);
  const options = () => [...app.document.querySelectorAll('.cmd-menu .cmd-opt .cmd-name')].map((n) => n.textContent);
  try {
    // A hardware keyboard on a phone sends these same key events.
    await app.text('/model ');
    await app.wait(() => options().includes('claude-opus-5'));
    await app.text('/model claude-op');
    assert.equal(await app.key('Tab'), true);
    assert.equal(app.input.value, '/model claude-opus-5.5', 'Tab completes');
    await app.text('/model claude-op');
    assert.equal(await app.key('Enter'), true, 'a partial\'s Enter completes');
    assert.equal(app.input.value, '/model claude-opus-5.5');
    await app.text('/model claude-opus-5');
    assert.deepEqual(options(), ['claude-opus-5', 'claude-opus-5.5']);
    assert.equal(await app.key('Enter'), false, 'a finished item: Enter is the phone\'s newline, as with no list (tap Send)');
    assert.equal(app.input.value, '/model claude-opus-5', 'not rewritten to the longer one');
    assert.equal(await app.key('Enter', { isComposing: true }), false);
    assert.deepEqual(commands, []);
    app.send.click();
    for (let i = 0; i < 8 && !commands.length; i++) await app.flush();
    assert.deepEqual(commands, ['alice:/model claude-opus-5']);
  } finally { await app.close(); }
});

// Board #340: `#` completes this project's board issues in the same palette.
const boardIssue = (id: number, title: string, status = 'todo') =>
  ({ id, title, body: '', status, assignee: '', created_by: 'human', created_at: 1, updated_at: 1, editable: true, notes: 0 });
test('typing # offers this project\'s board issues in the slash palette; Enter inserts #id, and each new # reads the board (#340)', { timeout: 60000 }, async (context) => {
  const posts: string[] = [];
  const reads: string[] = [];
  let board = [boardIssue(1, 'First'), boardIssue(2, 'Second', 'done'), boardIssue(3, 'Login page zoom')];
  const app = await composerFixture(context, {
    hubPost: async (_s: string, body: string) => { posts.push(body); return {}; },
    boardList: async (session: string) => { reads.push(session); return { issues: board, statuses: ['todo', 'doing', 'review', 'done'] }; },
  });
  const options = () => [...app.document.querySelectorAll('.cmd-menu .cmd-opt')].map((n) => `${n.querySelector('.cmd-name')?.textContent} ${n.querySelector('.cmd-hint')?.textContent}`);
  try {
    assert.deepEqual(reads, [], 'a room nobody references reads no board');
    await app.text('fixed in #');
    await app.flush();
    assert.deepEqual(reads, ['fixture'], 'a # being typed reads this project\'s board');
    assert.deepEqual(options(), ['#3 Login page zoom', '#1 First', '#2 Second'], 'open first, newest first; the name is the hint');
    await app.text('fixed in #zoom');
    assert.deepEqual(options(), ['#3 Login page zoom'], 'the name filters too');
    assert.equal(await app.key('Enter'), true, 'Enter accepts, it does not send');
    assert.equal(app.input.value, 'fixed in #3 ', 'the token and a space, no title');
    assert.equal(app.document.querySelector('.cmd-menu'), null);
    assert.deepEqual(posts, []);
    board = [...board, boardIssue(4, 'Just filed')];
    await app.text('fixed in #3 and #');
    await app.flush();
    assert.equal(reads.length, 2, 'the next # reads again, so a just-filed issue is offered');
    assert.equal(options()[0], '#4 Just filed');
    assert.equal(await app.key('Escape'), true);
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'Escape dismisses');
    await app.text('/compact #');
    assert.equal(app.document.querySelector('.cmd-menu .cmd-opt .cmd-name')?.textContent?.startsWith('#'), undefined, 'a slash-command line offers no issues');
    await app.text('fixed in #3');
    assert.equal(await app.key('Enter'), true);
    for (let i = 0; i < 6 && !posts.length; i++) await app.flush();
    assert.deepEqual(posts, ['@alice fixed in #3'], 'a finished reference sends exactly what was typed (to the selected agent)');
  } finally { await app.close(); }
});

test('a #id this project has is a link in a message that opens it on the Board; reads happen only for newer ids (#340)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const reads: string[] = [];
  const routes: unknown[][] = [];
  let board = [boardIssue(1, 'First'), boardIssue(2, 'Second')];
  const m1 = { id: 'm1', seq: 1, ts: 100, from: 'alice', body: 'plain hello' };
  const sys = { id: 's1', seq: 2, ts: 110, from: 'alice', body: '[tmm] board #2 todo → doing — Second' };
  const m2 = { id: 'm2', seq: 3, ts: 120, from: 'alice', body: 'fixed in #2, see #9 and page#2; `#1` in code' };
  const m3 = { id: 'm3', seq: 4, ts: 130, from: 'human', body: '#3 is new' };
  let log = [m1, sys];
  const app = await fixture.mount(context, {
    props: { visible: true, mobile: true, openBoardTab: (...args: unknown[]) => routes.push(args) },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{
      ...rpc,
      hubLog: async () => ({ messages: log, has_more: false }),
      boardList: async (session: string) => { reads.push(session); return { issues: board, statuses: ['todo', 'doing', 'review', 'done'] }; },
    }],
  });
  const links = () => [...app.document.querySelectorAll<HTMLAnchorElement>('.feed .bubble a.issue-ref')].map((a) => a.textContent);
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  try {
    await settle();
    assert.ok(app.document.querySelector('.feed .bubble'), 'the room rendered');
    assert.deepEqual(reads, [], 'no message names an issue (the board line carries its own jump): no read');
    log = [m1, sys, m2];
    await app.advance(10000); await settle();
    assert.deepEqual(reads, ['fixture'], 'a message naming an issue reads the board once');
    assert.deepEqual(links(), ['#2'], 'only an id the board has, outside code, at a word start');
    assert.match(app.document.querySelector('.feed')!.textContent ?? '', /see #9 and page#2/u, 'the rest stays text');
    app.document.querySelector<HTMLAnchorElement>('.feed .bubble a.issue-ref')!.click();
    await settle(4);
    assert.deepEqual(routes, [['fixture', 2]], 'the phone opens that issue on the Board page');
    assert.equal(app.document.querySelector('.m-acts'), null, 'the link is not a tap on the bubble');
    await app.advance(10000); await settle();
    assert.equal(reads.length, 1, '#9 is above the board but was already asked about: no second read');
    board = [...board, boardIssue(3, 'Third')];
    log = [m1, sys, m2, m3];
    await app.advance(10000); await settle();
    assert.equal(reads.length, 2, 'an id above the board not asked about yet reads again, though below the #9 typo');
    assert.deepEqual(links(), ['#2', '#3']);
  } finally { await app.close(); }
});

// Reviewer P1 on 0d48bdda: a read is an attempt, not a verdict. A failed
// read leaves nothing behind, and an id above the board's newest may be filed
// later, so a NEW message naming it, or entering the room again, asks again;
// nothing retries on its own.
test('a failed board read is not a verdict, and a reference to a not-yet-filed issue links once a new message names it (#340 review)', { timeout: 60000 }, async (context) => {
  const reads: string[] = [];
  let fail = true;
  let board = [boardIssue(1, 'First'), boardIssue(2, 'Second')];
  let log: unknown[] = [];
  const msg = (n: number, body: string, from = 'alice') => ({ id: `m${n}`, seq: n, ts: 100 + n, from, body });
  const app = await composerFixture(context, {
    hubLog: async (session: string) => ({ messages: session === 'fixture' ? log : [], has_more: false }),
    boardList: async (session: string) => {
      reads.push(session);
      if (fail) throw new Error('timed out');
      return { issues: board, statuses: ['todo', 'doing', 'review', 'done'] };
    },
  });
  const links = () => [...app.document.querySelectorAll('.feed .bubble a.issue-ref')].map((a) => a.textContent);
  const poll = async () => { await app.advance(10000); for (let i = 0; i < 12; i++) await app.flush(); };
  try {
    log = [msg(1, 'fixed in #2')];
    await poll();
    assert.deepEqual(reads, ['fixture'], 'the message asks once');
    assert.deepEqual(links(), [], 'and the read failed: nothing is linked');
    await poll(); await poll();
    assert.equal(reads.length, 1, 'a failure does not retry by itself');
    fail = false;
    log = [msg(1, 'fixed in #2'), msg(2, 'and #2 again')];
    await poll();
    assert.equal(reads.length, 2, 'a new message naming it asks again');
    assert.deepEqual(links(), ['#2', '#2'], 'and the failure left no "no such issue" behind');

    log = [...log as object[], msg(3, 'next up is #3')];
    await poll();
    assert.equal(reads.length, 3, '#3 is above the newest known issue: asked');
    assert.equal(links().includes('#3'), false, 'not filed yet');
    await poll();
    assert.equal(reads.length, 3, 'the same message does not ask twice in one visit');
    await app.room('other');
    await app.room('fixture');
    await poll();
    assert.equal(reads.filter((r) => r === 'fixture').length, 4, 'entering the room again asks once more');
    board = [...board, boardIssue(3, 'Third')];
    log = [...log as object[], msg(4, '#3 is filed now')];
    await poll();
    assert.equal(reads.filter((r) => r === 'fixture').length, 5, 'a new message naming #3 asks again');
    assert.deepEqual(links().filter((l) => l === '#3'), ['#3', '#3'], 'and both references link');
  } finally { await app.close(); }
});

// Reviewer P2-A and P2-B on 0d48bdda.
test('two board reads finishing out of order never move the list back, and a restored # draft reads its own room (#340 review)', { timeout: 60000 }, async (context) => {
  const reads: { session: string; answer: (issues: unknown[]) => void }[] = [];
  const app = await composerFixture(context, {
    boardList: (session: string) => new Promise((resolve) => {
      reads.push({ session, answer: (issues) => resolve({ issues, statuses: ['todo', 'doing', 'review', 'done'] }) });
    }),
  });
  const options = () => [...app.document.querySelectorAll('.cmd-menu .cmd-opt .cmd-name')].map((n) => n.textContent);
  try {
    await app.text('see #');
    await app.text('see');
    await app.text('see #');
    assert.equal(reads.length, 2, 'each entry into a # query reads');
    reads[1]!.answer([boardIssue(1, 'First'), boardIssue(2, 'Just filed')]);
    await app.flush(); await app.flush();
    reads[0]!.answer([boardIssue(1, 'First')]);
    await app.flush(); await app.flush();
    assert.deepEqual(options(), ['#2', '#1'], 'the older answer, landing last, does not replace the newer list');

    await app.room('other');
    await app.text('and #');
    assert.deepEqual(reads.map((r) => r.session), ['fixture', 'fixture', 'other']);
    await app.room('fixture');
    assert.equal(app.input.value, 'see #', 'the # draft is restored');
    assert.deepEqual(reads.map((r) => r.session), ['fixture', 'fixture', 'other', 'fixture'], 'and it reads THIS room, though a # draft was open before');
    await app.text('see #2');
    assert.equal(reads.length, 4, 'typing on inside the query asks nothing more');
    for (const r of reads.slice(2)) r.answer([]);
  } finally { await app.close(); }
});

test('a line refused in copy-mode shows one warn note naming the agent and the reason; its bubble stays hollow (#250)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      // jsdom has no canvas renderer (same stub as the feed tests below).
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.localStorage.setItem('tmux_hub_project', 'fixture');
    },
    modules: [{
      ...rpc,
      hubLog: async () => ({ messages: [
        { id: 'm-2', seq: 2, ts: 200, from: 'human', body: '@alice read this' },
      ], has_more: false }),
      // The server's warn for a refused line: plain, no delivery reference.
      hubActivity: async () => ({ events: [
        { id: 1, ts: 250, window: 'alice', kind: 'warn', text: 'undelivered (pane is in copy mode): [tmm chat] human: @alice read this' },
      ], has_more: false }),
    }],
  });
  try {
    for (let i = 0; i < 20 && !(app.document.querySelector('.msg') && app.document.querySelector('.note.warn')); i++) await app.flush();
    const notes = [...app.document.querySelectorAll<HTMLElement>('.note.warn')];
    assert.equal(notes.length, 1, 'exactly one warn note');
    assert.ok(notes[0]!.querySelector('.n-who')!.textContent!.includes('alice'), 'the note names the target');
    assert.match(notes[0]!.querySelector('.n-text')!.textContent!, /^undelivered \(pane is in copy mode\): .*@alice read this/u);
    const state = app.document.querySelector<HTMLElement>('.msg .m-state')!;
    assert.ok(state, 'the bubble has its delivery mark');
    assert.equal(state.classList.contains('ok'), false, 'not delivered');
    assert.equal(state.classList.contains('note'), false, 'still a delivery to an agent, not a room note');
    assert.equal(state.getAttribute('title'), 'Queued', 'the hollow ring');
  } finally { await app.close(); }
});

test('a /command to All that one pane refused in copy-mode succeeds for the rest and shows the refusal as a warn note (#250)', { timeout: 60000 }, async (context) => {
  // The server's answer for `all` with alice in copy-mode (the Rust test
  // a_command_to_all_with_one_pane_in_copy_mode…): success for bob, and one
  // plain warn on alice's window that the next activity poll brings in.
  const commands: string[] = [];
  const events: object[] = [];
  const app = await composerFixture(context, {
    hubCommand: async (_s: string, name: string, command: string) => {
      commands.push(`${name}:${command}`);
      events.push({ id: 1, ts: Date.now(), window: 'alice', kind: 'warn', text: `undelivered (pane is in copy mode): ${command}` });
      return { sent: ['bob'], command };
    },
    hubActivity: async () => ({ events: [...events], has_more: false }),
  });
  // jsdom has no canvas renderer; the feed measures glyphs once it has rows.
  app.window.HTMLCanvasElement.prototype.getContext = () => null;
  try {
    await app.to('everyone');
    await app.text('/compact');
    app.send.click();
    await app.wait(() => commands.length === 1);
    assert.deepEqual(commands, ['all:/compact'], 'one RPC; the server fans out');
    await app.advance(5000);
    await app.wait(() => !!app.document.querySelector('.note.warn'));
    const notes = [...app.document.querySelectorAll<HTMLElement>('.note.warn')];
    assert.equal(notes.length, 1);
    assert.ok(notes[0]!.querySelector('.n-who')!.textContent!.includes('alice'), 'the note names the refused agent');
    assert.equal(notes[0]!.querySelector('.n-text')!.textContent, 'undelivered (pane is in copy mode): /compact');
    assert.equal(app.input.value, '', 'a partial success is not a failed send to retry');
  } finally { await app.close(); }
});

test('stopped-card double-click only filters and closes its click menu (#173)', { timeout: 60000 }, async (context) => {
  const app = await composerFixture(context, {
    projectList: async () => ({ projects: [{
      project: { id: 'fixture', name: 'fixture', session: 'fixture', path: '/fixture' },
      live: true, slots: [{ window_name: 'paused', kind: 'agent', command: 'codex' }],
    }] }),
  });
  try {
    const button = stripCard(app.document, 'paused').querySelector<HTMLButtonElement>('.agent-select')!;
    button.dispatchEvent(new app.window.MouseEvent('click', { detail: 1, bubbles: true }));
    await app.flush();
    assert.ok(app.document.querySelector('.ctx'));
    button.dispatchEvent(new app.window.MouseEvent('click', { detail: 2, bubbles: true }));
    button.dispatchEvent(new app.window.MouseEvent('dblclick', { detail: 2, bubbles: true }));
    await app.flush();
    assert.equal(selectedCard(app.document), 'alice');
    assert.equal(app.document.querySelector('.ctx'), null);
    assert.ok(app.document.querySelector('.cards.filtering'));
    assert.ok(stripCard(app.document, 'paused').classList.contains('filtered'));
  } finally { await app.close(); }
});

test('Watch in the shared menu routes the clicked agent on phone and narrow desktop without selecting it (#180)', { timeout: 60000 }, async (context) => {
  for (const mobile of [true, false]) {
    const routes: unknown[][] = [];
    const { rpc } = roomFixture();
    const panes = [
      { session: 'fixture', window: 0, pane: 0, active: true, current_command: 'kiro', agent: 'kiro', window_name: 'alice', pane_title: 'alice', current_path: '/fixture', width: 80, height: 24 },
      { session: 'fixture', window: 1, pane: 0, active: true, current_command: 'codex', agent: 'codex', window_name: 'bob', pane_title: 'bob', current_path: '/fixture', width: 80, height: 24 },
    ];
    const app = await (await compiledHub()).mount(context, {
      props: { visible: true, mobile, openTerminal: (...args: unknown[]) => routes.push(args) },
      setup(window) {
        window.Element.prototype.getAnimations = () => [];
        const media = window.matchMedia.bind(window);
        window.matchMedia = query => Object.assign(media(query), { matches: query === '(max-width: 760px)' || (mobile && query === '(any-pointer: coarse)') });
      },
      modules: [{
        ...rpc,
        listSessionsWithPanes: async () => ({ panes }),
      }],
    });
    try {
      for (let i = 0; i < 12 && selectedCard(app.document) !== 'alice'; i++) await app.flush();
      assert.equal(app.document.querySelector('.agent-watch'), null, 'content-sized cards reserve no hidden Watch slot');
      stripCard(app.document, 'bob').querySelector('.agent-select')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
      await app.flush();
      const watch = [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')].find(button => button.textContent?.includes('Watch in terminal'))!;
      assert.ok(watch); watch.click();
      await app.flush();
      assert.deepEqual(routes, [['fixture', 'fixture:1.0']]);
      assert.equal(selectedCard(app.document), 'alice');
      panes.splice(0, 1);
      await app.advance(20000);
      stripCard(app.document, 'alice').querySelector('.agent-select')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
      await app.flush();
      [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')].find(button => button.textContent?.includes('Watch in terminal'))!.click();
      await app.flush();
      assert.equal(routes.length, 1, 'a missing pane must not reuse the previously watched agent');
    } finally { await app.close(); }
  }
});

test('team label selects only current members for chat, CLI commands and interrupt (#239)', { timeout: 60000 }, async (context) => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'running', since: 20, team: 'review' },
    { name: 'charlie', window: 2, managed: true, agent: 'codex', state: 'waiting', since: 5, team: 'review/backend' },
  ];
  const posts: string[] = [], commands: string[] = [], interrupts: string[] = [];
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents }),
    hubPost: async (_session: string, body: string) => { posts.push(body); return {}; },
    hubCommand: async (_session: string, name: string, command: string) => { commands.push(`${name}:${command}`); return {}; },
    hubAgentInterrupt: async (_session: string, name: string) => { interrupts.push(name); return {}; },
  });
  try {
    const team = app.document.querySelector<HTMLButtonElement>('.roster-cluster[data-team="review"] .team-label')!;
    assert.ok(team, 'the name itself is a native command target');
    team.click(); await app.flush();
    assert.equal(team.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(['alice', 'bob', 'charlie'].filter((name) => stripCard(app.document, name).classList.contains('sel')), ['bob', 'charlie']);
    assert.ok(team.closest('.roster-cluster')?.classList.contains('team-lit'), 'one enclosure, not two separate cards');
    assert.match(app.input.getAttribute('aria-label') ?? app.input.getAttribute('placeholder') ?? '', /team review/iu);

    await app.text('Ship @alice too');
    app.send.click(); await app.flush();
    assert.deepEqual(posts, ['@bob @charlie Ship @alice too'], 'a room record names only selected members plus explicit body mentions');
    await app.text('/compact');
    app.send.click(); await app.flush();
    assert.deepEqual(commands, ['bob:/compact', 'charlie:/compact'], 'one verbatim native CLI command per team member');
    await app.text('@alice /clear');
    app.send.click(); await app.flush();
    assert.deepEqual(commands, ['bob:/compact', 'charlie:/compact', 'alice:/clear'], 'an explicit addressee wins over team selection');
    await app.key('c', { ctrlKey: true }); await app.key('c', { ctrlKey: true });
    assert.deepEqual(interrupts, ['bob', 'charlie'], 'the same target resolution drives Stop');

    agents.pop();
    await app.advance(5000);
    assert.equal(stripCard(app.document, 'bob').classList.contains('sel'), true, 'one member still belongs to the team target');
    assert.equal(app.document.querySelector('.roster-cluster.team-lit'), null, 'one live member is not drawn as a team enclosure');
    assert.ok(app.document.querySelector('.tabs > .slide-pill.tab'), 'the marker stays shown, on bob\'s card (rosterMarker, #241)');
    await app.text('Only one left');
    app.send.click(); await app.flush();
    assert.equal(posts.at(-1), '@bob Only one left');
    agents.pop();
    await app.advance(5000);
    assert.match(app.input.getAttribute('aria-label') ?? app.input.getAttribute('placeholder') ?? '', /Record in chat only/iu,
      'an empty team becomes a room note, not a different agent');
    await app.room('other'); await app.room('fixture');
    assert.equal(app.document.querySelector('.roster-cluster[data-team="review"]'), null, 'a stale team target never returns after room restore');
  } finally { await app.close(); }
});

test('team slash fan-out never offers a duplicate retry after partial delivery (#239)', { timeout: 60000 }, async (context) => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'kiro', state: 'idle', since: 20, team: 'dev' },
    { name: 'charlie', window: 2, managed: true, agent: 'kiro', state: 'idle', since: 5, team: 'dev' },
  ];
  const commands: string[] = [];
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents }),
    hubCommand: async (_session: string, name: string, command: string) => {
      commands.push(`${name}:${command}`);
      if (name === 'charlie' || command === '/model') throw Error('not delivered');
      return {};
    },
  });
  try {
    app.document.querySelector<HTMLButtonElement>('.team-label')!.click(); await app.flush();
    await app.text('/compact');
    app.send.click(); await app.flush();
    assert.deepEqual(commands, ['bob:/compact', 'charlie:/compact']);
    assert.equal(app.input.value, '', 'a partial success cannot restore a command that would rerun on bob');
    const partial = app.document.querySelector('.composer-feedback [role="alert"]');
    assert.match(partial?.textContent ?? '', /\/compact failed for: charlie/u,
      'the human sees exactly which member did not run the command');
    await app.text('/model');
    app.send.click(); await app.flush();
    assert.deepEqual(commands.slice(2), ['bob:/model', 'charlie:/model']);
    assert.equal(app.input.value, '/model', 'only an all-failed command may be retried without duplication');
    const failed = app.document.querySelector('.composer-feedback [role="alert"]');
    assert.match(failed?.textContent ?? '', /\/model failed/u, 'all failures are visible too');
    assert.doesNotMatch(failed?.textContent ?? '', /not delivered/u, 'RPC details are not surfaced');
    await app.room('other');
    assert.equal(app.document.querySelector('.composer-feedback'), null, 'feedback does not leak into another room');
  } finally { await app.close(); }
});

test('roster disclosure keeps its cards, remembers each room, and holds order during interaction (#168)', { timeout: 60000 }, async (context) => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', since: 1000 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'running', since: 10, team: 'review' },
    { name: 'charlie', window: 2, managed: true, agent: 'codex', state: 'waiting', since: 20, team: 'review/backend' },
  ];
  const interrupts: string[] = [];
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents }),
    hubAgentInterrupt: async (_session: string, name: string) => { interrupts.push(name); return {}; },
  }, false, {}, true);
  const order = () => [...app.document.querySelectorAll<HTMLElement>('.acard[data-agent]')].map((node) => node.dataset.agent);
  const toggle = () => app.document.querySelector<HTMLButtonElement>('.roster-toggle button')!;
  try {
    // Owner #176 moves the bulk destination after identities, not ahead of them.
    assert.deepEqual(order(), ['charlie', 'bob', 'alice']);
    const alice = stripCard(app.document, 'alice');
    const list = app.document.querySelector('.cards')!;
    assert.doesNotMatch(list.textContent!, /running|waiting|idle/u);
    assert.equal(toggle().getAttribute('aria-expanded'), 'false');
    toggle().click(); await app.flush();
    assert.equal(toggle().getAttribute('aria-expanded'), 'true');
    assert.equal(stripCard(app.document, 'alice'), alice, 'expansion does not remount cards');
    assert.equal(app.document.querySelector('.cards'), list);
    await app.room('other');
    assert.equal(toggle().getAttribute('aria-expanded'), 'false');
    await app.room('fixture');
    assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'each room restores its own disclosure');

    agents[0]!.state = 'running'; agents[0]!.since = 5000;
    agents[2]!.state = 'idle'; agents[2]!.since = 6000;
    await app.advance(5000);
    assert.deepEqual(order(), ['alice', 'bob', 'charlie'], 'an idle expanded monitor follows new turn order');
    await hoverCard(app, 'alice');
    assert.ok(stripCard(app.document, 'alice').querySelector('.agent-stop button'), '#205: the hovered busy card shows its Stop');
    await unhoverCard(app, 'alice');
    assert.equal(stripCard(app.document, 'alice').querySelector('.agent-stop'), null, 'unhovered: the dot again');
    await hoverCard(app, 'charlie');
    assert.equal(stripCard(app.document, 'charlie').querySelector('.agent-stop'), null,
      'new turn state updates Stop availability: idle shows none even hovered');
    await unhoverCard(app, 'charlie');
    toggle().click(); await app.flush();
    assert.deepEqual(order(), ['alice', 'bob', 'charlie'], 'collapse adopts the new turn order');

    await hoverCard(app, 'bob');
    const bobStop = stripCard(app.document, 'bob').querySelector<HTMLButtonElement>('.agent-stop button')!;
    bobStop.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
    agents[1]!.since = 10000;
    await app.advance(5000);
    assert.deepEqual(order(), ['alice', 'bob', 'charlie'], 'a pressed Stop cannot move to another card');
    bobStop.click(); await app.flush();
    assert.deepEqual(interrupts, ['bob']);
    assert.equal(selectedCard(app.document), 'alice');
    assert.deepEqual(order(), ['bob', 'charlie', 'alice'], 'the whole team follows its most active member');
  } finally { await app.close(); }
});

test('a second live team member reveals group chrome without remounting its first tab (#238)', { timeout: 60000 }, async (context) => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'running', since: 20, team: 'review' },
  ];
  const app = await composerFixture(context, { hubAgents: async () => ({ agents }) });
  try {
    const bob = stripCard(app.document, 'bob');
    const cluster = bob.closest('.roster-cluster')!;
    assert.equal(cluster.hasAttribute('data-team'), false, 'one live member is an ordinary tab');
    agents.push({ name: 'charlie', window: 2, managed: true, agent: 'codex', state: 'idle', since: 5, team: 'review' });
    await app.advance(5000);
    assert.equal(stripCard(app.document, 'bob'), bob, 'joining never remounts the first member');
    assert.equal(bob.closest('.roster-cluster'), cluster, 'the stable group key retains the wrapper');
    assert.equal(cluster.getAttribute('data-team'), 'review');
    assert.deepEqual([...cluster.querySelectorAll<HTMLElement>('.acard[data-agent]')].map((x) => x.dataset.agent), ['bob', 'charlie']);
    agents.pop();
    await app.advance(5000);
    assert.equal(bob.closest('.roster-cluster'), cluster, 'losing the second member only removes group chrome');
    assert.equal(cluster.hasAttribute('data-team'), false);
  } finally { await app.close(); }
});

test('a restored expanded roster reorders live unless a pointer or focus holds it (#168)', { timeout: 60000 }, async (context) => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'running', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'running', since: 20 },
  ];
  const app = await composerFixture(context, { hubAgents: async () => ({ agents }) }, false,
    { tmux_hub_roster_expanded: JSON.stringify({ fixture: true }) }, true);
  const order = () => [...app.document.querySelectorAll<HTMLElement>('.acard[data-agent]')].map((node) => node.dataset.agent);
  try {
    assert.equal(app.document.querySelector('.roster-toggle button')!.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(order(), ['bob', 'alice']);
    agents[0]!.since = 40;
    await app.advance(5000);
    assert.deepEqual(order(), ['alice', 'bob']);
    const list = app.document.querySelector('.cards')!;
    list.dispatchEvent(new app.window.Event('pointerenter'));
    agents.push({ name: 'new', window: 2, managed: true, agent: 'codex', state: 'running', since: 50 });
    await app.advance(5000);
    assert.deepEqual(order(), ['alice', 'bob', 'new'], 'new members append without moving a pointed-at target');
    list.dispatchEvent(new app.window.Event('pointerleave'));
    await app.flush();
    assert.deepEqual(order(), ['new', 'alice', 'bob'], 'pointerleave releases order without a timer');
    stripCard(app.document, 'alice').querySelector<HTMLButtonElement>('.agent-select')!.focus();
    agents[1]!.since = 60;
    await app.advance(5000);
    assert.deepEqual(order(), ['new', 'alice', 'bob'], 'keyboard focus holds its target');
    app.input.focus(); await app.flush();
    assert.deepEqual(order(), ['bob', 'new', 'alice'], 'blur releases the new turn order immediately');
  } finally { await app.close(); }
});

test('roster releases a touch press without click and reconciles focus after a control disappears (#168)', { timeout: 60000 }, async (context) => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'running', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'running', since: 20 },
  ];
  const job = deferred<object>();
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents }),
    hubAgentInterrupt: () => job.promise,
  });
  const order = () => [...app.document.querySelectorAll<HTMLElement>('.acard[data-agent]')].map((node) => node.dataset.agent);
  const pointer = (element: Element, type: string) => {
    const event = new app.window.Event(type, { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    element.dispatchEvent(event);
  };
  try {
    await hoverCard(app, 'bob');
    const stop = stripCard(app.document, 'bob').querySelector<HTMLButtonElement>('.agent-stop button')!;
    stop.click(); await app.flush();
    assert.equal(stop.disabled, true);
    pointer(stop, 'pointerdown');
    agents[0]!.since = 40;
    await app.advance(5000);
    assert.deepEqual(order(), ['bob', 'alice']);
    pointer(stop, 'pointerup');
    await app.flush();
    assert.deepEqual(order(), ['alice', 'bob'], 'disabled touch targets may release without any click');
    job.resolve({}); await app.flush();

    stop.focus(); await app.flush();
    agents[1]!.since = 50;
    await app.advance(5000);
    assert.deepEqual(order(), ['alice', 'bob'], 'focused controls keep their location');
    agents[0]!.state = 'idle'; agents[0]!.since = 80;
    agents[1]!.state = 'idle'; agents[1]!.since = 90;
    await app.advance(5000);
    assert.equal(stop.isConnected, false);
    assert.deepEqual(order(), ['bob', 'alice'], 'DOM removal does not guarantee focusout');
    stripCard(app.document, 'alice').querySelector<HTMLButtonElement>('.agent-select')!.focus();
    agents.splice(0, 1);
    await app.advance(5000);
    agents.push({ name: 'new', window: 2, managed: true, agent: 'codex', state: 'running', since: 100 });
    await app.advance(5000);
    assert.deepEqual(order(), ['new', 'bob'], 'removing a focused member does not leave order locked');
  } finally { job.resolve({}); await app.close(); }
});

test('Stop follows hover and busy state: red on the hovered busy card, gone when the turn ends, never for an idle card (#180 → #205)', { timeout: 60000 }, async context => {
  const agents = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'running', since: 10 },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle', since: 20 },
  ];
  const app = await composerFixture(context, { hubAgents: async () => ({ agents }) });
  try {
    const alice = stripCard(app.document, 'alice'), bob = stripCard(app.document, 'bob');
    assert.equal(alice.querySelector('.agent-stop'), null, 'at rest a busy card shows its dot, not a Stop');
    await hoverCard(app, 'alice');
    const stop = alice.querySelector<HTMLButtonElement>('.agent-stop button')!;
    assert.ok(stop, 'hovering a busy card puts the Stop on the dot');
    assert.ok(stop.classList.contains('danger'), 'red — "更符合语义"');
    assert.ok(alice.classList.contains('stop-shown'), 'the dot yields to it');
    assert.equal(bob.querySelector('.agent-stop'), null, 'an idle card has no Stop');
    agents[0]!.state = 'idle'; agents[1]!.state = 'running';
    await app.advance(5000);
    assert.equal(alice.querySelector('.agent-stop'), null, 'the turn ended: nothing to interrupt, the dot returns');
    assert.equal(bob.querySelector('.agent-stop'), null, 'busy but not hovered: still the dot');
    await unhoverCard(app, 'alice');
    await hoverCard(app, 'bob');
    assert.ok(bob.querySelector('.agent-stop button'), 'hover reveals the newly busy card\'s Stop');
  } finally { await app.close(); }
});

test('Composer All selects once, then opens scoped Stop and record-only actions (#180)', { timeout: 60000 }, async context => {
  const calls: unknown[][] = [];
  const job = deferred<object>();
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents: [
      { name: 'alice', window: 0, agent: 'kiro', managed: true, state: 'running' },
      { name: 'bob', window: 1, agent: 'codex', managed: true, state: 'idle' },
      { name: 'carol', window: 2, agent: 'claude', managed: true, state: 'waiting' },
    ] }),
    hubAgentInterrupt: (...args: unknown[]) => { calls.push(args); return job.promise; },
  });
  try {
    const all = await allButton(app);
    assert.ok(all);
    assert.equal(app.document.querySelector('.roster [data-agent="all"]'), null, 'one All, no roster copy');
    all.click(); await app.flush();
    assert.equal(all.getAttribute('aria-pressed'), 'true');
    assert.equal(app.document.querySelector('.ctx'), null, 'first click selects only');
    all.click(); await app.flush();
    assert.equal(all.getAttribute('aria-expanded'), 'true');
    assert.equal(calls.length, 0, 'second click opens, never interrupts');
    app.document.querySelector('.feed')!.dispatchEvent(new app.window.Event('scroll'));
    await app.flush();
    assert.ok(app.document.querySelector('.ctx'), 'sibling feed output cannot dismiss an unchanged composer anchor');
    const menuButton = (label: string) => [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
      .find(button => button.textContent?.trim() === label)!;
    menuButton('Interrupt all').click(); await app.flush();
    assert.deepEqual(calls, [['fixture', 'alice'], ['fixture', 'carol']]);
    assert.equal(all.getAttribute('aria-pressed'), 'true');
    all.click(); await app.flush();
    assert.ok(menuButton('Interrupt all').disabled, 'pending members cannot be interrupted twice');
    job.resolve({}); await app.flush();
    assert.equal(menuButton('Interrupt all').disabled, false, 'an open menu follows request completion');
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await app.flush();
    all.click(); await app.flush();
    menuButton('Record only').click(); await app.flush();
    assert.equal(all.getAttribute('aria-pressed'), 'false');
    assert.equal(selectedCard(app.document), '');
    all.click(); await app.flush(); all.click(); await app.flush();
    await app.room('other');
    assert.equal(app.document.querySelector('.ctx'), null, 'All menu belongs to its opening room');
  } finally { job.resolve({}); await app.close(); }
});

test('an open All menu follows live busy membership without reopening (#180)', { timeout: 60000 }, async context => {
  const agents = [
    { name: 'alice', window: 0, agent: 'kiro', managed: true, state: 'idle' },
  ];
  const app = await composerFixture(context, { hubAgents: async () => ({ agents }) });
  const interrupt = () => [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')]
    .find(button => button.textContent?.trim() === 'Interrupt all');
  try {
    const all = await allButton(app);
    all.click(); await app.flush(); all.click(); await app.flush();
    assert.equal(interrupt(), undefined);
    agents[0]!.state = 'running';
    await app.advance(5000);
    assert.ok(interrupt());
    agents[0]!.state = 'idle';
    await app.advance(5000);
    assert.equal(interrupt(), undefined);
    assert.equal(all.getAttribute('aria-expanded'), 'true');
  } finally { await app.close(); }
});

test('late font completion remeasures the composer and releases its listener on unmount (#186)', { timeout: 60000 }, async context => {
  let reads = 0;
  let signal!: EventTarget;
  let event!: Event;
  const { rpc } = roomFixture();
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      const fontSet = new window.EventTarget();
      Object.assign(fontSet, { ready: Promise.resolve(fontSet) });
      Object.defineProperty(window.document, 'fonts', { value: fontSet });
      // No fabricated layout: a hidden/zero-width field only records entry to
      // the measurement owner; actual line geometry is tested in Chromium.
      Object.defineProperty(window.HTMLTextAreaElement.prototype, 'clientWidth', {
        get() { reads++; return 0; }, configurable: true,
      });
      signal = fontSet;
      event = new window.Event('loadingdone');
    },
    modules: [rpc],
  });
  try {
    await app.flush();
    const before = reads;
    signal.dispatchEvent(event);
    signal.dispatchEvent(event);
    assert.equal(reads, before, 'the measurement waits for the frame (#444)');
    await app.flush();
    assert.equal(reads, before + 1, 'two triggers in one frame share ONE measurement (#444)');
  } finally { await app.close(); }
  const closed = reads;
  signal.dispatchEvent(event);
  assert.equal(reads, closed, 'the disposed composer receives no late font event');
});

test('All addresses every managed card visually, and choosing one narrows the destination (#186)', { timeout: 60000 }, async context => {
  const app = await composerFixture(context, {
    projectList: async () => ({ projects: [{
      project: { id: 'fixture', name: 'fixture', session: 'fixture', path: '/fixture' }, live: true,
      slots: [{ kind: 'agent', window_name: 'paused', command: 'codex' }],
    }] }),
  });
  try {
    await app.to('everyone');
    for (const name of ['alice', 'bob']) {
      const card = stripCard(app.document, name);
      assert.ok(card.classList.contains('sel'), `${name} has the aggregate selection paint`);
      assert.equal(card.querySelector('.agent-select')?.getAttribute('aria-pressed'), 'true');
    }
    const stopped = stripCard(app.document, 'paused');
    assert.ok(stopped);
    assert.equal(stopped.classList.contains('sel'), false);
    assert.equal(stopped.querySelector('.agent-select')?.getAttribute('aria-pressed'), null);
    await app.to('bob');
    assert.equal(selectedCard(app.document), 'bob');
    assert.equal(stripCard(app.document, 'alice').classList.contains('sel'), false);
    assert.equal(stripCard(app.document, 'bob').classList.contains('sel'), true);
    assert.equal(app.document.querySelector('.all-choice button')?.getAttribute('aria-pressed'), 'false');
  } finally { await app.close(); }
});

test('send never interrupts; double Ctrl+C mirrors only the selected busy card (#168)', { timeout: 60000 }, async (context) => {
  const interrupts: Array<[string, string]> = [];
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents: [
      { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'running' },
      { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'blocked' },
      { name: 'idle', window: 2, managed: true, agent: 'codex', state: 'idle' },
      { name: 'shell', window: 3, managed: false, state: 'running' },
    ] }),
    hubAgentInterrupt: async (session: string, name: string) => { interrupts.push([session, name]); return {}; },
  }, true);
  const ctrlC = () => app.key('c', { ctrlKey: true });
  try {
    assert.equal(await app.key('Enter'), false, 'compact Enter remains a newline');
    assert.equal(app.send.disabled, true);
    app.send.click();
    await app.flush();
    await ctrlC();
    assert.deepEqual(interrupts, [], 'empty Send cannot be the first keyboard activation');
    await app.advance(3001);
    await ctrlC();
    assert.deepEqual(interrupts, [], 'an expired first key cannot fire');
    await app.key('Escape');
    await ctrlC();
    assert.deepEqual(interrupts, []);
    await app.text('copy me');
    assert.equal(await app.key('c', { ctrlKey: true }), false, 'nonempty Ctrl+C is native copy');
    await app.text('');
    await ctrlC();
    await app.to('bob');
    await ctrlC();
    assert.deepEqual(interrupts, [], 'recipient change resets the key sequence');
    await app.room('other');
    await ctrlC();
    assert.deepEqual(interrupts, [], 'room change resets the key sequence');
    await app.key('c', { ctrlKey: true, repeat: true });
    await app.key('c', { ctrlKey: true, isComposing: true });
    assert.deepEqual(interrupts, [], 'repeat/composition cannot fire Stop');
    await ctrlC();
    await app.wait(() => interrupts.length === 1);
    assert.deepEqual(interrupts, [['other', 'alice']]);
    await app.to('everyone');
    await ctrlC();
    await ctrlC();
    await app.wait(() => interrupts.length === 3);
    assert.deepEqual(interrupts.slice(1), [['other', 'alice'], ['other', 'bob']],
      '@all excludes idle and unmanaged windows');
    await app.to('idle');
    await ctrlC();
    await ctrlC();
    await app.to('note');
    assert.equal(app.send.disabled, true);
    await ctrlC();
    await ctrlC();
    assert.equal(interrupts.length, 3);
    assert.equal(app.document.querySelector('.int-pill, .to-chip'), null);
  } finally { await app.close(); }
});

test('a peer Stop captures its room, deduplicates pending clicks and never selects or kills (#168)', { timeout: 60000 }, async (context) => {
  const jobs: Array<{ session: string; name: string; task: ReturnType<typeof deferred<object>> }> = [];
  const app = await composerFixture(context, {
    hubAgents: async () => ({ agents: [
      { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'running' },
      { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'working' },
    ] }),
    hubAgentInterrupt: (session: string, name: string) => {
      const task = deferred<object>();
      jobs.push({ session, name, task });
      return task.promise;
    },
    hubAgentStop: () => assert.fail('Stop response must not kill the process'),
  });
  // #205: a Stop stands only on the hovered card (or a pending one) — hover before each look.
  const stop = async (name: string) => { await hoverCard(app, name); return stripCard(app.document, name).querySelector<HTMLButtonElement>('.agent-stop button')!; };
  try {
    (await stop('bob')).click();
    (await stop('bob')).click();
    await app.flush();
    assert.deepEqual(jobs.map(({ session, name }) => [session, name]), [['fixture', 'bob']]);
    assert.equal(selectedCard(app.document), 'alice');
    assert.equal((await stop('bob')).disabled, true);
    assert.equal((await stop('alice')).disabled, false);
    await app.room('other');
    assert.equal((await stop('bob')).disabled, false, 'another room has its own pending identity');
    (await stop('bob')).click();
    await app.flush();
    jobs[0]!.task.resolve({});
    await app.flush();
    assert.equal((await stop('bob')).disabled, true, 'old room completion cannot clear the new job');
    jobs[1]!.task.resolve({});
    await app.flush();
    assert.equal((await stop('bob')).disabled, false);
    assert.equal(selectedCard(app.document), 'alice');
    assert.deepEqual(jobs.map(({ session, name }) => [session, name]), [['fixture', 'bob'], ['other', 'bob']]);
  } finally {
    for (const job of jobs) job.task.resolve({});
    await app.close();
  }
});

test('Composer paste keeps Office words, stages files once and isolates overlapping generations', { timeout: 60000 }, async (context) => {
  const uploads: Array<{ path: string; job: ReturnType<typeof deferred<object>> }> = [];
  const posts: string[] = [];
  const app = await composerFixture(context, {
    fsUpload: async (path: string) => {
      if (path.endsWith('/.gitignore')) return {};
      const job = deferred<object>();
      uploads.push({ path, job });
      return job.promise;
    },
    hubPost: async (_session: string, body: string) => { posts.push(body); return {}; },
  });
  try {
    const file = (name: string) => new app.window.File(['bytes'], name, { type: 'text/plain' });
    const image = new app.window.File(['rendering'], 'selection.png', { type: 'image/png' });
    assert.equal(await app.paste([image], 'Quarterly results'), false, 'Office words retain native insertion');
    assert.equal(uploads.length, 0, 'a picture of the text is never staged');
    await app.text('left right');
    app.input.setSelectionRange(5, 5);
    assert.equal(await app.paste([file('first.txt')], '/first.txt'), true);
    await app.wait(() => uploads.length === 1);
    await app.paste([file('second.txt')]);
    await app.wait(() => uploads.length === 2);
    uploads[0]!.job.resolve({});
    await app.wait(() => app.input.value.includes('[file:1]'));
    assert.equal(app.input.value, 'left [file:1]right', 'token uses the click-time caret');
    assert.equal(app.send.disabled, true, 'the second same-room job keeps the gate closed');
    await app.room('other');
    await app.text('new room');
    assert.equal(app.send.disabled, false, 'an old job does not lock the new generation');
    await app.paste([file('third.txt')]);
    await app.wait(() => uploads.length === 3);
    uploads[1]!.job.resolve({});
    await app.flush();
    assert.equal(app.send.disabled, true, 'old finally cannot unlock the new job');
    assert.equal(app.input.value, 'new room');
    uploads[2]!.job.reject(new Error('upload denied'));
    await app.wait(() => app.document.querySelector('.pend-chip.err') !== null);
    assert.match(app.document.querySelector('.pend-why')!.textContent!, /upload denied/);
    assert.equal(app.send.disabled, true);
    await app.key('Enter');
    assert.deepEqual(posts, [], 'failed chips block the key path as well as the button');
    app.document.querySelector<HTMLElement>('.pend-x')!.click();
    await app.flush();
    assert.equal(app.send.disabled, false);
    await app.paste([file('fourth.txt')]);
    await app.wait(() => uploads.length === 4);
    uploads[3]!.job.resolve({});
    await app.wait(() => app.input.value.includes('[file:1]'));
    assert.equal(app.document.activeElement, app.input, 'completed staging restores focus');
    assert.equal(app.document.querySelectorAll('.pend-chip').length, 1);
  } finally {
    for (const { job } of uploads) job.resolve({});
    await app.close();
  }
});

test('Composer post and command failures never restore into the next room', { timeout: 60000 }, async (context) => {
  const requests: Array<{ method: string; session: string; body: string; job: ReturnType<typeof deferred<object>> }> = [];
  const call = (method: string, session: string, body: string) => {
    const job = deferred<object>();
    requests.push({ method, session, body, job });
    return job.promise;
  };
  const app = await composerFixture(context, {
    hubPost: (session: string, body: string) => call('post', session, body),
    hubCommand: (session: string, target: string, body: string) => call(`command:${target}`, session, body),
  });
  try {
    for (const [index, draft, method] of [[0, 'hello', 'post'], [1, '/clear', 'command:alice']] as const) {
      await app.room('fixture');
      await app.text(draft);
      app.send.click();
      await app.wait(() => requests.length === index + 1);
      assert.equal(app.input.value, '');
      assert.equal(requests[index]!.session, 'fixture');
      assert.equal(requests[index]!.method, method);
      await app.room('other');
      await app.text(`next ${index}`);
      requests[index]!.job.reject(new Error('send rejected'));
      await app.flush();
      assert.equal(app.input.value, `next ${index}`);
    }
    await app.text('same room');
    app.send.click();
    await app.wait(() => requests.length === 3);
    requests[2]!.job.reject(new Error('retry'));
    await app.wait(() => app.input.value === 'same room');
  } finally {
    for (const { job } of requests) job.resolve({});
    await app.close();
  }
});

test('Reply quotes a message: a chip, the id rides the send, the quoted agent is seated, and a quote renders as a blockquote (#290)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const posts: unknown[][] = [];
  const quoted = '[re alice 10:41: 「＠bob please check」] fixed';
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
    },
    modules: [{
      ...rpc,
      hubAgents: async () => ({ agents: [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' }] }),
      modelsList: async () => ({ models: [] }),
      hubLog: async () => ({ messages: [
        { id: 'm1', seq: 1, ts: 100, from: 'alice', body: '@bob please check\nthe second line' },
        { id: 'm2', seq: 2, ts: 200, from: 'human', body: `@alice ${quoted}` },
      ], has_more: false }),
      hubActivity: async () => ({ events: [], has_more: false }),
      hubPost: async (...args: unknown[]) => { posts.push(args.filter((a) => a !== undefined)); return {}; },
    }],
  });
  try {
    for (let i = 0; i < 12 && app.document.querySelectorAll('.msg').length !== 2; i++) await app.flush();
    const mine = app.document.querySelector<HTMLElement>('.msg.me')!;
    assert.equal(mine.querySelector('.m-quote')?.textContent?.replace(/\s+/gu, ' ').trim(), 'alice · 10:41 ＠bob please check', 'the quote is a blockquote');
    assert.ok(!mine.querySelector('.m-body p')?.textContent?.includes('[re '), 'the token never renders as text');
    const theirs = app.document.querySelector<HTMLElement>('.msg:not(.me)')!;
    theirs.querySelector<HTMLElement>('.bubble')!.click();
    await app.flush();
    theirs.querySelector<HTMLButtonElement>('.m-acts button[aria-label="Reply"]')!.click();
    await app.flush();
    let chip = app.document.querySelector('.pend-chip.reply');
    assert.ok(chip, 'the reply chip');
    // Escape peels it when it is the only layer up (validator 12:23).
    app.document.querySelector<HTMLTextAreaElement>('.c-input')!.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (let i = 0; i < 5 && app.document.querySelector('.pend-chip.reply'); i++) await app.flush();
    assert.equal(app.document.querySelector('.pend-chip.reply'), null, 'Escape drops the quote');
    theirs.querySelector<HTMLElement>('.bubble')!.click();
    await app.flush();
    theirs.querySelector<HTMLButtonElement>('.m-acts button[aria-label="Reply"]')!.click();
    await app.flush();
    chip = app.document.querySelector('.pend-chip.reply');
    assert.ok(chip, 'quoted again');
    assert.match(chip!.textContent ?? '', /Replying to alice/u);
    assert.match(chip!.textContent ?? '', /@bob please check/u, 'the preview is the first line');
    const input = app.document.querySelector<HTMLTextAreaElement>('.c-input')!;
    input.value = 'on it';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    app.document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
    for (let i = 0; i < 10 && !posts.length; i++) await app.flush();
    assert.deepEqual(posts, [['fixture', '@alice on it', 'human', 'm1']], 'the id rides the send; the quoted agent is the recipient');
    for (let i = 0; i < 10 && app.document.querySelector('.pend-chip.reply'); i++) await app.flush();
    assert.equal(app.document.querySelector('.pend-chip.reply'), null, 'one quote per send');
  } finally { await app.close(); }
});

test('Feed keeps native selection, Copy/Raw dismissal, path intents and room-local choices', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc, pushed } = roomFixture();
  const copied: string[] = [];
  const routes: unknown[][] = [];
  const boards: unknown[][] = [];
  const body = 'Reply with **formatting** and [source](/fixture/source.txt).';
  const app = await fixture.mount(context, {
    props: { visible: true, mobile: true,
      openFilesTab: (...args: unknown[]) => { routes.push(args); },
      openBoardTab: (...args: unknown[]) => { boards.push(args); },
    },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      // jsdom has no canvas renderer. Do not invent glyph widths here:
      // native Chromium owns the actual measurement/anchor characterization.
      window.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(window.navigator, 'clipboard', { value: {
        writeText: async (text: string) => { copied.push(text); },
      } });
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
        project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
      })) }),
      modelsList: async () => ({ models: [] }),
      hubLog: async () => ({ messages: [
        { id: 'question', seq: 1, ts: 100, from: 'human', body: '@alice Review this.' },
        { id: 'reply', seq: 2, ts: 200, from: 'alice', body },
        { id: 'board', seq: 3, ts: 300, from: 'alice', body: '[tmm] board #7 todo → doing — Feed extraction' },
      ], has_more: false }),
      hubActivity: async () => ({ events: [
        { id: 1, ts: 250, window: 'alice', kind: 'tool', tool: 'Read', text: 'source.ts' },
        { id: 2, ts: 251, window: 'bob', kind: 'tool', tool: 'Bash', text: 'npm test' },
      ], has_more: false }),
    }],
  });
  try {
    for (let i = 0; i < 12 && app.document.querySelectorAll('.msg').length !== 2; i++) await app.flush();
    const reply = () => app.document.querySelector<HTMLElement>('.msg:not(.me)')!;
    const bubble = () => reply().querySelector<HTMLElement>('.bubble')!;
    const actions = () => reply().querySelector<HTMLElement>('.m-acts');
    assert.ok(reply());
    assert.equal(reply().parentElement?.classList.contains('feed'), true);
    const selection = app.window.getSelection()!;
    const range = app.document.createRange();
    range.selectNodeContents(reply().querySelector('.m-body')!);
    selection.addRange(range);
    bubble().click();
    await app.flush();
    assert.equal(actions(), null, 'a real Selection object wins over the bubble click');
    selection.removeAllRanges();
    const hold = new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(hold, 'pointerType', { value: 'touch' });
    bubble().dispatchEvent(hold);
    assert.equal(hold.defaultPrevented, false, 'contextmenu is a passive mark, not a replacement menu');
    bubble().click();
    await app.flush();
    assert.equal(actions(), null, 'the compatibility click is consumed once');
    bubble().click();
    await app.flush();
    assert.ok(actions());
    const rawButton = actions()!.querySelector<HTMLButtonElement>('button[aria-label="Raw"]')!;
    assert.ok(rawButton.classList.contains('command-button'), '#166: shared command states, not private bubble paint');
    assert.equal(rawButton.getAttribute('aria-pressed'), 'false');
    assert.deepEqual([...actions()!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')), ['Copy', 'Raw', 'Reply'], 'Reply joins the one action row (#290)');
    rawButton.click();
    await app.flush();
    assert.equal(reply().querySelector('.raw')?.textContent, body);
    assert.equal(rawButton.getAttribute('aria-pressed'), 'true');
    assert.ok(rawButton.classList.contains('engaged'), 'selected source view has the shared visible state');
    const composer = app.document.querySelector<HTMLTextAreaElement>('.c-input')!;
    composer.value = '/';
    composer.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    assert.ok(app.document.querySelector('.cmd-menu'));
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await app.flush();
    assert.equal(actions(), null);
    assert.equal(app.document.querySelector('.cmd-menu'), null, 'one capture callback closes both surviving territories');
    assert.ok(reply().querySelector('.raw'), 'Escape closes the actions, never the raw reading mode');
    reply().querySelector<HTMLElement>('.m-meta')!.click();
    await app.flush();
    actions()!.querySelector<HTMLElement>('button:first-child')!.click();
    await app.flush();
    assert.deepEqual(copied, [body], 'copy uses exact source rather than rendered text');
    await app.advance(1499);
    assert.ok(actions());
    await app.advance(1);
    assert.equal(actions(), null);
    const head = app.document.querySelector<HTMLElement>('.s-head')!;
    head.click();
    await app.flush();
    assert.equal(head.getAttribute('aria-expanded'), 'true', 'a stopped run starts folded (#298); the head opens it');
    app.document.querySelector<HTMLElement>('[aria-label="other"] .proj-pick')!.click();
    for (let i = 0; i < 12 && app.document.querySelector('.h1-text')?.textContent !== 'other'; i++) await app.flush();
    assert.equal(reply().querySelector('.raw'), null, 'room reset clears raw without remounting the whole Feed');
    assert.equal(app.document.querySelector('.s-head')?.getAttribute('aria-expanded'), 'true',
      'the same tool group retains its explicit disclosure choice across rooms');
    const link = reply().querySelector<HTMLAnchorElement>('a')!;
    for (const [type, options] of [
      ['click', {}], ['click', { metaKey: true }], ['auxclick', { button: 1 }],
    ] as const) {
      const event = new app.window.MouseEvent(type, { bubbles: true, cancelable: true, ...options });
      link.dispatchEvent(event);
      await app.flush();
      assert.equal(event.defaultPrevented, true);
      assert.equal(actions(), null, 'path routing wins over Copy/Raw toggling');
    }
    assert.deepEqual(routes, Array.from({ length: 3 }, () => ['other', '', '/fixture/source.txt']));
    app.document.querySelector<HTMLElement>('.sys-jump')!.click();
    await app.flush();
    assert.deepEqual(boards, [['other', 7]], 'the feed board row carries the clicked issue id');
  } finally { await app.close(); }
  assert.equal(pushed.size, 0);
});

test('equal message bodies do not share Copied state or its expiry (#167 batch2)', async context => {
  const { rpc } = roomFixture();
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } });
    },
    modules: [{ ...rpc, hubLog: async () => ({ messages: [1, 2].map(id => ({
      id: `copy-${id}`, seq: id, ts: id * 100, from: 'alice', body: 'Same body',
    })), has_more: false }) }],
  });
  try {
    for (let i = 0; i < 12 && app.document.querySelectorAll('.msg').length < 2; i++) await app.flush();
    const rows = app.document.querySelectorAll('.msg');
    rows[0]!.querySelector<HTMLButtonElement>('.m-meta')!.click(); await app.flush();
    rows[0]!.querySelector<HTMLButtonElement>('.m-acts button')!.click(); await app.flush();
    await app.advance(750);
    rows[1]!.querySelector<HTMLButtonElement>('.m-meta')!.click(); await app.flush();
    assert.equal(rows[1]!.querySelector('.m-acts button')?.getAttribute('aria-label'), 'Copy',
      'a different message with identical text has not been copied');
    await app.advance(750);
    assert.ok(rows[1]!.querySelector('.m-acts'), 'the previous message expiry cannot close this row');
  } finally { await app.close(); }
});

test('failed message copy remains retryable and ignores an older clipboard completion (#167 batch2)', async context => {
  const { rpc } = roomFixture();
  const jobs: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.document.execCommand = () => false;
      Object.defineProperty(window.navigator, 'clipboard', { value: {
        writeText: () => new Promise<void>((resolve, reject) => jobs.push({ resolve, reject })),
      } });
    },
    modules: [{ ...rpc, hubLog: async () => ({ messages: [1, 2].map(id => ({
      id: `copy-${id}`, seq: id, ts: id * 100, from: 'alice', body: `Body ${id}`,
    })), has_more: false }) }],
  });
  try {
    for (let i = 0; i < 12 && app.document.querySelectorAll('.msg').length < 2; i++) await app.flush();
    const rows = app.document.querySelectorAll('.msg');
    for (const row of rows) {
      row.querySelector<HTMLButtonElement>('.m-meta')!.click(); await app.flush();
      row.querySelector<HTMLButtonElement>('.m-acts button')!.click(); await app.flush();
    }
    jobs[1]!.reject(new Error('clipboard unavailable')); await app.flush();
    assert.match(app.document.querySelector('.feed-wrap [role=alert]')?.textContent ?? '', /Copy failed/);
    jobs[0]!.resolve(); await app.flush();
    await app.advance(2000);
    assert.match(app.document.querySelector('.feed-wrap [role=alert]')?.textContent ?? '', /Copy failed/);
    assert.equal(rows[1]!.querySelector('.m-acts button')?.getAttribute('aria-label'), 'Copy');
    rows[1]!.querySelector<HTMLButtonElement>('.m-acts button')!.click(); await app.flush();
    jobs[2]!.resolve(); await app.flush();
    assert.equal(app.document.querySelector('.feed-wrap [role=alert]'), null);
    assert.equal(rows[1]!.querySelector('.m-acts button')?.getAttribute('aria-label'), 'Copied');
    await app.advance(1500);
    assert.equal(rows[1]!.querySelector('.m-acts'), null);
  } finally { await app.close(); }
});

test('header path copy reports only a confirmed write and invalidates the previous room (#167 batch2)', async context => {
  const { rpc } = roomFixture();
  const jobs: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.document.execCommand = () => false;
      Object.defineProperty(window.navigator, 'clipboard', { value: {
        writeText: () => new Promise<void>((resolve, reject) => jobs.push({ resolve, reject })),
      } });
    },
    modules: [{ ...rpc, projectList: async () => ({ projects: ['fixture', 'other'].map(session => ({
      project: { id: session, name: session, session, path: '/same-path' }, live: true, slots: [],
    })) }) }],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.chat-head .path'); i++) await app.flush();
    const copy = async () => {
      app.document.querySelector('.chat-head .path')!.dispatchEvent(new app.window.MouseEvent('dblclick', { bubbles: true }));
      await app.flush();
    };
    await copy();
    assert.equal(app.document.querySelector('.header-copy-feedback [role=status]'), null);
    jobs[0]!.reject(new Error('denied')); await app.flush();
    assert.match(app.document.querySelector('.header-copy-feedback [role=alert]')?.textContent ?? '', /Copy failed/);
    await copy(); jobs[1]!.resolve(); await app.flush();
    assert.match(app.document.querySelector('.header-copy-feedback [role=status]')?.textContent ?? '', /Copied/);
    await app.advance(1500);
    assert.equal(app.document.querySelector('.header-copy-feedback'), null);
    await copy();
    app.document.querySelector<HTMLButtonElement>('[aria-label="other"] .proj-pick')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
    jobs[2]!.resolve(); await app.flush();
    assert.equal(app.document.querySelector('.header-copy-feedback'), null, 'same path in another room is a new context');
  } finally { await app.close(); }
});

test('Chat header commands report drawer state and preserve compact navigation (#166)', { timeout: 60000 }, async context => {
  const fixture = await compiledHub();
  for (const compact of [false, true]) {
    const { rpc } = roomFixture();
    const routes: unknown[] = [];
    const app = await fixture.mount(context, {
      props: { visible: true, mobile: compact, openFilesTab: (...args: unknown[]) => routes.push(args) },
      setup(window) { window.Element.prototype.getAnimations = () => []; },
      modules: [{
        ...rpc, fsList: async () => ({ entries: [] }), fsCwd: async () => ({ path: '/fixture' }),
        getPrefs: async () => ({}), getBookmarks: async () => ({ bookmarks: [] }),
        gitCmd: async () => ({ code: 1 }),
      }],
    });
    try {
      for (let i = 0; i < 12 && !app.document.querySelector('.h1-text')?.textContent; i++) await app.flush();
      const files = app.document.querySelector<HTMLButtonElement>('.page-head [aria-label="Files"]')!;
      assert.ok(files.classList.contains('command-button'));
      assert.equal(files.getAttribute('aria-expanded'), compact ? null : 'false');
      assert.equal(files.getAttribute('aria-controls'), null, 'a closed/unmounted drawer has no dangling relationship');
      files.click();
      for (let i = 0; i < 12; i++) await app.flush();
      if (compact) {
        assert.equal(app.document.querySelector('.drawer'), null);
        assert.equal(routes.length, 1, 'phone navigates instead of pretending to disclose a drawer');
      } else {
        assert.equal(files.getAttribute('aria-expanded'), 'true');
        assert.ok(app.document.getElementById(files.getAttribute('aria-controls')!)?.querySelector('.drawer'));
        app.document.querySelector<HTMLButtonElement>('.drawer-head [aria-label="Close"]')!.click();
        for (let i = 0; i < 12; i++) await app.flush();
        assert.equal(files.getAttribute('aria-expanded'), 'false');
      }
    } finally { await app.close(); }
  }
});

test('Chat picker commands retain choice, disabled start and the original spawn intent (#166)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const spawned: unknown[] = [];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    modules: [{
      ...rpc,
      registryList: async () => ({ agents: [{ name: 'helper', backend: 'kiro' }] }),
      hubSpawn: async (...args: unknown[]) => { spawned.push(args); return {}; },
    }],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.roster-add > button'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    await app.flush();
    const start = app.document.querySelector<HTMLButtonElement>('.dlg-actions .command-button.primary')!;
    assert.ok(start);
    assert.ok(start.disabled, 'no selection still means no spawn');
    const choice = app.document.querySelector<HTMLButtonElement>('.dlg-agents .agent-pick')!;
    assert.equal(choice.getAttribute('aria-pressed'), 'false');
    choice.click();
    await app.flush();
    assert.equal(choice.getAttribute('aria-pressed'), 'true');
    assert.equal(start.disabled, false);
    assert.ok(start.querySelector('svg')?.children.length, 'the command uses an existing icon, not a blank glyph');
    start.click();
    await app.flush();
    assert.deepEqual(spawned, [['fixture', 'helper', '', '', '']], 'standalone: no team to join');
    assert.equal(app.document.querySelector('.dlg-agents'), null, 'the existing spawn path closes the picker');
  } finally { await app.close(); }
});

// Board #382: hiring inside a team. The picker offers Join (Standalone or a
// team running here); its default follows the team tab the composer points
// at, and it is a visible choice before confirming.
test('the picker joins the team its tab points at by default, Standalone joins none, and no running team shows no choice (#382)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const spawned: unknown[][] = [];
  let roster: { name: string; window: number; managed: boolean; agent: string; state: string; team: string | null }[] = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', team: 'squad' },
    { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle', team: 'squad/review' },
    { name: 'carol', window: 2, managed: true, agent: 'kiro', state: 'idle', team: 'ops' },
  ];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_hub_lead', JSON.stringify({ fixture: 'team:squad' }));
    },
    modules: [{
      ...rpc,
      hubAgents: async () => ({ agents: roster }),
      registryList: async () => ({ agents: [{ name: 'helper', backend: 'kiro' }] }),
      hubSpawn: async (...args: unknown[]) => { spawned.push(args); return {}; },
    }],
  });
  const join = () => app.document.querySelector<HTMLButtonElement>('[aria-label="Join"]');
  const open = async () => {
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    for (let i = 0; i < 4; i++) await app.flush();
  };
  const go = async () => {
    app.document.querySelector<HTMLButtonElement>('.dlg-agents .agent-pick')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions .command-button.primary')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
  };
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.roster-cluster.team-lit'); i++) await app.flush();
    assert.ok(app.document.querySelector('.roster-cluster[data-team="squad"].team-lit'), 'the composer points at team squad');
    await open();
    assert.equal(join()?.querySelector('.sel-value')?.textContent, 'Team squad', 'the default follows the team tab');
    join()!.click(); await app.flush();
    assert.deepEqual([...app.document.querySelectorAll('[role=option]')].map((o) => o.textContent?.trim()), ['Standalone', 'Team ops', 'Team squad'],
      'standalone, then each team running here, by its root');
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find((o) => o.textContent?.trim() === 'Standalone')!.click();
    await app.flush();
    await go();
    assert.deepEqual(spawned.at(-1), ['fixture', 'helper', '', '', ''], 'Standalone: no team');
    await open();
    assert.equal(join()?.querySelector('.sel-value')?.textContent, 'Team squad', 'the next opening defaults to the tab again');
    await go();
    assert.deepEqual(spawned.at(-1), ['fixture', 'helper', '', '', 'squad'], 'joined to squad');
    roster = roster.map((a) => ({ ...a, team: null }));
    await app.advance(5000);
    await open();
    assert.equal(join(), null, 'no team running here: no choice to make');
    await go();
    assert.deepEqual(spawned.at(-1), ['fixture', 'helper', '', '', '']);
  } finally { await app.close(); }
});

// Reviewer P1-C on 56a3ad44: a confirmed choice is never quietly changed.
// A picked Join stays the Join even when its team stops (the server judges
// it, and its refusal is SAID), and a batch is frozen at confirmation: a
// project switch stops it, so nothing lands in the other project.
test('a picked Join survives its team stopping and the server\'s refusal is shown; an old server\'s refusal too (#382 review)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const spawned: unknown[][] = [];
  let refuse: unknown = null;
  let roster: { name: string; window: number; managed: boolean; agent: string; state: string; team: string | null }[] = [
    { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', team: 'squad' },
  ];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_hub_lead', JSON.stringify({ fixture: 'team:squad' }));
    },
    modules: [{
      ...rpc,
      hubAgents: async () => ({ agents: roster }),
      registryList: async () => ({ agents: [{ name: 'helper', backend: 'kiro' }] }),
      hubSpawn: async (...args: unknown[]) => { spawned.push(args); if (refuse) throw refuse; return { window_name: 'helper', team: args[4] || null }; },
    }],
  });
  const join = () => app.document.querySelector<HTMLButtonElement>('[aria-label="Join"]');
  const feedback = () => app.document.querySelector('.composer-feedback [role="alert"]')?.textContent?.trim() ?? '';
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.roster-cluster.team-lit'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(join()?.querySelector('.sel-value')?.textContent, 'Team squad');
    roster = [];
    await app.advance(5000);
    assert.equal(join()?.querySelector('.sel-value')?.textContent, 'Team squad', 'the team stopped while the picker was open: the choice stays what was picked');
    refuse = new Error("team 'squad' has no member in this project — start the team first, or spawn the agent standalone");
    app.document.querySelector<HTMLButtonElement>('.dlg-agents .agent-pick')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions .command-button.primary')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.deepEqual(spawned.at(-1), ['fixture', 'helper', '', '', 'squad'], 'sent as picked, never as Standalone');
    assert.match(feedback(), /Could not start helper: team 'squad' has no member in this project/u, 'the refusal is said where the person is looking');

    roster = [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', team: 'squad' }];
    await app.advance(5000);
    refuse = Object.assign(new Error('too old'), { code: 'server_too_old' });
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    for (let i = 0; i < 4; i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-agents .agent-pick')!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions .command-button.primary')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.match(feedback(), /Could not start helper: This server is older than the app\. Update the server to start an agent inside a team\./u);
  } finally { await app.close(); }
});

test('a batch is frozen at confirmation: a project switch stops it, and nothing lands in the other project (#382 review)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const spawned: unknown[][] = [];
  let release!: () => void;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_hub_lead', JSON.stringify({ fixture: 'team:squad', other: 'carol' }));
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({ project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [] })) }),
      hubAgents: async (session: string) => ({ agents: session === 'fixture'
        ? [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', team: 'squad' }]
        : [{ name: 'carol', window: 0, managed: true, agent: 'kiro', state: 'idle', team: null }] }),
      registryList: async () => ({ agents: [{ name: 'one', backend: 'kiro' }, { name: 'two', backend: 'kiro' }] }),
      hubSpawn: (...args: unknown[]) => { spawned.push(args); return args[1] === 'one' ? new Promise((yes) => { release = () => yes({ window_name: 'one', team: 'squad' }); }) : Promise.resolve({ window_name: String(args[1]) }); },
    }],
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.roster-cluster.team-lit'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    await settle(4);
    for (const row of app.document.querySelectorAll<HTMLButtonElement>('.dlg-agents .agent-pick')) row.click();
    await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions .command-button.primary')!.click();
    await settle(4);
    assert.deepEqual(spawned, [['fixture', 'one', '', '', 'squad']], 'the first spawn is out and has not answered');
    app.document.querySelector<HTMLElement>('[aria-label="other"] .proj-pick')!.click();
    for (let i = 0; i < 20 && app.document.querySelector('.h1-text')?.textContent !== 'other'; i++) await app.flush();
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'other');
    // In other, the person opens the picker and starts a draft of their own.
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    await settle(4);
    const brief = app.document.querySelector<HTMLInputElement>('.pick-brief')!;
    brief.value = 'for other';
    brief.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    app.document.querySelector<HTMLButtonElement>('.dlg-agents .agent-pick')!.click();
    await app.flush();
    release();
    await settle();
    assert.deepEqual(spawned, [['fixture', 'one', '', '', 'squad']], 'the rest of the batch stopped: nothing was spawned into other, and nothing with the other join');
    assert.equal(selectedCard(app.document), 'carol', 'and other\'s recipient is untouched');
    assert.equal(app.document.querySelector<HTMLInputElement>('.pick-brief')?.value, 'for other', 'the old batch ending does not wipe the new project\'s draft');
    assert.equal(app.document.querySelector('.dlg-agents .agent-pick')?.getAttribute('aria-pressed'), 'true', 'nor its pick');
  } finally { await app.close(); }
});

// Reviewer P1 on a4f0d9d7: the Join is the value of ONE confirmed picker
// submission. A cancelled picker leaves nothing behind, a reopened picker
// starts from the tab's default, and the empty room's one-tap start is
// always standalone.
// The add button stays enabled while a batch starts, so the picker CAN be
// reopened in the same project mid-batch: the old batch ending must not
// wipe that new opening's draft (reviewer P2 on 90b7c4e3, found reachable).
test('a picker reopened in the same project while a batch starts keeps its draft when the batch ends (#382 review)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const spawned: unknown[][] = [];
  let release!: () => void;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.localStorage.setItem('tmux_hub_project', 'fixture'); },
    modules: [{
      ...rpc,
      registryList: async () => ({ agents: [{ name: 'one', backend: 'kiro' }, { name: 'two', backend: 'kiro' }] }),
      hubSpawn: (...args: unknown[]) => { spawned.push(args); return args[1] === 'one' ? new Promise((yes) => { release = () => yes({ window_name: 'one' }); }) : Promise.resolve({ window_name: String(args[1]) }); },
    }],
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  const rows = () => [...app.document.querySelectorAll<HTMLButtonElement>('.dlg-agents .agent-pick')];
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.roster-add > button'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    await settle(4);
    rows()[0]!.click(); await app.flush();
    app.document.querySelector<HTMLButtonElement>('.dlg-actions .command-button.primary')!.click();
    await settle(4);
    assert.equal(spawned.length, 1, 'the batch is starting');
    const add = app.document.querySelector<HTMLButtonElement>('.roster-add > button')!;
    assert.equal(add.disabled, false, 'the add button stays enabled meanwhile: a reopen is reachable');
    add.click();
    await settle(4);
    const brief = app.document.querySelector<HTMLInputElement>('.pick-brief')!;
    brief.value = 'second draft';
    brief.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    rows()[1]!.click(); await app.flush();
    release();
    await settle();
    assert.equal(app.document.querySelector<HTMLInputElement>('.pick-brief')?.value, 'second draft', 'the new opening\'s brief survives the old batch');
    assert.equal(rows()[1]?.getAttribute('aria-pressed'), 'true', 'and its pick');
  } finally { await app.close(); }
});

test('a cancelled Join leaves nothing behind: the next picker starts from the tab, and a one-tap start elsewhere is standalone (#382 review)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const spawned: unknown[][] = [];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_hub_lead', JSON.stringify({ fixture: 'team:squad' }));
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: ['fixture', 'empty'].map((session) => ({ project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [] })) }),
      hubAgents: async (session: string) => ({ agents: session === 'fixture'
        ? [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', team: 'squad' }, { name: 'carol', window: 1, managed: true, agent: 'kiro', state: 'idle', team: 'ops' }]
        : [] }),
      registryList: async () => ({ agents: [{ name: 'helper', backend: 'kiro' }] }),
      hubSpawn: async (...args: unknown[]) => { spawned.push(args); return { window_name: 'helper' }; },
    }],
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  const join = () => app.document.querySelector<HTMLButtonElement>('[aria-label="Join"]');
  const pick = async (label: string) => {
    join()!.click(); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')].find((o) => o.textContent?.trim() === label)!.click();
    await app.flush();
  };
  const open = async () => { app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click(); await settle(4); };
  const cancel = async () => { [...app.document.querySelectorAll<HTMLButtonElement>('.dlg-actions button')].find((b) => b.textContent?.trim() === 'Cancel')!.click(); await settle(4); };
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.roster-cluster.team-lit'); i++) await app.flush();
    await open();
    await pick('Team ops');
    await cancel();
    await open();
    assert.equal(join()?.querySelector('.sel-value')?.textContent, 'Team squad', 'reopened: the tab\'s default, not the cancelled choice');
    await pick('Team ops');
    await cancel();
    app.document.querySelector<HTMLElement>('[aria-label="empty"] .proj-pick')!.click();
    for (let i = 0; i < 20 && !app.document.querySelector('.start-row'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.start-row')!.click();
    await settle();
    assert.deepEqual(spawned, [['empty', 'helper', '', '', '']], 'the empty room\'s one-tap start is standalone, whatever a picker held');
  } finally { await app.close(); }
});

// Reviewer P2 on b4f01642: a team start keeps the mode it was started in.
// The empty room's one-tap team start is a START (its first member leads);
// opening the picker in Add mode while it starts must not take that away.
test('a team started from the empty room leads with its first member, though the picker was opened in Add mode meanwhile (#382 follow-up)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  let roster: unknown[] = [];
  let release!: () => void;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_hub_lead', JSON.stringify({ fixture: 'dev' }));
    },
    modules: [{
      ...rpc,
      hubAgents: async () => ({ agents: roster }),
      teamsList: async () => ({ teams: [{ name: 'squad', description: '', members: JSON.stringify([{ name: 'lead' }, { name: 'dev' }]) }] }),
      registryList: async () => ({ agents: [{ name: 'helper', backend: 'kiro' }] }),
      hubSpawnTeam: () => new Promise((yes) => { release = () => {
        roster = [
          { name: 'lead', window: 1, managed: true, agent: 'kiro', state: 'idle', team: 'squad' },
          { name: 'dev', window: 2, managed: true, agent: 'kiro', state: 'idle', team: 'squad' },
        ];
        yes({ team: 'squad', spawned: [{ name: 'lead', window_name: 'lead' }, { name: 'dev', window_name: 'dev' }], errors: [] });
      }; }),
    }],
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.start-row.team'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.start-row.team')!.click();
    await settle(4);
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    await settle(4);
    assert.ok(app.document.querySelector('.dlg-agents'), 'the picker is open, in Add mode');
    release();
    await settle();
    assert.equal(selectedCard(app.document), 'lead', 'the started team\'s first member leads, not the stored lead the roster would pick');
  } finally { await app.close(); }
});

// Board #384: moving a running agent between teams at runtime. The card
// menu carries the drag's form for touch and keyboard; a member its team's
// definition places has none; a server without agent_team shows them
// disabled; a drag on a fine pointer lands in the same verb.
// The drag end to end, Roster -> Hub: jsdom has no layout, so each drop
// target's box is given by its `data-drop` key, one row: squad | ops.
const dropBoxes = (window: any) => {
  const boxes: Record<string, [number, number]> = { squad: [0, 200], ops: [210, 400] };
  window.Element.prototype.animate = () => ({ cancel() {}, finish() {}, onfinish: null, finished: Promise.resolve() });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const box = this.classList.contains('cards') ? [0, 1000] as [number, number] : boxes[this.dataset.drop ?? ''];
    const [left, right] = box ?? [0, 0];
    return { left, right, top: 0, bottom: box ? 60 : 0, width: right - left, height: box ? 60 : 0, x: left, y: 0, toJSON() {} };
  };
};
function moveFixture(context: TestContext, caps: string[] | undefined, extra: Record<string, (...args: any[]) => unknown> = {}, layout?: (window: any) => void) {
  const { rpc } = roomFixture();
  const moves: unknown[][] = [];
  const roster = [
    { name: 'lead', window: 0, managed: true, agent: 'kiro', state: 'idle', team: 'squad', joined: false },
    { name: 'helper', window: 1, managed: true, agent: 'kiro', state: 'idle', team: 'squad', joined: true },
    { name: 'solo', window: 2, managed: true, agent: 'codex', state: 'idle', team: null },
    { name: 'ops1', window: 3, managed: true, agent: 'kiro', state: 'idle', team: 'ops', joined: false },
  ];
  return compiledHub().then((fixture) => fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      layout?.(window);
    },
    modules: [{
      ...rpc,
      getCaps: () => caps,
      onCaps: () => undefined,
      hubAgents: async () => ({ agents: roster }),
      hubAgentSetTeam: async (...args: unknown[]) => { moves.push(args); return { agent: args[1], team: args[2] || null, left: null, changed: true }; },
      ...extra,
    }],
  })).then((app) => ({ app, moves }));
}
async function cardMenu(app: { document: Document; window: any; flush: () => Promise<void> }, name: string) {
  for (let i = 0; i < 20 && !stripCard(app.document, name); i++) await app.flush();
  stripCard(app.document, name).querySelector('.agent-select')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
  await app.flush();
  return [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')];
}
const closeMenu = async (app: { window: any; flush: () => Promise<void> }) => {
  app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await app.flush();
};

test('the card menu moves a solo or joined agent between running teams; a definition member has no Move item (#384)', { timeout: 60000 }, async (context) => {
  const { app, moves } = await moveFixture(context, ['board_dispatch', 'spawn_join', 'agent_team']);
  const labels = (items: HTMLButtonElement[]) => items.map((b) => b.textContent?.trim()).filter((l) => /team/u.test(l ?? ''));
  try {
    assert.deepEqual(labels(await cardMenu(app, 'solo')), ['Move to team ops', 'Move to team squad'], 'a solo agent: every running team');
    await closeMenu(app);
    assert.deepEqual(labels(await cardMenu(app, 'helper')), ['Move to team ops', 'Leave team squad'], 'a joiner: the other teams, and leave its own');
    await closeMenu(app);
    assert.deepEqual(labels(await cardMenu(app, 'lead')), [], 'a member its team\'s definition places: none (Teams editor)');
    await closeMenu(app);
    const items = await cardMenu(app, 'helper');
    items.find((b) => b.textContent?.trim() === 'Leave team squad')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(moves, [['fixture', 'helper', '']], 'leave = team ""');
    (await cardMenu(app, 'solo')).find((b) => b.textContent?.trim() === 'Move to team squad')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(moves.at(-1), ['fixture', 'solo', 'squad']);
  } finally { await app.close(); }
});

test('on a server without agent_team the Move items are disabled and say why, a drag carries nothing, and nothing is sent (#384)', { timeout: 60000 }, async (context) => {
  const { app, moves } = await moveFixture(context, ['board_dispatch', 'spawn_join'], {}, dropBoxes);
  try {
    for (let i = 0; i < 20 && !stripCard(app.document, 'solo'); i++) await app.flush();
    for (let i = 0; i < 8; i++) await app.flush();
    const card = stripCard(app.document, 'solo').querySelector('.agent-select')!;
    const at = (type: string, x: number) => card.dispatchEvent(new app.window.PointerEvent(type,
      { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: 30 }));
    at('pointerdown', 450);
    for (const x of [100, 100]) { at('pointermove', x); await app.flush(); }
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'the card is not carried');
    at('pointerup', 100);
    for (let i = 0; i < 4; i++) await app.flush();
    assert.deepEqual(moves, [], 'the drag sent nothing');
    const items = (await cardMenu(app, 'solo')).filter((b) => /Move to team/u.test(b.textContent ?? ''));
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal(item.disabled || item.getAttribute('aria-disabled') === 'true', true, 'disabled');
      assert.match(item.getAttribute('title') ?? '', /Update the server to move an agent between teams/u);
      assert.equal(item.querySelector('.ctx-hint')?.textContent, 'update the server', 'the reason is on the item, not only in a tooltip');
    }
    items[0]!.click();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.deepEqual(moves, [], 'nothing sent');
  } finally { await app.close(); }
});

test('a card dragged onto a team moves it; a definition member\'s drop says where to change it and sends nothing (#384)', { timeout: 60000 }, async (context) => {
  const { app, moves } = await moveFixture(context, ['board_dispatch', 'spawn_join', 'agent_team'], {}, dropBoxes);
  const drag = async (name: string, from: number, to: number) => {
    for (let i = 0; i < 20 && !stripCard(app.document, name); i++) await app.flush();
    for (let i = 0; i < 8; i++) await app.flush(); // the room is ready (canMove) a few turns after its cards
    const el = stripCard(app.document, name).querySelector('.agent-select')!;
    const at = (type: string, x: number) => el.dispatchEvent(new app.window.PointerEvent(type,
      { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: 30 }));
    at('pointerdown', from);
    at('pointermove', to);
    await app.flush();
    at('pointermove', to);
    await app.flush();
    at('pointerup', to);
    for (let i = 0; i < 8; i++) await app.flush();
  };
  try {
    await drag('lead', 100, 300);
    assert.deepEqual(moves, [], 'a definition member is not sent');
    assert.match(app.document.querySelector('.composer-feedback [role="alert"]')?.textContent ?? '',
      /lead is in team squad by its definition\. Change it in Agents > Teams\./u);
    await drag('solo', 450, 100);
    assert.deepEqual(moves, [['fixture', 'solo', 'squad']], 'the drop lands in the menu\'s one verb');
  } finally { await app.close(); }
});

test('on a phone the disabled Move items say why on the item itself: a touch screen has no tooltip (#384, validator F1)', { timeout: 60000 }, async (context) => {
  const { rpc } = roomFixture();
  const roster = [
    { name: 'lead', window: 0, managed: true, agent: 'kiro', state: 'idle', team: 'squad', joined: false },
    { name: 'solo', window: 2, managed: true, agent: 'codex', state: 'idle', team: null },
  ];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, mobile: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      const media = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => Object.assign(media(query), { matches: query === '(max-width: 760px)' || query === '(any-pointer: coarse)' || query === '(pointer: coarse)' });
    },
    modules: [{ ...rpc, getCaps: () => ['board_dispatch', 'spawn_join'], hubAgents: async () => ({ agents: roster }), hubAgentSetTeam: async () => { throw new Error('must not be sent'); } }],
  });
  try {
    for (let i = 0; i < 20 && !stripCard(app.document, 'solo'); i++) await app.flush();
    const items = (await cardMenu(app, 'solo')).filter((b) => /Move to team/u.test(b.textContent ?? ''));
    assert.equal(items.length, 1);
    assert.equal(items[0]!.disabled, true);
    assert.equal(items[0]!.querySelector('.ctx-hint')?.textContent, 'update the server', 'a visible reason');
  } finally { await app.close(); }
});

test('a drag belongs to the project and page it was pressed in: released after a switch (or A -> B -> A, a hidden page, a lost focus, a lost cap) it moves nothing (#384, P1-A)', { timeout: 60000 }, async (context) => {
  let capsCb: ((caps: string[] | undefined) => void) | undefined;
  const { app, moves } = await moveFixture(context, ['board_dispatch', 'spawn_join', 'agent_team'], {
    projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
      project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
    })) }),
    onCaps: (cb: (caps: string[] | undefined) => void) => { capsCb = cb; },
  }, dropBoxes);
  const settle = async (n = 8) => { for (let i = 0; i < n; i++) await app.flush(); };
  const card = () => stripCard(app.document, 'solo').querySelector<HTMLElement>('.agent-select')!;
  const at = (el: EventTarget, type: string, x: number) => el.dispatchEvent(new app.window.PointerEvent(type,
    { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: 30 }));
  const carry = async () => {
    for (let i = 0; i < 20 && !stripCard(app.document, 'solo'); i++) await app.flush();
    await settle();
    const el = card();
    at(el, 'pointerdown', 450);
    for (const x of [100, 100]) { at(el, 'pointermove', x); await app.flush(); }
    assert.equal(app.document.querySelector('.roster-cluster.drop-target')?.getAttribute('data-drop'), 'squad', 'carried over squad');
    return el;
  };
  const room = async (name: string) => {
    app.document.querySelector<HTMLElement>(`[aria-label="${name}"] .proj-pick`)!.click();
    for (let i = 0; i < 20 && app.document.querySelector('.h1-text')?.textContent !== name; i++) await app.flush();
    assert.equal(app.document.querySelector('.h1-text')?.textContent, name);
  };
  const release = async () => { at(app.window, 'pointerup', 100); await settle(); };
  try {
    // The fixture can move at all: a steady drag lands.
    const el = await carry();
    at(el, 'pointerup', 100);
    await settle();
    assert.deepEqual(moves, [['fixture', 'solo', 'squad']], 'a steady drag moves');
    moves.length = 0;

    await carry();
    await room('other');
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'the switch cancels the drag');
    await release();
    assert.deepEqual(moves, [], 'a release after a switch moves nothing in B');

    await room('fixture');
    await carry();
    await room('other');
    await room('fixture');
    at(card(), 'pointermove', 100);
    await release();
    assert.deepEqual(moves, [], 'nor after A -> B -> A: the old gesture is not revived');

    await carry();
    await app.setProps({ visible: false });
    await release();
    await app.setProps({ visible: true });
    assert.deepEqual(moves, [], 'nor from a hidden page');

    // Displayed but no longer the focus: the host moved focus to another
    // server and this tree is only revealed (reviewer P2: visible is not
    // the whole eligibility).
    await carry();
    await app.setScope({ eligible: false });
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'losing the focus cancels the drag');
    await release();
    assert.deepEqual(moves, [], 'nor from a tree that is visible but not eligible');
    await app.setScope({ eligible: true });

    await carry();
    capsCb!(['board_dispatch', 'spawn_join']);
    await release();
    assert.deepEqual(moves, [], 'nor once the server lost agent_team');
  } finally { await app.close(); }
});

test('a server refusal of a move is said in the composer feedback slot (#384)', { timeout: 60000 }, async (context) => {
  const { app } = await moveFixture(context, ['agent_team'], {
    hubAgentSetTeam: async () => { throw new Error("team 'squad' has no member in this project — start the team first, or spawn the agent standalone"); },
  });
  try {
    (await cardMenu(app, 'solo')).find((b) => b.textContent?.trim() === 'Move to team squad')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.match(app.document.querySelector('.composer-feedback [role="alert"]')?.textContent ?? '', /Could not move solo: team 'squad' has no member/u);
  } finally { await app.close(); }
});

test('Start a team: every row is avatar, name, action; the team avatar draws a glyph and the action holds one line (#341)', { timeout: 60000 }, async context => {
  const { rpc } = roomFixture();
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true },
    modules: [{
      ...rpc,
      registryList: async () => ({ agents: [{ name: 'helper', backend: 'kiro' }] }),
      teamsList: async () => ({ teams: [
        { name: 'content-creator-team', description: '', members: JSON.stringify([{ name: 'lead' }, { name: 'writer' }, { name: 'researcher' }, { name: 'review-reader' }, { team: 'review' }]) },
        { name: 'dev', description: '', members: JSON.stringify([{ name: 'lead' }, { name: 'rust-dev' }]) },
      ] }),
    }],
  });
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.roster-add > button'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.roster-add > button')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
    const rows = [...app.document.querySelectorAll<HTMLElement>('.dlg-agents .agent-pick')];
    assert.equal(rows.length, 3, 'two teams and one agent');
    for (const row of rows) {
      assert.ok(row.children[0]!.classList.contains('ava'), `${row.textContent?.trim().slice(0, 20)}: the avatar leads`);
      assert.ok(row.children[1]!.classList.contains('ap-name'), 'then the one name column');
      assert.ok(row.children[1]!.textContent!.trim().length > 2, 'which holds the text');
    }
    const teams = rows.filter((r) => r.classList.contains('team'));
    assert.equal(teams.length, 2);
    for (const row of teams) {
      const glyph = row.querySelector('.ava svg');
      assert.ok(glyph?.children.length, 'the team avatar draws an icon; an unknown name renders an empty box (the owner\u2019s screenshot)');
      assert.deepEqual([...row.children].map((c) => c.classList.contains('ap-go') ? 'go' : c.classList.contains('ap-name') ? 'name' : 'avatar'), ['avatar', 'name', 'go'], 'avatar, name, action: the action is the last column and never inside the name');
      assert.equal(row.querySelector('.ap-go')!.textContent!.trim(), 'Start team');
    }
    assert.equal(rows.at(-1)!.querySelector('.ap-go'), null, 'an agent row has no action column');
  } finally { await app.close(); }
});

test('Feed observes its box once across data updates and releases the observer on unmount', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc, pushed } = roomFixture();
  const observers: Array<{ targets: Set<Element>; disconnected: boolean; fire: () => void }> = [];
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.document.hasFocus = () => true;
      Object.assign(window, {
        ResizeObserver: class {
          targets = new Set<Element>();
          disconnected = false;
          fire: () => void;
          constructor(callback: ResizeObserverCallback) {
            // This spy proves registration/scheduling, not browser geometry.
            this.fire = () => callback([], this as unknown as ResizeObserver);
            observers.push(this);
          }
          observe(target: Element) { this.targets.add(target); }
          unobserve(target: Element) { this.targets.delete(target); }
          disconnect() { this.disconnected = true; this.targets.clear(); }
        },
      });
    },
    modules: [rpc],
  });
  let owner: typeof observers[number] | undefined;
  try {
    for (let i = 0; i < 10 && !selectedCard(app.document); i++) await app.flush();
    const feed = app.document.querySelector('.feed')!;
    const owning = observers.filter((observer) => observer.targets.has(feed));
    assert.equal(owning.length, 1);
    owner = owning[0]!;
    owner.fire();
    await app.flush();
    const message = app.window.JSON.parse(JSON.stringify({
      id: 'new', seq: 1, room: 'proj:fixture', from: 'alice', ts: Date.now(), body: 'A new reply.',
    }));
    for (const listener of pushed) (listener as (message: unknown) => void)(message);
    for (let i = 0; i < 10 && !app.document.querySelector('.msg'); i++) await app.flush();
    assert.ok(app.document.querySelector('.msg'));
    assert.deepEqual(observers.filter((observer) => observer.targets.has(feed)), [owner],
      'data changes update the snapshot, not the observer lifetime');
    assert.equal(owner.disconnected, false);
  } finally { await app.close(); }
  assert.equal(owner?.disconnected, true);
  assert.equal(pushed.size, 0);
});

test('Feed settles image load/error before reapplying live tail intent', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) { window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{
      ...rpc,
      hubLog: async () => ({ messages: [
        { id: 'image', seq: 1, ts: 100, from: 'alice', body: '![](/fixture/chart.png)' },
      ], has_more: false }),
      fsDownloadHttp: async () => ({ url: 'https://mount.test/chart.png' }),
    }],
  });
  try {
    for (let i = 0; i < 10; i++) await app.flush();
    const feed = app.document.querySelector<HTMLElement>('.feed')!;
    const image = feed.querySelector<HTMLImageElement>('.ci')!;
    assert.ok(image);
    // Observe the write and DOM-update order only. jsdom supplies no image
    // dimensions; cold/cached pixel gaps and history intent belong to Chromium.
    // Each tail write records what the image slot showed at that moment:
    // the picture, the grey reference (a re-sign in flight, board #175), or
    // the warn-coloured failed reference.
    const writes: string[] = [];
    Object.defineProperty(feed, 'scrollTop', {
      configurable: true, get: () => 0,
      set: () => { writes.push(feed.querySelector('.ci-ref.failed') ? 'failed' : feed.querySelector('.ci-ref') ? 'pending' : 'image'); },
    });
    image.dispatchEvent(new app.window.Event('load'));
    assert.deepEqual(writes, [], 'the capture handler must wait for the component update');
    await app.flush();
    assert.ok(writes.length > 0, 'a loaded image reapplies the live tail');
    assert.ok(writes.every((w) => w === 'image'));
    writes.length = 0;
    // First error: the signature is re-minted once (board #175) — the slot
    // shows the grey reference while the new url is fetched.
    image.dispatchEvent(new app.window.Event('error'));
    assert.deepEqual(writes, []);
    await app.flush();
    assert.ok(writes.length > 0, 'a failed load also changes the content height');
    assert.ok(writes.every((w) => w === 'pending'), 'the re-sign fallback is rendered before measuring/writing the tail');
    for (let i = 0; i < 4; i++) await app.flush();
    const retried = feed.querySelector<HTMLImageElement>('.ci')!;
    assert.ok(retried, 'the re-signed image mounts');
    writes.length = 0;
    // Second error: the file is unreachable — the failed reference, no loop.
    retried.dispatchEvent(new app.window.Event('error'));
    assert.deepEqual(writes, []);
    await app.flush();
    assert.ok(writes.length > 0);
    assert.ok(writes.every((w) => w === 'failed'), 'the failed fallback is rendered before measuring/writing the tail');
  } finally { await app.close(); }
});

test('Files opened from a project Chat starts at the DECLARED project path, not the active pane cwd (board #181)', { timeout: 60000 }, async context => {
  // Owner, 2026-09-12: "你应该默认从我们选定的项目路径去跑". fs_cwd answers with
  // whatever pane happens to be active in tmux (a worktree here); the project
  // declares /declared. Declaration over pane accident (tenets 7/9).
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const listed: string[] = [];
  const stated: string[] = [];
  const routes: unknown[][] = [];
  const mountHub = (mobile: boolean) => fixture.mount(context, {
    props: { visible: true, mobile, openFilesTab: (...args: unknown[]) => routes.push(args) },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: [{ project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/declared' }, live: true, slots: [] }] }),
      hubLog: async () => ({ messages: [{ id: 'm1', seq: 1, ts: 100, from: 'alice', body: 'see [the plan](docs/plan.md)' }], has_more: false }),
      fsCwd: async () => ({ path: '/pane/worktree' }),
      fsList: async (path: string) => { listed.push(path); return { path, entries: path === '/declared' ? [{ name: 'docs', path: '/declared/docs', type: 'dir', size: 0 }] : [] }; },
      fsStat: async (path: string) => { stated.push(path); return { path, is_text: true, readable: true, writable: false, size: 1, mime_hint: 'text/markdown' }; },
      fsRead: async () => ({ content: '# plan' }),
      // The preview is in the project, so its review cards are read (#434).
      reviewList: async () => ({ project_id: 'fixture', path: '/declared/docs/plan.md', revision: '', annotations: [] }),
      getPrefs: async () => ({}), setPref: async () => ({}), getBookmarks: async () => ({ bookmarks: [] }), gitCmd: async () => ({ code: 1 }),
    }],
  });
  const app = await mountHub(false);
  try {
    const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
    for (let i = 0; i < 12 && !app.document.querySelector('.h1-text')?.textContent; i++) await app.flush();
    const files = () => app.document.querySelector<HTMLButtonElement>('.page-head [aria-label="Files"]')!;
    // 1. Open Files: the first listing is the declared path.
    files().click();
    await settle();
    assert.ok(app.document.querySelector('.drawer .file-list'), 'the Files partition opened');
    assert.equal(listed[0], '/declared', `first listing is the project path, got ${listed.join(' → ')}`);
    assert.ok(!listed.includes('/pane/worktree'), 'the pane cwd is never the default');
    // 2. Browse into docs, close, reopen: the parked position still wins.
    app.document.querySelector<HTMLButtonElement>('.drawer .file-row .file-main')!.click();
    await settle();
    assert.equal(listed.at(-1), '/declared/docs');
    // Closing withdraws over moveMs (#174): the Drawer unmounts — and parks
    // its position — only after the move.
    const close = async () => { files().click(); await settle(); await app.advance(400); await settle(); };
    await close();
    assert.equal(app.document.querySelector('.drawer'), null);
    listed.length = 0;
    files().click(); await settle();       // reopen
    assert.equal(listed[0], '/declared/docs', 'a parked browse position wins over the default (file-handling.md)');
    assert.ok(!listed.includes('/declared'), 'and the default does not yank it back');
    await close();
    // 3. A relative path reference in chat resolves against the project path.
    const link = app.document.querySelector<HTMLAnchorElement>('.feed a[href="docs/plan.md"]')!;
    assert.ok(link, 'the relative reference rendered as a link');
    link.click();
    await settle();
    assert.equal(stated.at(-1), '/declared/docs/plan.md', `relative refs resolve against the project, got ${stated.join(' → ')}`);
  } finally { await app.close(); }
  // 4. The phone route hands the declared path to the Files page.
  const phone = await mountHub(true);
  try {
    for (let i = 0; i < 12 && !phone.document.querySelector('.h1-text')?.textContent; i++) await phone.flush();
    phone.document.querySelector<HTMLButtonElement>('.page-head [aria-label="Files"]')!.click();
    for (let i = 0; i < 6; i++) await phone.flush();
    assert.deepEqual(routes.at(-1), ['fixture', '/declared'], 'compact: the page is asked to start at the project path');
  } finally { await phone.close(); }
});

test('a global font change re-takes the tail through the reading anchor; a history reader keeps row and offset (board #189)', { timeout: 60000 }, async context => {
  // Measured in Chromium (390×844, 24 messages): uiFont.set("DejaVu Sans Mono")
  // grew scrollHeight 2563 → 2795 while scrollTop stayed 1839 — a 232 px gap
  // under a feed that still believed it was following; document.fonts fired
  // nothing (a system family), the container did not resize, no block changed.
  const { rpc } = roomFixture();
  const messages = Array.from({ length: 24 }, (_, i) => ({ id: 'm' + i, seq: i + 1, ts: 100 + i, from: i % 2 ? 'alice' : 'human', body: 'line ' + i }));
  const app = await compiledHub().then(f => f.mount(context, {
    props: { visible: true, mobile: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{ ...rpc, hubLog: async () => ({ messages, has_more: false }) }],
  }));
  try {
    for (let i = 0; i < 12 && app.document.querySelectorAll('.msg').length < 24; i++) await app.flush();
    const feed = app.document.querySelector<HTMLElement>('.feed')!;
    let sh = 2563;
    Object.defineProperty(feed, 'scrollHeight', { get: () => sh, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { get: () => 724, configurable: true });
    Object.defineProperty(feed, 'clientWidth', { get: () => 390, configurable: true }); // readingSize() needs a real box
    // Following, at the tail.
    feed.scrollTop = sh - 724;
    feed.dispatchEvent(new app.window.Event('scroll'));
    await app.flush();
    // The font swap: every bubble re-wraps, the content grows, nothing else moves.
    sh = 2795;
    app.document.dispatchEvent(new app.window.CustomEvent('tmux:font'));
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(feed.scrollTop, sh, `the tail is re-taken through the reading anchor (gap ${sh - 724 - feed.scrollTop})`);
    // A history reader: far above the tail, the same swap must return them to
    // the SAME ROW at the SAME OFFSET (codex's P2 on the first cut: "not the
    // tail" alone proved nothing about the row). jsdom lays nothing out, so
    // give every row a box: 100 px each before the swap, 120 px after — the
    // shape the live measurement showed (rows grow, the reference row's
    // offset stays; −71 px → −71 px at 390 with DejaVu Sans Mono).
    let rowH = 100;
    const rows = [...feed.children] as HTMLElement[];
    rows.forEach((row, i) => {
      Object.defineProperty(row, 'offsetTop', { get: () => i * rowH, configurable: true });
      Object.defineProperty(row, 'offsetHeight', { get: () => rowH, configurable: true });
    });
    feed.scrollTop = 330;                      // inside row 3 (300–400), 30 px into it
    feed.dispatchEvent(new app.window.Event('scroll'));
    for (let i = 0; i < 4; i++) await app.flush();
    rowH = 120; sh = 3000;                     // the swap: every row taller
    app.document.dispatchEvent(new app.window.CustomEvent('tmux:font'));
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(feed.scrollTop, 3 * 120 + 30, 'the reader is back on row 3, 30 px into it — same row, same offset');
    assert.notEqual(feed.scrollTop, sh, 'and nowhere near the tail');
  } finally { await app.close(); }
});

test('focusing the composer is not navigation: a history reader keeps their place (board #303)', { timeout: 60000 }, async context => {
  // Owner 2026-10-03: reading an earlier reply while typing the answer to it;
  // the composer's focus used to force `following` and park the feed at the tail.
  const { rpc } = roomFixture();
  const messages = Array.from({ length: 24 }, (_, i) => ({ id: 'm' + i, seq: i + 1, ts: 100 + i, from: i % 2 ? 'alice' : 'human', body: 'line ' + i }));
  const app = await compiledHub().then(f => f.mount(context, {
    props: { visible: true, mobile: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{ ...rpc, hubLog: async () => ({ messages, has_more: false }) }],
  }));
  try {
    for (let i = 0; i < 12 && app.document.querySelectorAll('.msg').length < 24; i++) await app.flush();
    const feed = app.document.querySelector<HTMLElement>('.feed')!;
    Object.defineProperty(feed, 'scrollHeight', { get: () => 2563, configurable: true });
    Object.defineProperty(feed, 'clientHeight', { get: () => 724, configurable: true });
    Object.defineProperty(feed, 'clientWidth', { get: () => 390, configurable: true });
    feed.scrollTop = 330;
    feed.dispatchEvent(new app.window.Event('scroll'));
    for (let i = 0; i < 4; i++) await app.flush();
    assert.ok(app.document.querySelector('.to-tail'), 'the reader is off the tail');
    app.document.querySelector<HTMLTextAreaElement>('.c-input')!.focus();
    await app.advance(400);
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(feed.scrollTop, 330, 'focus leaves the reading position where it was');
    assert.ok(app.document.querySelector('.to-tail'), 'and the feed still knows it is not following');
  } finally { await app.close(); }
});

// ── Board #258: group verbs on All and on a team name ─────────────────────
async function groupFixture(context: TestContext, extra: Record<string, (...args: any[]) => unknown>, openAgentConfig?: (name: string, kind?: string) => void) {
  const { rpc } = roomFixture();
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, ...(openAgentConfig ? { openAgentConfig } : {}) },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: [{
        project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/fixture' }, live: true,
        slots: [{ window_name: 'qa', kind: 'agent', command: 'kiro' }, { window_name: 'loner', kind: 'agent', command: 'codex' }],
      }] }),
      hubAgents: async () => ({
        agents: [
          { name: 'lead', window: 0, managed: true, agent: 'kiro', state: 'running', team: 'squad' },
          { name: 'dev', window: 1, managed: true, agent: 'kiro', state: 'idle', team: 'squad/sub' },
          { name: 'solo', window: 2, managed: true, agent: 'codex', state: 'idle' },
        ],
        stopped_teams: { qa: 'squad' },
      }),
      ...extra,
    }],
  });
  for (let i = 0; i < 30 && !app.document.querySelector('.team-label'); i++) await app.flush();
  const labels = () => [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')].map((b) => b.textContent?.trim());
  const pick = async (label: string) => {
    [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')].find((b) => b.textContent?.trim() === label)!.click();
    await app.flush();
  };
  const context_ = async (el: Element) => {
    el.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await app.flush();
  };
  return { ...app, labels, pick, contextmenu: context_ };
}

/** Open an agent card's menu the way a person does: right-click on its select button. */
const openCardMenu = async (app: Awaited<ReturnType<typeof groupFixture>>, name: string) => {
  const select = stripCard(app.document, name).querySelector<HTMLElement>('.agent-select')!;
  select.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  await app.flush();
};
const cardMenuLabels = (app: Awaited<ReturnType<typeof groupFixture>>) =>
  [...app.document.querySelectorAll<HTMLButtonElement>('[role=menu] .menu-item')].map((b) => b.textContent!.trim());
const pickCardItem = async (app: Awaited<ReturnType<typeof groupFixture>>, label: string) => {
  [...app.document.querySelectorAll<HTMLButtonElement>('[role=menu] .menu-item')].find((b) => b.textContent?.trim() === label)!.click();
  await app.flush();
};

test('a running agent\'s card menu forks it in one tap; a stopped one has no Fork (#383)', { timeout: 60000 }, async (context) => {
  const forks: unknown[][] = [];
  const app = await groupFixture(context, {
    hubAgentFork: async (...args: unknown[]) => { forks.push(args); return { window_name: 'solo-2', pane: '%9', backend: 'codex', forked_from: 'solo' }; },
  }, () => {});
  try {
    await openCardMenu(app, 'solo');
    const labels = cardMenuLabels(app);
    const fork = labels.indexOf('Fork');
    assert.ok(fork > 0, `a running agent offers Fork: ${labels}`);
    assert.equal(labels[fork - 1], 'Configure agent', 'Fork follows Config');
    assert.ok(fork < labels.indexOf('Restart') && fork < labels.indexOf('Stop') && fork < labels.indexOf('Remove'), 'and leads the consequential verbs (destructive last)');
    await pickCardItem(app, 'Fork');
    for (let i = 0; i < 10 && !forks.length; i++) await app.flush();
    assert.deepEqual(forks, [['fixture', 'solo']], 'one tap, one fork, of that agent in this project, with no name and no dialog');
    assert.equal(app.document.querySelector('.dlg[role=alertdialog]'), null, 'no confirmation');
    // The stopped agent (qa) is offered Resume/Remove, never Fork.
    await openCardMenu(app, 'qa');
    assert.ok(cardMenuLabels(app).includes('Resume'), `qa's own menu is open: ${cardMenuLabels(app)}`);
    assert.ok(!cardMenuLabels(app).includes('Fork'), `a stopped card has no Fork: ${cardMenuLabels(app)}`);
  } finally { await app.close(); }
});

test('a refused fork says why, and a second tap while one is in flight is not a second fork (#383)', { timeout: 60000 }, async (context) => {
  const forks: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = await groupFixture(context, {
    hubAgentFork: async (_s: string, name: string) => {
      forks.push(name);
      await gate;
      throw new Error('project already has 8 agents (cap 8) — finish or close one first');
    },
  });
  try {
    await openCardMenu(app, 'solo');
    await pickCardItem(app, 'Fork');
    await openCardMenu(app, 'solo');
    await pickCardItem(app, 'Fork');
    assert.deepEqual(forks, ['solo'], 'the second tap during the first fork does nothing');
    release();
    for (let i = 0; i < 12 && !app.document.querySelector('.composer-feedback [role="alert"]'); i++) await app.flush();
    const said = app.document.querySelector('.composer-feedback [role="alert"]')?.textContent ?? '';
    assert.match(said, /Could not fork solo: project already has 8 agents/u, said);
  } finally { await app.close(); }
});

test('an older server that has no fork verb is told to be updated, not shown a raw method name (#383, #389)', { timeout: 60000 }, async (context) => {
  const app = await groupFixture(context, {
    hubAgentFork: async () => { throw Object.assign(new Error('unknown hub method: hub_agent_fork'), { code: -32601 }); },
  });
  try {
    await openCardMenu(app, 'solo');
    await pickCardItem(app, 'Fork');
    for (let i = 0; i < 12 && !app.document.querySelector('.composer-feedback [role="alert"]'); i++) await app.flush();
    const said = app.document.querySelector('.composer-feedback [role="alert"]')?.textContent ?? '';
    assert.match(said, /Could not fork solo: this server is older than the app\. Update the server to fork an agent\./u, said);
    assert.ok(!/unknown hub method|hub_agent_fork/u.test(said), `no raw method name: ${said}`);
  } finally { await app.close(); }
});

test('right-click on All opens the group verbs at any time, counted, destructive last (#258)', { timeout: 60000 }, async (context) => {
  const app = await groupFixture(context, {});
  try {
    const all = await allButton(app);
    assert.notEqual(all.getAttribute('aria-pressed'), 'true', 'All is not the destination');
    await app.contextmenu(all.closest('.all-choice')!);
    assert.deepEqual(app.labels(), ['Message everyone', 'Interrupt all', 'Restart all (3)', 'Start stopped (2)', 'Stop all (3)']);
    assert.ok(!app.labels().some((l) => /remove/iu.test(l ?? '')), 'remove is never a group verb');
    await app.pick('Message everyone');
    assert.equal(all.getAttribute('aria-pressed'), 'true');
  } finally { await app.close(); }
});

test('a team with nobody running stays in the roster; its name opens Start and Configure, and Start is one team restart (#287)', { timeout: 60000 }, async (context) => {
  const teamCalls: unknown[][] = [];
  const perAgent: string[] = [];
  const opened: unknown[][] = [];
  const app = await groupFixture(context, {
    projectList: async () => ({ projects: [{
      project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/fixture' }, live: true,
      slots: [{ window_name: 'qa', kind: 'agent', command: 'kiro' }, { window_name: 'qb', kind: 'agent', command: 'kiro' }, { window_name: 'loner', kind: 'agent', command: 'codex' }],
    }] }),
    hubAgents: async () => ({
      agents: [{ name: 'solo', window: 2, managed: true, agent: 'codex', state: 'idle' }],
      stopped_teams: { qa: 'squad', qb: 'squad/sub' },
    }),
    hubAgentRestart: async (_s: string, name: string) => { perAgent.push(name); return {}; },
    hubTeamRestart: async (...args: unknown[]) => { teamCalls.push(args.filter((a) => a !== undefined)); return { team: 'squad', restarted: ['qa', 'qb'], stopped: [], spawned: [], errors: [] }; },
  }, (...args) => { opened.push(args); });
  try {
    for (let i = 0; i < 30 && !app.document.querySelector('.roster-cluster.team.off'); i++) await app.flush();
    const group = app.document.querySelector('.roster-cluster.team.off[data-team="squad"]')!;
    assert.ok(group, 'the stopped team is drawn');
    assert.deepEqual([...group.querySelectorAll('.acard.off')].map((c) => c.getAttribute('data-agent')), ['qa', 'qb'], 'its stopped members sit under its name');
    assert.ok(app.document.querySelector('.acard.off[data-agent="loner"]'), 'a stopped agent with no team stays a loose card');
    assert.equal(app.document.querySelectorAll('.acard.off[data-agent="qa"]').length, 1, 'never twice');
    group.querySelector<HTMLButtonElement>('.team-label')!.click();
    await app.flush();
    assert.deepEqual(app.labels(), ['Start stopped (2)', 'Configure team'], 'not a destination: no talk row, nothing to stop');
    await app.pick('Start stopped (2)');
    for (let i = 0; i < 10 && !teamCalls.length; i++) await app.flush();
    assert.deepEqual(teamCalls, [['fixture', 'squad']], 'one alignment with the current definition');
    assert.deepEqual(perAgent, [], 'no per-member replay');
    const label = () => app.document.querySelector<HTMLButtonElement>('.roster-cluster.team.off[data-team="squad"] .team-label')!;
    for (let i = 0; i < 20 && label().disabled; i++) await app.flush();
    label().click();
    await app.flush();
    await app.pick('Configure team');
    assert.deepEqual(opened, [['squad', 'team']]);
  } finally { await app.close(); }
});

test('a team name menu is scoped to its members, stopped ones by their recipe team, and opens its editor (#258)', { timeout: 60000 }, async (context) => {
  const restarts: string[] = [];
  const opened: unknown[][] = [];
  const app = await groupFixture(context, {
    hubAgentRestart: async (_s: string, name: string) => { restarts.push(name); return {}; },
  }, (...args) => { opened.push(args); });
  try {
    const team = app.document.querySelector<HTMLButtonElement>('.roster-cluster[data-team="squad"] .team-label')!;
    await app.contextmenu(team);
    assert.deepEqual(app.labels(), ['Message team', 'Interrupt team', 'Restart team (2)', 'Start stopped (1)', 'Stop team (2)', 'Configure team']);
    await app.pick('Start stopped (1)');
    for (let i = 0; i < 10 && !restarts.length; i++) await app.flush();
    assert.deepEqual(restarts, ['qa'], 'only the team\'s stopped member, never loner or solo');
    await app.contextmenu(team);
    await app.pick('Configure team');
    assert.deepEqual(opened, [['squad', 'team']]);
  } finally { await app.close(); }
});

test('Restart team aligns the team with its current definition in one server step, never per member (#286)', { timeout: 60000 }, async (context) => {
  const teamCalls: unknown[][] = [];
  const perAgent: string[] = [];
  let fail = true;
  const app = await groupFixture(context, {
    hubAgentRestart: async (_s: string, name: string) => { perAgent.push(name); return {}; },
    hubTeamRestart: async (...args: unknown[]) => {
      teamCalls.push(args.filter((a) => a !== undefined));
      const errors = fail ? [{ name: 'reviewer', error: 'spawn failed' }] : [];
      fail = false;
      return { team: 'squad', restarted: ['lead', 'dev'], stopped: ['archivist'], spawned: [], errors };
    },
  });
  try {
    const team = app.document.querySelector<HTMLButtonElement>('.roster-cluster[data-team="squad"] .team-label')!;
    await app.contextmenu(team);
    await app.pick('Restart team (2)');
    assert.ok(app.document.querySelector('.dlg[role=alertdialog]'), 'lead is running: the restart asks');
    app.document.querySelector<HTMLButtonElement>('.dlg[role=alertdialog] .primary')!.click();
    for (let i = 0; i < 10 && !app.document.querySelector('.dlg-error'); i++) await app.flush();
    assert.deepEqual(teamCalls, [['fixture', 'squad']], 'one alignment for the whole team');
    assert.deepEqual(perAgent, [], 'no per-member recipe replay');
    assert.match(app.document.querySelector('.dlg-error')?.textContent ?? '', /reviewer/u, 'a member that failed is named');
    app.document.querySelector<HTMLButtonElement>('.dlg[role=alertdialog] .primary')!.click();
    for (let i = 0; i < 10 && app.document.querySelector('.dlg[role=alertdialog]'); i++) await app.flush();
    assert.equal(JSON.stringify(teamCalls), JSON.stringify([['fixture', 'squad'], ['fixture', 'squad', ['reviewer']]]), `a retry runs only the member that failed; lead and dev are not restarted again: ${JSON.stringify(teamCalls)}`);
    assert.equal(app.document.querySelector('.dlg[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('Stop all confirms, runs every member once, and a retry runs only the ones that failed (#258)', { timeout: 60000 }, async (context) => {
  const calls: string[] = [];
  let failDev = true;
  const app = await groupFixture(context, {
    hubAgentStop: async (_s: string, name: string) => {
      calls.push(name);
      if (name === 'dev' && failDev) { failDev = false; throw new Error('boom'); }
      return {};
    },
  });
  try {
    await app.contextmenu((await allButton(app)).closest('.all-choice')!);
    await app.pick('Stop all (3)');
    assert.equal(calls.length, 0, 'a stop asks first');
    assert.match(app.document.querySelector('.dlg[role=alertdialog] h2')?.textContent ?? '', /Stop 3 agents \(everyone\)/u);
    app.document.querySelector<HTMLButtonElement>('.dlg[role=alertdialog] .primary')!.click();
    for (let i = 0; i < 10 && !app.document.querySelector('.dlg-error'); i++) await app.flush();
    assert.deepEqual([...calls].sort(), ['dev', 'lead', 'solo']);
    assert.match(app.document.querySelector('.dlg-error')?.textContent ?? '', /dev/u, 'the failure names who failed');
    app.document.querySelector<HTMLButtonElement>('.dlg[role=alertdialog] .primary')!.click();
    for (let i = 0; i < 10 && app.document.querySelector('.dlg[role=alertdialog]'); i++) await app.flush();
    assert.deepEqual(calls.slice(3), ['dev'], 'the retry runs only the failed member');
    assert.equal(app.document.querySelector('.dlg[role=alertdialog]'), null);
  } finally { await app.close(); }
});

test('Restart all confirms only when it would cut a turn; an idle group restarts at once and names failures (#258)', { timeout: 60000 }, async (context) => {
  const restarts: string[] = [];
  let busy = true;
  const app = await groupFixture(context, {
    hubAgents: async () => ({
      agents: [
        { name: 'lead', window: 0, managed: true, agent: 'kiro', state: busy ? 'running' : 'idle', team: 'squad' },
        { name: 'solo', window: 2, managed: true, agent: 'codex', state: 'idle' },
      ],
      stopped_teams: { qa: 'squad' },
    }),
    hubAgentRestart: async (_s: string, name: string) => { restarts.push(name); if (name === 'solo') throw new Error('x'); return {}; },
  });
  try {
    const all = () => allButton(app).then((b) => b.closest('.all-choice')!);
    await app.contextmenu(await all());
    await app.pick('Restart all (2)');
    assert.ok(app.document.querySelector('.dlg[role=alertdialog]'), 'lead is running: the restart asks');
    assert.equal(restarts.length, 0);
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg[role=alertdialog] button')].find((b) => !b.classList.contains('primary'))!.click();
    await app.flush();

    busy = false;
    await app.advance(5000);
    await app.contextmenu(await all());
    await app.pick('Restart all (2)');
    assert.equal(app.document.querySelector('.dlg[role=alertdialog]'), null, 'nobody is working: no confirm');
    for (let i = 0; i < 10 && !app.document.querySelector('.operation-feedback'); i++) await app.flush();
    assert.deepEqual([...restarts].sort(), ['lead', 'solo'], 'every live member once');
    assert.match(app.document.querySelector('.operation-feedback')?.textContent ?? '', /Restart failed for: solo/u,
      'the partial failure names who failed; lead is not retried');
    assert.equal(restarts.length, 2);

    await app.contextmenu(await all());
    await app.pick('Start stopped (2)');
    for (let i = 0; i < 10 && restarts.length < 4; i++) await app.flush();
    assert.deepEqual(restarts.slice(2).sort(), ['loner', 'qa'], 'Start stopped runs at once, on the stopped identities only');
  } finally { await app.close(); }
});

test('a group Interrupt names the member whose interrupt failed; the others are not retried (#258 review)', { timeout: 60000 }, async (context) => {
  const calls: string[] = [];
  const app = await groupFixture(context, {
    hubAgents: async () => ({
      agents: [
        { name: 'lead', window: 0, managed: true, agent: 'kiro', state: 'running', team: 'squad' },
        { name: 'dev', window: 1, managed: true, agent: 'kiro', state: 'waiting', team: 'squad' },
        { name: 'solo', window: 2, managed: true, agent: 'codex', state: 'idle' },
      ],
      stopped_teams: {},
    }),
    hubAgentInterrupt: async (_s: string, name: string) => { calls.push(name); if (name === 'dev') throw new Error('gone'); return {}; },
  });
  try {
    const team = app.document.querySelector<HTMLButtonElement>('.roster-cluster[data-team="squad"] .team-label')!;
    await app.contextmenu(team);
    await app.pick('Interrupt team');
    for (let i = 0; i < 10 && !app.document.querySelector('.operation-feedback'); i++) await app.flush();
    assert.deepEqual([...calls].sort(), ['dev', 'lead'], 'every busy member once; the idle solo is not in the team');
    assert.match(app.document.querySelector('.operation-feedback')?.textContent ?? '', /Interrupt failed for: dev/u);
    assert.doesNotMatch(app.document.querySelector('.operation-feedback')?.textContent ?? '', /lead/u, 'a success is not named');
    assert.equal(calls.length, 2, 'nothing is retried by itself');
  } finally { await app.close(); }
});

// Board #271: the kiro card's queue ⇄ steer item, mounted through a host that
// serves backends_list as App does. Only a backend the server says can switch
// LIVE offers it, and only when hub_agents reports the running mode.
let hosted: ReturnType<typeof compileMount> | undefined;
const compiledHost = () => hosted ??= compileMount(new URL('./Hub.test.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
], { serverScope: true });
const served = (name: string, toggle: boolean) => ({ name, icon: `/assets/${name}.svg`, color: `--backend-${name}`, efforts: [], input_modes: true, input_mode_toggle: toggle });

async function menuOf(app: { document: Document; window: any; flush: () => Promise<void> }, name: string) {
  app.document.querySelector('.ctx') && app.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await app.flush();
  stripCard(app.document, name).querySelector('.agent-select')!.dispatchEvent(new app.window.MouseEvent('contextmenu', { bubbles: true }));
  await app.flush();
  return [...app.document.querySelectorAll<HTMLButtonElement>('.ctx button')];
}

test('the kiro card menu switches queue ⇄ steer for this session; codex and older servers show no item (#271)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHost();
  const { rpc } = roomFixture();
  let modes: Record<string, string | null | undefined> = { alice: 'queue', bob: 'queue' };
  const calls: unknown[][] = [];
  const app = await fixture.mount(context, {
    props: { visible: true, backends: [served('kiro', true), served('codex', false)] },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{
      ...rpc,
      hubAgents: async () => ({ agents: [
        { name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', input_mode: modes.alice },
        { name: 'bob', window: 1, managed: true, agent: 'codex', state: 'idle', input_mode: modes.bob },
      ] }),
      hubAgentInputMode: async (...args: unknown[]) => { calls.push(args); modes.alice = args[2] as string; return { agent: 'alice', mode: args[2], changed: true }; },
    }],
  });
  const item = (buttons: HTMLButtonElement[]) => buttons.find((b) => /Switch to (Steer|Queue)/u.test(b.textContent ?? ''));
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.acard[data-agent="alice"]'); i++) await app.flush();
    let toSteer = item(await menuOf(app, 'alice'));
    assert.ok(toSteer, 'a queued kiro offers steer');
    assert.match(toSteer!.textContent!, /Switch to Steer/u);
    assert.equal(toSteer!.querySelector('.ctx-hint'), null, 'no hint line under the item (#272)');
    toSteer!.click();
    for (let i = 0; i < 5 && !calls.length; i++) await app.flush();
    assert.deepEqual(calls, [['fixture', 'alice', 'steer']], 'the one RPC, with the other mode');
    for (let i = 0; i < 5; i++) await app.flush();
    const toQueue = item(await menuOf(app, 'alice'));
    assert.match(toQueue?.textContent ?? '', /Switch to Queue/u, 'the reloaded row flips the label');
    assert.equal(toQueue!.querySelector('.ctx-hint'), null, 'neither direction has one (#272)');
    assert.equal(item(await menuOf(app, 'bob')), undefined, 'codex: its mode is fixed at launch');
    modes = { alice: undefined, bob: undefined };
    await app.advance(5000);
    assert.equal(item(await menuOf(app, 'alice')), undefined, 'an older server reports no mode: no item');
  } finally { await app.close(); }
});

test('without the served capability the kiro card offers no switch (#271)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHost();
  const { rpc } = roomFixture();
  const app = await fixture.mount(context, {
    props: { visible: true, backends: null },
    setup(window) { window.Element.prototype.getAnimations = () => []; },
    modules: [{
      ...rpc,
      hubAgents: async () => ({ agents: [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle', input_mode: 'queue' }] }),
      hubAgentInputMode: async () => assert.fail('no switch without the capability'),
    }],
  });
  try {
    for (let i = 0; i < 20 && !app.document.querySelector('.acard[data-agent="alice"]'); i++) await app.flush();
    const buttons = await menuOf(app, 'alice');
    assert.ok(buttons.length > 0, 'the menu opened');
    assert.equal(buttons.find((b) => /Switch to/u.test(b.textContent ?? '')), undefined);
  } finally { await app.close(); }
});

test('every project row shows its unread count; reading the room clears it by seq (#322)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const asks: Record<string, unknown>[] = [];
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_hub_seen', JSON.stringify({ other: 50 }));
      window.HTMLCanvasElement.prototype.getContext = () => null;
    },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
        project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
      })) }),
      hubUnread: async (rooms: Record<string, { seq?: number; ts?: number }>) => {
        asks.push(rooms);
        const other = rooms['proj:other'];
        return { rooms: other && !(other.seq! >= 11) ? { 'proj:other': { count: 2, first_seq: 10, last_seq: 11 } } : {} };
      },
      hubLog: async (session: string) => ({ has_more: false, messages: session === 'other' ? [
        { seq: 10, id: 'a', ts: 60, room: 'proj:other', from: 'alice', to: [], body: 'one' },
        { seq: 11, id: 'b', ts: 60, room: 'proj:other', from: 'bob', to: [], body: 'two' },
      ] : [] }),
    }],
  });
  try {
    const row = () => app.document.querySelector<HTMLElement>('.proj-row[aria-label^="other"]');
    for (let i = 0; i < 12 && !row()?.querySelector('.side-unread'); i++) await app.flush();
    assert.equal(row()!.querySelector('.side-unread')!.textContent!.trim(), '2', 'a room not open shows its count');
    assert.equal(row()!.getAttribute('aria-label'), 'other · 2 unread');
    assert.ok(row()!.classList.contains('unread'));
    assert.equal(app.document.querySelector('.proj-row[aria-label="fixture"] .side-unread'), null, 'a read room shows none');
    assert.equal(JSON.stringify(asks[0]!['proj:other']), '{"ts":50}', 'a legacy mark is asked by ts');
    row()!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && row()?.querySelector('.side-unread'); i++) await app.flush();
    assert.equal(row()!.querySelector('.side-unread'), null, 'reading the room to its tail clears the cue');
    assert.deepEqual(JSON.parse(app.window.localStorage.getItem('tmux_hub_seen')!).other, { seq: 11, ts: 60 }, 'the mark is the newest seq');
    assert.equal(JSON.stringify(asks.at(-1)!['proj:other']), '{"seq":11}', 'and the server is asked with it');
  } finally { await app.close(); }
});

// Board #334: ONE read mark per room on the server. A fake server that keeps
// it the way hub_rpc.rs does: hub_read resolves (clamps to the head) and only
// moves forward; hub_unread reads from the later of the server's and the
// client's mark and answers the PERSISTED marks.
function readServer() {
  const msg = (room: string, seq: number, from = 'alice') => ({ seq, id: `${room}-${seq}`, ts: 60 + seq, room, from, to: [], body: `m${seq}` });
  const rooms: Record<string, ReturnType<typeof msg>[]> = {
    'proj:other': [msg('proj:other', 10), msg('proj:other', 11, 'bob')],
    'proj:third': [msg('proj:third', 20), msg('proj:third', 21)],
  };
  const marks: Record<string, { seq: number; ts: number }> = {};
  const reads: Record<string, unknown>[] = [];
  let failReads = 0;
  /** Rooms the fake server confirms; null = all (a room left out wrote nothing and is absent). */
  let acks: Set<string> | null = null;
  return {
    marks, reads, rooms, msg,
    failNextReads(n: number) { failReads = n; },
    ackOnly(list: string[] | null) { acks = list && new Set(list); },
    rpc: {
      projectList: async () => ({ projects: ['fixture', 'other', 'third'].map((session) => ({
        project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
      })) }),
      hubLog: async (session: string) => ({ has_more: false, messages: rooms[`proj:${session}`] ?? [] }),
      hubUnread: async (asked: Record<string, { seq?: number; ts?: number }>) => {
        const out: Record<string, unknown> = {};
        const persisted: Record<string, unknown> = {};
        for (const [r, m] of Object.entries(asked)) {
          const list = rooms[r];
          if (!list) continue;
          const head = list.at(-1)!.seq;
          const client = (m.seq ?? 0) <= head ? (m.seq ?? 0) : 0;
          const at = Math.max(client, marks[r]?.seq ?? 0);
          const above = list.filter((x) => x.seq > at);
          if (above.length) out[r] = { count: above.length, first_seq: above[0]!.seq, last_seq: above.at(-1)!.seq };
          if (marks[r]) persisted[r] = { ...marks[r] };
        }
        return { rooms: out, marks: persisted };
      },
      hubRead: async (asked: Record<string, { seq?: number; ts?: number }>) => {
        reads.push(asked);
        if (failReads > 0) { failReads--; throw new Error('offline'); }
        const out: Record<string, unknown> = {};
        for (const [r, m] of Object.entries(asked)) {
          const list = rooms[r];
          if (!list || !m.seq || (acks && !acks.has(r))) continue;
          const hit = [...list].reverse().find((x) => x.seq <= m.seq!)!;
          marks[r] = { seq: Math.max(hit.seq, marks[r]?.seq ?? 0), ts: Math.max(hit.ts, marks[r]?.ts ?? 0) };
          out[r] = { ...marks[r] };
        }
        return { rooms: out };
      },
    },
  };
}
/** A latch: `wait()` parks a call until `open()`. */
function latch() {
  let release: () => void = () => {};
  let armed = false;
  const parked = new Promise<void>((r) => { release = r; });
  return { arm() { armed = true; }, get armed() { return armed; }, wait: () => (armed ? parked : Promise.resolve()), open: () => release() };
}
async function mountReader(context: TestContext, rpc: Record<string, unknown>, seen?: Record<string, unknown>) {
  const fixture = await compiledHub();
  const { rpc: base } = roomFixture();
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_server_current', 's1');
      if (seen) window.localStorage.setItem('tmux_hub_seen', JSON.stringify(seen));
    },
    modules: [{ ...base, ...rpc }],
  });
  return app;
}
const otherRow = (app: { document: Document }) => app.document.querySelector<HTMLElement>('.proj-row[aria-label^="other"]');
const otherCount = (app: { document: Document }) => otherRow(app)?.querySelector('.side-unread')?.textContent?.trim() ?? '';
const seenOf = (app: { window: any }, room = 'other') => JSON.parse(app.window.localStorage.getItem('tmux_hub_seen') ?? '{}')[room];
const rowOf = (app: { document: Document }, room: string) => app.document.querySelector<HTMLElement>(`.proj-row[aria-label^="${room}"]`);
const countOf = (app: { document: Document }, room: string) => rowOf(app, room)?.querySelector('.side-unread')?.textContent?.trim() ?? '';
const readKeys = (srv: { reads: Record<string, unknown>[] }) => srv.reads.map((r) => Object.keys(r).sort().join(','));

test('a fresh client inherits the server\'s read mark; its reading reaches the next client (#334)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  srv.marks['proj:other'] = { seq: 10, ts: 70 };          // read to `one` on another client
  const a = await mountReader(context, srv.rpc);
  try {
    for (let i = 0; i < 12 && otherCount(a) !== '1'; i++) await a.flush();
    assert.equal(otherCount(a), '1', 'no local mark: the server\'s mark is the watermark, not the whole room');
    assert.deepEqual(seenOf(a), { seq: 10, ts: 70 }, 'and the cache adopts the persisted mark');
    otherRow(a)!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && (otherCount(a) || !srv.marks['proj:other'] || srv.marks['proj:other'].seq < 11); i++) await a.flush();
    assert.equal(otherCount(a), '');
    assert.deepEqual(srv.marks['proj:other'], { seq: 11, ts: 71 }, 'the server holds the read');
  } finally { await a.close(); }
  const b = await mountReader(context, srv.rpc);          // another fresh client
  try {
    for (let i = 0; i < 12 && !otherRow(b); i++) await b.flush();
    for (let i = 0; i < 6; i++) await b.flush();
    assert.equal(otherCount(b), '', 'the next client agrees: nothing unread');
    assert.deepEqual(seenOf(b), { seq: 11, ts: 71 });
  } finally { await b.close(); }
});

test('an idle client converges on its next refresh after another client reads (#334)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  const app = await mountReader(context, srv.rpc);
  try {
    for (let i = 0; i < 12 && otherCount(app) !== '2'; i++) await app.flush();
    assert.equal(otherCount(app), '2');
    srv.marks['proj:other'] = { seq: 11, ts: 71 };        // the phone read the room
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(otherCount(app), '2', 'no instant push is claimed');
    await app.advance(20000);
    for (let i = 0; i < 12 && otherCount(app); i++) await app.flush();
    assert.equal(otherCount(app), '', 'the 20 s sidebar read adopts it');
    assert.deepEqual(seenOf(app), { seq: 11, ts: 71 });
  } finally { await app.close(); }
});

test('a read whose hub_read fails stays pending and is re-sent until ACKed (#334)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  srv.failNextReads(1_000);                               // offline for a while
  const app = await mountReader(context, srv.rpc);
  try {
    for (let i = 0; i < 12 && otherCount(app) !== '2'; i++) await app.flush();
    otherRow(app)!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && srv.reads.length < 1; i++) await app.flush();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(srv.marks['proj:other'], undefined, 'every hub_read so far failed');
    srv.failNextReads(0);
    assert.deepEqual(seenOf(app), { seq: 11, ts: 71 }, 'the optimistic cache keeps the room read here');
    assert.equal(otherCount(app), '', 'the count reads from the later of the two marks');
    await app.advance(20000);
    for (let i = 0; i < 12 && !srv.marks['proj:other']; i++) await app.flush();
    assert.ok(srv.reads.length >= 2, 'the pending mark was re-sent by the refresh');
    assert.deepEqual(srv.marks['proj:other'], { seq: 11, ts: 71 }, 'and ACKed: another client now agrees');
    const sent = srv.reads.length;
    await app.advance(20000);
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(srv.reads.length, sent, 'an ACKed mark is not re-sent');
  } finally { await app.close(); }
});

test('an impossible cached mark is corrected by the server; a late ACK after a server switch touches nothing (#334)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  srv.marks['proj:other'] = { seq: 10, ts: 70 };
  let release: (() => void) | null = null;
  const app = await mountReader(context, {
    ...srv.rpc,
    // The ACK lands late and differs from the optimistic cache (the server
    // resolved the mark lower — a deleted head), so a write would show.
    hubRead: async () => {
      await new Promise<void>((r) => { release = r; });
      return { rooms: { 'proj:other': { seq: 10, ts: 70 } } };
    },
  }, { other: { seq: 9_000_000, ts: 9_000_000 } });
  try {
    for (let i = 0; i < 12 && otherCount(app) !== '1'; i++) await app.flush();
    assert.equal(otherCount(app), '1', 'the future mark hides nothing');
    assert.deepEqual(seenOf(app), { seq: 10, ts: 70 }, 'the cache became the server\'s persisted mark');
    otherRow(app)!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && !release; i++) await app.flush();
    assert.ok(release, 'hub_read in flight');
    app.window.localStorage.setItem('tmux_server_current', 's2');
    app.window.localStorage.setItem('tmux_hub_seen', JSON.stringify({ other: { seq: 3, ts: 3 } }));
    release!();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(seenOf(app), { seq: 3, ts: 3 }, 'the late ACK did not write into the other server\'s cache');
  } finally { await app.close(); }
});

test('a pending mark clears only on its own room\'s ACK: an empty or partial answer is re-sent, an ACKed room is not (#334 review)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  srv.ackOnly([]);                                          // the server answers {rooms: {}}
  const app = await mountReader(context, srv.rpc);
  try {
    for (let i = 0; i < 12 && countOf(app, 'other') !== '2'; i++) await app.flush();
    rowOf(app, 'other')!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && !srv.reads.length; i++) await app.flush();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.ok(srv.reads.length >= 1 && readKeys(srv).every((k) => k === 'proj:other'), 'sent (and retried by the read\'s own refresh), answered empty');
    srv.ackOnly(['proj:third']);                            // a partial server from here on
    rowOf(app, 'third')!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && !srv.marks['proj:third']; i++) await app.flush();
    assert.deepEqual(srv.marks['proj:third'], { seq: 21, ts: 81 }, 'third ACKed');
    for (let i = 0; i < 4; i++) await app.flush();
    const before = srv.reads.length;
    await app.advance(20000);
    for (let i = 0; i < 12 && srv.reads.length <= before; i++) await app.flush();
    const later = readKeys(srv).slice(before);
    assert.ok(later.length > 0 && later.every((k) => k === 'proj:other'), `the unconfirmed room is re-sent, the ACKed one is not: ${later}`);
    srv.ackOnly(null);
    await app.advance(20000);
    for (let i = 0; i < 12 && !srv.marks['proj:other']; i++) await app.flush();
    assert.deepEqual(srv.marks['proj:other'], { seq: 11, ts: 71 }, 'confirmed at last');
    const sent = srv.reads.length;
    await app.advance(20000);
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(srv.reads.length, sent, 'nothing left pending');
  } finally { await app.close(); }
});

test('an ACK below the pending mark does not clear it (#334 review)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  let lowAcks = 1;
  const app = await mountReader(context, {
    ...srv.rpc,
    // An older confirmation (for a mark below the one now pending) answers first.
    hubRead: async (asked: Record<string, { seq?: number }>) => {
      srv.reads.push(asked);
      if (lowAcks-- > 0) { srv.marks['proj:other'] = { seq: 10, ts: 70 }; return { rooms: { 'proj:other': { seq: 10, ts: 70 } } }; }
      srv.reads.pop();
      return srv.rpc.hubRead(asked);
    },
  });
  try {
    for (let i = 0; i < 12 && countOf(app, 'other') !== '2'; i++) await app.flush();
    rowOf(app, 'other')!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && !srv.reads.length; i++) await app.flush();
    for (let i = 0; i < 4; i++) await app.flush();
    assert.deepEqual(seenOf(app), { seq: 11, ts: 71 }, 'the low ACK did not lower the cache');
    await app.advance(20000);
    for (let i = 0; i < 12 && (srv.marks['proj:other']?.seq ?? 0) < 11; i++) await app.flush();
    assert.deepEqual(srv.marks['proj:other'], { seq: 11, ts: 71 }, 'still pending, so it was re-sent and confirmed');
  } finally { await app.close(); }
});

test('an unread answer asked before an ACK never rolls the room back (#334 review)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  srv.marks['proj:other'] = { seq: 10, ts: 70 };
  const r = latch(), u = latch();
  const app = await mountReader(context, {
    ...srv.rpc,
    hubRead: async (asked: Record<string, { seq?: number }>) => { await r.wait(); return srv.rpc.hubRead(asked); },
    // Computed when ASKED (persisted 10), delivered when released.
    hubUnread: async (asked: Record<string, { seq?: number }>) => { const v = await srv.rpc.hubUnread(asked); await u.wait(); return v; },
  });
  try {
    for (let i = 0; i < 12 && countOf(app, 'other') !== '1'; i++) await app.flush();
    r.arm(); u.arm();
    rowOf(app, 'other')!.querySelector<HTMLElement>('.proj-pick')!.click();
    for (let i = 0; i < 20 && seenOf(app)?.seq !== 11; i++) await app.flush();
    r.open();                                               // the ACK (11) lands first
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(srv.marks['proj:other'], { seq: 11, ts: 71 });
    u.open();                                               // then the answer that saw 10
    for (let i = 0; i < 8; i++) await app.flush();
    assert.deepEqual(seenOf(app), { seq: 11, ts: 71 }, 'the cache stays at the ACK');
    assert.equal(countOf(app, 'other'), '', 'the sidebar stays read');
    assert.equal(app.document.querySelector('.acard[data-agent="bob"] .unread-dot'), null, 'the roster stays read');
  } finally { await app.close(); }
});

test('unread answers apply in ask order: an older one landing late does not overwrite a newer one (#334 review)', { timeout: 60000 }, async (context) => {
  const srv = readServer();
  const gates: (() => void)[] = [];
  let hold = false;
  const app = await mountReader(context, {
    ...srv.rpc,
    hubUnread: async (asked: Record<string, { seq?: number }>) => {
      const v = await srv.rpc.hubUnread(asked);
      if (hold) await new Promise<void>((r) => { gates.push(r); });
      return v;
    },
  });
  try {
    for (let i = 0; i < 12 && countOf(app, 'other') !== '2'; i++) await app.flush();
    hold = true;
    await app.advance(20000);                               // U1 sees 2
    for (let i = 0; i < 12 && gates.length < 1; i++) await app.flush();
    srv.rooms['proj:other']!.push(srv.msg('proj:other', 12));
    await app.advance(20000);                               // U2 sees 3
    for (let i = 0; i < 12 && gates.length < 2; i++) await app.flush();
    assert.equal(gates.length, 2, 'two answers in flight');
    gates[1]!();
    for (let i = 0; i < 6 && countOf(app, 'other') !== '3'; i++) await app.flush();
    assert.equal(countOf(app, 'other'), '3');
    gates[0]!();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(countOf(app, 'other'), '3', 'the older answer is dropped');
  } finally { await app.close(); }
});

// Board #322: the centre's jump. A record names server + room + seq + id;
// the Hub opens that room, loads ONE page around the message as a history
// window when it is not loaded, rings it, and only then marks it viewed. The
// window takes no live rows and moves no read mark; Back to latest swaps the
// tail page in only once it has answered.
function jumpFixture(over: Record<string, unknown> = {}) {
  const { rpc, pushed } = roomFixture();
  // Addressed to the human: only those (and finished tasks) are bell entries (#334).
  const msg = (seq: number, body = `m${seq}`, from = 'alice') => ({ seq, id: `id${seq}`, ts: 1_000 + seq, room: 'proj:other', from, to: ['human'], body });
  const tail = Array.from({ length: 10 }, (_, i) => msg(200 + i));
  const around = [msg(48), msg(49), { ...msg(50), id: 'target', body: 'the reply you heard' }, msg(51), msg(52)];
  return {
    pushed, msg, tail, around,
    rpc: {
      ...rpc,
      projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
        project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
      })) }),
      hubLog: async (session: string) => ({ has_more: true, oldest_seq: 200, messages: session === 'other' ? tail : [] }),
      hubLogAround: async () => ({ has_more: true, newer_more: true, oldest_seq: 48, messages: around }),
      ...over,
    },
  };
}
// The Hub's server is its SCOPE's ('test', the mount harness's runtime), not
// CURRENT (reviewer P1 on the b3 binding range) — the setup's CURRENT of 's1'
// is deliberately another id.
const alertFor = (id = 'target', seq = 50, server = 'test') => ({
  key: `proj:other|${id}`, server, room: 'proj:other', session: 'other', project: 'other',
  seq, id, ts: 1_050, from: 'alice', toHuman: true, kind: 'reply', excerpt: 'the reply you heard', viewed: false,
});
async function mountJump(context: TestContext, rpc: Record<string, unknown>, setup: (w: any) => void = () => {}) {
  const fixture = await compiledHost();
  return fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_server_current', 's1');
      window.HTMLMediaElement.prototype.play = () => Promise.resolve();
      setup(window);
    },
    modules: [rpc as Record<string, (...args: any[]) => unknown>],
  });
}
const centreOf = (app: { window: any }) => app.window.__centre;
const until = async (app: { flush: () => Promise<void> }, ok: () => boolean, n = 30) => { for (let i = 0; i < n && !ok(); i++) await app.flush(); };

test('a centre jump opens the room, windows the page around the message, rings it, and only then marks it viewed (#322)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const app = await mountJump(context, f.rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.requestJump(centre.items[0]);
    const hit = () => app.document.querySelector('.msg.jump-hit[data-msg="target"]');
    await until(app, () => !!hit());
    assert.ok(hit(), 'the target bubble is on screen and ringed');
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'other', 'its room is open');
    assert.equal(centre.items[0].viewed, true, 'viewed only after it landed');
    assert.equal(app.document.querySelector('[data-msg="id209"]'), null, 'the window is the page around it, not the tail');
    assert.equal(JSON.parse(app.window.localStorage.getItem('tmux_hub_seen') ?? '{}').other, undefined, 'a window moves no read mark');
    // A push for this room while windowed: recorded, not merged; the to-tail dot says news waits.
    for (const fn of f.pushed) (fn as (m: unknown) => void)(f.msg(300, 'late news'));
    await app.flush();
    assert.equal(app.document.querySelector('[data-msg="id300"]'), null, 'no live row joins a history window');
    const toTail = app.document.querySelector<HTMLButtonElement>('.to-tail')!;
    assert.ok(toTail.classList.contains('news'));
    assert.equal(toTail.getAttribute('aria-label'), 'Back to latest');
    assert.ok(centre.items.some((a: { id: string; viewed: boolean }) => a.id === 'id300' && !a.viewed), 'the push is in the centre, unviewed');
  } finally { await app.close(); }
});

// Board #439 (validator on the #432 rig, 1280 px): a centre jump landed the
// message ~34 px above the feed's visible top, under the header. jsdom lays
// nothing out, so the real chain is given: the bubble's offsetParent is the
// positioned .feed-wrap (the .feed is static), and .feed-wrap sits below a
// 42 px header in its own offsetParent, the body. The message is 2000 px into
// the feed's content; it must land at feed top + 8 px, i.e. scrollTop 1992.
test('a centre jump lands the message 8 px below the feed top with a header above the feed (#439)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const app = await mountJump(context, f.rpc, (window) => {
    const proto = window.HTMLElement.prototype;
    const wrapOf = (el: HTMLElement) => el.closest('.feed-wrap');
    Object.defineProperty(proto, 'offsetParent', { configurable: true, get(this: HTMLElement) {
      if (this.matches('.feed-wrap')) return this.ownerDocument.body;
      if (this === this.ownerDocument.body) return null;
      return wrapOf(this) ?? null;
    } });
    Object.defineProperty(proto, 'offsetTop', { configurable: true, get(this: HTMLElement) {
      if (this.matches('.feed-wrap')) return 42;
      if (this.matches('[data-msg="target"]')) return 2000;
      return 0;
    } });
  });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.requestJump(centre.items[0]);
    await until(app, () => !!app.document.querySelector('.msg.jump-hit[data-msg="target"]'));
    const feed = app.document.querySelector<HTMLElement>('.feed')!;
    assert.equal(feed.offsetParent, feed.closest('.feed-wrap'), 'the modelled chain: the static feed is not an offset parent');
    assert.equal(feed.scrollTop, 1992, `the message lands 8 px below the feed top, not under the header (scrollTop ${feed.scrollTop})`);
  } finally { await app.close(); }
});

test('Back to latest keeps the window until the tail answers; a push meanwhile is not merged; a failure keeps it for a retry (#322)', { timeout: 60000 }, async (context) => {
  let answer: ((v: unknown) => void) | null = null;
  let fail = false;
  const f = jumpFixture();
  const rpc = { ...f.rpc, hubLog: async (session: string, sinceTs = 0) => {
    if (session !== 'other' || sinceTs > 0 || !answer && !fail && !(rpc as any).armed) return f.rpc.hubLog(session);
    if (fail) throw new Error('offline');
    return new Promise((r) => { answer = r; });
  } } as Record<string, unknown>;
  const app = await mountJump(context, rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.requestJump(centre.items[0]);
    await until(app, () => !!app.document.querySelector('.jump-hit'));
    // 1) the tail request fails: the window and its control stay.
    fail = true;
    app.document.querySelector<HTMLButtonElement>('.to-tail')!.click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.ok(app.document.querySelector('[data-msg="target"]'), 'a failed return keeps the window');
    assert.ok(app.document.querySelector('.to-tail'), 'and the way back, for a retry');
    // 2) a slow tail with a push in between.
    fail = false; (rpc as any).armed = true;
    app.document.querySelector<HTMLButtonElement>('.to-tail')!.click();
    await until(app, () => !!answer);
    for (const fn of f.pushed) (fn as (m: unknown) => void)(f.msg(301, 'during the return'));
    await app.flush();
    assert.equal(app.document.querySelector('[data-msg="id301"]'), null, 'still windowed: the push is not appended to history');
    assert.ok(app.document.querySelector('[data-msg="target"]'));
    answer!({ has_more: true, oldest_seq: 200, messages: [...f.tail, f.msg(301, 'during the return')] });
    await until(app, () => !!app.document.querySelector('[data-msg="id209"]'));
    assert.ok(app.document.querySelector('[data-msg="id301"]'), 'the tail page carries it');
    assert.equal(app.document.querySelector('[data-msg="target"]'), null, 'the window is replaced in one step');
  } finally { await app.close(); }
});

test('a newer jump supersedes an older one; another server\'s record never jumps; a gone message keeps its record (#322)', { timeout: 60000 }, async (context) => {
  let first: ((v: unknown) => void) | null = null;
  const f = jumpFixture();
  const rpc = { ...f.rpc, hubLogAround: async (_s: string, seq: number) => {
    if (seq === 50) return new Promise((r) => { first = r; });
    if (seq === 60) return { has_more: true, newer_more: true, oldest_seq: 58, messages: [f.msg(58), { ...f.msg(60), id: 'second' }] };
    return { has_more: false, newer_more: true, oldest_seq: 70, messages: [f.msg(70)] };
  } };
  const app = await mountJump(context, rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.record(alertFor('second', 60));
    centre.requestJump(centre.items.find((a: { id: string }) => a.id === 'target'));
    await until(app, () => !!first);
    centre.requestJump(centre.items.find((a: { id: string }) => a.id === 'second'));
    await until(app, () => !!app.document.querySelector('.jump-hit[data-msg="second"]'));
    first!({ has_more: true, newer_more: true, oldest_seq: 48, messages: f.around });
    for (let i = 0; i < 6; i++) await app.flush();
    assert.ok(app.document.querySelector('[data-msg="second"]'), 'the superseded answer changed nothing');
    assert.equal(app.document.querySelector('[data-msg="target"]'), null);
    const by = (id: string) => centre.items.find((a: { id: string }) => a.id === id);
    assert.equal(by('target').viewed, false, 'a superseded jump never marks viewed');
    assert.equal(by('second').viewed, true);
    // Another server's record.
    centre.record(alertFor('elsewhere', 99, 's2'));
    centre.requestJump(by('elsewhere'));
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(by('elsewhere').viewed, false);
    assert.equal(by('elsewhere').failed, 'On another server');
    // A message no longer in the room: the record stays, with the reason.
    centre.record(alertFor('gone', 70));
    centre.requestJump(by('gone'));
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(by('gone').viewed, false);
    assert.equal(by('gone').failed, 'Message no longer in the room');
    assert.ok(app.document.querySelector('[data-msg="second"]'), 'a failed jump leaves the feed where it was');
  } finally { await app.close(); }
});

test('a jump reaches a finished-task line at the chat-only level and clears a filter visibly (#322)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const sysTarget = { ...f.msg(50, '[tmm] board #3 doing → review — ship it'), id: 'target' };
  const rpc = { ...f.rpc, hubLogAround: async () => ({ has_more: true, newer_more: true, oldest_seq: 49, messages: [f.msg(49), sysTarget, f.msg(51)] }) };
  const app = await mountJump(context, rpc, (w) => { w.localStorage.setItem('tmux_hub_feed_level', 'chat'); });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record({ ...alertFor(), kind: 'finished' });
    centre.requestJump(centre.items[0]);
    await until(app, () => !!app.document.querySelector('.sys-item.jump-hit[data-msg="target"]'));
    assert.ok(app.document.querySelector('.sys-item.jump-hit[data-msg="target"]'), 'the level keeps the jump\'s target');
    assert.equal(app.window.localStorage.getItem('tmux_hub_feed_level'), 'chat', 'the stored level is untouched');
    assert.equal(centre.items[0].viewed, true);
  } finally { await app.close(); }
});

// Board #322 review: ONE reading generation owns the visible feed. Requests
// already in flight when a jump or a return starts may not write into it.
test('a poll and an older page in flight when a jump lands are dropped; the window, its cursor and seen stay (#322 review)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const held: Record<string, (v: unknown) => void> = {};
  const befores: number[] = [];
  const rpc = { ...f.rpc,
    hubLog: async (session: string, sinceTs = 0, _limit = 100, beforeSeq = 0) => {
      if (session !== 'other') return { has_more: false, messages: [] };
      if (beforeSeq) { befores.push(beforeSeq); if (beforeSeq === 200) return new Promise((r) => { held.older = r; }); return { has_more: false, messages: [] }; }
      if (sinceTs > 0) return new Promise((r) => { held.poll = r; });
      return { has_more: true, oldest_seq: 200, messages: f.tail };
    } };
  const app = await mountJump(context, rpc, (w) => { w.localStorage.setItem('tmux_hub_project', 'other'); });
  try {
    await until(app, () => !!app.document.querySelector('[data-msg="id209"]'));
    await app.advance(10000); // the tail poll goes out and hangs
    await until(app, () => !!held.poll);
    app.document.querySelector<HTMLButtonElement>('.older-more')?.click();
    await until(app, () => !!held.older);
    assert.ok(held.poll && held.older, 'both requests are in flight');
    const seenBefore = app.window.localStorage.getItem('tmux_hub_seen');
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.requestJump(centre.items[0]);
    await until(app, () => !!app.document.querySelector('.jump-hit[data-msg="target"]'));
    held.poll!({ has_more: false, messages: [f.msg(400, 'late tail')] });
    held.older!({ has_more: true, oldest_seq: 150, messages: [f.msg(150, 'old page')] });
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(app.document.querySelector('[data-msg="id400"]'), null, 'the old poll did not join the window');
    assert.equal(app.document.querySelector('[data-msg="id150"]'), null, 'the old page did not join the window');
    assert.ok(app.document.querySelector('[data-msg="target"]'));
    assert.equal(app.window.localStorage.getItem('tmux_hub_seen'), seenBefore, 'seen did not move');
    assert.ok(centre.items.some((a: { id: string }) => a.id === 'id400'), 'the dropped row still reached the centre');
    app.document.querySelector<HTMLButtonElement>('.older-more')?.click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(befores.at(-1), 48, 'the older walk continues from the window, not the stale cursor');
  } finally { await app.close(); }
});

test('a slow return is superseded by a same-room jump: the old tail lands nowhere (#322 review)', { timeout: 60000 }, async (context) => {
  let tail: ((v: unknown) => void) | null = null;
  const f = jumpFixture();
  let armed = false;
  const rpc = { ...f.rpc,
    hubLog: async (session: string, sinceTs = 0) => (session === 'other' && armed && sinceTs === 0 ? new Promise((r) => { tail = r; }) : f.rpc.hubLog(session)),
    hubLogAround: async (_s: string, seq: number) => (seq === 60
      ? { has_more: true, newer_more: true, oldest_seq: 58, messages: [f.msg(58), { ...f.msg(60), id: 'second' }, f.msg(61)] }
      : { has_more: true, newer_more: true, oldest_seq: 48, messages: f.around }) };
  const app = await mountJump(context, rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.record(alertFor('second', 60));
    centre.requestJump(centre.items.find((a: { id: string }) => a.id === 'target'));
    await until(app, () => !!app.document.querySelector('.jump-hit[data-msg="target"]'));
    armed = true;
    app.document.querySelector<HTMLButtonElement>('.to-tail')!.click();
    await until(app, () => !!tail);
    centre.requestJump(centre.items.find((a: { id: string }) => a.id === 'second'));
    await until(app, () => !!app.document.querySelector('.jump-hit[data-msg="second"]'));
    tail!({ has_more: true, oldest_seq: 200, messages: f.tail });
    for (let i = 0; i < 8; i++) await app.flush();
    assert.ok(app.document.querySelector('[data-msg="second"]'), 'window 2 intact');
    assert.equal(app.document.querySelector('[data-msg="id209"]'), null, 'the superseded tail did not land');
    assert.equal(app.document.querySelector('.to-tail')?.getAttribute('aria-label'), 'Back to latest', 'still a window, not following');
  } finally { await app.close(); }
});

test('a jump is one-shot: leaving and returning never replays it; one pending when you leave neither lands nor marks viewed (#322 review)', { timeout: 60000 }, async (context) => {
  let around: ((v: unknown) => void) | null = null;
  let hold = false;
  const f = jumpFixture();
  const rpc = { ...f.rpc, hubLogAround: async () => (hold ? new Promise((r) => { around = r; }) : { has_more: true, newer_more: true, oldest_seq: 48, messages: f.around }) };
  const app = await mountJump(context, rpc);
  const setVisible = async (v: boolean) => { app.window.__setVisible(v); for (let i = 0; i < 4; i++) await app.flush(); };
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.requestJump(centre.items[0]);
    await until(app, () => !!app.document.querySelector('.jump-hit[data-msg="target"]'));
    assert.equal(centre.jump, null, 'the request is consumed when it lands');
    // The reader moves on: another room, then away and back.
    app.document.querySelector<HTMLElement>('.proj-row[aria-label="fixture"] .proj-pick')!.click();
    await until(app, () => app.document.querySelector('.h1-text')?.textContent === 'fixture');
    await setVisible(false);
    await setVisible(true);
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'fixture', 'no replay moved the reader');
    // A jump pending when the reader leaves the Hub.
    hold = true;
    centre.record(alertFor('later', 70));
    centre.requestJump(centre.items.find((a: { id: string }) => a.id === 'later'));
    await until(app, () => !!around);
    await setVisible(false);
    around!({ has_more: true, newer_more: true, oldest_seq: 69, messages: [f.msg(69), { ...f.msg(70), id: 'later' }] });
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(centre.items.find((a: { id: string }) => a.id === 'later').viewed, false, 'not viewed on a hidden page');
    assert.equal(centre.jump, null, 'the left-behind request is spent');
    await setVisible(true);
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(app.document.querySelector('[data-msg="later"]'), null, 'no forced jump on return');
  } finally { await app.close(); }
});

test('a stale jump whose room switch is slow cannot void a newer jump in that room (#322 review r2)', { timeout: 60000 }, async (context) => {
  let firstPage: ((v: unknown) => void) | null = null;
  let around2: ((v: unknown) => void) | null = null;
  const f = jumpFixture();
  const rpc = { ...f.rpc,
    hubLog: async (session: string, sinceTs = 0) => (session === 'other' && sinceTs === 0 && !firstPage ? new Promise((r) => { firstPage = r; }) : f.rpc.hubLog(session)),
    hubLogAround: async (_s: string, seq: number) => (seq === 60
      ? new Promise((r) => { around2 = r; })
      : { has_more: true, newer_more: true, oldest_seq: 48, messages: f.around }) };
  const app = await mountJump(context, rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.record(alertFor('second', 60));
    centre.requestJump(centre.items.find((a: { id: string }) => a.id === 'target')); // A → B, its room load hangs
    await until(app, () => !!firstPage);
    centre.requestJump(centre.items.find((a: { id: string }) => a.id === 'second')); // already in B, its page hangs
    await until(app, () => !!around2);
    firstPage!({ has_more: true, oldest_seq: 200, messages: f.tail }); // the stale jump's await returns first
    for (let i = 0; i < 6; i++) await app.flush();
    around2!({ has_more: true, newer_more: true, oldest_seq: 58, messages: [f.msg(58), { ...f.msg(60), id: 'second' }, f.msg(61)] });
    await until(app, () => !!app.document.querySelector('.jump-hit[data-msg="second"]'));
    const by = (id: string) => centre.items.find((a: { id: string }) => a.id === id);
    assert.ok(app.document.querySelector('.jump-hit[data-msg="second"]'), 'the newest click lands');
    assert.equal(by('second').viewed, true);
    assert.equal(by('target').viewed, false);
    assert.equal(centre.jump, null);
  } finally { await app.close(); }
});

test('a preflight refusal (no project, another server) consumes the request: no replay on return (#322 review r2)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const app = await mountJump(context, f.rpc);
  const setVisible = async (v: boolean) => { app.window.__setVisible(v); for (let i = 0; i < 4; i++) await app.flush(); };
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    const missing = { ...alertFor('lost', 5), key: 'proj:nowhere|lost', room: 'proj:nowhere', session: 'nowhere', project: 'nowhere' };
    for (const a of [missing, alertFor('elsewhere', 9, 's2')]) {
      centre.record(a);
      centre.requestJump(centre.items.find((x: { key: string }) => x.key === a.key));
      for (let i = 0; i < 6; i++) await app.flush();
      const rec = centre.items.find((x: { key: string }) => x.key === a.key);
      assert.equal(centre.jump, null, `${a.id}: the refused request is spent`);
      assert.equal(rec.viewed, false);
      assert.ok(rec.failed, `${a.id}: the row says why`);
    }
    await setVisible(false);
    await setVisible(true);
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'fixture', 'no replay on return');
  } finally { await app.close(); }
});

test('a first-page poll in flight when a jump lands at the tail cannot reset the cursor or splice in its page (#322 review r2, generation alone)', { timeout: 60000 }, async (context) => {
  let first: ((v: unknown) => void) | null = null;
  const befores: number[] = [];
  const f = jumpFixture();
  const rpc = { ...f.rpc,
    hubLog: async (session: string, sinceTs = 0, _l = 100, beforeSeq = 0) => {
      if (session !== 'other') return { has_more: false, messages: [] };
      if (beforeSeq) { befores.push(beforeSeq); return { has_more: false, messages: [] }; }
      if (sinceTs === 0 && !first) return new Promise((r) => { first = r; });
      return { has_more: false, messages: [] };
    },
    // The page around the target reaches the room's newest message: no window.
    hubLogAround: async () => ({ has_more: true, newer_more: false, oldest_seq: 48, messages: f.around }) };
  const app = await mountJump(context, rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    app.document.querySelector<HTMLElement>('.proj-row[aria-label^="other"] .proj-pick')!.click();
    await until(app, () => !!first);
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.requestJump(centre.items[0]);
    await until(app, () => !!app.document.querySelector('.jump-hit[data-msg="target"]'));
    first!({ has_more: true, oldest_seq: 200, messages: f.tail });
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(app.document.querySelector('[data-msg="id209"]'), null, 'the stale first page did not splice a gap into the feed');
    app.document.querySelector<HTMLButtonElement>('.older-more')?.click();
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(befores.at(-1), 48, 'the cursor is still the jump page\'s');
  } finally { await app.close(); }
});

test('a manual room choice ends a pending jump at once, even B → C → B (#322 review r3)', { timeout: 60000 }, async (context) => {
  let bLoad: ((v: unknown) => void) | null = null;
  let arounds = 0;
  let bCalls = 0;
  const f = jumpFixture();
  const three = ['fixture', 'other', 'third'];
  const rpc = { ...f.rpc,
    projectList: async () => ({ projects: three.map((session) => ({ project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [] })) }),
    hubLog: async (session: string, sinceTs = 0) => {
      if (session === 'other' && sinceTs === 0 && ++bCalls === 1) return new Promise((r) => { bLoad = r; });
      if (session === 'third') return { has_more: false, messages: [{ ...f.msg(900), room: 'proj:third', id: 'c1' }] };
      return f.rpc.hubLog(session);
    },
    hubLogAround: async () => { arounds++; return { has_more: true, newer_more: true, oldest_seq: 48, messages: f.around }; } };
  const app = await mountJump(context, rpc);
  const pick = async (name: string) => {
    app.document.querySelector<HTMLElement>(`.proj-row[aria-label^="${name}"] .proj-pick`)!.click();
    await until(app, () => app.document.querySelector('.h1-text')?.textContent === name);
  };
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="third"]'));
    const centre = centreOf(app);
    // Above the manual tail (209), so reading B to its tail does not mark it.
    centre.record(alertFor('target', 999));
    centre.requestJump(centre.items[0]);
    await until(app, () => !!bLoad);
    await pick('third');
    assert.equal(centre.jump, null, 'the manual choice spent the pending jump at once');
    for (let i = 0; i < 4; i++) await app.flush();
    assert.ok(JSON.parse(app.window.localStorage.getItem('tmux_hub_seen') ?? '{}').third, 'C reads normally: markSeen is not held by the old jump');
    await pick('other');
    await until(app, () => !!app.document.querySelector('[data-msg="id209"]'));
    bLoad!({ has_more: true, oldest_seq: 200, messages: f.tail });
    for (let i = 0; i < 8; i++) await app.flush();
    assert.equal(arounds, 0, 'the old jump never asked for its page');
    assert.equal(app.document.querySelector('.jump-hit'), null, 'nothing ringed');
    assert.equal(centre.items[0].viewed, false);
    assert.ok(app.document.querySelector('[data-msg="id209"]'), 'the manual B reading is intact');
  } finally { await app.close(); }
});

// Board #432: the search box in the Hub header. A hit opens its message through
// the SAME jump the bell uses (`openAt`), but it is not a notification: nothing
// is recorded in the AlertLog, no bell state moves, and what the jump reports
// goes to the search generation that asked.
const searchHits = (f: ReturnType<typeof jumpFixture>) => [
  { ...f.msg(40, 'older talk about the reply'), id: 'older' },
  { ...f.msg(50, 'the reply you heard'), id: 'target' },
];
async function openSearch(app: { document: Document; window: any; flush: () => Promise<void>; advance: (ms: number) => Promise<void> }, query = 'reply') {
  const button = app.document.querySelector<HTMLButtonElement>('.head-tools button[aria-label="Search messages"]')!;
  button.click();
  await until(app, () => !!app.document.querySelector('.search-input'));
  const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
  input.value = query;
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.advance(300);                                       // the debounce runs on the harness clock
  await until(app, () => app.document.querySelectorAll('.sr-row').length > 0 || /No matches|failed/u.test(app.document.querySelector('.sr-status')?.textContent ?? ''));
}

test('a search hit opens its message through the bell’s jump, records no notification, and closes the box when it lands (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const asked: unknown[][] = [];
  const app = await mountJump(context, { ...f.rpc, hubSearch: async (...args: unknown[]) => { asked.push(args); return { messages: searchHits(f).map((m) => ({ ...m, room: 'proj:other' })), more: false }; } });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    await openSearch(app);
    assert.deepEqual(JSON.parse(JSON.stringify(asked[0])), ['fixture', ['reply'], { all: true, global: false, limit: 50 }], 'this room, every term, the default page');
    const rows = [...app.document.querySelectorAll<HTMLButtonElement>('.sr-row')];
    assert.equal(rows.length, 2);
    assert.match(rows[0]!.textContent ?? '', /the reply you heard/u, 'newest first');
    rows[0]!.click();
    await until(app, () => !!app.document.querySelector('.msg.jump-hit[data-msg="target"]'));
    assert.ok(app.document.querySelector('.msg.jump-hit[data-msg="target"]'), 'the message is on screen and ringed, in the room it was said');
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'other');
    await until(app, () => !app.document.querySelector('.search-bar'));
    assert.equal(app.document.querySelector('.search-bar'), null, 'it landed: the box closes');
    assert.equal(centre.items.length, 0, 'a search hit is not a notification: nothing recorded');
    assert.equal(centre.unviewed, 0, 'and the bell did not move');
  } finally { await app.close(); }
});

test('the box stays open while its own jump changes the room, and says so when the message is gone (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture({ hubLogAround: async () => ({ has_more: true, newer_more: true, oldest_seq: 48, messages: f0().around.filter((m: { id: string }) => m.id !== 'target') }) });
  function f0() { return jumpFixture(); }
  const app = await mountJump(context, { ...f.rpc, hubSearch: async () => ({ messages: searchHits(f).map((m) => ({ ...m, room: 'proj:other' })) }) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openSearch(app);
    app.document.querySelectorAll<HTMLButtonElement>('.sr-row')[0]!.click();
    await until(app, () => /no longer in the room/u.test(app.document.querySelector('.sr-notice')?.textContent ?? ''));
    assert.match(app.document.querySelector('.sr-notice')?.textContent ?? '', /Message no longer in the room/u, 'the failure is said where the user looked');
    assert.ok(app.document.querySelector('.search-bar'), 'the room changed under the box (its own jump) and it stayed');
    assert.equal(centreOf(app).items.length, 0, 'a failed search jump is not an alert either');
  } finally { await app.close(); }
});

test('choosing another project closes the box, and an answer still in flight lands nowhere (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  let answer: ((v: unknown) => void) | null = null;
  const app = await mountJump(context, { ...f.rpc, hubSearch: () => new Promise((r) => { answer = r; }) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const button = app.document.querySelector<HTMLButtonElement>('.head-tools button[aria-label="Search messages"]')!;
    button.click();
    await until(app, () => !!app.document.querySelector('.search-input'));
    const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'reply';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.advance(300);
    await until(app, () => !!answer);
    app.document.querySelector<HTMLElement>('.proj-row[aria-label^="other"] .proj-pick')!.click();
    await until(app, () => app.document.querySelector('.h1-text')?.textContent === 'other');
    assert.equal(app.document.querySelector('.search-bar'), null, 'a room-scoped answer belongs to the room it was asked in');
    answer!({ messages: searchHits(f).map((m) => ({ ...m, room: 'proj:fixture' })) });
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(app.document.querySelector('.sr-row'), null, 'the late answer is dropped');
    assert.equal(app.document.querySelector('.search-panel'), null);
  } finally { await app.close(); }
});

test('the bell’s centre and the search results are one popover at a time (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const app = await mountJump(context, { ...f.rpc, hubSearch: async () => ({ messages: [] }) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    const centre = centreOf(app);
    const anchor = app.document.querySelector<HTMLElement>('.head-tools button[aria-label="Search messages"]')!;
    centre.toggle(anchor);                                      // the centre is open
    assert.ok(centre.anchor);
    anchor.click();                                             // opening the search closes it
    await until(app, () => !!app.document.querySelector('.search-input'));
    assert.equal(centre.anchor, null, 'opening the search dismisses the centre');
    centre.toggle(anchor);                                      // and the centre opening dismisses the search
    await until(app, () => !app.document.querySelector('.search-input'));
    assert.equal(app.document.querySelector('.search-bar'), null);
  } finally { await app.close(); }
});

// Board #432, review round 1: a search-owned jump is CANCELLED when its generation goes stale (not
// merely unreported), a hidden Hub or one that lost its server's focus closes the box, and the
// agent filter lives in the search button. `ownedJump` is the centre n the box started and nothing else.
async function mountSearch(context: TestContext, rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const fixture = await compiledHost();
  return fixture.mount(context, {
    props: { visible: true, ...props },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.localStorage.setItem('tmux_hub_project', 'fixture');
      window.localStorage.setItem('tmux_server_current', 's1');
      window.HTMLMediaElement.prototype.play = () => Promise.resolve();
    },
    modules: [rpc as Record<string, (...args: any[]) => unknown>],
  });
}
type SearchApp = Awaited<ReturnType<typeof mountSearch>>;
/** A mouse double-click on an agent's card, the way the strip receives it. */
async function doubleClickCard(app: SearchApp, name: string) {
  const button = app.document.querySelector<HTMLElement>(`.acard[data-agent="${name}"] .agent-select`)!;
  for (const [type, detail] of [['click', 1], ['click', 2], ['dblclick', 2]] as const) {
    button.dispatchEvent(new app.window.MouseEvent(type, { detail, bubbles: true, cancelable: true }));
    await app.flush();
  }
}
/** The fixture where a hit lives in ANOTHER room and its `around` page is held until released. */
function heldAround(extra: Record<string, unknown> = {}, room = 'proj:other') {
  const f = jumpFixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let arounds = 0;
  const searched: unknown[][] = [];
  const rpc = {
    ...f.rpc,
    hubSearch: async (...args: unknown[]) => { searched.push(args); return { messages: searchHits(f).map((m) => ({ ...m, room, from: 'alice' })) }; },
    hubLogAround: async () => { arounds++; await gate; return { has_more: true, newer_more: true, oldest_seq: 48, messages: f.around }; },
    ...extra,
  };
  return { f, rpc, release: () => release(), arounds: () => arounds, searched };
}

test('closing the box cancels the jump it started: the late answer moves nothing, and the bell’s own jump still lands (#432)', { timeout: 60000 }, async (context) => {
  const h = heldAround();
  const app = await mountSearch(context, h.rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openSearch(app);
    app.document.querySelectorAll<HTMLButtonElement>('.sr-row')[0]!.click();
    await until(app, () => h.arounds() === 1);
    const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await app.flush();
    assert.equal(app.document.querySelector('.search-bar'), null, 'Escape closed the box');
    h.release();
    for (let i = 0; i < 10; i++) await app.flush();
    assert.equal(app.document.querySelector('[data-msg="target"]'), null, 'the cancelled jump’s page was never put on screen');
    assert.notEqual(app.document.querySelector('.to-tail')?.getAttribute('aria-label'), 'Back to latest', 'no history window: the reader is still on the room’s tail');
    assert.ok(app.document.querySelector('[data-msg="id209"]'), 'the reading is what the person was looking at');
    const centre = centreOf(app);
    centre.record(alertFor());
    centre.requestJump(centre.items[0]);
    await until(app, () => !!app.document.querySelector('.msg.jump-hit[data-msg="target"]'));
    assert.ok(app.document.querySelector('.msg.jump-hit[data-msg="target"]'), 'a bell jump after the cancelled one is not swallowed by it');
  } finally { await app.close(); }
});

test('typing a new query cancels the jump the box started, too (#432)', { timeout: 60000 }, async (context) => {
  const h = heldAround();
  const app = await mountSearch(context, h.rpc);
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openSearch(app);
    app.document.querySelectorAll<HTMLButtonElement>('.sr-row')[0]!.click();
    await until(app, () => h.arounds() === 1);
    const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'another word';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    h.release();
    for (let i = 0; i < 10; i++) await app.flush();
    assert.equal(app.document.querySelector('[data-msg="target"]'), null, 'the old answer did not land');
    assert.ok(app.document.querySelector('.search-bar'), 'and the box the reader is typing in was not closed by the old jump’s report');
  } finally { await app.close(); }
});

test('a hidden Hub, or one whose server lost the focus, closes the box at once; nothing fills it or returns with the page (#432)', { timeout: 60000 }, async (context) => {
  for (const leave of ['hidden', 'unfocused'] as const) {
    let answer: ((v: unknown) => void) | null = null;
    const f = jumpFixture();
    const app = await mountSearch(context, { ...f.rpc, hubSearch: () => new Promise((r) => { answer = r; }) });
    try {
      await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
      app.document.querySelector<HTMLButtonElement>('.head-tools button[aria-label="Search messages"]')!.click();
      await until(app, () => !!app.document.querySelector('.search-input'));
      const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
      input.value = 'reply';
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
      await app.advance(300);
      await until(app, () => !!answer);
      if (leave === 'hidden') { app.window.__setVisible(false); await app.flush(); } else await app.setScope({ eligible: false });
      assert.equal(app.document.querySelector('.search-bar'), null, `${leave}: closed at once`);
      answer!({ messages: searchHits(f).map((m) => ({ ...m, room: 'proj:fixture' })) });
      for (let i = 0; i < 6; i++) await app.flush();
      assert.equal(app.document.querySelector('.sr-row'), null, `${leave}: the late answer fills nothing`);
      if (leave === 'hidden') { app.window.__setVisible(true); await app.flush(); } else await app.setScope({ eligible: true });
      for (let i = 0; i < 4; i++) await app.flush();
      assert.equal(app.document.querySelector('.search-bar'), null, `${leave}: and nothing comes back with the page`);
      assert.equal(app.document.querySelector('.sr-row'), null);
    } finally { await app.close(); }
  }
});

test('double-click puts the agent filter on the search button; the funnel is gone; the token and Back take it off (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const searched: unknown[][] = [];
  let back: () => boolean = () => false;
  const app = await mountSearch(context, { ...f.rpc, hubSearch: async (...a: unknown[]) => { searched.push(a); return { messages: [] }; } },
    { onGoBack: (fn: () => boolean) => { back = fn; } });
  try {
    await until(app, () => !!app.document.querySelector('.acard[data-agent="bob"]'));
    const face = () => app.document.querySelector<HTMLElement>('.head-tools .filter-face');
    assert.equal(face(), null, 'no filter, the plain search icon');
    await doubleClickCard(app, 'bob');
    assert.ok(app.document.querySelector('.cards.filtering'), 'the feed is filtered, as before');
    assert.ok(app.document.querySelector('.acard[data-agent="bob"].filtered'), 'and the card is lit while the others dim, as before');
    assert.equal(app.document.querySelector('.agent-filter'), null, 'the funnel on the card is gone (owner: 原来的标识不要了)');
    assert.equal(face()?.textContent?.trim(), 'bob', 'the search button wears the agent');
    assert.equal(face()!.querySelector('button')!.getAttribute('aria-label'), 'Search · only bob', 'and its accessible name says it is the search, and for whom');
    face()!.querySelector('button')!.click();
    await until(app, () => !!app.document.querySelector('.search-token'));
    assert.equal(app.document.querySelector('.search-token .token-name')?.textContent, 'bob', 'the box shows the filter as its scope');
    const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'reply';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.advance(300);
    await until(app, () => searched.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(searched[0])), ['fixture', ['reply'], { all: true, global: false, from: 'bob', limit: 50 }], 'the filter scopes the request by sender');

    // Back: the box first, then the filter.
    assert.equal(back(), true);
    await app.flush();
    assert.equal(app.document.querySelector('.search-bar'), null, 'Back closed the box');
    assert.ok(app.document.querySelector('.cards.filtering'), 'and left the reading filter');
    assert.equal(back(), true);
    await app.flush();
    assert.equal(app.document.querySelector('.cards.filtering'), null, 'the next Back peels the filter');
    assert.equal(face(), null);

    // The token’s x and Backspace in an empty field are the same toggle.
    await doubleClickCard(app, 'bob');
    face()!.querySelector('button')!.click();
    await until(app, () => !!app.document.querySelector('.search-token'));
    app.document.querySelector<HTMLButtonElement>('.search-token button')!.click();
    await app.flush();
    assert.equal(app.document.querySelector('.cards.filtering'), null, 'the x unfilters the feed');
    assert.equal(app.document.querySelector('.search-token'), null);
    await doubleClickCard(app, 'bob');
    const field = app.document.querySelector<HTMLInputElement>('.search-input')!;
    assert.ok(field, 'the box is still open and now shows the new filter');
    assert.equal(app.document.querySelector('.search-token .token-name')?.textContent, 'bob', 'a filter set while the box is open reaches the box');
    field.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    await app.flush();
    assert.equal(app.document.querySelector('.cards.filtering'), null, 'Backspace in an empty field takes the token, and the filter, off');
  } finally { await app.close(); }
});

test('a user’s filter change cancels the jump the box started; the jump’s OWN filter clear does not (#432)', { timeout: 60000 }, async (context) => {
  // 1) alice is the filter, the box scoped to her; a hit's around page is held; the user double-clicks bob.
  let h = heldAround();
  let app = await mountSearch(context, h.rpc);
  try {
    await until(app, () => !!app.document.querySelector('.acard[data-agent="bob"]'));
    await doubleClickCard(app, 'alice');
    app.document.querySelector<HTMLButtonElement>('.head-tools .filter-face button')!.click();
    await until(app, () => !!app.document.querySelector('.search-input'));
    const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'reply';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.advance(300);
    await until(app, () => app.document.querySelectorAll('.sr-row').length > 0);
    app.document.querySelectorAll<HTMLButtonElement>('.sr-row')[0]!.click();
    await until(app, () => h.arounds() === 1);
    const asked = h.searched.length;
    await doubleClickCard(app, 'bob');                       // a NEW intent while the old jump is in flight
    await until(app, () => h.searched.length > asked);
    assert.deepEqual(JSON.parse(JSON.stringify(h.searched.at(-1))), ['other', ['reply'], { all: true, global: false, from: 'bob', limit: 50 }],
      'the user’s change is a new question: asked again at once, for bob, in the room the reader is now in (not merely adopted)');
    h.release();
    for (let i = 0; i < 10; i++) await app.flush();
    assert.equal(app.document.querySelector('[data-msg="target"]'), null, 'the old jump did not land after the user changed the filter');
    assert.ok(app.document.querySelector('.search-bar'), 'its report did not close the box the user just re-scoped');
    assert.equal(app.document.querySelector('.search-token .token-name')?.textContent, 'bob', 'the box follows the user’s filter');
    assert.ok(app.document.querySelector('.cards.filtering'), 'and the user’s filter stands: the old jump did not clear it');
  } finally { await app.close(); }

  // 2) the jump clears the filter ITSELF (openAt’s visible clear, a hit in the SAME room) and still
  // completes and reports.
  h = heldAround({}, 'proj:fixture');
  app = await mountSearch(context, h.rpc);
  try {
    await until(app, () => !!app.document.querySelector('.acard[data-agent="bob"]'));
    await doubleClickCard(app, 'alice');
    app.document.querySelector<HTMLButtonElement>('.head-tools .filter-face button')!.click();
    await until(app, () => !!app.document.querySelector('.search-input'));
    const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'reply';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.advance(300);
    await until(app, () => app.document.querySelectorAll('.sr-row').length > 0);
    app.document.querySelectorAll<HTMLButtonElement>('.sr-row')[0]!.click();
    await until(app, () => h.arounds() === 1);
    h.release();
    await until(app, () => !!app.document.querySelector('.msg.jump-hit[data-msg="target"]'));
    assert.ok(app.document.querySelector('.msg.jump-hit[data-msg="target"]'), 'the jump landed although it cleared the filter it was scoped by');
    await until(app, () => !app.document.querySelector('.search-bar'));
    assert.equal(app.document.querySelector('.search-bar'), null, 'and reported: the box closed');
    assert.equal(app.document.querySelector('.cards.filtering'), null, 'the filter was cleared for the jump, visibly');
    assert.match(app.document.querySelector('.jump-note')?.textContent ?? '', /./u, 'with the note that says so');
  } finally { await app.close(); }
});

test('a hit in ANOTHER room still lands while the agent filter is on: the room switch it causes is its own (#432 validator X5)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const app = await mountSearch(context, { ...f.rpc, hubSearch: async () => ({ messages: searchHits(f).map((m) => ({ ...m, room: 'proj:other', from: 'alice' })) }) });
  try {
    await until(app, () => !!app.document.querySelector('.acard[data-agent="alice"]'));
    await doubleClickCard(app, 'alice');
    app.document.querySelector<HTMLButtonElement>('.head-tools .filter-face button')!.click();
    await until(app, () => !!app.document.querySelector('.search-input'));
    const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
    input.value = 'reply';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.advance(300);
    await until(app, () => app.document.querySelectorAll('.sr-row').length > 0);
    app.document.querySelectorAll<HTMLButtonElement>('.sr-row')[0]!.click();
    await until(app, () => !!app.document.querySelector('.msg.jump-hit[data-msg="target"]'));
    assert.ok(app.document.querySelector('.msg.jump-hit[data-msg="target"]'), 'the room switch resets the filter as part of the jump, and the jump is not cancelled by it');
    assert.equal(app.document.querySelector('.h1-text')?.textContent, 'other');
    await until(app, () => !app.document.querySelector('.search-bar'));
    assert.equal(app.document.querySelector('.search-bar'), null, 'and it reported: the box closed');
  } finally { await app.close(); }
});

test('destroying the Hub clears the box’s pending request: nothing is asked after it is gone (#432 validator X6)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const asked: unknown[] = [];
  const app = await mountSearch(context, { ...f.rpc, hubSearch: async (...a: unknown[]) => { asked.push(a); return { messages: [] }; } });
  await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
  app.document.querySelector<HTMLButtonElement>('.head-tools button[aria-label="Search messages"]')!.click();
  await until(app, () => !!app.document.querySelector('.search-input'));
  const input = app.document.querySelector<HTMLInputElement>('.search-input')!;
  input.value = 'reply';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();                                       // typed; the debounce has not fired
  await app.unmount();
  await app.advance(1000);
  assert.deepEqual(asked, [], 'the destroyed Hub’s timer did not fire a request');
  await app.close();
});

// Board #432, Files mode. A file row opens the file against the project that NAMED it (its
// room), never the selected one: "all rooms" lists files from other projects, and a relative
// path means the project it was said in. Everything after an await is checked against the
// search generation that asked.
const fileRow = (path: string, room = 'proj:fixture', over: Record<string, unknown> = {}) => ({ path, line: null, col: null, room, id: 'i1', seq: 5, ts: 1_050, from: 'alice', count: 1, ...over });
async function openFilesMode(app: SearchApp) {
  app.document.querySelector<HTMLButtonElement>('.head-tools button[aria-label="Search messages"]')!.click();
  await until(app, () => !!app.document.querySelector('.search-input'));
  const files = [...app.document.querySelectorAll<HTMLButtonElement>('.search-panel button')].find((b) => b.textContent?.trim() === 'Files')!;
  files.click();
  await until(app, () => app.document.querySelectorAll('.sr-file').length > 0);
}

test('a file opens against the project that named it: its folder resolves a relative path, the selected project’s tab opens by its own session, and ~ and absolute paths pass through (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const routes: unknown[][] = [];
  const asked: unknown[][] = [];
  const rows = [
    fileRow('src/own.md'), fileRow('src/theirs.md', 'proj:other'), fileRow('/srv/abs.pdf', 'proj:other'), fileRow('~/notes.md'), fileRow('./lead.md', 'proj:other'),
  ];
  const app = await mountSearch(context, { ...f.rpc, hubFiles: async (...a: unknown[]) => { asked.push(a); return { files: rows, next: null, scanned: 4 }; } }, { mobile: true, openFilesTab: (...a: unknown[]) => routes.push(a) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openFilesMode(app);
    assert.deepEqual(JSON.parse(JSON.stringify(asked[0])), ['fixture', [], { all: true, global: false, limit: 50 }], 'this room, no word needed');
    const open = async (n: number) => {
      app.document.querySelectorAll<HTMLButtonElement>('.sr-file .sr-row')[n]!.click();
      await until(app, () => routes.length > 0 && !app.document.querySelector('.search-bar'));
      const got = routes.splice(0).map((r) => JSON.parse(JSON.stringify(r)));
      return got[0];
    };
    assert.deepEqual(await open(0), ['fixture', '', '/fixture/src/own.md'], 'the selected project: its own folder');
    assert.equal(app.document.querySelector('.search-bar'), null, 'opening closes the box');
    for (const [n, want] of [[1, ['other', '', '/other/src/theirs.md']], [2, ['other', '', '/srv/abs.pdf']], [3, ['fixture', '', '~/notes.md']], [4, ['other', '', '/other/lead.md']]] as const) {
      await openFilesMode(app);
      assert.deepEqual(await open(n), want, `row ${n}`);
    }
  } finally { await app.close(); }
});

test('a project with no declared folder asks where it is, and says so when it cannot be found; a row whose project is gone opens nothing (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const routes: unknown[][] = [];
  const cwds: string[] = [];
  const rpc = {
    ...f.rpc,
    projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({ project: { id: session, name: session, session, path: '' }, live: true, slots: [] })) }),
    fsCwd: async (session: string) => { cwds.push(session); return session === 'other' ? { path: '/where/other' } : { path: '' }; },
    hubFiles: async () => ({ files: [fileRow('a.md', 'proj:other'), fileRow('b.md', 'proj:fixture'), fileRow('c.md', 'proj:vanished')], next: null, scanned: 3 }),
  };
  const app = await mountSearch(context, rpc, { mobile: true, openFilesTab: (...a: unknown[]) => routes.push(a) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openFilesMode(app);
    const rowsEl = () => app.document.querySelectorAll<HTMLButtonElement>('.sr-file .sr-row');
    rowsEl()[0]!.click();
    await until(app, () => routes.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(routes[0])), ['other', '', '/where/other/a.md'], 'the row’s own project was asked, not the selected one');
    assert.deepEqual(cwds, ['other']);
    routes.length = 0;
    await openFilesMode(app);
    rowsEl()[1]!.click();
    await until(app, () => /project folder is unknown/u.test(app.document.querySelector('.sr-notice')?.textContent ?? ''));
    assert.match(app.document.querySelector('.sr-notice')?.textContent ?? '', /project folder is unknown/u);
    assert.deepEqual(routes, [], 'nothing opened');
    assert.ok(app.document.querySelector('.search-bar'), 'and the box stays, saying why');
    rowsEl()[2]!.click();
    await until(app, () => /no longer|not found|no project/iu.test(app.document.querySelector('.sr-notice')?.textContent ?? '') && !/project folder is unknown/u.test(app.document.querySelector('.sr-notice')?.textContent ?? ''));
    assert.deepEqual(routes, [], 'a row of a project that is gone opens nothing');
  } finally { await app.close(); }
});

test('a file that was being resolved when the box closed is not opened afterwards (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const routes: unknown[][] = [];
  let release: (v: { path: string }) => void = () => {};
  const rpc = {
    ...f.rpc,
    projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({ project: { id: session, name: session, session, path: '' }, live: true, slots: [] })) }),
    fsCwd: () => new Promise<{ path: string }>((r) => { release = r; }),
    hubFiles: async () => ({ files: [fileRow('a.md', 'proj:other')], next: null, scanned: 1 }),
  };
  const app = await mountSearch(context, rpc, { mobile: true, openFilesTab: (...a: unknown[]) => routes.push(a) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openFilesMode(app);
    app.document.querySelector<HTMLButtonElement>('.sr-file .sr-row')!.click();
    await app.flush();
    app.document.querySelector<HTMLButtonElement>('.search-bar button[aria-label="Close search"]')!.click();
    await until(app, () => !app.document.querySelector('.search-bar'));
    release({ path: '/late' });
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(routes, [], 'the answer arrived for a box that is gone');
  } finally { await app.close(); }
});

test('the Files request carries the scope, the agent filter as the sender and the page cursor, exactly as Messages does (#432)', { timeout: 60000 }, async (context) => {
  const f = jumpFixture();
  const asked: unknown[][] = [];
  const app = await mountSearch(context, {
    ...f.rpc,
    hubFiles: async (...a: unknown[]) => { asked.push(JSON.parse(JSON.stringify(a))); return { files: [fileRow('a.md', 'proj:fixture', { from: 'alice' })], next: asked.length < 3 ? 42 : null, scanned: 10 }; },
  });
  try {
    await until(app, () => !!app.document.querySelector('.acard[data-agent="alice"]'));
    await doubleClickCard(app, 'alice');                                   // the agent filter: the chip wears alice
    app.document.querySelector<HTMLButtonElement>('.head-tools .filter-face button')!.click();
    await until(app, () => !!app.document.querySelector('.search-input'));
    [...app.document.querySelectorAll<HTMLButtonElement>('.search-panel button')].find((b) => b.textContent?.trim() === 'Files')!.click();
    await until(app, () => asked.length > 0);
    assert.deepEqual(asked[0], ['fixture', [], { all: true, global: false, from: 'alice', limit: 50 }], 'this room, no word, only alice’s messages');
    [...app.document.querySelectorAll<HTMLButtonElement>('.search-panel button')].find((b) => b.textContent?.trim() === 'All rooms')!.click();
    await until(app, () => asked.length > 1);
    assert.deepEqual(asked[1], ['fixture', [], { all: true, global: true, from: 'alice', limit: 50 }], 'every room, same sender');
    await until(app, () => !![...app.document.querySelectorAll<HTMLButtonElement>('.search-panel button')].find((b) => b.textContent?.trim() === 'Read older messages'));
    [...app.document.querySelectorAll<HTMLButtonElement>('.search-panel button')].find((b) => b.textContent?.trim() === 'Read older messages')!.click();
    await until(app, () => asked.length > 2);
    assert.deepEqual(asked[2], ['fixture', [], { all: true, global: true, from: 'alice', limit: 50, before: 42 }], 'the cursor of the page before, nothing else changed');
  } finally { await app.close(); }
});

// Board #432 review P1-B: a file row is stamped with the project that named it (id, session,
// declared folder) when the answer lands, and opening checks it is still THAT project, both
// at the click and again after any lookup. The Hub refreshes its project list every 20 s,
// which does not touch the search, so a list can outlive the project it came from.
function movableProjects() {
  const state = { projects: ['fixture', 'other'].map((session) => ({ id: session, name: session, session, path: `/${session}` } as Record<string, unknown>)) };
  const f = jumpFixture();
  const rpc = {
    ...f.rpc,
    projectList: async () => ({ projects: state.projects.map((project) => ({ project, live: true, slots: [] })) }),
  };
  return { state, rpc };
}
async function reloadProjects(app: SearchApp, until_: () => boolean = () => true) {
  await app.advance(20000);
  await until(app, until_);
}
const noticeOf = (app: SearchApp) => app.document.querySelector('.sr-notice')?.textContent ?? '';

test('a project that changed after the list was made opens nothing: a new folder, a recreated project, another room (#432 review P1-B)', { timeout: 120000 }, async (context) => {
  for (const [label, change] of [
    ['a new declared folder', (s: ReturnType<typeof movableProjects>['state']) => { s.projects[1]!.path = '/moved'; }],
    ['deleted and recreated under the same name', (s: ReturnType<typeof movableProjects>['state']) => { s.projects[1] = { id: 'other-2', name: 'other', session: 'other', path: '/other' }; }],
    ['its room mapping changed', (s: ReturnType<typeof movableProjects>['state']) => { s.projects[1]!.room = 'proj:elsewhere'; }],
  ] as const) {
    const { state, rpc } = movableProjects();
    const routes: unknown[][] = [];
    const app = await mountSearch(context, { ...rpc, hubFiles: async () => ({ files: [fileRow('a.md', 'proj:other')], next: null, scanned: 1 }) }, { mobile: true, openFilesTab: (...a: unknown[]) => routes.push(a) });
    try {
      await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
      await openFilesMode(app);
      change(state);
      await reloadProjects(app);
      app.document.querySelector<HTMLButtonElement>('.sr-file .sr-row')!.click();
      await until(app, () => /has changed since/u.test(noticeOf(app)));
      assert.match(noticeOf(app), /That project has changed since this list was made/u, label);
      assert.deepEqual(routes, [], `${label}: nothing opened`);
      assert.ok(app.document.querySelector('.search-bar'), `${label}: and the box stays, saying why`);
    } finally { await app.close(); }
  }
});

test('a changed project is said for an absolute path too, and before its folder is asked at all (#432 review P1-B)', { timeout: 120000 }, async (context) => {
  const { state, rpc } = movableProjects();
  state.projects[1]!.path = '';
  const routes: unknown[][] = [];
  const cwds: string[] = [];
  const app = await mountSearch(context, {
    ...rpc,
    fsCwd: async (session: string) => { cwds.push(session); return { path: '/asked' }; },
    hubFiles: async () => ({ files: [fileRow('/srv/abs.md', 'proj:other'), fileRow('rel.md', 'proj:other')], next: null, scanned: 1 }),
  }, { mobile: true, openFilesTab: (...a: unknown[]) => routes.push(a) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openFilesMode(app);
    state.projects[1] = { id: 'other-2', name: 'other', session: 'other', path: '' };
    await reloadProjects(app);
    const rowsEl = () => app.document.querySelectorAll<HTMLButtonElement>('.sr-file .sr-row');
    rowsEl()[0]!.click();                                              // absolute: no lookup, still checked
    await until(app, () => /has changed since/u.test(noticeOf(app)));
    assert.match(noticeOf(app), /has changed since/u);
    app.document.querySelector<HTMLButtonElement>('.sr-notice')?.remove();
    rowsEl()[1]!.click();                                              // relative with no declared folder: refused before fsCwd
    await app.flush();
    assert.deepEqual([routes, cwds], [[], []], 'nothing opened, and no folder was asked for a project that is not the one');
  } finally { await app.close(); }
});

test('a project that changes while its folder is being asked is not opened against the answer (#432 review P1-B)', { timeout: 120000 }, async (context) => {
  const { state, rpc } = movableProjects();
  state.projects[1]!.path = '';
  const routes: unknown[][] = [];
  let release: (v: { path: string }) => void = () => {};
  const app = await mountSearch(context, {
    ...rpc,
    fsCwd: () => new Promise<{ path: string }>((r) => { release = r; }),
    hubFiles: async () => ({ files: [fileRow('a.md', 'proj:other')], next: null, scanned: 1 }),
  }, { mobile: true, openFilesTab: (...a: unknown[]) => routes.push(a) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openFilesMode(app);
    app.document.querySelector<HTMLButtonElement>('.sr-file .sr-row')!.click();
    await app.flush();
    state.projects[1] = { id: 'other-2', name: 'other', session: 'other', path: '' };   // recreated while asking
    await reloadProjects(app);
    release({ path: '/where/the/old/one/was' });
    await until(app, () => /has changed since/u.test(noticeOf(app)));
    assert.match(noticeOf(app), /has changed since/u);
    assert.deepEqual(routes, [], 'the folder of the old project was not used for the new one');
  } finally { await app.close(); }
});

test('two projects with the same relative path each open their own file, from the same list (#432 review P1-B)', { timeout: 120000 }, async (context) => {
  const { rpc } = movableProjects();
  const routes: unknown[][] = [];
  const app = await mountSearch(context, {
    ...rpc,
    hubFiles: async () => ({ files: [fileRow('README.md', 'proj:fixture'), fileRow('README.md', 'proj:other')], next: null, scanned: 2 }),
  }, { mobile: true, openFilesTab: (...a: unknown[]) => routes.push(a) });
  try {
    await until(app, () => !!app.document.querySelector('.proj-row[aria-label^="other"]'));
    await openFilesMode(app);
    for (const n of [0, 1]) {
      if (n) await openFilesMode(app);
      app.document.querySelectorAll<HTMLButtonElement>('.sr-file .sr-row')[n]!.click();
      await until(app, () => routes.length > n);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(routes)), [['fixture', '', '/fixture/README.md'], ['other', '', '/other/README.md']]);
  } finally { await app.close(); }
});

test('a review feedback block lands in the LIVE composer after the typed text; a late automatic recipient only when nobody chose (#434)', { timeout: 60000 }, async (context) => {
  const app = await composerFixture(context, {
    hubLog: async () => ({ messages: [
      { id: 'm1', seq: 1, ts: 100, from: 'alice', body: 'first' },
      { id: 'm2', seq: 2, ts: 200, from: 'bob', body: 'last agent to post' },
      { id: 'm3', seq: 3, ts: 300, from: 'human', body: 'me' },
    ], has_more: false }),
  });
  try {
    const state = (app.window as any).__serverState;
    const gen = () => state.review.intents.get('fixture') ?? 0;
    const composer = () => [...state.review.composers].find((c: any) => c.session() === 'fixture') as { append: (b: string, auto: boolean) => void };
    // What `landFeedback` does with the generation captured at the ask.
    const land = async (intent: number, block: string) => { composer().append(block, gen() === intent); await app.flush(); };
    assert.ok(composer(), 'the Hub showing the room registered its composer');

    // The current recipient is an agent: it is kept, and the block goes after
    // what the person had typed.
    await app.text('typed first');
    await land(gen(), '[Document feedback on /f — 1 comment]');
    assert.equal(app.input.value, 'typed first\n\n[Document feedback on /f — 1 comment]');
    assert.equal(selectedCard(app.document), 'alice');

    // Record only, chosen BEFORE the ask, and nobody chose since: the last
    // agent that posted is preselected. Nothing is sent.
    await app.to('note');
    await app.text('');
    await land(gen(), 'B1');
    assert.equal(selectedCard(app.document), 'bob');
    assert.equal(app.input.value, 'B1');

    // empty → alice → empty while the block was in flight: the person's last
    // choice stands (ABA, by generation, never by value).
    await app.to('note');
    let asked = gen();
    await app.to('alice'); await app.to('note');
    await land(asked, 'B2');
    assert.equal(selectedCard(app.document), '', 'record-only, chosen again meanwhile, is kept');

    // alice → bob → alice: the same.
    await app.to('alice');
    asked = gen();
    await app.to('bob'); await app.to('alice');
    await land(asked, 'B3');
    assert.equal(selectedCard(app.document), 'alice');
    assert.equal(app.input.value, 'B1\n\nB2\n\nB3', 'each block landed once, in order');
  } finally { await app.close(); }
});

// Board #447: the chat image's viewer. Before it the Hub took whatever URL an image's signature
// finally returned and opened it; now each tap takes a claim, an open is one record of URL and
// reference, and the Hub (kept mounted, only toggled) retires it on its own visible/eligible gate.
test('a chat image opens a viewer that can save its file; a late signature never opens after a hide/show or an eligibility round trip (#447)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const shot = { id: 'm1', seq: 1, ts: 100, from: 'alice', body: 'look ![](/fixture/shot.png)' };
  const pending: Array<{ path: string; done: (value: { url: string; name: string }) => void }> = [];
  const signed: string[] = [];
  let gate = false;
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.HTMLCanvasElement.prototype.getContext = () => null;
      (window as any).fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } });
      window.URL.createObjectURL = () => 'blob:x';
      window.URL.revokeObjectURL = () => {};
    },
    modules: [{
      ...rpc,
      hubLog: async () => ({ messages: [shot], has_more: false }),
      fsDownloadHttp: (path: string) => {
        signed.push(path);
        if (!gate) return Promise.resolve({ url: `https://dl.test/?p=${encodeURIComponent(path)}`, name: 'shot.png' });
        return new Promise((done) => pending.push({ path, done: done as never }));
      },
    }],
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  const tap = async () => { app.document.querySelector<HTMLButtonElement>('.feed .shots .ci-link')!.click(); await settle(4); };
  const lb = () => app.document.querySelector('.lb img');
  const answer = async (i: number) => { pending[i]!.done({ url: 'https://dl.test/late.png', name: 'shot.png' }); await settle(4); };
  try {
    await settle();
    assert.ok(app.document.querySelector('.feed .shots .ci-link'), 'the agent\u2019s picture is a thumbnail button');
    // 1. an ordinary tap opens a viewer that offers the file, and the download signs at ITS tap.
    await tap();
    assert.ok(lb(), 'opened');
    const before = signed.length;
    app.document.querySelector<HTMLButtonElement>('.lb .lb-download')!.click(); await settle(8);
    assert.equal(signed.length, before + 1, 'one signature for the download tap');
    assert.equal(signed.at(-1), '/fixture/shot.png', 'for the reference of the tap');
    app.document.querySelector<HTMLButtonElement>('.lb .lb-close')!.click(); await settle(4);
    assert.equal(lb(), null);
    // 2. hide/show with the signature held: the late answer opens nothing.
    gate = true;
    await tap();
    const held = pending.length - 1;
    await app.setProps({ visible: false }); await app.setProps({ visible: true });
    await answer(held);
    assert.equal(lb(), null, 'the claim died on the hide');
    // 3. the same on an eligibility round trip, room and path unchanged.
    await tap();
    const heldAgain = pending.length - 1;
    await app.setScope({ eligible: false }); await app.setScope({ eligible: true });
    await answer(heldAgain);
    assert.equal(lb(), null, 'the ABA of eligible false/true');
    // 4. an open viewer closes on the hide edge and stays closed on return.
    gate = false;
    await tap();
    assert.ok(lb(), 'a fresh tap opens');
    await app.setProps({ visible: false });
    assert.equal(lb(), null, 'closed in the same tick');
    await app.setProps({ visible: true });
    assert.equal(lb(), null, 'and not reopened');
  } finally { for (const p of pending) p.done({ url: 'https://dl.test/x', name: 'x' }); await app.close(); }
});

test('a room switch retires the viewer and the claim: a held signature from the old room opens nothing, and an open viewer closes (#447)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const shot = { id: 'm1', seq: 1, ts: 100, from: 'alice', body: 'look ![](/fixture/shot.png)' };
  const pending: Array<(value: { url: string; name: string }) => void> = [];
  let gate = true;
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) { window.Element.prototype.getAnimations = () => []; window.HTMLCanvasElement.prototype.getContext = () => null; },
    modules: [{
      ...rpc,
      projectList: async () => ({ projects: ['fixture', 'other'].map((session) => ({
        project: { id: session, name: session, session, path: `/${session}` }, live: true, slots: [],
      })) }),
      hubLog: async (session: string) => ({ messages: session === 'fixture' ? [shot] : [], has_more: false }),
      fsDownloadHttp: (path: string) => gate
        ? new Promise((done) => pending.push(done as never))
        : Promise.resolve({ url: `https://dl.test/?p=${encodeURIComponent(path)}`, name: 'shot.png' }),
    }],
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  const room = async (name: string) => {
    app.document.querySelector<HTMLElement>(`[aria-label="${name}"] .proj-pick`)!.click();
    for (let i = 0; i < 20 && app.document.querySelector('.h1-text')?.textContent !== name; i++) await app.flush();
  };
  const tap = async () => { app.document.querySelector<HTMLButtonElement>('.feed .shots .ci-link')!.click(); await settle(4); };
  try {
    await room('fixture'); await settle();
    // 1. a tap in `fixture`, its signature held; the reader moves to `other`; the answer arrives late.
    await tap();
    const held = pending.length - 1;
    await room('other'); await settle();
    pending[held]!({ url: 'https://dl.test/late.png', name: 'shot.png' }); await settle(4);
    assert.equal(app.document.querySelector('.lb img'), null, 'a tap made in another room opens nothing here');
    // 2. an open viewer does not outlive its room.
    gate = false;
    await room('fixture'); await settle();
    await tap();
    assert.ok(app.document.querySelector('.lb img'), 'opened in fixture');
    await room('other'); await settle();
    assert.equal(app.document.querySelector('.lb img'), null, 'closed with its room');
  } finally { for (const done of pending) done({ url: 'https://dl.test/x', name: 'x' }); await app.close(); }
});

test('a local attachment that opens while a chat image\'s signature is held cannot be overwritten by that late answer (#447 review P1-A)', { timeout: 60000 }, async (context) => {
  const fixture = await compiledHub();
  const { rpc } = roomFixture();
  const shot = { id: 'm1', seq: 1, ts: 100, from: 'alice', body: 'look ![](/fixture/shot.png)' };
  const pending: Array<(value: { url: string; name: string }) => void> = [];
  const app = await fixture.mount(context, {
    props: { visible: true },
    setup(window) {
      const w = window as any;
      w.Element.prototype.getAnimations = () => [];
      w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
      w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, measureText: () => ({ width: 8 }) });
      w.HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob) => void) { cb(new w.Blob(['img'], { type: 'image/webp' })); };
      w.URL.createObjectURL = () => 'blob:thumb';
      w.URL.revokeObjectURL = () => {};
    },
    modules: [{
      ...rpc,
      hubLog: async () => ({ messages: [shot], has_more: false }),
      fsMkdir: async () => ({}),
      fsUpload: async () => ({}),
      fsDownloadHttp: () => new Promise((done) => pending.push(done as never)),
    }],
  });
  const settle = async (n = 12) => { for (let i = 0; i < n; i++) await app.flush(); };
  const lb = () => app.document.querySelector<HTMLImageElement>('.lb img');
  try {
    await settle();
    pending.length = 0;
    app.document.querySelector<HTMLButtonElement>('.feed .shots .ci-link')!.click(); await settle(4);   // A, held
    const held = pending.length - 1;
    const picker = app.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, 'files', { value: [new app.window.File(['raw'], 'shot.png', { type: 'image/png' })] });
    picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    for (let i = 0; i < 20 && !app.document.querySelector('.pend-thumb button'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.pend-thumb button')!.click(); await settle(4);
    assert.equal(lb()?.getAttribute('src'), 'blob:thumb', 'B (the attachment) opened at once');
    pending[held]!({ url: 'https://dl.test/late-a.png', name: 'shot.png' }); await settle(4);
    assert.equal(lb()?.getAttribute('src'), 'blob:thumb', 'A\u2019s late answer does not replace the later open');
    assert.equal(app.document.querySelector('.lb .lb-download'), null, 'and the local picture has no download');
  } finally { for (const done of pending) done({ url: 'https://dl.test/x', name: 'x' }); await app.close(); }
});

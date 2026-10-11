// Board #324: the scratch panel's lifecycle — lazy ensure on open, focus in
// and back, close hides (the session lives on), Kill ends it after a
// confirmation, and a server switch drops every pending completion and never
// ensures again by itself.
// Board #326: opening converges on a LIVE session from every state the panel
// knows about — an ended one included, which is what left the owner opening
// the panel on a bare "Session ended" line — while `ready` still trusts the
// pane it has until the subscription says otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

let compiled: ReturnType<typeof compileMount> | undefined;
// The real Terminal needs xterm, which this tier does not paint; a stub
// component stands in and records the target it was given.
const fixture = () => compiled ??= compileMount(new URL('./ScratchPanel.test.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
  new URL('../terminal/Terminal.svelte', import.meta.url),
// Bound to one server's scope, as App's provider binds it (board #335 ②b).
], { serverScope: true });
const terminalStub = {
  default: (anchor: Comment, props: { target: string; visible: boolean; onPaneExit: (t: string) => void }) => {
    const el = anchor.ownerDocument.createElement('div');
    el.className = 'xterm-wrap';
    el.dataset.target = props.target;
    el.innerHTML = '<textarea class="xterm-helper-textarea"></textarea>';
    anchor.before(el);
    // The real Terminal calls this from its pane_closed listener, which it
    // keeps registered while HIDDEN (rule 7) — the route #326 is about.
    (anchor.ownerDocument.defaultView as unknown as { __paneExit: (t: string) => void }).__paneExit = props.onPaneExit;
  },
};

function rpc(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    mod: {
      scratchSession: async () => { calls.push('ensure'); return { session: 'tmm-scratch', target: 'tmm-scratch:1.1' }; },
      scratchKill: async () => { calls.push('kill'); return { killed: true }; },
      subscribe: () => {}, unsubscribe: () => {}, capturePane: async () => ({ output: '' }),
      addPaneOutputListener: () => {}, removePaneOutputListener: () => {},
      addPaneClosedListener: () => {}, removePaneClosedListener: () => {},
      ...over,
    } as Record<string, (...a: any[]) => unknown>,
  };
}
async function mount(context: TestContext, mod: Record<string, (...a: any[]) => unknown>) {
  const f = await fixture();
  return f.mount(context, {
    modules: [mod, terminalStub as unknown as Record<string, (...a: any[]) => unknown>],
    setup(w) { w.Element.prototype.getAnimations = () => []; w.HTMLCanvasElement.prototype.getContext = () => null; },
  });
}
const until = async (app: { flush: () => Promise<void> }, ok: () => boolean, n = 30) => { for (let i = 0; i < n && !ok(); i++) await app.flush(); };

test('closed: inert, hidden, nothing ensured; open ensures once and mounts the Terminal on the pane target', { timeout: 60000 }, async (context) => {
  const r = rpc();
  const app = await mount(context, r.mod);
  try {
    const panel = () => app.document.querySelector<HTMLElement>('.scratch')!;
    const inert = () => panel().hasAttribute('inert') || (panel() as any).inert === true;
    assert.ok(inert(), 'a closed panel is not reachable');
    assert.equal(panel().getAttribute('aria-hidden'), 'true');
    assert.deepEqual(r.calls, [], 'nothing until the reader opens it');
    app.document.querySelector<HTMLButtonElement>('.opener')!.focus();
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    assert.deepEqual(r.calls, ['ensure']);
    assert.equal(app.document.querySelector<HTMLElement>('.scratch .xterm-wrap')!.dataset.target, 'tmm-scratch:1.1', 'the concrete pane target');
    assert.ok(!inert());
    await until(app, () => app.document.activeElement?.className === 'xterm-helper-textarea', 6);
    assert.equal(app.document.activeElement?.className, 'xterm-helper-textarea', 'focus goes into the terminal once it is mounted and shown');
    assert.ok(panel().classList.contains('open'));
    // Close hides; reopening does not ensure again (the session lives on).
    app.window.__scratch.open = false;
    for (let i = 0; i < 4; i++) await app.flush();
    assert.ok(inert());
    assert.equal(app.document.activeElement?.className, 'opener', 'focus returns to where it was');
    assert.ok(app.document.querySelector('.scratch .xterm-wrap'), 'the Terminal stays mounted while hidden');
    app.window.__scratch.open = true;
    for (let i = 0; i < 4; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure'], 'no second ensure for a session that is still there');
  } finally { await app.close(); }
});

test('Escape closes from the head, Kill asks first then ends the session, and opening an ended panel brings a live one back', { timeout: 60000 }, async (context) => {
  const r = rpc();
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    const head = app.document.querySelector<HTMLElement>('.scratch-head')!;
    head.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await app.flush();
    assert.equal(app.window.__scratch.open, false, 'Escape on the head closes');
    app.window.__scratch.open = true;
    for (let i = 0; i < 4; i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.scratch-head [aria-label="Kill scratch session"]')!.click();
    await until(app, () => !!app.document.querySelector('.confirm-dialog, [role="alertdialog"], dialog[open]'));
    assert.deepEqual(r.calls, ['ensure'], 'nothing is killed before the confirmation');
    const confirm = [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Kill scratch session') && !b.closest('.scratch-head'))!;
    confirm.click();
    await until(app, () => r.calls.includes('kill') && app.window.__scratch.open === false);
    assert.deepEqual(r.calls, ['ensure', 'kill']);
    // Nothing recreates it in the background: the panel is closed and the
    // session stays dead until the READER asks for it again.
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure', 'kill'], 'no background recreate');
    // And that ask is opening the panel (#326): it ensures from `ended` too,
    // so the reader gets a prompt instead of the bare "Session ended" line.
    app.window.__scratch.open = true;
    await until(app, () => r.calls.length === 3);
    assert.deepEqual(r.calls, ['ensure', 'kill', 'ensure'], 'opening an ended panel ensures');
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    assert.equal(app.document.querySelector<HTMLElement>('.scratch .xterm-wrap')!.dataset.target, 'tmm-scratch:1.1');
    assert.equal(app.document.querySelector('.scratch-state'), null, 'no ended state left on screen');
  } finally { await app.close(); }
});

test('a server switch drops a pending ensure and never ensures by itself; the edge switch moves the panel', { timeout: 60000 }, async (context) => {
  let answer: ((v: unknown) => void) | null = null;
  const r = rpc({ scratchSession: () => { r.calls.push('ensure'); return new Promise((res) => { answer = res; }); } });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!answer);
    // The switch starts: the panel is closed and no longer live; then the
    // keyed tree remounts for the new server.
    app.window.__scratch.live = false;
    app.window.__scratch.open = false;
    await app.flush();
    answer!({ session: 'tmm-scratch', target: 'tmm-scratch:0.0' });
    for (let i = 0; i < 4; i++) await app.flush();
    assert.equal(app.document.querySelector('.scratch .xterm-wrap'), null, 'the old server\'s answer mounted nothing');
    app.window.__scratch.bump();
    app.window.__scratch.live = true;
    for (let i = 0; i < 4; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure'], 'no ensure on the new server until the reader opens it');
    // Edge: the head's two icons move it to the right (#326).
    const edges = app.document.querySelectorAll<HTMLButtonElement>('.scratch-head .segmented button');
    assert.deepEqual([...edges].map((b) => b.getAttribute('aria-label')), ['Bottom', 'Right'],
      'icons, with their words as the accessible names');
    assert.ok([...edges].every((b) => !b.textContent?.trim()), 'no Bottom/Right text in the head');
    edges[1]!.click();
    await app.flush();
    assert.equal(app.window.__scratch.edge, 'right');
    assert.ok(app.document.querySelector('.scratch.right'));
    assert.equal(app.document.querySelector('.scratch .side-handle')!.getAttribute('aria-orientation'), 'vertical', 'the side-docked panel resizes on X');
  } finally { await app.close(); }
});

test('a refusal is a stable error: no automatic retry, Open again asks once (#324 review)', { timeout: 60000 }, async (context) => {
  const r = rpc({ scratchSession: async () => { r.calls.push('ensure'); throw new Error("a tmux session named 'tmm-scratch' already exists and is not the scratch terminal"); } });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch-err'));
    for (let i = 0; i < 12; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure'], 'the error does not re-ensure');
    assert.match(app.document.querySelector('.scratch-err')!.textContent!, /already exists/u, 'the reason stays on screen');
    app.document.querySelector<HTMLButtonElement>('.scratch-state button')!.click();
    for (let i = 0; i < 8; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure', 'ensure'], 'one explicit retry, one call');
  } finally { await app.close(); }
});

test('the server-keyed tree unmounting first still drops a pending completion (#324 review, real teardown order)', { timeout: 60000 }, async (context) => {
  let killed: ((v: unknown) => void) | null = null;
  const r = rpc({ scratchKill: () => { r.calls.push('kill'); return new Promise((res) => { killed = res; }); } });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    app.document.querySelector<HTMLButtonElement>('.scratch-head [aria-label="Kill scratch session"]')!.click();
    await until(app, () => !![...app.document.querySelectorAll('button')].find((b) => b.textContent?.includes('Kill scratch session') && !b.closest('.scratch-head')));
    [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Kill scratch session') && !b.closest('.scratch-head'))!.click();
    await until(app, () => !!killed);
    // The switch tears the keyed tree down BEFORE `live` ever goes false, and
    // the reader opens the new server's panel.
    app.window.__scratch.bump();
    await app.flush();
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    killed!({ killed: true });
    for (let i = 0; i < 6; i++) await app.flush();
    assert.equal(app.window.__scratch.open, true, 'the old panel\'s kill completion did not close the new one');
  } finally { await app.close(); }
});

test('a session that ends while the panel is CLOSED is not what the reader opens into (#326)', { timeout: 60000 }, async (context) => {
  // The owner's "点开 Terminal 之后，我现在经常看到里面什么都没有": a hidden
  // Terminal stays subscribed, so pane_closed arrives while the panel is
  // closed and leaves phase='ended' with no target. Before #326 the open
  // effect only re-ensured from idle|error, so the next open showed the bare
  // "Session ended" line instead of a prompt.
  const r = rpc();
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    app.window.__scratch.open = false;
    for (let i = 0; i < 4; i++) await app.flush();
    // The shell exits / the session is killed from outside: the subscription
    // reports it to a panel nobody is looking at.
    (app.window as unknown as { __paneExit: (t: string) => void }).__paneExit('tmm-scratch:1.1');
    for (let i = 0; i < 4; i++) await app.flush();
    // (The Terminal stub's node is not reactive, so the panel's own state
    // block is what says the pane is gone.)
    assert.match(app.document.querySelector('.scratch-state')!.textContent!, /Session ended/u,
      'the panel drops the dead pane while nobody is looking');
    assert.deepEqual(r.calls, ['ensure'], 'and nothing is recreated behind the reader');
    app.window.__scratch.open = true;
    await until(app, () => r.calls.length === 2);
    assert.deepEqual(r.calls, ['ensure', 'ensure'], 'opening ensures from ended');
    await until(app, () => !app.document.querySelector('.scratch-state'));
    assert.equal(app.document.querySelector('.scratch-state'), null, 'a prompt, not a notice');
  } finally { await app.close(); }
});

test('a `ready` panel trusts its pane until the subscription says otherwise — the window, stated (#326 review P2)', { timeout: 60000 }, async (context) => {
  // Honest boundary: if the session is killed BEHIND our back and the panel
  // is reopened before pane_closed arrives, the panel still believes its
  // target and only focuses it — it does not re-ask on every open (board
  // #324's rule, and its retry-loop guard). The subscription closes the
  // window: once pane_closed lands, the state is `ended` and the next open
  // ensures. This is the behaviour, recorded, not a claim that opening is
  // always a round-trip.
  const r = rpc();
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    app.window.__scratch.open = false;
    for (let i = 0; i < 4; i++) await app.flush();
    app.window.__scratch.open = true;              // reopened inside the window
    for (let i = 0; i < 8; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure'], 'no second ensure while the panel believes its pane is live');
    assert.equal(app.document.querySelector<HTMLElement>('.scratch .xterm-wrap')!.dataset.target, 'tmm-scratch:1.1');
    (app.window as unknown as { __paneExit: (t: string) => void }).__paneExit('tmm-scratch:1.1');
    for (let i = 0; i < 4; i++) await app.flush();
    app.window.__scratch.open = false;
    await app.flush();
    app.window.__scratch.open = true;
    await until(app, () => r.calls.length === 2);
    assert.deepEqual(r.calls, ['ensure', 'ensure'], 'the close notice is what makes the next open re-ask');
  } finally { await app.close(); }
});

test('a held name offers a release the reader confirms, about the project the refusal named (#337)', { timeout: 60000 }, async (context) => {
  // The refusal is a dead end without this: "Open again" re-asks and gets the
  // same answer (the owner: "完全用不了"). The action is offered on the error
  // CODE, and what it sends back is the refusal's own snapshot — so the
  // project the reader saw in the confirmation is the only one that can be
  // renamed, even if the holder changed in between (the server re-checks).
  const held = Object.assign(new Error("the name 'tmm-scratch' belongs to project 'tmm-scratch'"), {
    code: -32010,
    data: { projectId: 'tmm-scratch-871f72', projectName: 'tmm-scratch', session: 'tmm-scratch' },
  });
  let refuse = true;
  const sent: unknown[] = [];
  const r = rpc({
    scratchSession: async () => { r.calls.push('ensure'); if (refuse) throw held; return { session: 'tmm-scratch', target: 'tmm-scratch:1.1' }; },
    scratchRelease: async (projectId: string, session: string) => {
      r.calls.push('release'); sent.push({ projectId, session }); refuse = false;
      return { released: true, project: 'tmm-scratch', renamed_to: 'tmm-scratch-recovered' };
    },
  });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch-err'));
    assert.match(app.document.querySelector('.scratch-err')!.textContent!, /belongs to project/u, 'the server’s one sentence');
    const actions = [...app.document.querySelectorAll<HTMLButtonElement>('.scratch-state button')];
    assert.deepEqual(actions.map((b) => b.textContent?.trim()), ['Release the name', 'Open again'],
      'the way out sits beside the retry, in that order');
    // Nothing happens until the confirmation is answered.
    actions[0]!.click();
    await until(app, () => !!app.document.querySelector('[role=alertdialog]'));
    assert.deepEqual(r.calls, ['ensure'], 'the dialog has not released anything yet');
    const dialog = app.document.querySelector<HTMLElement>('[role=alertdialog]')!;
    assert.match(dialog.textContent!, /tmm-scratch/u, 'and it names the project and session being renamed');
    const confirm = dialog.querySelector<HTMLButtonElement>('.dlg-actions button:last-child')!;
    confirm.click();
    await until(app, () => r.calls.includes('release'));
    assert.deepEqual(sent, [{ projectId: 'tmm-scratch-871f72', session: 'tmm-scratch' }],
      'the release is about the refusal’s own project, not “whoever holds it now”');
    // And it opens straight onto the freed session, without a second ask.
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    assert.deepEqual(r.calls, ['ensure', 'release', 'ensure']);
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'the confirmation closed');
  } finally { await app.close(); }
});

test('a stale confirm recovers: the snapshot is dropped and the panel asks once what is true now (#337)', { timeout: 60000 }, async (context) => {
  // The reader confirms a release, and by the time it arrives the holder has
  // changed or let go — nothing is renamed. Showing that sentence would leave
  // them exactly where the incident left them, so the panel drops the stale
  // snapshot and re-asks. Here the name turned out to be FREE: the panel
  // opens, with no second confirmation to answer.
  const held = Object.assign(new Error("the name 'tmm-scratch' belongs to project 'tmm-scratch'"), {
    code: -32010,
    data: { projectId: 'tmm-scratch-871f72', projectName: 'tmm-scratch', session: 'tmm-scratch' },
  });
  let refuse = true;
  const r = rpc({
    scratchSession: async () => { r.calls.push('ensure'); if (refuse) throw held; return { session: 'tmm-scratch', target: 'tmm-scratch:1.1' }; },
    scratchRelease: async () => {
      r.calls.push('release');
      refuse = false;                                  // someone else freed it in the meantime
      throw Object.assign(new Error("'tmm-scratch' is no longer held by that project — it is held by 'my-work' now, so nothing was renamed"), { code: -32011 });
    },
  });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch-err'));
    app.document.querySelector<HTMLButtonElement>('.scratch-state button')!.click();
    await until(app, () => !!app.document.querySelector('[role=alertdialog]'));
    app.document.querySelector<HTMLButtonElement>('[role=alertdialog] .dlg-actions button:last-child')!.click();
    await until(app, () => !!app.document.querySelector('.scratch .xterm-wrap'));
    assert.deepEqual(r.calls, ['ensure', 'release', 'ensure'], 'one re-ask, not a retry loop');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'the stale confirmation is gone');
    assert.equal(app.document.querySelector('.scratch-err'), null, 'and the refusal text with it');
    assert.equal(app.document.querySelector<HTMLElement>('.scratch .xterm-wrap')!.dataset.target, 'tmm-scratch:1.1');
  } finally { await app.close(); }
});

test('a stale confirm whose name is STILL held re-asks the reader about the NEW holder (#337)', { timeout: 60000 }, async (context) => {
  // The other half: the name changed hands. The panel shows the fresh
  // refusal, which names the project holding it NOW, and offers the action
  // again — it does NOT carry the approval over by reopening the dialog on a
  // project the reader has never seen (the review that made the snapshot
  // exist in the first place).
  const firstHolder = Object.assign(new Error("the name 'tmm-scratch' belongs to project 'tmm-scratch'"), {
    code: -32010,
    data: { projectId: 'tmm-scratch-871f72', projectName: 'tmm-scratch', session: 'tmm-scratch' },
  });
  const newHolder = Object.assign(new Error("the name 'tmm-scratch' belongs to project 'my-work'"), {
    code: -32010,
    data: { projectId: 'my-work-44ab10', projectName: 'my-work', session: 'tmm-scratch' },
  });
  let answer = firstHolder;
  const sent: unknown[] = [];
  const r = rpc({
    scratchSession: async () => { r.calls.push('ensure'); throw answer; },
    scratchRelease: async (projectId: string, session: string) => {
      r.calls.push('release'); sent.push({ projectId, session });
      answer = newHolder;                              // it changed hands under the confirmation
      throw Object.assign(new Error("'tmm-scratch' is no longer held by that project — it is held by 'my-work' now, so nothing was renamed"), { code: -32011 });
    },
  });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch-err'));
    app.document.querySelector<HTMLButtonElement>('.scratch-state button')!.click();
    await until(app, () => !!app.document.querySelector('[role=alertdialog]'));
    app.document.querySelector<HTMLButtonElement>('[role=alertdialog] .dlg-actions button:last-child')!.click();
    await until(app, () => r.calls.length === 3);
    assert.deepEqual(r.calls, ['ensure', 'release', 'ensure']);
    assert.deepEqual(sent, [{ projectId: 'tmm-scratch-871f72', session: 'tmm-scratch' }], 'only ever the project that was on screen');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'no confirmation is opened for them');
    assert.match(app.document.querySelector('.scratch-err')!.textContent!, /project 'my-work'/u, 'the refusal names the holder NOW');
    const actions = [...app.document.querySelectorAll<HTMLButtonElement>('.scratch-state button')];
    assert.deepEqual(actions.map((b) => b.textContent?.trim()), ['Release the name', 'Open again'], 'and the way out is offered again');
    // Confirming THAT one sends the new holder's snapshot, never the old.
    actions[0]!.click();
    await until(app, () => !!app.document.querySelector('[role=alertdialog]'));
    assert.match(app.document.querySelector('[role=alertdialog]')!.textContent!, /my-work/u);
    app.document.querySelector<HTMLButtonElement>('[role=alertdialog] .dlg-actions button:last-child')!.click();
    await until(app, () => sent.length === 2);
    assert.deepEqual(sent[1], { projectId: 'my-work-44ab10', session: 'tmm-scratch' });
  } finally { await app.close(); }
});

test('a release that FAILED keeps its sentence on screen (#337)', { timeout: 60000 }, async (context) => {
  // Only a stale snapshot is recovered from. A release that was about the
  // right project and could not finish is the server's one sentence for the
  // human, and re-asking would hide it behind the same refusal.
  const held = Object.assign(new Error("the name 'tmm-scratch' belongs to project 'tmm-scratch'"), {
    code: -32010,
    data: { projectId: 'tmm-scratch-871f72', projectName: 'tmm-scratch', session: 'tmm-scratch' },
  });
  const r = rpc({
    scratchSession: async () => { r.calls.push('ensure'); throw held; },
    scratchRelease: async () => {
      r.calls.push('release');
      throw Object.assign(new Error("a tmux session named 'tmm-scratch-recovered' already exists"), { code: -32603 });
    },
  });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch-err'));
    app.document.querySelector<HTMLButtonElement>('.scratch-state button')!.click();
    await until(app, () => !!app.document.querySelector('[role=alertdialog]'));
    app.document.querySelector<HTMLButtonElement>('[role=alertdialog] .dlg-actions button:last-child')!.click();
    await until(app, () => r.calls.includes('release'));
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure', 'release'], 'no re-ask for a failure that is not stale');
    const dialog = app.document.querySelector('[role=alertdialog]')!;
    assert.ok(dialog, 'the confirmation stays open, with the reason in it');
    assert.match(dialog.textContent!, /already exists/u);
  } finally { await app.close(); }
});

test('the CODE decides, not the sentence: a message that disagrees with it changes nothing (#337 review P2)', { timeout: 60000 }, async (context) => {
  // The message is the server's one sentence for the human — translated,
  // reworded, and in #337's case naming a project — so the panel keys on the
  // code alone. These two fixtures disagree on purpose, in both directions,
  // and the behaviour follows the code every time: without this the rule is
  // only implemented, not pinned.
  const held = Object.assign(new Error("the name 'tmm-scratch' belongs to project 'tmm-scratch'"), {
    code: -32010,
    data: { projectId: 'tmm-scratch-871f72', projectName: 'tmm-scratch', session: 'tmm-scratch' },
  });
  // A stale code wearing a failure's words.
  const staleCode = Object.assign(new Error("a tmux session named 'tmm-scratch-recovered' already exists"), { code: -32011 });
  // A failure code wearing a stale refusal's words.
  const failedCode = Object.assign(new Error("'tmm-scratch' is no longer held by that project — it is held by 'my-work' now, so nothing was renamed"), { code: -32603 });
  let answer: Error = staleCode;
  const r = rpc({
    scratchSession: async () => { r.calls.push('ensure'); throw held; },
    scratchRelease: async () => { r.calls.push('release'); throw answer; },
  });
  const app = await mount(context, r.mod);
  const confirmRelease = async () => {
    app.document.querySelector<HTMLButtonElement>('.scratch-state button')!.click();
    await until(app, () => !!app.document.querySelector('[role=alertdialog]'));
    app.document.querySelector<HTMLButtonElement>('[role=alertdialog] .dlg-actions button:last-child')!.click();
  };
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch-err'));
    // -32011 wearing a failure's sentence: still RECOVERED from — the
    // snapshot is dropped and the panel asks once what is true now.
    await confirmRelease();
    await until(app, () => r.calls.length === 3);
    assert.deepEqual(r.calls, ['ensure', 'release', 'ensure'], 'the stale code re-asked, whatever its words said');
    assert.equal(app.document.querySelector('[role=alertdialog]'), null, 'and the stale confirmation closed');
    assert.ok(app.document.querySelector('.scratch-err'), 'the re-ask met the same holder, so the action is offered again');
    // -32603 wearing a stale refusal's sentence: still SHOWN, no re-ask.
    answer = failedCode;
    await confirmRelease();
    await until(app, () => r.calls.length === 4);
    for (let i = 0; i < 6; i++) await app.flush();
    assert.deepEqual(r.calls, ['ensure', 'release', 'ensure', 'release'],
      'nothing follows the failure code: it is read, not recovered from');
    const dialog = app.document.querySelector('[role=alertdialog]')!;
    assert.ok(dialog, 'the confirmation stays open on a failure code');
    assert.match(dialog.textContent!, /no longer held by that project/u, 'showing the words it came with');
  } finally { await app.close(); }
});

test('a refusal with no holder data offers only the retry (#337)', { timeout: 60000 }, async (context) => {
  // A plain tmux session of that name, or a failed read of who holds it: the
  // panel must not offer to release something it cannot identify.
  const r = rpc({
    scratchSession: async () => {
      r.calls.push('ensure');
      throw Object.assign(new Error("a tmux session named 'tmm-scratch' already exists and is not the scratch terminal"), { code: -32603 });
    },
  });
  const app = await mount(context, r.mod);
  try {
    app.window.__scratch.open = true;
    await until(app, () => !!app.document.querySelector('.scratch-err'));
    const actions = [...app.document.querySelectorAll<HTMLButtonElement>('.scratch-state button')];
    assert.deepEqual(actions.map((b) => b.textContent?.trim()), ['Open again'], 'no release for an unidentified holder');
  } finally { await app.close(); }
});

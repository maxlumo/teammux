// Board #91 round 1 (validator note 7, orchestrator note 9): a label table
// read from project_list never overwrites a NEWER write: a rename push, or a
// read that started later. A failed read keeps what was known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./LabelsProbe.test.svelte', import.meta.url), []);
type Rows = { projects: { project: { session: string }; labels: { agent: string; label: string; aliases: string[] }[] }[] };
const table = (label: string, other = 'elsewhere'): Rows => ({ projects: [
  { project: { session: 'app' }, labels: [{ agent: 'kiro-2', label, aliases: [] }, { agent: 'omp-2', label: 'research', aliases: [] }] },
  { project: { session: 'other' }, labels: [{ agent: 'kiro-2', label: other, aliases: [] }] },
] });

function server() {
  const pending: { ok: (r: Rows) => void; no: (e: Error) => void }[] = [];
  const listeners: ((r: unknown) => void)[] = [];
  const runtime = {
    id: 'srv-a',
    api: { projectList: () => new Promise<Rows>((ok, no) => { pending.push({ ok, no }); }) },
    connection: { addAgentRenamedListener: (cb: (r: unknown) => void) => { listeners.push(cb); }, removeAgentRenamedListener: () => {} },
  };
  const push = (label: string, session = 'app') => { for (const cb of listeners) cb({ session, agent: 'kiro-2', label, aliases: [] }); };
  return { runtime, pending, push };
}

test('a list answer that lands after a rename push never undoes it (#91 round 1)', async (context) => {
  const s = server();
  const app = await (await compiled).mount(context, { props: { runtime: s.runtime }, modules: [] });
  try {
    await app.flush();
    s.push('deploy'); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'deploy', 'the push shows at once');
    s.pending[0]!.ok(table('ops')); await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'deploy', 'the older snapshot does not put "ops" back');
    assert.equal(app.document.querySelector('#other')?.textContent, 'elsewhere', 'and another session still takes the read');
    assert.equal(app.document.querySelector('#peer')?.textContent, 'research', 'round 2: another agent of the SAME session takes the read too');
  } finally { await app.close(); }
});

test('overlapping reads: an older answer landing last never replaces a newer one; a failed read keeps the table (#91 round 1)', async (context) => {
  const s = server();
  const app = await (await compiled).mount(context, { props: { runtime: s.runtime }, modules: [] });
  try {
    await app.flush();
    app.document.querySelector<HTMLButtonElement>('#refresh')!.click(); await app.flush();
    assert.equal(s.pending.length, 2, 'two reads in flight');
    s.pending[1]!.ok(table('deploy')); await app.flush(); await app.flush();
    s.pending[0]!.ok(table('ops')); await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'deploy', 'the newer read wins');
    app.document.querySelector<HTMLButtonElement>('#refresh')!.click(); await app.flush();
    s.pending[2]!.no(new Error('lost')); await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'deploy', 'a failed read erases nothing');
  } finally { await app.close(); }
});

// Round 3 (reviewer note 23, orchestrator note 24): the watcher re-reads on
// the app's reconnect door for ITS server: a rename made while the socket was
// down, and an initial read that failed, both recover without a push.
test('a reconnect of its own server re-reads the labels; another server\u2019s does not (#91 round 3)', async (context) => {
  const s = server();
  const app = await (await compiled).mount(context, { props: { runtime: s.runtime }, modules: [] });
  try {
    await app.flush();
    s.pending[0]!.no(new Error('not connected')); await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'kiro-2', 'the first read failed: physical name');
    const reconnect = (serverId: string) => app.window.dispatchEvent(new app.window.CustomEvent('ws-reconnected', { detail: { serverId } }));
    reconnect('srv-b'); await app.flush();
    assert.equal(s.pending.length, 1, 'another server\u2019s reconnect asks nothing');
    reconnect('srv-a'); await app.flush();
    assert.equal(s.pending.length, 2, 'its own reconnect re-reads');
    s.pending[1]!.ok(table('ops')); await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'ops', 'the labels arrive');
    // A rename made while the socket was down (no push), then a reconnect.
    reconnect('srv-a'); await app.flush();
    s.pending[2]!.ok(table('deploy')); await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'deploy', 'the missed rename shows after the reconnect');
    assert.equal(app.document.querySelector('#peer')?.textContent, 'research');
  } finally { await app.close(); }
});

// Round 4 (reviewer note 32, orchestrator note 33): an agent or a session may
// be NAMED like an Object prototype key; "constructor" is a valid name. The
// per-agent revisions and the session tables must not read inherited keys.
test('an agent and a session named "constructor" take their labels like any other (#91 round 4)', async (context) => {
  const s = server();
  const app = await (await compiled).mount(context, { props: { runtime: s.runtime, agent: 'constructor', other: 'toString' }, modules: [] });
  try {
    await app.flush();
    assert.equal(app.document.querySelector('#other')?.textContent, 'constructor', 'a session named like a prototype key, unread: the physical name');
    s.pending[0]!.ok(table('ops')); await app.flush(); await app.flush();
    const reconnect = () => app.window.dispatchEvent(new app.window.CustomEvent('ws-reconnected', { detail: { serverId: 'srv-a' } }));
    reconnect(); await app.flush();
    s.pending[1]!.ok({ projects: [
      { project: { session: 'app' }, labels: [{ agent: 'kiro-2', label: 'ops', aliases: [] }, { agent: 'constructor', label: 'builder', aliases: [] }] },
      { project: { session: 'toString' }, labels: [{ agent: 'constructor', label: 'maker', aliases: [] }] },
    ] }); await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('#shown')?.textContent, 'builder', 'the renamed "constructor" agent shows its label after the reconnect snapshot');
    assert.equal(app.document.querySelector('#other')?.textContent, 'maker', 'and in a session named "toString"');
  } finally { await app.close(); }
});

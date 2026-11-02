// The Backends section's actions (board #492 phase 2, reviewer design CLEAR
// 07:29): one Refresh per entry, Test only on a click, one action at a time,
// and the ticket that decides which answer may land — the mount rows the
// execution contract lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';
import { clock } from './backends-view.ts';

const compiled = compileMount(new URL('./BackendsSection.svelte', import.meta.url), []);

const KIRO = {
  name: 'kiro', program: 'kiro-cli',
  installed: { state: 'present', path: '/home/u/.local/bin/kiro-cli', version: '1.2.3', reason: null },
  set_up: { state: 'unknown', basis: 'presence', via: null, missing: [], reason: 'test_only' },
  answers: { state: 'unknown', count: null, reason: 'test_only' },
};
const CLAUDE = {
  name: 'claude', program: 'claude',
  installed: { state: 'unknown', path: null, version: null, reason: 'path_unreadable' },
  set_up: { state: 'unknown', basis: 'cli', via: null, missing: [], reason: 'not_signed_in' },
  answers: { state: 'unknown', count: null, reason: 'first_run' },
};
const KIMI = {
  name: 'kimi', program: 'kimi',
  installed: { state: 'missing', path: null, version: null, reason: 'not_found' },
  set_up: { state: 'missing', basis: 'presence', via: null, missing: ['KIMI_API_KEY'], reason: 'env_unset' },
  answers: { state: 'unknown', count: null, reason: 'first_run' },
};
const report = (...backends: object[]) => ({ backends, scope: 'default', baseline: null });
const TESTED = { test: { name: 'kiro', set_up: { state: 'present', basis: 'cli', via: 'builder_id', missing: [], reason: null }, answers: { state: 'yes', count: 24, reason: null } } };

type Wait = { test?: string; resolve: (v: unknown) => void; reject: (e: unknown) => void };
/** A runtime whose `backends_check` the test answers by hand. */
function server(id = 'a') {
  const waits: Wait[] = [];
  const runtime = {
    id,
    api: { backendsCheck: (test?: string) => new Promise((resolve, reject) => { waits.push({ test, resolve, reject }); }) },
  };
  return { runtime, waits, calls: () => waits.map((w) => w.test ?? 'refresh') };
}

async function mount(context: TestContext, props: Record<string, unknown>) {
  const app = await (await compiled).mount(context, { props, modules: [] });
  const flush = async () => { for (let i = 0; i < 6; i++) await app.flush(); };
  const q = <E extends Element>(sel: string) => app.document.querySelector<E>(sel);
  const button = (label: string, row?: string) => {
    const scope = row ? app.document.querySelector(`section[aria-label="${row}"]`) : app.document;
    const b = scope?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    assert.ok(b, `${label} button${row ? ` on ${row}` : ''}`);
    return b;
  };
  const text = () => app.document.body.textContent ?? '';
  const row = (name: string) => app.document.querySelector(`section[aria-label="${name}"]`)?.textContent ?? '';
  return { ...app, flush, q, button, text, row };
}

test('entering the section runs exactly ONE Refresh; its answer, busy and error start no other; Test never runs by itself', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  assert.deepEqual(s.calls(), ['refresh']);
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), 'true');
  s.waits[0]!.resolve(report(KIRO, CLAUDE, KIMI)); await app.flush();
  assert.match(app.row('kiro'), /1\.2\.3/u);
  await app.advance(60_000);
  assert.deepEqual(s.calls(), ['refresh'], 'no poller, no follow-up, no automatic Test');
  app.button('Refresh').click(); await app.flush();
  s.waits[1]!.reject(new Error('request timeout')); await app.flush();
  await app.advance(60_000);
  assert.deepEqual(s.calls(), ['refresh', 'refresh'], 'an error starts nothing either');
});

test('a Refresh runs on ENTRY, not on mount: each new entry runs one', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: false, cap: 'present' });
  assert.deepEqual(s.calls(), [], 'the page is mounted but the section is not entered');
  await app.setProps({ active: true });
  assert.deepEqual(s.calls(), ['refresh']);
  s.waits[0]!.resolve(report(KIRO)); await app.flush();
  await app.setProps({ active: false });
  await app.setProps({ active: true });
  assert.deepEqual(s.calls(), ['refresh', 'refresh'], 'a second entry is a second visit');
  assert.match(app.row('kiro'), /1\.2\.3/u, 'the last rows stay while the new check runs');
});

test('Test runs only on a click, replaces only its row\u2019s set up and answers, and says what it writes', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.resolve(report(KIRO, KIMI)); await app.flush();
  assert.match(app.row('kiro'), /Not tested/u);
  assert.match(app.row('kiro'), /Press Test\./u, 'the one known fix: press Test, said once');
  assert.equal(app.row('kiro').match(/Press Test/gu)?.length, 1);
  assert.match(app.row('kiro'), /kiro-cli's own sign-in and model checks on the server/u, 'the disclosure line');
  assert.equal(app.document.querySelectorAll('[aria-label="Test"]').length, 1, 'Test only where the server says a Test decides');
  app.button('Test', 'kiro').click(); await app.flush();
  assert.deepEqual(s.calls(), ['refresh', 'kiro']);
  s.waits[1]!.resolve(TESTED); await app.flush();
  assert.match(app.row('kiro'), /Signed in per the CLI \(builder_id\)/u);
  assert.match(app.row('kiro'), /Yes, 24 models/u);
  assert.match(app.row('kiro'), /1\.2\.3/u, 'Installed is the Refresh\u2019s, untouched');
  assert.match(app.row('kimi'), /kimi not found on the managed PATH/u, 'another row is untouched');
});

test('only the running action shows pending: a Refresh disables Test without making it look busy', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.resolve(report(KIRO)); await app.flush();
  app.button('Refresh').click(); await app.flush();
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), 'true');
  assert.equal(app.button('Test', 'kiro').disabled, true, 'one action at a time');
  assert.equal(app.button('Test', 'kiro').getAttribute('aria-busy'), null, 'and it does not look as if it runs');
  app.button('Test', 'kiro').click(); await app.flush();
  assert.deepEqual(s.calls(), ['refresh', 'refresh'], 'a disabled Test sends nothing');
  s.waits[1]!.resolve(report(KIRO)); await app.flush();
  app.button('Test', 'kiro').click(); await app.flush();
  assert.equal(app.button('Test', 'kiro').getAttribute('aria-busy'), 'true');
  assert.equal(app.button('Refresh').disabled, true);
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), null);
});

test('a Refresh pending when caps go unknown: released at once; the old answer and finally change nothing; no re-run when caps return', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.resolve(report(KIRO)); await app.flush();
  app.button('Refresh').click(); await app.flush();
  await app.setProps({ cap: 'unknown' });
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), null, 'the pending clears at once');
  assert.equal(app.button('Refresh').disabled, true, 'disabled: no permission, not busy');
  assert.match(app.text(), /Waiting for the connection to check\./u);
  assert.match(app.text(), /Showing the result from/u, 'the last rows stay, said to be old');
  assert.match(app.row('kiro'), /1\.2\.3/u);
  await app.setProps({ cap: 'present' });
  assert.equal(app.button('Refresh').disabled, false, 'usable again');
  assert.deepEqual(s.calls(), ['refresh', 'refresh'], 'nothing re-runs by itself: this visit already sent its entry Refresh');
  // A new Refresh by hand, then the OLD one's answer and finally arrive.
  app.button('Refresh').click(); await app.flush();
  s.waits[1]!.resolve(report({ ...KIRO, installed: { ...KIRO.installed, version: '0.0.1-old' } })); await app.flush();
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), 'true', 'the old finally cannot clear the new busy state');
  assert.doesNotMatch(app.text(), /0\.0\.1-old/u, 'the old answer does not land');
  s.waits[2]!.resolve(report({ ...KIRO, installed: { ...KIRO.installed, version: '9.9.9' } })); await app.flush();
  assert.match(app.row('kiro'), /9\.9\.9/u);
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), null);
});

test('a Test pending when caps go unknown: released; its late failure says nothing; nothing re-runs', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.resolve(report(KIRO)); await app.flush();
  app.button('Test', 'kiro').click(); await app.flush();
  await app.setProps({ cap: 'unknown' });
  assert.equal(app.button('Test', 'kiro').getAttribute('aria-busy'), null);
  assert.equal(app.button('Test', 'kiro').disabled, true);
  s.waits[1]!.reject(new Error('connection lost')); await app.flush();
  assert.doesNotMatch(app.text(), /This Test could not run/u, 'a voided ticket shows nothing');
  await app.setProps({ cap: 'present' });
  assert.equal(app.button('Test', 'kiro').disabled, false);
  assert.equal(app.button('Refresh').disabled, false);
  assert.deepEqual(s.calls(), ['refresh', 'kiro']);
});

test('a visit that began before the login answered sends its ONE Refresh when the cap is first known present', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'unknown' });
  assert.deepEqual(s.calls(), [], 'nothing goes to a server whose caps are unknown');
  assert.match(app.text(), /Waiting for the connection to check\./u);
  assert.equal(app.button('Refresh').disabled, true);
  await app.setProps({ cap: 'present' });
  assert.deepEqual(s.calls(), ['refresh'], 'the visit\u2019s entry Refresh, now');
  s.waits[0]!.resolve(report(KIRO)); await app.flush();
  await app.setProps({ cap: 'unknown' });
  await app.setProps({ cap: 'present' });
  assert.deepEqual(s.calls(), ['refresh'], 'a later reconnect in the same visit sends none');
});

test('A\u2192B\u2192A: an answer from an earlier visit never lands on a later one', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  await app.setProps({ active: false });
  await app.setProps({ active: true });
  assert.deepEqual(s.calls(), ['refresh', 'refresh']);
  s.waits[0]!.resolve(report({ ...KIRO, installed: { ...KIRO.installed, version: 'visit-one' } })); await app.flush();
  assert.doesNotMatch(app.text(), /visit-one/u);
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), 'true', 'the later visit\u2019s Refresh is still the one running');
  s.waits[1]!.resolve(report({ ...KIRO, installed: { ...KIRO.installed, version: 'visit-two' } })); await app.flush();
  assert.match(app.row('kiro'), /visit-two/u);
});

test('a replaced runtime with the SAME server id: the old one\u2019s answer is dropped and its rows go', async (context) => {
  const a = server('same');
  const app = await mount(context, { runtime: a.runtime, active: true, cap: 'present' });
  a.waits[0]!.resolve(report(KIRO)); await app.flush();
  app.button('Refresh').click(); await app.flush();
  const b = server('same');
  await app.setProps({ runtime: b.runtime });
  assert.doesNotMatch(app.text(), /1\.2\.3/u, 'another runtime\u2019s rows are not this one\u2019s');
  assert.deepEqual(b.calls(), ['refresh'], 'the new runtime is a new visit with its own Refresh');
  a.waits[1]!.resolve(report({ ...KIRO, installed: { ...KIRO.installed, version: 'from-the-old-handle' } })); await app.flush();
  assert.doesNotMatch(app.text(), /from-the-old-handle/u);
  assert.equal(app.button('Refresh').getAttribute('aria-busy'), 'true');
  b.waits[0]!.resolve(report(KIMI)); await app.flush();
  assert.match(app.row('kimi'), /not found/u);
});

test('a failed Test keeps Installed and the earlier facts, and says this Test could not run', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.resolve(report(KIRO)); await app.flush();
  app.button('Test', 'kiro').click(); await app.flush();
  s.waits[1]!.reject(new Error('request timeout')); await app.flush();
  assert.match(app.row('kiro'), /This Test could not run \(request timeout\)\./u);
  assert.match(app.row('kiro'), /1\.2\.3/u);
  assert.match(app.row('kiro'), /Not tested/u, 'the earlier facts, not a new verdict');
  assert.doesNotMatch(app.row('kiro'), /not found|Missing/u);
});

test('a failed Refresh keeps the old rows and says they are from HH:MM; with none, it never says "not installed"', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.reject(new Error('request timeout')); await app.flush();
  assert.match(app.text(), /Could not check now \(request timeout\)\./u);
  assert.equal(app.document.querySelectorAll('section.backend').length, 0);
  assert.doesNotMatch(app.text(), /not found|Missing|not installed/iu, 'an error is not a fact');
  app.button('Refresh').click(); await app.flush();
  s.waits[1]!.resolve(report(KIRO)); await app.flush();
  const at = clock(Date.now());
  app.button('Refresh').click(); await app.flush();
  s.waits[2]!.reject(new Error('connection lost')); await app.flush();
  assert.match(app.text(), new RegExp(`Could not check now \\(connection lost\\)\\. Showing the result from ${at}\\.`, 'u'));
  assert.match(app.row('kiro'), /1\.2\.3/u);
});

test('the cap announced but the method missing: the server needs an update, never "missing"', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.reject(Object.assign(new Error('unknown method: backends_check'), { code: -32601 })); await app.flush();
  assert.match(app.text(), /This server needs an update to check backends\./u);
  assert.doesNotMatch(app.text(), /not found|Missing|unknown method/u);
});

test('unknown is never shown as not installed; reasons and known fixes are words, and the path is text on the row', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present', head: false });
  s.waits[0]!.resolve(report(KIRO, CLAUDE, KIMI, { name: 'future', program: 'future', installed: { state: 'odd', reason: 'from_a_newer_server' } })); await app.flush();
  assert.match(app.row('claude'), /Install state unknown/u);
  assert.match(app.row('claude'), /a directory on the managed PATH could not be looked at/u);
  assert.match(app.row('claude'), /Check the permissions of the managed PATH directories on the server\./u);
  assert.match(app.row('claude'), /the CLI says it is not signed in/u);
  assert.doesNotMatch(app.row('claude'), /not found|Missing/u);
  assert.match(app.row('kimi'), /Install kimi on the server so it is on the managed PATH/u);
  assert.match(app.row('kimi'), /Set KIMI_API_KEY in the server's login shell startup file, then Refresh\./u);
  assert.match(app.row('future'), /Install state unknown/u, 'a state this page does not know is unknown');
  assert.match(app.row('future'), /unknown reason/u);
  const path = app.document.querySelector('section[aria-label="kiro"] .fact-path');
  assert.equal(path?.textContent, '/home/u/.local/bin/kiro-cli', 'the program found, as text on the row: readable on a phone, no hover needed');
  assert.equal(app.q('.page-head'), null, 'inside Settings the host owns the head');
  assert.equal(app.text().match(/default provider and model/gu)?.length, 1, 'the scope line once, at the head of the section');
  assert.match(app.q('.backends .config-form > .config-note')?.textContent ?? '', /default provider and model/u);
});

// ── A reply is not a result (reviewer P1-A on d7c6ab54) ───────────────────
// The server answers a check that could not run INSIDE a normal reply: these
// are readiness.rs `refresh_timed_out` / `test_timed_out` and the flight's
// panic answer, resolved, not rejected.
const ALL = ['kiro', 'claude', 'codex', 'grok', 'omp', 'kimi', 'dsh'];
const unknownSetUp = (reason: string) => ({ state: 'unknown', basis: 'presence', via: null, missing: [], reason });
const unknownAnswers = (reason: string) => ({ state: 'unknown', count: null, reason });
const REFRESH_TIMED_OUT = {
  backends: ALL.map((name) => ({ name, program: name, installed: { state: 'unknown', path: null, version: null, reason: 'check_timeout' },
    set_up: unknownSetUp('check_timeout'), answers: unknownAnswers('check_timeout') })),
  scope: 'default', baseline: 'check_timeout',
};
const TEST_TIMED_OUT = { test: { name: 'kiro', set_up: unknownSetUp('check_timeout'), answers: unknownAnswers('check_timeout') } };
const CODEX = {
  name: 'codex', program: 'codex',
  installed: { state: 'present', path: '/home/u/.local/bin/codex', version: '0.162.1', reason: null },
  set_up: { state: 'present', basis: 'presence', via: 'env OPENAI_API_KEY', missing: [], reason: null },
  answers: { state: 'unknown', count: null, reason: 'first_run' },
};
const MINUTE = 60_000;

/** A Refresh, then a successful kiro Test, five minutes apart. */
async function known(context: TestContext) {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  const refreshedAt = clock(Date.now());
  s.waits[0]!.resolve(report(KIRO, CODEX)); await app.flush();
  await app.advance(5 * MINUTE);
  const testedAt = clock(Date.now());
  app.button('Test', 'kiro').click(); await app.flush();
  s.waits[1]!.resolve(TESTED); await app.flush();
  await app.advance(5 * MINUTE);
  return { s, app, refreshedAt, testedAt };
}

test('a Refresh that timed out on the server keeps the earlier facts, their times and the Test (P1-A)', async (context) => {
  const { s, app, refreshedAt, testedAt } = await known(context);
  app.button('Refresh').click(); await app.flush();
  s.waits[2]!.resolve(REFRESH_TIMED_OUT); await app.flush();
  assert.match(app.text(), new RegExp(`Could not check now \\(the check did not answer in time\\)\\. Showing the result from ${refreshedAt}\\.`, 'u'));
  assert.match(app.text(), /Try Refresh later\. A hung file system on the server can hold the check\./u, 'the known advice, once');
  assert.match(app.row('kiro'), /1\.2\.3/u, 'Installed is the earlier answer\u2019s');
  assert.match(app.row('kiro'), /Signed in per the CLI \(builder_id\)/u);
  assert.match(app.row('kiro'), /Yes, 24 models/u);
  assert.match(app.row('kiro'), new RegExp(`Tested at ${testedAt}\\.`, 'u'), 'the Test keeps its own time');
  assert.match(app.row('codex'), /0\.162\.1[\s\S]*Present \(env OPENAI_API_KEY\)/u);
  assert.doesNotMatch(app.text(), /Install state unknown|Checked at/u, 'a timeout is not a new result');
  assert.equal(app.button('Refresh').disabled, false, 'released, usable');
  assert.equal(app.button('Test', 'kiro').disabled, false, 'the Test entry is still there');
});

test('a Test that timed out on the server says so and keeps the earlier Test and its time (P1-A)', async (context) => {
  const { s, app, testedAt } = await known(context);
  app.button('Test', 'kiro').click(); await app.flush();
  s.waits[2]!.resolve(TEST_TIMED_OUT); await app.flush();
  assert.match(app.row('kiro'), /This Test could not run \(the check did not answer in time\)\./u);
  assert.match(app.row('kiro'), /Signed in per the CLI \(builder_id\)/u);
  assert.match(app.row('kiro'), /Yes, 24 models/u);
  assert.match(app.row('kiro'), new RegExp(`Tested at ${testedAt}\\.`, 'u'));
  assert.equal(app.button('Test', 'kiro').disabled, false);
});

test('a first check that timed out shows no result, only that it could not check (P1-A)', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.resolve(REFRESH_TIMED_OUT); await app.flush();
  assert.match(app.text(), /Could not check now \(the check did not answer in time\)\./u);
  assert.doesNotMatch(app.text(), /Showing the result from|Checked at/u);
  assert.equal(app.document.querySelectorAll('section.backend').length, 0, 'seven rows of unknown are not a result');
  assert.equal(app.button('Refresh').disabled, false);
});

test('the server\u2019s own failure answer is a failure, not rows (P1-A)', async (context) => {
  const s = server();
  const app = await mount(context, { runtime: s.runtime, active: true, cap: 'present' });
  s.waits[0]!.resolve({ error: 'check_failed' }); await app.flush();
  assert.match(app.text(), /Could not check now \(the check failed on the server\)\./u);
});

test('a NEGATIVE answer is news: not signed in and an empty model list replace the earlier Test (P1-A control)', async (context) => {
  const { s, app } = await known(context);
  const now = clock(Date.now());
  app.button('Test', 'kiro').click(); await app.flush();
  s.waits[2]!.resolve({ test: { name: 'kiro',
    set_up: { state: 'missing', basis: 'cli', via: null, missing: [], reason: 'not_signed_in' },
    answers: { state: 'no', count: 0, reason: 'empty_catalogue' } } }); await app.flush();
  assert.match(app.row('kiro'), /Missing[\s\S]*the CLI says it is not signed in/u);
  assert.match(app.row('kiro'), /\bNo\b[\s\S]*it listed no models/u);
  assert.match(app.row('kiro'), new RegExp(`Tested at ${now}\\.`, 'u'));
  assert.doesNotMatch(app.row('kiro'), /could not run|Signed in per the CLI|24 models/u);
});

test('a partial answer renews what it found and keeps, with its time, what it could not decide (P1-A)', async (context) => {
  const { s, app, refreshedAt, testedAt } = await known(context);
  // The login-shell probe timed out: set up is undecided, the PATH walk is new.
  app.button('Refresh').click(); await app.flush();
  s.waits[2]!.resolve({ backends: [KIRO, { ...CODEX, installed: { ...CODEX.installed, version: '0.170.0' }, set_up: unknownSetUp('probe_timeout') }],
    scope: 'default', baseline: 'probe_timeout' }); await app.flush();
  assert.match(app.row('codex'), /0\.170\.0/u, 'what it found is new');
  assert.match(app.row('codex'), new RegExp(`Present \\(env OPENAI_API_KEY\\)[\\s\\S]*From the check at ${refreshedAt}; the latest one could not decide it \\(the login-shell check timed out\\)\\.`, 'u'));
  assert.match(app.text(), /The login-shell check could not run: the login-shell check timed out\./u);
  assert.match(app.row('kiro'), new RegExp(`Signed in per the CLI \\(builder_id\\)[\\s\\S]*Tested at ${testedAt}\\.`, 'u'),
    'a Refresh that still leaves kiro to a Test keeps the Test');
  // A Test whose model list never answered: sign-in is new, the count is kept.
  await app.advance(5 * MINUTE);
  const nowAt = clock(Date.now());
  app.button('Test', 'kiro').click(); await app.flush();
  s.waits[3]!.resolve({ test: { name: 'kiro', set_up: { state: 'present', basis: 'cli', via: 'iam_identity_center', missing: [], reason: null },
    answers: unknownAnswers('cli_timeout') } }); await app.flush();
  assert.match(app.row('kiro'), /Signed in per the CLI \(iam_identity_center\)/u);
  assert.match(app.row('kiro'), new RegExp(`Yes, 24 models[\\s\\S]*From the check at ${testedAt}; the latest one could not decide it \\(the CLI's own check timed out\\)\\.`, 'u'));
  assert.match(app.row('kiro'), new RegExp(`Tested at ${nowAt}\\.`, 'u'));
  assert.doesNotMatch(app.row('kiro'), /could not run \(/u, 'a Test that found something is not a failed Test');
});

// Reviewer P1-A residual on b19f703b: a Test fact is new only when the CLI
// gave a DEFINITE answer. The CLI failing or writing what the check cannot
// read (decide_test's cli_exit / cli_unreadable / cli_bad_answer /
// cli_overflow) is a Test that could not decide.
const cliSetUp = (reason: string) => ({ state: 'unknown', basis: 'cli', via: null, missing: [], reason });
for (const [why, reason, text] of [
  ['exited with a failure', 'cli_exit', "the CLI's own check exited with a failure it does not explain"],
  ['wrote output the check cannot read', 'cli_unreadable', "the CLI's own check gave no answer this check reads"],
] as const) {
  test(`a Test whose CLI ${why} keeps the earlier Test and its time, and says it could not run (P1-A residual)`, async (context) => {
    const { s, app, testedAt } = await known(context);
    app.button('Test', 'kiro').click(); await app.flush();
    s.waits[2]!.resolve({ test: { name: 'kiro', set_up: cliSetUp(reason), answers: unknownAnswers(reason) } }); await app.flush();
    assert.match(app.row('kiro'), new RegExp(`This Test could not run \\(${text.replace(/[()']/gu, '.')}\\)\\.`, 'u'));
    assert.match(app.row('kiro'), /Signed in per the CLI \(builder_id\)/u);
    assert.match(app.row('kiro'), /Yes, 24 models/u);
    assert.match(app.row('kiro'), new RegExp(`Tested at ${testedAt}\\.`, 'u'));
    assert.equal(app.button('Test', 'kiro').disabled, false, 'usable again');
    assert.equal(app.button('Refresh').disabled, false);
  });
}

test('a Test with one definite answer and one unreadable updates only the definite one (P1-A residual)', async (context) => {
  const { s, app, testedAt } = await known(context);
  const nowAt = clock(Date.now());
  app.button('Test', 'kiro').click(); await app.flush();
  s.waits[2]!.resolve({ test: { name: 'kiro', set_up: { state: 'present', basis: 'cli', via: 'iam_identity_center', missing: [], reason: null },
    answers: unknownAnswers('cli_bad_answer') } }); await app.flush();
  assert.match(app.row('kiro'), /Signed in per the CLI \(iam_identity_center\)/u, 'the definite answer is new');
  assert.match(app.row('kiro'), new RegExp(`Yes, 24 models[\\s\\S]*From the check at ${testedAt}; the latest one could not decide it \\(the CLI's own check gave no answer this check reads\\)\\.`, 'u'));
  assert.match(app.row('kiro'), new RegExp(`Tested at ${nowAt}\\.`, 'u'));
  assert.doesNotMatch(app.row('kiro'), /This Test could not run/u);
});

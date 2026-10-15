// Two servers' backend lists, held at once (board #335 ②a-4).
//
// `agents.test.ts` covers what ONE list answers and is unchanged by the
// conversion to a factory — that it still passes is the evidence Single mode
// did not move. This file adds what a factory buys: two answers that cannot
// reach each other, which matters because the list is a statement about one
// MACHINE's installed CLIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendCatalog, type BackendInfo } from './agents.ts';

const info = (over: Partial<BackendInfo> & { name: string }): BackendInfo =>
  ({ icon: `/assets/${over.name}.svg`, color: `--backend-${over.name}`, efforts: [], ...over });

test('two servers answer for their own installed CLIs', () => {
  // The real case: a laptop with kiro and codex, a build box with only claude.
  const a = createBackendCatalog();
  const b = createBackendCatalog();
  a.set([info({ name: 'kiro', efforts: ['low', 'max'], input_modes: true, default_input_mode: 'steer' }), info({ name: 'codex' })]);
  b.set([info({ name: 'claude', efforts: ['high'] })]);

  assert.deepEqual(a.spawnable(), ['kiro', 'codex']);
  assert.deepEqual(b.spawnable(), ['claude']);
  assert.equal(a.defaultBackend(), 'kiro');
  assert.equal(b.defaultBackend(), 'claude');
  assert.deepEqual(a.efforts('kiro'), ['low', 'max']);
  assert.equal(a.switchesInputMode('kiro'), true);
  // B has no kiro at all, so asking B about it falls back to what the client
  // ships rather than borrowing A's answer.
  assert.deepEqual(b.efforts('kiro'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(b.switchesInputMode('kiro'), false, 'server truth only, and B never said it');
  // Board #336: a new draft's mode is the server's word too.
  assert.equal(a.defaultInputMode('kiro'), 'steer');
  assert.equal(a.defaultInputMode('codex'), 'queue', 'a backend that names none queues');
  assert.equal(b.defaultInputMode('kiro'), 'queue', 'and B never said kiro steers');
});

test('one server s list arriving does not notify the other, or change it', () => {
  const a = createBackendCatalog();
  const b = createBackendCatalog();
  let aChanges = 0;
  let bChanges = 0;
  const offA = a.onChange(() => { aChanges++; });
  b.onChange(() => { bChanges++; });

  a.set([info({ name: 'kiro' })]);
  assert.equal(aChanges, 1);
  assert.equal(bChanges, 0, 'B s open pages are not told about A s connect');
  assert.equal(b.known(), false, 'and B has still not answered');

  // A reconnect that loses the list is A's alone.
  a.set(null);
  assert.equal(a.known(), false);
  b.set([info({ name: 'claude' })]);
  assert.equal(b.known(), true);
  assert.equal(a.known(), false, 'B answering does not answer for A');

  const settled = aChanges;                 // a.set(null) above notified too
  offA();
  a.set([info({ name: 'kiro' })]);
  assert.equal(aChanges, settled, 'the unsubscribe is per instance too');
  assert.equal(bChanges, 1, 'and B only ever heard about B');
});

test('an empty list is "not answered", per server', () => {
  // A present but empty list tells us nothing, so every reader falls back —
  // and "no switch" is only a verdict once a list has really arrived.
  const a = createBackendCatalog();
  a.set([]);
  assert.equal(a.known(), false);
  assert.deepEqual(a.spawnable(), ['kiro', 'claude', 'codex', 'grok', 'omp']);
});

test('what the client SHIPS is not per server', () => {
  // The frozen pre-#130 fallbacks and the avatar switch describe this build.
  // Two servers must not get two different answers for them.
  const a = createBackendCatalog();
  const b = createBackendCatalog();
  assert.deepEqual(a.spawnable(), b.spawnable(), 'the same frozen fallback for both');
  assert.equal(a.icon('openclaw'), '/assets/openclaw.svg');
  assert.equal(b.icon('openclaw'), '/assets/openclaw.svg', 'a detection-only CLI is the client s knowledge');
  // A server's own icon still wins for that server.
  a.set([info({ name: 'kiro', icon: '/assets/custom.svg' })]);
  assert.equal(a.icon('kiro'), '/assets/custom.svg');
  assert.equal(b.icon('kiro'), '/assets/kiro.svg', 'and only for that server');
});

test('a catalog keeps answering once a page destructures it (board #335 ②b-3)', () => {
  // The module-level catalog and its named exports are gone: each runtime's
  // state holds one, and a page takes its methods apart once at init
  // (`const { defaultBackend, icon } = scope.state.backends`). A method that
  // leaned on `this` would answer from nothing then.
  const c = createBackendCatalog();
  const { defaultBackend, spawnable, icon, known } = c;
  assert.equal(defaultBackend(), 'kiro', 'unanswered: the build s first fallback');
  c.set([info({ name: 'grok' })]);
  assert.equal(known(), true);
  assert.deepEqual(spawnable(), ['grok']);
  assert.equal(defaultBackend(), 'grok', 'the server s first, through the destructured method');
  assert.equal(icon('grok'), '/assets/grok.svg');
});

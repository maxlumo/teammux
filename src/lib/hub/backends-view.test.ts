// Backend readiness, the page's pure half (board #492 phase 2): the cap's
// three states and the one shown-predicate, the fact-to-dot map, reason and
// hint lookup, and the answer validation at the door.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  REASON_CODES, backendsShown, capState, factDot, hintKey, noteCap, readRefresh, readTest, reasonKey, rowHints, testable,
} from './backends-view.ts';

test('caps undefined is unknown, not absent; a list without the cap is absent', () => {
  assert.equal(capState(undefined), 'unknown');
  assert.equal(capState([]), 'absent');
  assert.equal(capState(['mcp_masked']), 'absent');
  assert.equal(capState(['mcp_masked', 'backends_check']), 'present');
});

test('the shown-predicate keeps the last definite answer through a reconnect (P1-B)', () => {
  const fresh = {};
  assert.equal(backendsShown(fresh, 'unknown'), true, 'nothing known yet: unknown is not no');
  const old = {};
  noteCap(old, 'absent');
  assert.equal(backendsShown(old, 'absent'), false, 'known absent: no entry');
  noteCap(old, 'unknown');
  assert.equal(backendsShown(old, 'unknown'), false, 'a reconnect to a server known to lack it does not flash the entry');
  const current = {};
  noteCap(current, 'present');
  noteCap(current, 'unknown');
  assert.equal(backendsShown(current, 'unknown'), true, 'a reconnect keeps the section the server has');
  assert.equal(backendsShown({}, 'present'), true);
  noteCap(current, 'absent');
  assert.equal(backendsShown(current, 'absent'), false, 'a definite no wins over what was known before');
});

test('a fact wears the one dot language: good at rest, act-on amber, undecided grey', () => {
  assert.equal(factDot('present'), 'idle');
  assert.equal(factDot('yes'), 'idle');
  assert.equal(factDot('missing'), 'waiting');
  assert.equal(factDot('no'), 'waiting');
  for (const s of ['unknown', undefined, 'something-new']) assert.equal(factDot(s), 'shell', `${s} is never a verdict`);
});

test('every reason the server writes has its words here; an unknown one falls back, never to "missing"', async () => {
  const rust = await readFile(new URL('../../../src-tauri/src/backends/readiness.rs', import.meta.url), 'utf8');
  const body = /pub fn reason_text\(code: &str\) -> &'static str \{([\s\S]*?)\n\}/u.exec(rust)?.[1] ?? '';
  const codes = [...body.matchAll(/"([a-z_]+)"/gu)].map((m) => m[1]!);
  assert.ok(codes.length > 30, 'the server table was read');
  assert.deepEqual(codes.filter((c) => !REASON_CODES.includes(c)), [], 'a server reason without page words');
  assert.equal(reasonKey('a_code_from_a_newer_server'), 'backendsReasonUnknown');
  assert.equal(reasonKey(null), 'backendsReasonUnknown');
  const i18n = await readFile(new URL('../core/i18n.svelte.ts', import.meta.url), 'utf8');
  const en = /^  en: \{([\s\S]*?)^  \},/mu.exec(i18n)?.[1] ?? '';
  const keys = new Set([...REASON_CODES.map(reasonKey), 'backendsReasonUnknown', ...REASON_CODES.map(hintKey).filter(Boolean)]);
  for (const key of keys) assert.match(en, new RegExp(`^    ${key}:`, 'mu'), `${key} has words`);
});

test('fix hints exist only where the fix is known, and each names the server', async () => {
  assert.deepEqual(['not_found', 'env_unset', 'no_tmux', 'test_only', 'check_timeout', 'path_unreadable'].map((c) => !!hintKey(c)), [true, true, true, true, true, true]);
  for (const c of ['not_signed_in', 'aws_chain', 'config_invalid', 'config_absent', 'invalid_env_name', 'cli_exit', 'cli_timeout', 'nope', null]) {
    assert.equal(hintKey(c), null, `${c}: its reason alone`);
  }
  const i18n = await readFile(new URL('../core/i18n.svelte.ts', import.meta.url), 'utf8');
  for (const [, lang, body] of i18n.matchAll(/^  (en|zh): \{([\s\S]*?)^  \},/gmu)) {
    for (const key of ['backendsFixNotFound', 'backendsFixEnvUnset', 'backendsFixNoTmux', 'backendsFixCheckTimeout', 'backendsFixPathUnreadable']) {
      const line = new RegExp(`^    ${key}: (.*)$`, 'mu').exec(body!)?.[1] ?? '';
      assert.match(line, lang === 'en' ? /server/u : /服务器/u, `${lang} ${key} says what to change is the server`);
    }
  }
});

test('a row says each hint once: kiro\u2019s two test_only facts are one "Press Test"', () => {
  const kiro = { name: 'kiro', program: 'kiro-cli', installed: { state: 'present' }, set_up: { state: 'unknown', reason: 'test_only' }, answers: { state: 'unknown', reason: 'test_only' } };
  assert.deepEqual(rowHints(kiro).map((h) => h.key), ['backendsFixTestOnly']);
  assert.equal(testable(kiro), true, 'Test is offered where the SERVER says only a Test decides');
  const kimi = { name: 'kimi', program: 'kimi', installed: { state: 'missing', reason: 'not_found' }, set_up: { state: 'missing', missing: ['KIMI_API_KEY'], reason: 'env_unset' }, answers: { state: 'unknown', reason: 'first_run' } };
  assert.deepEqual(rowHints(kimi), [
    { key: 'backendsFixNotFound', program: 'kimi', names: [] },
    { key: 'backendsFixEnvUnset', program: 'kimi', names: ['KIMI_API_KEY'] },
  ]);
  assert.equal(testable(kimi), false);
});

test('answers are validated at the door', () => {
  assert.equal(readRefresh(null), null);
  assert.equal(readRefresh({ backends: 'no' }), null);
  assert.deepEqual(readRefresh({ backends: [{ name: 'kiro' }, { nope: 1 }, null], baseline: 'no_tmux' }), { backends: [{ name: 'kiro' }], baseline: 'no_tmux' });
  assert.deepEqual(readRefresh({ backends: [] }), { backends: [], baseline: null });
  const test = { test: { name: 'kiro', set_up: { state: 'present' }, answers: { state: 'yes', count: 3 } } };
  assert.deepEqual(readTest(test, 'kiro'), { set_up: { state: 'present' }, answers: { state: 'yes', count: 3 } });
  assert.equal(readTest(test, 'claude'), null, 'an answer for another backend is not this Test\u2019s');
  assert.equal(readTest({ test: { name: 'kiro' } }, 'kiro'), null);
});

test('a reply is read for what it FOUND: the server\u2019s timeout and failure shapes are not results (P1-A)', async () => {
  const { notRun, refreshFailed, testFailed, mergeFact } = await import('./backends-view.ts');
  const u = (reason: string) => ({ state: 'unknown', reason });
  for (const r of ['check_timeout', 'probe_timeout', 'no_tmux', 'helper_missing', 'cli_timeout', 'cli_lost', 'cli_exit', 'cli_unreadable', 'cli_bad_answer', 'cli_overflow']) {
    assert.equal(notRun(u(r)), true, `${r}: the CLI gave no definite answer`);
  }
  for (const r of ['first_run', 'test_only', 'aws_chain', 'credential_store_unverified', 'path_unreadable']) assert.equal(notRun(u(r)), false, `${r} is what the check can say`);
  assert.equal(notRun({ state: 'missing', reason: 'not_signed_in' }), false, 'a negative fact is news');
  assert.equal(notRun({ state: 'no', reason: 'empty_catalogue' }), false);
  const row = (reason: string) => ({ name: 'kiro', installed: u(reason), set_up: u(reason), answers: u(reason) });
  assert.equal(refreshFailed({ backends: [row('check_timeout')], baseline: 'check_timeout' }), 'check_timeout');
  assert.equal(refreshFailed({ error: 'check_failed' }), 'check_failed');
  assert.equal(refreshFailed({ backends: [row('probe_lost')], baseline: null }), 'probe_lost', 'not one fact found');
  assert.equal(refreshFailed({ backends: [{ ...row('probe_timeout'), installed: { state: 'present' } }], baseline: 'probe_timeout' }), null, 'a partial answer is a result');
  assert.equal(refreshFailed({ backends: [{ name: 'omp', installed: { state: 'present' }, set_up: u('credential_store_unverified'), answers: u('first_run') }], baseline: null }), null);
  assert.equal(testFailed({ test: { name: 'kiro', set_up: u('check_timeout'), answers: u('check_timeout') } }, 'kiro'), 'check_timeout');
  assert.equal(testFailed({ test: { name: 'kiro', set_up: { state: 'present' }, answers: u('cli_timeout') } }, 'kiro'), null);
  assert.equal(testFailed({ test: { name: 'kiro', set_up: { state: 'unknown', reason: 'cli_exit' }, answers: u('cli_exit') } }, 'kiro'), 'cli_exit', 'output is not an answer');
  assert.deepEqual(mergeFact({ state: 'present', via: 'x' } as never, u('probe_timeout'), 100), { state: 'present', via: 'x', kept: { at: 100, reason: 'probe_timeout' } });
  assert.deepEqual(mergeFact({ state: 'present', kept: { at: 50, reason: 'a' } } as never, u('probe_timeout'), 100), { state: 'present', kept: { at: 50, reason: 'probe_timeout' } }, 'a kept fact keeps its OWN time');
  assert.deepEqual(mergeFact({ state: 'present' }, { state: 'missing', reason: 'not_signed_in' }, 100), { state: 'missing', reason: 'not_signed_in' });
  assert.deepEqual(mergeFact(u('first_run'), u('probe_timeout'), 100), u('probe_timeout'), 'nothing definite to keep');
});

test('config_invalid says the same format-neutral words in tmm and on the page (reviewer P2-B, non-negotiable 14)', async () => {
  // It covers Claude's settings.json and non-UTF-8 bytes too, not only TOML.
  const rust = await readFile(new URL('../../../src-tauri/src/backends/readiness.rs', import.meta.url), 'utf8');
  const server = /"config_invalid" => "([^"]*)"/u.exec(rust)?.[1];
  const i18n = await readFile(new URL('../core/i18n.svelte.ts', import.meta.url), 'utf8');
  const page = /^    backendsReasonConfigInvalid: '([^']*)',$/mu.exec(i18n)?.[1];
  assert.equal(server, 'its config is invalid');
  assert.equal(page, server, 'the CLI and the page say the same thing');
  assert.doesNotMatch(`${server} ${page}`, /TOML/u);
});

// Board #7: the Agents list's two groups and an agent's availability, as
// `registry_list` states them (the server's ONE rule, readiness::unavailable).
import { agentGroups, unavailableOf, unavailableText } from './backends-view.ts';

const def = (name: string, backend: string, group?: string, availability?: object) => ({ name, backend, group, availability });

test('the list partitions into harness defaults then custom agents, in the server order (#7)', () => {
  const defs = [def('kiro', 'kiro', 'default'), def('codex', 'claude', 'custom'), def('grok', 'grok', 'default'), def('pentester', 'kiro', 'custom')];
  const g = agentGroups(defs)!;
  assert.deepEqual(g.defaults.map((d) => d.name), ['kiro', 'grok']);
  assert.deepEqual(g.custom.map((d) => d.name), ['codex', 'pentester']);
  assert.equal(agentGroups([def('kiro', 'kiro')]), null, 'an older server names no group: no groups');
});

test('only a stated unavailable greys, and the words say why (#7)', () => {
  const t = (k: string) => ({
    agentsUnavailable: 'Unavailable: {program} {reason}',
    agentsUnavailableMissing: 'Unavailable: {program} missing {names} ({reason})',
    backendsReasonNotFound: 'not on the managed PATH',
    backendsReasonEnvUnset: "not set in the login shell's environment",
    backendsReasonUnknown: 'unknown reason',
  } as Record<string, string>)[k] ?? k;
  const grok = def('grok', 'grok', 'default', { state: 'unavailable', reason: 'not_found', missing: [] });
  const dsh = def('dsh', 'dsh', 'default', { state: 'unavailable', reason: 'env_unset', missing: ['DEEPSEEK_API_KEY'] });
  assert.deepEqual(unavailableOf(grok), { reason: 'not_found', missing: [] });
  assert.equal(unavailableText(grok, t), 'Unavailable: grok not on the managed PATH');
  assert.equal(unavailableText(dsh, t), "Unavailable: dsh missing DEEPSEEK_API_KEY (not set in the login shell's environment)");
  for (const a of [{ state: 'available' }, { state: 'unknown' }, undefined, { state: 'unavailable-ish' }]) {
    assert.equal(unavailableOf(def('x', 'kiro', 'default', a)), null, JSON.stringify(a));
  }
  assert.equal(unavailableText(def('x', 'kiro', 'custom', { state: 'unavailable', reason: 'brand_new_code' }), t), 'Unavailable: kiro unknown reason');
});

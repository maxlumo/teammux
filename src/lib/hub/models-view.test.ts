import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILED_MODELS, NO_MODELS, defaultLabel, readModels } from './models-view.ts';

const t = (key: string) => ({ agentsModelDefault: 'backend default', agentsModelDefaultIs: 'default: {id}', agentsModelDefaultUnknown: 'default unknown' } as Record<string, string>)[key] ?? key;
const answer = (extra: Record<string, unknown> = {}) => ({ backend: 'codex', models: ['a', 'b'], kind: 'authoritative', complete: true,
  list_reason: null, default: 'a', default_reason: null, ...extra });
const facts = (r: unknown) => { const v = readModels(r); return [v.status, v.defaultStatus]; };

// Board #511 P3: the two facts of a models_list answer, and which absences are
// facts (nothing to list) and which are failures (Retry).
test('readModels tells a list, a fact, a failure and an older server apart', () => {
  const ok = readModels(answer({ kind: 'suggestions', complete: false, list_reason: 'overflow' }));
  assert.deepEqual(ok, { status: 'ok', ids: ['a', 'b'], kind: 'suggestions', complete: false, defaultStatus: 'ok', baseline: 'a' });

  // dsh: no list is a FACT, and the default survives without a list.
  const dsh = readModels(answer({ models: null, kind: null, complete: false, list_reason: 'not_listed', default: 'deepseek-flash' }));
  assert.deepEqual([dsh.status, dsh.defaultStatus, dsh.baseline], ['none', 'ok', 'deepseek-flash'], 'not_listed is not a failure: no Retry');

  for (const reason of ['unreadable', 'invalid', 'too_large', 'overflow', 'cli_failed']) {
    assert.deepEqual(facts(answer({ models: null, kind: null, complete: false, list_reason: reason, default: null, default_reason: 'not_derivable' })),
      ['failed', 'none'], reason);
  }

  // An older server answers models only: no kind KEY at all.
  const old = readModels({ backend: 'kiro', models: ['auto'] });
  assert.deepEqual(old, { status: 'unsupported', ids: ['auto'], kind: null, complete: true, defaultStatus: 'unsupported', baseline: null });
  assert.equal(readModels({ backend: 'kiro', models: null }).status, 'unsupported');

  // Nothing readable is a failure of both facts, never a list.
  assert.deepEqual(readModels(null), FAILED_MODELS);
  assert.deepEqual(readModels('nope'), FAILED_MODELS);
  assert.deepEqual(readModels(answer({ models: ['a', 7] })).ids, ['a'], 'a non-string id is dropped');
});

// P3 review P1-A: the list and the default are two facts in the UI too; a
// default that could not be read is never "the backend's default".
test('the default fails on its own, beside a good list or a list that does not exist', () => {
  assert.deepEqual(facts(answer({ default: null, default_reason: 'unreadable' })), ['ok', 'failed'], 'list ok + default unreadable');
  assert.deepEqual(facts(answer({ models: null, kind: null, complete: false, list_reason: 'not_listed', default: null, default_reason: 'invalid' })),
    ['none', 'failed'], 'not_listed + default invalid');
  assert.deepEqual(facts(answer({ models: null, kind: null, complete: false, list_reason: 'cli_failed', default: 'x' })), ['failed', 'ok'], 'list failed + default ok');
  assert.deepEqual(facts(answer({ models: null, kind: null, complete: false, list_reason: 'unreadable', default: null, default_reason: 'invalid' })),
    ['failed', 'failed'], 'both failed');
  // The legal absences are facts: Ok(None) is null with no reason; kiro's is not_derivable.
  assert.deepEqual(facts(answer({ default: null, default_reason: null })), ['ok', 'none']);
  assert.deepEqual(facts(answer({ default: null, default_reason: 'not_derivable' })), ['ok', 'none']);
});

// An answer this client cannot judge is not a fact: an unknown reason or
// shape is `failed` (Retry), never `none` and never a list.
test('an unknown reason or shape is a failure, never not_listed', () => {
  assert.deepEqual(facts(answer({ models: null, kind: null, complete: false, list_reason: 'gone_fishing' })), ['failed', 'ok'], 'unknown list reason');
  assert.deepEqual(facts(answer({ models: null, kind: null, complete: false, list_reason: null })), ['failed', 'ok'], 'no list and no reason');
  assert.deepEqual(facts(answer({ kind: 'whitelist' })), ['failed', 'ok'], 'unknown kind');
  assert.deepEqual(facts(answer({ complete: 'yes' })), ['failed', 'ok'], 'complete not a boolean');
  assert.deepEqual(facts(answer({ complete: false, list_reason: null })), ['failed', 'ok'], 'cut without saying why');
  assert.deepEqual(facts(answer({ models: 'a,b' })), ['failed', 'ok'], 'models not an array');
  assert.deepEqual(facts(answer({ default: null, default_reason: 'gone_fishing' })), ['ok', 'failed'], 'unknown default reason');
  assert.deepEqual(facts(answer({ default: 7 })), ['ok', 'failed'], 'default not a string');
  assert.deepEqual(facts(answer({ default: 'a', default_reason: 'unreadable' })), ['ok', 'failed'], 'an id beside a failure');
  const noDefaultKeys: Record<string, unknown> = answer();
  delete noDefaultKeys.default; delete noDefaultKeys.default_reason;
  assert.deepEqual(facts(noDefaultKeys), ['ok', 'failed'], 'a new server that dropped the default');
});

test('the empty field is labelled with the baseline default, "default unknown" on a failure, or the generic one', () => {
  assert.equal(defaultLabel(readModels(answer({ default: 'opus' })), t), 'default: opus');
  assert.equal(defaultLabel(readModels(answer({ default: null, default_reason: 'unreadable' })), t), 'default unknown', 'a failure is not the CLI default');
  assert.equal(defaultLabel(FAILED_MODELS, t), 'default unknown');
  assert.equal(defaultLabel(readModels(answer({ default: null, default_reason: 'not_derivable' })), t), 'backend default');
  assert.equal(defaultLabel(NO_MODELS, t), 'backend default');
  assert.equal(defaultLabel(readModels({ backend: 'kiro', models: ['auto'] }), t), 'backend default', 'an older server says nothing more');
});

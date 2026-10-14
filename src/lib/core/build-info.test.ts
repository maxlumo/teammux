// The UI's side of the build identity (board #368): what a login answer's
// `build` parses to, the one line every surface speaks, and the one verdict —
// two different real commits — that About colours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_COMMIT, NO_TIME, buildParts, buildsDiffer, formatBuild, parseBuild, uiBuild, uiLicense, type BuildInfo } from './build-info.ts';

const B: BuildInfo = { version: '1.0.0', commit: '46392f16', built: '2026-10-14 07:40' };

test('a build parses only as three plain strings, else it is none', () => {
  assert.deepEqual(parseBuild({ ...B, extra: 1 }), B, 'extra members are ignored');
  for (const bad of [undefined, null, 'v1', 7, [], {}, { version: '1', commit: 'a' }, { ...B, commit: '' }, { ...B, built: 3 }, { ...B, version: null }]) {
    assert.equal(parseBuild(bad), null, JSON.stringify(bad));
  }
});

test('the line is the words tmm gateway status prints', () => {
  assert.equal(formatBuild(B), 'v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC');
  assert.equal(formatBuild({ ...B, built: NO_TIME }), 'v1.0.0 · 46392f16 · unknown', 'an unknown time is not "unknown UTC"');
  assert.equal(formatBuild({ ...B, commit: NO_COMMIT }), 'v1.0.0 · dev · 2026-10-14 07:40 UTC');
});

test('the line is its two halves joined: what it IS, then when it was made', () => {
  assert.deepEqual(buildParts(B), { id: 'v1.0.0 · 46392f16', when: '2026-10-14 07:40 UTC' });
  assert.deepEqual(buildParts({ ...B, built: NO_TIME }), { id: 'v1.0.0 · 46392f16', when: 'unknown' });
  assert.equal(formatBuild(B), `${buildParts(B).id} · ${buildParts(B).when}`, 'one definition: the line is built FROM the halves');
});

test('only two real, different commits are a mismatch', () => {
  const ui = B;
  assert.equal(buildsDiffer(ui, { ...B, commit: '0badc0de' }), true, 'the stale-PWA tell');
  assert.equal(buildsDiffer(ui, { ...B, built: '2026-10-15 01:00' }), false, 'the same commit built twice is the same code');
  assert.equal(buildsDiffer(ui, B), false);
  assert.equal(buildsDiffer(ui, null), false, 'an older server cannot be compared');
  assert.equal(buildsDiffer(ui, undefined), false, 'no socket cannot be compared');
  assert.equal(buildsDiffer({ ...B, commit: NO_COMMIT }, { ...B, commit: '0badc0de' }), false, 'a dev UI names no commit');
  assert.equal(buildsDiffer(ui, { ...B, commit: NO_COMMIT }), false, 'a dev server names no commit');
});

test('outside Vite the UI says what it does not know instead of inventing a commit', () => {
  // node --test runs no Vite, so no define: the fallback, never a made-up hash.
  assert.equal(uiBuild.commit, NO_COMMIT);
  assert.equal(uiBuild.built, NO_TIME);
  assert.equal(uiLicense, '');
});

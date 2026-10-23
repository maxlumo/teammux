// Board #460: `build:android` refuses to start without a named SDK and NDK,
// instead of reaching tauri's interactive NDK prompt.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./preflight.mjs', import.meta.url));
const run = (env: Record<string, string>) => spawnSync(process.execPath, [script, 'android-env'], {
  // Only what is given: no ANDROID_HOME/NDK_HOME leaks in from the shell.
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

const sdk = mkdtempSync(join(tmpdir(), 'preflight-sdk-'));
const ndk = join(sdk, 'ndk', '28.2.13676358');
mkdirSync(ndk, { recursive: true });

test('android-env: neither variable set → refuses, naming both', () => {
  const r = run({});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ANDROID_HOME is not set/u);
  assert.match(r.stderr, /NDK_HOME is not set/u);
  assert.match(r.stderr, /development\.md/u);
  assert.doesNotMatch(r.stderr, /export /u, 'nothing is guessed: with no SDK named, no NDK is offered');
});

test('android-env: the SDK named, NDK_HOME unset → refuses, and offers the NDK it finds as an export line', () => {
  const r = run({ ANDROID_HOME: sdk });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /ANDROID_HOME/u);
  assert.match(r.stderr, /NDK_HOME is not set/u);
  assert.ok(r.stderr.includes(`export NDK_HOME=${ndk}`), r.stderr);
});

test('android-env: a path that does not exist is refused like an unset one', () => {
  const r = run({ ANDROID_HOME: join(sdk, 'nope'), NDK_HOME: join(sdk, 'ndk', 'nope') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ANDROID_HOME=.*nope is not a directory/u);
  assert.match(r.stderr, /NDK_HOME=.*nope is not a directory/u);
});

test('android-env: both named and present → passes silently; ANDROID_SDK_ROOT counts for the SDK', () => {
  for (const env of [{ ANDROID_HOME: sdk, NDK_HOME: ndk }, { ANDROID_SDK_ROOT: sdk, NDK_HOME: ndk }]) {
    const r = run(env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  }
});

test('build:android runs the guard before tauri, so no prompt is reachable', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['build:android'], /^node scripts\/preflight\.mjs android-env && npx tauri android build /u);
});

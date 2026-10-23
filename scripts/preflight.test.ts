// Board #460: `build:android` refuses to start unless the SDK tauri will use
// holds an NDK, instead of reaching tauri's interactive NDK prompt. What the
// guard checks is what tauri-cli 2.10/2.11 decides on: the SDK from
// ANDROID_HOME (else ANDROID_SDK_ROOT) and its ndk/<version>/source.properties.
// It does not prove the NDK is complete (a broken one fails loudly in tauri,
// with no prompt).
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A path with a space and a `$`, so nothing depends on shell-safe names.
const base = mkdtempSync(join(tmpdir(), 'preflight sdk $x-'));
after(() => rmSync(base, { recursive: true, force: true }));
/** A HOME with the usual SDK places holding an NDK: a guard that guessed
 * from them would be caught on any host. */
const home = join(base, 'home');
mkdirSync(join(home, 'Android', 'sdk', 'ndk', '28.2.13676358'), { recursive: true });
writeFileSync(join(home, 'Android', 'sdk', 'ndk', '28.2.13676358', 'source.properties'), 'Pkg.Revision = 28.2.13676358\n');

const script = fileURLToPath(new URL('./preflight.mjs', import.meta.url));
const run = (env: Record<string, string>) => spawnSync(process.execPath, [script, 'android-env'], {
  // Only what is given: no ANDROID_HOME/NDK_HOME leaks in from the shell.
  env: { PATH: process.env.PATH ?? '', HOME: home, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
/** An SDK holding one NDK (its source.properties), as tauri reads it. */
const sdk = join(base, 'sdk');
const ndk = join(sdk, 'ndk', '28.2.13676358');
mkdirSync(ndk, { recursive: true });
writeFileSync(join(ndk, 'source.properties'), 'Pkg.Revision = 28.2.13676358\n');
/** This host's trap: an SDK directory with no ndk/ (~/Android/Sdk). */
const empty = join(base, 'Sdk');
mkdirSync(empty);
/** An ndk/<version> with nothing in it is not an NDK. */
const hollow = join(base, 'hollow');
mkdirSync(join(hollow, 'ndk', '27.0.0'), { recursive: true });
const aFile = join(base, 'not-a-dir');
writeFileSync(aFile, '');

test('android-env: an SDK holding an NDK, no NDK_HOME → passes silently (tauri needs nothing more)', () => {
  const r = run({ ANDROID_HOME: sdk });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('android-env: ANDROID_SDK_ROOT counts when ANDROID_HOME is unset, as tauri reads it', () => {
  const r = run({ ANDROID_SDK_ROOT: sdk });
  assert.equal(r.status, 0, r.stderr);
});

test('android-env: ANDROID_HOME wins over ANDROID_SDK_ROOT, as in tauri — an empty ANDROID_HOME is refused even with a good ANDROID_SDK_ROOT', () => {
  const r = run({ ANDROID_HOME: empty, ANDROID_SDK_ROOT: sdk });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`ANDROID_HOME=${empty} holds no NDK`), r.stderr);
});

test('android-env: an SDK with no ndk/ (this host s ~/Android/Sdk) is refused naming the missing ndk/, a correct NDK_HOME notwithstanding (validator V1)', () => {
  const r = run({ ANDROID_HOME: empty, NDK_HOME: ndk });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`no ${join(empty, 'ndk')}/<version>/source.properties`), r.stderr);
});

test('android-env: an ndk/<version> with no source.properties is not an NDK', () => {
  const r = run({ ANDROID_HOME: hollow });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holds no NDK/u);
});

test('android-env: no SDK named → refused, and NDK_HOME alone does not stand in for it; nothing is guessed', () => {
  for (const env of [{}, { NDK_HOME: ndk }]) {
    const r = run(env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ANDROID_HOME is not set/u);
    assert.doesNotMatch(r.stderr, /NDKs under/u, 'with no SDK named, no NDK is offered');
  }
});

test('android-env: an SDK path that does not exist, or is a file, is refused', () => {
  for (const path of [join(base, 'nope'), aFile]) {
    const r = run({ ANDROID_HOME: path });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes(`ANDROID_HOME=${path} is not a directory`), r.stderr);
  }
});

test('android-env: NDK_HOME is optional, and when set must be one of the SDK s NDKs — otherwise refused, listing them as paths', () => {
  assert.equal(run({ ANDROID_HOME: sdk, NDK_HOME: ndk }).status, 0, 'the SDK s own NDK');
  assert.equal(run({ ANDROID_HOME: sdk, NDK_HOME: `${ndk}/` }).status, 0, 'a trailing slash is the same NDK');
  const r = run({ ANDROID_HOME: sdk, NDK_HOME: join(hollow, 'ndk', '27.0.0') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not one of the NDKs under/u);
  assert.ok(r.stderr.includes(`     ${ndk}`), 'the usable NDKs, each on its own line as a path');
});

test('build:android runs the guard before tauri, so a missing NDK stops it before tauri can ask', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['build:android'], /^node scripts\/preflight\.mjs android-env && npx tauri android build /u);
});

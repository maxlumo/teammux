// Board #460: `build:android` refuses to start unless the SDK tauri will use
// holds an NDK, instead of reaching tauri's interactive NDK prompt. What the
// guard checks is what tauri-cli 2.10/2.11 decides on: the SDK from
// ANDROID_HOME (else ANDROID_SDK_ROOT), and in its ndk/ the directory whose
// name sorts last, which must hold source.properties.
// It does not prove the NDK is complete (a broken one fails loudly in tauri,
// with no prompt).
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockedWry } from './wry-chrome-client.mjs';

// A path with a space and a `$`, so nothing depends on shell-safe names.
const base = mkdtempSync(join(tmpdir(), 'preflight sdk $x-'));
after(() => rmSync(base, { recursive: true, force: true }));
/** A HOME with the usual SDK places holding an NDK: a guard that guessed
 * from them would be caught on any host. */
const home = join(base, 'home');
mkdirSync(join(home, 'Android', 'sdk', 'ndk', '28.2.13676358'), { recursive: true });
writeFileSync(join(home, 'Android', 'sdk', 'ndk', '28.2.13676358', 'source.properties'), 'Pkg.Revision = 28.2.13676358\n');

const script = fileURLToPath(new URL('./preflight.mjs', import.meta.url));
/** A cargo registry holding the LOCKED wry's chrome client, with wry
 * 0.54.2's real signatures (board #454, scripts/fixtures): android-env reads it and the wrapper must
 * cover it. The NDK tests below are about the NDK, so it is always there. */
const cargo = join(base, 'cargo');
{
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [wry] = lockedWry(readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8'));
  const kotlin = join(cargo, 'registry', 'src', 'index.test', `wry-${wry}`, 'src', 'android', 'kotlin');
  mkdirSync(kotlin, { recursive: true });
  writeFileSync(join(kotlin, 'RustWebChromeClient.kt'), readFileSync(new URL('./fixtures/RustWebChromeClient-0.54.2.kt', import.meta.url), 'utf8'));
}
const run = (env: Record<string, string>) => spawnSync(process.execPath, [script, 'android-env'], {
  // Only what is given: no ANDROID_HOME/NDK_HOME leaks in from the shell.
  env: { PATH: process.env.PATH ?? '', HOME: home, CARGO_HOME: cargo, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
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
  assert.ok(r.stderr.includes(`holds no NDK: no ${join(empty, 'ndk')}/<version>/`), r.stderr);
});

test('android-env: an ndk/<version> with no source.properties is not an NDK', () => {
  const r = run({ ANDROID_HOME: hollow });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /27\.0\.0 — the NDK tauri would use .* has no source\.properties/u);
});

/** An SDK whose ndk/ holds the given versions, each a complete-looking NDK
 * unless listed in `bare`. */
function sdkWith(name: string, versions: string[], bare: string[] = []) {
  const root = join(base, name);
  for (const v of versions) {
    mkdirSync(join(root, 'ndk', v), { recursive: true });
    if (!bare.includes(v)) writeFileSync(join(root, 'ndk', v, 'source.properties'), `Pkg.Revision = ${v}\n`);
  }
  return root;
}

test('android-env: with several NDKs the one that counts is tauri s pick, the name that sorts LAST as a string — NDK_HOME must name it (validator P2 on 173d7faf; measured, 2.11.1)', () => {
  const two = sdkWith('two', ['27.9.0', '28.2.13676358']);
  assert.equal(run({ ANDROID_HOME: two }).status, 0);
  assert.equal(run({ ANDROID_HOME: two, NDK_HOME: join(two, 'ndk', '28.2.13676358') }).status, 0);
  const older = run({ ANDROID_HOME: two, NDK_HOME: join(two, 'ndk', '27.9.0') });
  assert.equal(older.status, 1, 'an NDK of the SDK that tauri does not use');
  assert.ok(older.stderr.includes(`is not ${join(two, 'ndk', '28.2.13676358')}, the NDK tauri builds with`), older.stderr);
  // Not the highest version: tauri sorts names, so 9.0.0 beats 10.0.0.
  const nine = sdkWith('nine-ten', ['9.0.0', '10.0.0']);
  assert.equal(run({ ANDROID_HOME: nine, NDK_HOME: join(nine, 'ndk', '9.0.0') }).status, 0);
  const ten = run({ ANDROID_HOME: nine, NDK_HOME: join(nine, 'ndk', '10.0.0') });
  assert.equal(ten.status, 1);
  assert.ok(ten.stderr.includes(`tauri uses ${join(nine, 'ndk', '9.0.0')}`), ten.stderr);
});

test('android-env: tauri s pick with no source.properties is refused, even when an older NDK has one (tauri would fail on it)', () => {
  const r = run({ ANDROID_HOME: sdkWith('bare-newest', ['27.9.0', '28.2.13676358'], ['28.2.13676358']) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /28\.2\.13676358 — the NDK tauri would use .* has no source\.properties/u);
});

test('android-env: NDK_HOME through a symlink to tauri s NDK is the same NDK (reviewer P2 on 173d7faf)', () => {
  const alias = join(base, 'ndk-alias');
  symlinkSync(ndk, alias);
  assert.equal(run({ ANDROID_HOME: sdk, NDK_HOME: alias }).status, 0);
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

test('android-env: NDK_HOME is optional, and when set must be the SDK s NDK — another one is refused, naming the right one as a path', () => {
  assert.equal(run({ ANDROID_HOME: sdk, NDK_HOME: ndk }).status, 0, 'the SDK s own NDK');
  assert.equal(run({ ANDROID_HOME: sdk, NDK_HOME: `${ndk}/` }).status, 0, 'a trailing slash is the same NDK');
  for (const other of [join(hollow, 'ndk', '27.0.0'), sdk, join(base, 'nope')]) {
    const r = run({ ANDROID_HOME: sdk, NDK_HOME: other });
    assert.equal(r.status, 1, other);
    assert.ok(r.stderr.includes(`is not ${ndk}, the NDK tauri builds with`), r.stderr);
  }
});

test('build:android runs the guard before tauri, so a missing NDK stops it before tauri can ask', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['build:android'], /^node scripts\/preflight\.mjs android-env && pnpm exec tauri android build /u);
});

// Board #454: android-env also refuses when the fullscreen wrapper does not
// cover the locked wry's chrome client, and when that source is not found.
test('android-env: the locked wry overriding a method the fullscreen wrapper does not forward → refused, naming it', () => {
  const extra = join(base, 'cargo-extra');
  const lockText = readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'src-tauri', 'Cargo.lock'), 'utf8');
  const kotlin = join(extra, 'registry', 'src', 'index.test', `wry-${lockedWry(lockText)[0]}`, 'src', 'android', 'kotlin');
  mkdirSync(kotlin, { recursive: true });
  const fixture = readFileSync(join(cargo, 'registry', 'src', 'index.test', `wry-${lockedWry(lockText)[0]}`, 'src', 'android', 'kotlin', 'RustWebChromeClient.kt'), 'utf8');
  writeFileSync(join(kotlin, 'RustWebChromeClient.kt'), fixture.replace(/\}\n$/u, '  override fun onCloseWindow(window: WebView) {}\n}\n'));
  const r = run({ ANDROID_HOME: sdk, CARGO_HOME: extra });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /overrides onCloseWindow\(WebView\)/u);
});

test('android-env: the locked wry\'s source missing from the registry → refused, not skipped', () => {
  const r = run({ ANDROID_HOME: sdk, CARGO_HOME: join(base, 'no-cargo') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not in .*does not skip/u);
});

// Board #17: `android-apk`, the postflight after `tauri android build`. It runs
// on a copy of the checkout's scripts in a temp checkout, so `root` is that
// checkout, and on an empty HOME, so no real gradle cache is read.
const releaseRel = join('outputs', 'apk', 'universal', 'release');
/** A checkout whose gen/android holds `files` (relative paths), with
 * preflight.mjs and its imports copied in. */
function checkout(name: string, files: string[] = []) {
  const at = join(base, name);
  mkdirSync(join(at, 'scripts'), { recursive: true });
  for (const f of ['preflight.mjs', 'dev-ports.mjs', 'env-names.mjs', 'wry-chrome-client.mjs', 'target-lock.mjs']) {
    writeFileSync(join(at, 'scripts', f), readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
  }
  const android = join(at, 'src-tauri', 'gen', 'android');
  for (const f of files) {
    mkdirSync(join(android, f, '..'), { recursive: true });
    writeFileSync(join(android, f), '');
  }
  return { at, android };
}
const postflight = (at: string, homeDir: string) => spawnSync(process.execPath, [join(at, 'scripts', 'preflight.mjs'), 'android-apk'], {
  env: { PATH: process.env.PATH ?? '', HOME: homeDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const emptyHome = join(base, 'empty-home');
mkdirSync(emptyHome);

test('android-apk: only an -unsigned APK (no signing files) → refused, naming the unsigned APK, the missing key.properties and keystore.jks, and the doc section — not the gradle redirect', () => {
  const { at, android } = checkout('unsigned', [join('app', 'build', releaseRel, 'app-universal-release-unsigned.apk')]);
  const r = postflight(at, emptyHome);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(join(android, 'app', 'build', releaseRel, 'app-universal-release-unsigned.apk')), r.stderr);
  assert.ok(r.stderr.includes(`missing: ${join(android, 'key.properties')}, ${join(android, 'keystore.jks')}`), r.stderr);
  assert.ok(r.stderr.includes('docs/conventions/development.md § Android signing'), r.stderr);
  assert.doesNotMatch(r.stderr, /redirect/u);
});

test('android-apk: only the files actually absent are named; with both present it claims nothing about their contents and says to rebuild (reviewer P2-R1)', () => {
  const apk = join('app', 'build', releaseRel, 'app-universal-release-unsigned.apk');
  const one = checkout('unsigned-no-jks', [apk, 'key.properties']);
  const r = postflight(one.at, emptyHome);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(`missing: ${join(one.android, 'keystore.jks')}\n`), r.stderr);
  // A valid configuration placed after an unsigned build: the APK is the old one.
  const both = checkout('unsigned-both', [apk, 'keystore.jks']);
  writeFileSync(join(both.android, 'key.properties'), 'storeFile=keystore.jks\nstorePassword=x\nkeyAlias=x\nkeyPassword=x\n');
  const s = postflight(both.at, emptyHome);
  assert.equal(s.status, 1);
  assert.doesNotMatch(s.stderr, /missing|has no storeFile/u);
  assert.ok(s.stderr.includes(`${join(both.android, 'key.properties')} and ${join(both.android, 'keystore.jks')} both exist: the APK predates them or gradle did not use them. Rebuild; if it is still unsigned, check storeFile in key.properties.`), s.stderr);
});

test('android-apk: a signed APK in a real app/build directory → exit 0, naming it, even beside an older -unsigned one', () => {
  const { at, android } = checkout('signed', [
    join('app', 'build', releaseRel, 'app-universal-release.apk'),
    join('app', 'build', releaseRel, 'app-universal-release-unsigned.apk'),
  ]);
  const r = postflight(at, emptyHome);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(`📦 APK: ${join(android, 'app', 'build', releaseRel, 'app-universal-release.apk')}`), r.stderr);
});

test('android-apk: no APK at all → refused with the gradle build dir redirect message', () => {
  const { at } = checkout('no-apk', [join('app', 'build', releaseRel, 'output-metadata.json')]);
  const r = postflight(at, emptyHome);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no APK at .*app-universal-release\.apk — check the gradle build dir redirect/u);
  assert.doesNotMatch(r.stderr, /unsigned/u);
});

test('android-apk: a dangling app/build symlink is re-pointed at the cache dir holding the APK, then passes', () => {
  const { at, android } = checkout('dangling');
  mkdirSync(join(android, 'app'), { recursive: true });
  symlinkSync(join(base, 'pruned-cache-dir'), join(android, 'app', 'build'));
  const cacheHome = join(base, 'cache-home');
  const built = join(cacheHome, '.cache', 'builds', 'gradle-builds', 'android-0123456789ab', 'app');
  mkdirSync(join(built, releaseRel), { recursive: true });
  writeFileSync(join(built, releaseRel, 'app-universal-release.apk'), '');
  const r = postflight(at, cacheHome);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /re-pointed \(dangling\)/u);
  assert.ok(r.stderr.includes(`now:  ${built}`), r.stderr);
});

// Board #32: `check:android` compiles the Rust lib for the phone's target with
// the NDK tauri would build with, so desktop-only code leaking into a shared
// file is caught before merge (incident 17:05: main 4f6e2925 had 10 Android
// errors nobody had compiled). It needs only the NDK, no emulator. A fake
// `cargo` on PATH records what it was asked and with which C toolchain.
const fakeBin = join(base, 'fake bin');
mkdirSync(fakeBin);
// Round 2 (#35): asked `metadata`, it names CARGO_TARGET_DIR, as cargo would.
writeFileSync(join(fakeBin, 'cargo'), '#!/bin/sh\nif [ "$1" = metadata ]; then printf \'{"target_directory":"%s"}\' "$CARGO_TARGET_DIR"; exit 0; fi\n{ printf \'%s\\n\' "$@"; echo "CC=$CC_aarch64_linux_android"; echo "AR=$AR_aarch64_linux_android"; } > "$CARGO_RECORD"\nexit "${CARGO_EXIT:-0}"\n', { mode: 0o755 });
const checkAndroid = (env: Record<string, string>) => {
  const record = join(base, `record-${Math.random().toString(36).slice(2)}`);
  const r = spawnSync(process.execPath, [script, 'android-check'], {
    // A private target dir (board #35): the run takes its lock there, never in this checkout's own.
    env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, HOME: home, CARGO_HOME: cargo, CARGO_RECORD: record, CARGO_TARGET_DIR: join(base, 'target'), ...env },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let lines: string[] | null = null;
  try { lines = readFileSync(record, 'utf8').trim().split('\n'); } catch { /* cargo never ran */ }
  return { ...r, lines };
};
const prebuilt = process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';

test('check:android runs the android-check preflight', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['check:android'], 'node scripts/preflight.mjs android-check');
});

test('android-check: cargo checks the lib for aarch64-linux-android with the C toolchain of the NDK tauri picks', () => {
  const r = checkAndroid({ ANDROID_HOME: sdk });
  assert.equal(r.status, 0, r.stderr);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const bin = join(ndk, 'toolchains', 'llvm', 'prebuilt', prebuilt, 'bin');
  assert.deepEqual(r.lines, [
    'check', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'), '--lib', '--target', 'aarch64-linux-android',
    '--target-dir', realpathSync(join(base, 'target')),
    `CC=${join(bin, 'aarch64-linux-android24-clang')}`, `AR=${join(bin, 'llvm-ar')}`,
  ], 'minSdk 24, as gen/android/app/build.gradle.kts');
});

test('android-check: cargo runs under the target directory\'s lock, and a held lock refuses before cargo runs (#35)', async () => {
  const { lockFile, lockedCommand } = await import('./target-lock.mjs');
  const target = join(base, `target-${Math.random().toString(36).slice(2)}`);
  mkdirSync(target);
  const [hcmd, hargs] = lockedCommand(target, 'test:rust', 'sleep', ['30']);
  const { spawn } = await import('node:child_process');
  const holder = spawn(hcmd, hargs, { stdio: 'ignore' });
  try {
    for (let i = 0; i < 250 && !(existsSync(lockFile(target)) && readFileSync(lockFile(target), 'utf8').includes('test:rust')); i++) await new Promise((r) => setTimeout(r, 20));
    const refused = checkAndroid({ ANDROID_HOME: sdk, CARGO_TARGET_DIR: target });
    assert.equal(refused.status, 75, refused.stderr);
    assert.equal(refused.lines, null, 'cargo never ran');
    assert.match(refused.stderr, /check:android.*refused[\s\S]*test:rust/u);
  } finally { holder.kill('SIGKILL'); }
});

test('android-check: a failing cargo check fails the command with its exit code', () => {
  const r = checkAndroid({ ANDROID_HOME: sdk, CARGO_EXIT: '101' });
  assert.equal(r.status, 101);
});

test('android-check: the same NDK guard as build:android refuses before cargo runs', () => {
  for (const env of [{}, { ANDROID_HOME: empty }, { ANDROID_HOME: hollow }]) {
    const r = checkAndroid(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.lines, null, `cargo never ran: ${JSON.stringify(env)}`);
  }
});

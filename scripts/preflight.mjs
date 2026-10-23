#!/usr/bin/env node
// Preflight for dev/build commands. Three jobs:
//
// 1. Development preflights fail FAST when the requested ports are already
//    taken, and say exactly who owns them. `web` checks 5173, `server` checks
//    9899, and `dev` checks the complete stack. Without this, a second Vite
//    process can nuke node_modules/.vite before it loses the port race (the
//    "blank white page"), while a duplicate backend wastes a build first.
//
// 2. `preflight android-apk`: after `tauri android build`, re-point the
//    machine-local gradle build symlink (`app/build`) at THIS checkout's
//    output, when it is a symlink. Where a build dir is relocated into
//    ~/.cache/builds/gradle-builds/<dirname>-<md5(abs path)[:12]>/ the slug is
//    a pure function of the gradle root path, so we can compute the right
//    answer instead of guessing. On this host (measured 2026-10-15) nothing
//    relocates it any more — no global gradle init script exists, an earlier
//    version of this comment named `~/.gradle/init.d/00-build-dir.gradle.kts`
//    — the only relocation is the launch checkout's hand-made `app/build`
//    symlink (dated 2026-08-18), and a fresh git worktree builds in-tree: a
//    real `app/build` directory, left alone here. The postflight then only
//    insists that the APK exists at the in-project path.
//
//    Two ways the symlink goes wrong, and the second one is the nasty one:
//    - DANGLING (cache pruned, or the path canonicalizes differently under the
//      zfs-boost overlay): the documented APK path 404s even though the build
//      SUCCEEDED. Loud, easy to spot.
//    - STALE BUT VALID: it points at another checkout's build dir — the same
//      repo cloned at a second path hashes to a different slug. Then a green
//      build silently serves that other tree's older APK, with a plausible
//      timestamp and everything. Hit for real on 2026-08-05: this checkout's
//      link had pointed at /Users/clawd/work/project/260226_tmux_mobile's
//      output since Jul 22, so a fresh build "produced" a day-old APK.
//    Healing only the dangling case is therefore not enough, and picking the
//    newest APK across all android-* dirs is exactly how you land on the wrong
//    checkout. Compute, compare, re-point.
//
// 3. `preflight android-env`: before `tauri android build`, refuse to start
//    unless the SDK tauri will use holds an NDK — without one tauri stops at
//    an interactive NDK prompt (board #460; see that mode below).
//
// Zero dependencies; runs everywhere node does.
import { execSync } from 'node:child_process';
import { existsSync, readlinkSync, unlinkSync, symlinkSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEV_WEB_PORT, devServerPort } from './dev-ports.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'dev';

function whoOwnsPort(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.trim().split('\n')[1];
    if (!line) return null;
    const [cmd, pid] = line.split(/\s+/);
    return { cmd, pid };
  } catch {
    return null; // lsof exits non-zero when nothing listens — that's the good case
  }
}

const serverPort = devServerPort();
const devPorts = {
  web: [[DEV_WEB_PORT, 'vite dev server']],
  server: [[serverPort, 'tmux-mobile WS server']],
  dev: [[DEV_WEB_PORT, 'vite dev server'], [serverPort, 'tmux-mobile WS server']],
};

if (mode in devPorts) {
  const conflicts = [];
  for (const [port, what] of devPorts[mode]) {
    const owner = whoOwnsPort(port);
    if (owner) conflicts.push({ port, what, ...owner });
  }
  if (conflicts.length) {
    const scope = mode === 'dev' ? 'dev stack' : `${mode} dev service`;
    console.error(`\n✋ ${scope} already running — refusing to start a duplicate.\n`);
    for (const c of conflicts) {
      console.error(`   port ${c.port} (${c.what}) is held by ${c.cmd} (pid ${c.pid})`);
    }
    console.error('\n   Reuse the running instance, or stop it first:');
    console.error(`   kill ${conflicts.map(c => c.pid).join(' ')}\n`);
    console.error('   (Starting a second Vite instance corrupts the dependency cache;');
    console.error('   a second backend would only fail after doing build work.)\n');
    process.exit(1);
  }
  process.exit(0);
}

/** Where a relocated `:app` build dir lands for this checkout (the cache dir
 *  the launch checkout's `app/build` symlink points into). The slug is
 *  "<dirname>-<md5(abs path of the GRADLE ROOT)[:12]>", and the `:app`
 *  subproject lands in `app/`. The root here is src-tauri/gen/android, NOT the
 *  repo root. No init script produces it on this host any more (2026-10-15). */
function expectedAppBuildDir(androidRoot) {
  const hash = createHash('md5').update(androidRoot).digest('hex').slice(0, 12);
  const slug = `${basename(androidRoot)}-${hash}`;
  return join(process.env.HOME || '', '.cache/builds/gradle-builds', slug, 'app');
}

/** Fallback for when the computed slug has no APK — the overlay case where
 *  gradle saw a different absolute path than we do. Newest APK wins, which is a
 *  guess: it can pick another checkout, so it is only ever a last resort. */
function newestAppBuildDir(apkRel) {
  const cache = join(process.env.HOME || '', '.cache/builds/gradle-builds');
  try {
    return readdirSync(cache)
      .filter(d => d.startsWith('android-'))
      .map(d => join(cache, d, 'app'))
      .filter(d => existsSync(join(d, apkRel)))
      .sort((a, b) => statSync(join(b, apkRel)).mtimeMs - statSync(join(a, apkRel)).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

if (mode === 'android-apk') {
  const androidRoot = join(root, 'src-tauri/gen/android');
  const link = join(androidRoot, 'app/build');
  const apkRel = 'outputs/apk/universal/release/app-universal-release.apk';
  try {
    const info = (() => { try { return lstatSync(link); } catch { return null; } })();
    // A real directory means this machine opted out of the redirect
    // (.gradle-local-build) — gradle really did build in-tree. Not ours to touch.
    if (!info || info.isSymbolicLink()) {
      const want = expectedAppBuildDir(androidRoot);
      const have = info ? readlinkSync(link).replace(/\/+$/, '') : null;
      const target = existsSync(join(want, apkRel)) ? want : newestAppBuildDir(apkRel);
      if (target && target !== have) {
        const why = have === null ? 'missing'
          : existsSync(have) ? 'STALE — it pointed at another checkout, so this build would have served ITS older APK'
          : 'dangling';
        if (info) unlinkSync(link);
        symlinkSync(target + '/', link);
        console.error(`🔗 gradle build symlink re-pointed (${why})`);
        if (have) console.error(`   was:  ${have}`);
        console.error(`   now:  ${target}`);
      }
    }
    const apk = join(link, apkRel);
    if (existsSync(apk)) {
      console.error(`📦 APK: ${apk}`);
      process.exit(0);
    }
    console.error(`⚠️  build reported success but no APK at ${apk} — check the gradle build dir redirect (scripts/preflight.mjs).`);
    process.exit(1);
  } catch (e) {
    console.error(`⚠️  android-apk postflight failed: ${e.message}`);
    process.exit(1);
  }
}

if (mode === 'android-env') {
  // Board #460, measured with tauri-cli 2.10.0 (validator) and 2.11.1 (the
  // version build:android runs here): tauri takes the SDK from ANDROID_HOME,
  // else ANDROID_SDK_ROOT, else an auto-detected one, and the NDK from that
  // SDK's ndk/<version>/ — NDK_HOME does not decide it. With no ndk/<version>
  // there it ASKS whether to install the command line tools, a prompt nobody
  // answers under a tmm task (it hung for an hour on 2026-10-23: with
  // ANDROID_HOME unset the auto-detect picked this host's empty ~/Android/Sdk).
  // An ndk/<version> that is present but broken fails loudly, not with the
  // prompt. So the build refuses to start unless the SDK is NAMED and holds
  // at least one NDK whose source.properties (the first file tauri reads)
  // exists. NDK_HOME is optional; if set it must be one of those NDKs, since
  // anything else would name a toolchain the build does not use. Nothing here
  // sets or guesses a variable.
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  const sdkVar = process.env.ANDROID_HOME ? 'ANDROID_HOME' : process.env.ANDROID_SDK_ROOT ? 'ANDROID_SDK_ROOT' : null;
  const sdk = sdkVar ? process.env[sdkVar] : '';
  const ndkHome = process.env.NDK_HOME || '';
  const ndkDir = sdk ? join(sdk, 'ndk') : '';
  const ndks = sdk && isDir(ndkDir)
    ? (() => { try { return readdirSync(ndkDir).filter((d) => isFile(join(ndkDir, d, 'source.properties'))).sort(); } catch { return []; } })()
    : [];
  const problems = [];
  if (!sdkVar) problems.push('ANDROID_HOME is not set — tauri would auto-detect an SDK, and stop at its NDK prompt if that one has no ndk/');
  else if (!isDir(sdk)) problems.push(`${sdkVar}=${sdk} is not a directory`);
  else if (ndks.length === 0) problems.push(`${sdkVar}=${sdk} holds no NDK: no ${ndkDir}/<version>/source.properties`);
  if (ndkHome && sdkVar && ndks.length > 0 && !(resolve(dirname(ndkHome)) === resolve(ndkDir) && ndks.includes(basename(ndkHome)))) {
    problems.push(`NDK_HOME=${ndkHome} is not one of the NDKs under ${ndkDir} — tauri builds with ${sdkVar}'s; unset NDK_HOME or name one of those`);
  }
  if (problems.length === 0) process.exit(0);
  console.error('\n✋ build:android needs an Android SDK that holds an NDK — refusing to start (tauri would stop at an interactive NDK prompt).\n');
  for (const p of problems) console.error(`   ${p}`);
  if (ndks.length) console.error(`\n   NDKs under ${ndkDir}:\n${ndks.map((d) => `     ${join(ndkDir, d)}`).join('\n')}`);
  console.error('\n   See docs/conventions/development.md § Build targets (Android).\n');
  process.exit(1);
}

console.error(`unknown preflight mode: ${mode}`);
process.exit(1);

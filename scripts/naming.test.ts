// The project is Teammux (board #472). The old name survives only where it is an
// identifier that something else reads, a project's own name, or dated history, and
// docs/reference/naming.md says which and why. This test is that list made
// executable: a new "tmux-mobile" in prose, a UI string, a banner or a doc fails here
// and must either say Teammux or be added below WITH a reason.
//
// The list SHRINKS: phase B (config dir, env vars, service names, crate) removes its
// rows as each identifier moves, and the owner's decisions (application id, folder,
// project name) remove the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const OLD = /[\w./:@~$"'\-{}%]*(?:tmux[- ]?mobile|tmux_mobile|TMUX_MOBILE|TmuxMobile|vokako|cc\.voka)[\w./:@~\-]*/giu;

/** Files where any occurrence is expected: a record, generated, or the list itself. */
const FILES: Array<[RegExp, string]> = [
  [/^docs\/exec-plans\//u, 'dated plans: what each board saw under the name it had'],
  [/^src-tauri\/gen\/apple\//u, 'generated iOS project; iOS is not a target (naming.md)'],
  [/^src-tauri\/Cargo\.lock$/u, 'the crate name, until phase B'],
  [/^LICENSE$/u, 'the copyright holder, an owner decision'],
  [/^docs\/reference\/naming\.md$/u, 'the list itself'],
  [/^scripts\/naming\.test\.ts$/u, 'this file'],
];

/** The shape of the word around an occurrence. */
const WORDS: Array<[RegExp, string]> = [
  [/tmux-mobile-e2e/u, 'HKDF info strings of the encrypted handshake: a protocol constant'],
  [/tmux-mobile-agent-notify|tmux-mobile\.json/u, 'hook markers written into agents\' configs'],
  [/config\}?\/tmux-mobile|XDG_CONFIG_HOME\/tmux-mobile|^\$S\/tmux-mobile|^\/tmux-mobile\/?$|^tmux-mobile\/$|tmux-mobile\/(?:teams|system_prompt)/u, 'the config directory, until phase B'],
  [/tmux-mobile-(?:gateway|dev)/u, 'systemd units, until phase B'],
  [/cc\.voka\.tmux-mobile/u, 'the launchd label, an owner decision'],
  [/tmux_mobile::|libtmux_mobile|_tmux_mobile_test|tmux_mobile_cfg_test|Theme\.tmux_mobile/u, 'the Rust crate path, library and test scratch names, until phase B'],
  [/com[./]tmuxmobile|TmuxMobileTest|Download\/TmuxMobile/u, 'the Android and macOS identifiers and the downloads folder, owner decisions'],
  [/tmux-mobile_(?:iOS|macOS)|container:tmux-mobile|\/tmux-mobile\.apk$/u, 'generated project names and an artefact file name'],
  [/^proj:tmux-mobile|tmux-mobile:\d|projects\/tmux-mobile|260226_tmux_mobile|workplace\/tmux-mobile|\/work\/tmux-mobile$/u, 'a project key, a tmux target and checkout paths on real hosts'],
];

/** A bare `tmux-mobile` that is a project's NAME, a binary name, or a reference to history. */
const LINES: Array<[RegExp, RegExp, string]> = [
  [/^(?:AGENTS|CLAUDE)\.md$/u, /naming\.md/u, 'the link to this list'],
  [/^docs\/conventions\/development\.md$/u, /`tmux-mobile` bin|cargo clean -p tmux-mobile|libtmux_mobile/u, 'the Cargo bin and package, until phase B'],
  [/^docs\/design-docs\/features\/android-platform\.md$/u, /fullscreenEnabled|desktop `tmux-mobile`/u, 'the Android log tag and the Cargo bin'],
  [/^docs\/design-docs\/features\/hub-composer\.md$/u, /LingTing|tmux-mobile at/u, 'a measurement on the project named tmux-mobile'],
  [/^docs\/design-docs\/features\/hub-feed\.md$/u, /archivist/u, 'the project named tmux-mobile, in a dated owner quote'],
  [/^docs\/design-docs\/features\/pwa-install\.md$/u, /they said tmux-mobile/u, 'what the manifest said before the rename'],
  [/^docs\/design-docs\/features\/tmm-cli\.md$/u, /Contents\/MacOS/u, 'the bundle\'s binary names'],
  [/^docs\/reference\/config\.md$/u, /behavior\(s\)|reverse_proxy/u, 'steps against the owner\'s live CloudFront and Caddy, worded as they show'],
  [/^docs\/reference\/install\.md$/u, /TmuxMobile\.app/u, 'the move from the old app bundle'],
  [/^scripts\/(?:dev-ports|dev-stack|gateway-update)\.mjs$/u, /_LEGACY = 'TMUX_MOBILE_|`TMUX_MOBILE_/u, 'the legacy names of the renamed variables, still read (B2)'],
  [/^scripts\/env-names\.mjs$/u, /tmux-mobile|TMUX_MOBILE_/u, 'the module that reads the legacy names'],
  [/^scripts\/env-names\.test\.ts$/u, /TMUX_MOBILE_/u, 'the test of the legacy names'],
  [/^docs\/(?:conventions\/development|reference\/install)\.md$/u, /TMUX_MOBILE_/u, 'one sentence saying the old names are still read'],
  [/^src-tauri\/src\/main\.rs$/u, /TMUX_MOBILE_TEST_12345/u, 'a test sentinel string'],
  [/^src-tauri\/src\/lib\.rs$/u, /<Downloads>\/TmuxMobile\//u, 'the Android downloads folder, an owner decision'],
  [/^src\/lib\/files\/Files\.mount\.test\.ts$/u, /TmuxMobile\\\//u, 'the Android downloads folder in a test'],
  [/^\.gitignore$/u, /\/tmuxmobile\.svg/u, 'an ignore entry for a stray file'],
  [/^src\/lib\/app\/servers\.test\.ts$/u, /tmuxmobile-/u, 'sample CloudFront paths'],
  [/^scripts\/restore-acceptance\.sh$/u, /bad\/tmux-mobile/u, 'a rig path under the config dir name'],
  [/^scripts\/test-rust\.test\.ts$/u, /TMM_PROJECT/u, 'a sample project name'],
  [/^scripts\/wry-chrome-client(?:\.test)?\.(?:mjs|ts)$/u, /tmuxmobile\/dev/u, 'the Kotlin package path'],
  [/^src-tauri\/Cargo\.toml$/u, /name = "tmux-mobile"|name = "tmux_mobile"|default-run|cargo clean/u, 'the crate, lib and bin, until phase B'],
  [/^src-tauri\/gen\/android\/app\/\.gitignore$/u, /tmuxmobile/u, 'the Kotlin package path'],
  [/FullscreenChromeClient\.kt$/u, /Log\.w\("tmux-mobile"/u, 'the logcat tag people filter on'],
  [/^src-tauri\/src\/backends\/kiro\.rs$/u, /GIT_EXCLUDE_MARK/u, 'the dedup key of an existing .git/info/exclude'],
  [/^src-tauri\/src\/config\.rs$/u, /config directory|join\("tmux-mobile"\)/u, 'the config directory, until phase B'],
  [/^src-tauri\/src\/gateway\/service\.rs$/u, /join\("tmux-mobile"\)/u, 'the config directory, until phase B'],
  [/^src-tauri\/src\/projects\/spawn\.rs$/u, /contains\("tmux-mobile"\)/u, 'the hook marker'],
  [/^src-tauri\/tests\/(?:local_socket_cli|setup_cli|project_archive_cli)\.rs$/u, /tmux-mobile/u, 'the config directory and a project name in a CLI rig'],
  [/^src\/App\.shell\.mount\.test\.ts$/u, /tmux-mobile/u, 'a project named tmux-mobile in a saved-state fixture'],
  [/^src\/lib\/hub\/AgentsPage\.mount\.test\.ts$/u, /dsh-1 .{0,3}tmux-mobile/u, 'a project name in an alert'],
  [/^src\/lib\/hub\/sidebar\.ts$/u, /archivist/u, 'the project named tmux-mobile, in a dated owner quote'],
  [/^vite\.config\.js$/u, /#393/u, 'a board reference in a comment; editing it would restart the supervised dev server'],
];

function tracked(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
}

export function strays(files: string[], read: (f: string) => string | null): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (FILES.some(([re]) => re.test(f))) continue;
    const text = read(f);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(OLD)) {
        const word = m[0].replace(/^["']+|["']+$/gu, '');
        if (WORDS.some(([re]) => re.test(word))) continue;
        if (LINES.some(([file, re]) => file.test(f) && re.test(line))) continue;
        out.push(`${f}:${i + 1}: ${word}`);
      }
    });
  }
  return out;
}

const read = (f: string): string | null => {
  try { return readFileSync(f, 'utf8'); } catch { return null; }
};

test('the old name appears only where naming.md says it must (board #472)', () => {
  const found = strays(tracked(), read);
  assert.deepEqual(found, [], `say Teammux, or list it in scripts/naming.test.ts with the reason:\n${found.join('\n')}`);
});

test('the check sees what it should: prose, a UI string and a banner fail; an identifier passes', () => {
  const fake = (name: string, text: string) => strays([name], () => text);
  assert.equal(fake('README.md', 'tmux-mobile connects those sessions').length, 1);
  assert.equal(fake('src/lib/core/i18n.svelte.ts', "installTitle: 'Install tmux-mobile',").length, 1);
  assert.equal(fake('src-tauri/src/server/mod.rs', 'println!("tmux-mobile server listening")').length, 1);
  assert.equal(fake('README.md', 'a token in `~/.config/tmux-mobile/config.toml`').length, 0, 'a path is an identifier');
  assert.equal(fake('README.md', 'set TMUX_MOBILE_DEV_HOST=0.0.0.0').length, 1, 'the old variable names are legacy now: only the scripts that still read them, and one sentence, may name them');
  assert.equal(fake('scripts/dev-ports.mjs', "export const DEV_HOST_ENV_LEGACY = 'TMUX_MOBILE_DEV_HOST';").length, 0);
  assert.equal(fake('docs/exec-plans/x.md', 'the tmux-mobile server').length, 0, 'history keeps its name');
  // the old DISPLAY name in every spelling a person could type
  assert.equal(fake('README.md', 'TmuxMobile connects those sessions').length, 1, 'the CamelCase product name');
  assert.equal(fake('src/lib/core/i18n.svelte.ts', "installTitle: 'Install TmuxMobile',").length, 1);
  assert.equal(fake('index.html', '<title>TmuxMobile</title>').length, 1);
  assert.equal(fake('README.md', 'a Tmux Mobile server').length, 1, 'the spaced spelling');
  assert.equal(fake('README.md', 'the tmux mobile app').length, 1, 'and in lower case');
  assert.equal(fake('README.md', 'by vokako').length, 1, 'the old owner name');
  assert.equal(fake('src-tauri/src/server/mod.rs', 'println!("tmux_mobile server")').length, 1);
  assert.equal(fake('src/lib/core/i18n.svelte.ts', 'Android Settings > Apps > TmuxMobile > Permissions').length, 1);
  assert.equal(fake('src-tauri/gen/android/app/src/main/res/xml/file_paths.xml', 'path="Download/TmuxMobile"').length, 0, 'the downloads folder is an identifier');
});

// The rows that must NOT move in a sweep (naming.md). A rename that "helpfully" reaches
// one of these passes every other test, because client and server would change together
// and agree with each other; only an old peer, an old hook entry or an old install would
// notice. So each is pinned verbatim, and phase B changes a row HERE on purpose.
test('the kept identifiers are kept verbatim (board #472)', () => {
  const has = (file: string, ...needles: string[]) => {
    const text = readFileSync(file, 'utf8');
    for (const n of needles) assert.ok(text.includes(n), `${file} must still contain ${n}`);
  };
  const labels = ['tmux-mobile-e2e', 'tmux-mobile-e2e/v2/proof', 'tmux-mobile-e2e/v2/c2s', 'tmux-mobile-e2e/v2/s2c'];
  has('src-tauri/src/server/wire.rs', ...labels.map((l) => `b"${l}"`));
  has('src/lib/core/connection.ts', ...labels.map((l) => `'${l}'`));
  has('src/lib/core/connection.fixture.ts', ...labels.map((l) => `'${l}'`));
  has('src-tauri/src/agent_notifications.rs', 'OWNER_MARKER: &str = "tmux-mobile-agent-notify"');
  has('src-tauri/src/backends/kiro.rs', 'GIT_EXCLUDE_MARK: &str = "# tmux-mobile managed kiro entries (board #207)"');
  has('src-tauri/src/backends/grok.rs', 'join("tmux-mobile.json")');
  has('src-tauri/tauri.conf.json', '"identifier": "com.tmuxmobile.dev"');
  has('src-tauri/gen/android/app/build.gradle.kts', 'namespace = "com.tmuxmobile.dev"', 'applicationId = "com.tmuxmobile.dev"');
  has('src-tauri/src/config.rs', 'base.join("tmux-mobile")');
  has('src-tauri/src/gateway/service.rs', 'LABEL: &str = "cc.voka.tmux-mobile"', 'UNIT: &str = "tmux-mobile-gateway.service"');
  has('src-tauri/Cargo.toml', 'name = "tmux-mobile"', 'name = "tmux_mobile"');
});

test('the web app metadata says Teammux (board #472, A1)', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as { name: string; short_name: string };
  assert.deepEqual([manifest.name, manifest.short_name], ['Teammux', 'Teammux']);
  assert.equal((JSON.parse(readFileSync('package.json', 'utf8')) as { name: string }).name, 'teammux');
});

test('the installed-app names say Teammux and the identifiers beside them did not move (board #472, A2)', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { productName: string; identifier: string; app: { windows: Array<{ title: string }> } };
  assert.equal(conf.productName, 'Teammux');
  assert.equal(conf.app.windows[0]!.title, 'Teammux');
  assert.equal(conf.identifier, 'com.tmuxmobile.dev', 'the bundle id is what makes a new build an upgrade (owner decision Q1)');
  const strings = readFileSync('src-tauri/gen/android/app/src/main/res/values/strings.xml', 'utf8');
  assert.match(strings, /<string name="app_name">Teammux<\/string>/u);
  assert.match(strings, /<string name="main_activity_title">Teammux<\/string>/u);
});

// Source pins for the build identity (board #368). Each fact below is a
// contract between files that no single unit test can see: build.rs bakes two
// env names, build_info.rs reads the same two, both login answers carry the
// result, and the one link to the repository lives on About alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');

test('build.rs bakes the commit and the build time, and build_info.rs reads the same two names', async () => {
  const build = await read('../../../src-tauri/build.rs');
  const info = await read('../../../src-tauri/src/build_info.rs');
  assert.match(build, /cargo:rustc-env=TMM_GIT_SHA=/u, 'the commit is baked');
  assert.match(build, /cargo:rustc-env=TMM_BUILD_TIME=/u, 'and the minute');
  assert.match(info, /option_env!\("TMM_GIT_SHA"\)/u, 'read under the same name, never env!: a source archive still builds');
  assert.match(info, /option_env!\("TMM_BUILD_TIME"\)/u);
  assert.match(info, /None => "dev"/u);
  // Declaring any rerun-if-changed switches cargo's default off, so a moved
  // HEAD must be declared or the baked commit goes stale across commits.
  assert.match(build, /rerun-if-changed=\{head\}/u, 'a new commit reruns the script');
  assert.match(build, /rerun-if-changed=src/u, 'and so does a source change');
});

test('BOTH login answers carry the build, and nothing else builds one', async () => {
  const conn = await read('../../../src-tauri/src/server/connection.rs');
  assert.equal(conn.split('crate::build_info::json()').length - 1, 2, 'the sealed (v2) answer and the plain one');
  const sealed = conn.match(/"e2e":e2e_version[^\n]*/u)?.[0] ?? '';
  assert.match(sealed, /"build":crate::build_info::json\(\)/u, 'the sealed answer');
  // Board #440: the plain answer is built first (a LOCAL login adds its
  // `endpoint`), then sent.
  const plain = conn.match(/let mut answer = serde_json::json!\(\{ "authenticated": true[^\n]*/u)?.[0] ?? '';
  assert.match(plain, /"build": crate::build_info::json\(\)/u, 'the plain answer');
  assert.match(conn, /let r = Response::ok\(req\.id, answer\);/u, 'and that answer is the one sent');
});

test('the repository link has ONE home: About, not the connect form', async () => {
  const prefs = await read('../app/Preferences.svelte');
  const connect = await read('../app/Settings.svelte');
  assert.equal(prefs.split('github.com/maxlumo/teammux').length - 1, 2, 'About\'s href and its text');
  assert.doesNotMatch(connect, /github\.com|about-link/u, 'moved out of the connect form, not duplicated');
  const i18n = await read('./i18n.svelte.ts');
  assert.doesNotMatch(i18n, /^\s*about:/mu, 'the old one-line "About — github…" key is gone');
});

test('the server rows read the build per row from App, and only the Connection page asks', async () => {
  const app = await read('../../App.svelte');
  assert.match(app, /builds=\{buildOf\}/u);
  assert.equal(app.split('builds={buildOf}').length - 1, 1, 'the popover\'s ServerList asks nothing');
  assert.match(app, /function buildOf\(id\) \{\s*return members\.find\(\(r\) => r\.id === id\)\?\.build\(\);/u, 'the focused server or a background member, by id');
  const runtime = await read('../app/server-runtime.ts');
  assert.match(runtime, /build: \(\) => connection\.getBuild\(\),/u, 'asked of the live socket, never remembered on the entry');
});

test('every place App (re)binds the server in front reads it through ONE function, so none forgets the build (#368)', async () => {
  const app = await read('../../App.svelte');
  // The first version assigned the object literally at eight sites; two
  // (the boot bring-up and the address-up) forgot `build`, and About said
  // "unknown" for a server that had named its build. Now EVERY assignment is
  // `infoOf(...)`, except the one that says the socket is gone.
  const assigns = [...app.matchAll(/(?<!let )serverInfo = ([^;\n]*);/gu)].map((m) => m[1]!.trim());
  assert.ok(assigns.length >= 6, `the sites exist: ${assigns.length}`);
  const drop = assigns.filter((a) => !/^infoOf\(.*\)$/u.test(a));
  assert.deepEqual(drop, ['{ ...serverInfo, build: undefined }'], 'the only other assignment is onDrop clearing the build of the socket that just closed');
  assert.match(app, /function infoOf\(runtime\) \{\s*return \{ hostname: runtime\?\.hostname\(\) \|\| '', machineId: runtime\?\.machineId\(\) \|\| '', build: runtime\?\.build\(\) \};/u,
    'undefined (nothing answering) and null (an older server) stay different words: no `?? null` here');
  // Review P1-A: the build counts only while the link is really up, the predicate
  // the Connection rows use; onDrop clears it before any branch decides anything.
  assert.match(app, /const serverInfoShown = \$derived\(connected && !reconnecting \? serverInfo : \{ \.\.\.serverInfo, build: undefined \}\);/u);
  assert.match(app, /serverInfo=\{serverInfoShown\}/u, 'Preferences is handed the gated one');
  assert.match(app, /function onDrop\(\) \{[^}]*?serverInfo = \{ \.\.\.serverInfo, build: undefined \};\s*if \(switching\) return;/u);
});

test('the source revision is read from the environment FIRST in both builds, then git, then dev, and a dev server is not a build (#368 review P1-B, P2-C)', async () => {
  const build = await read('../../../src-tauri/build.rs');
  assert.match(build, /cargo:rerun-if-env-changed=SOURCE_COMMIT/u);
  assert.match(build, /cargo:rerun-if-env-changed=SOURCE_TIME/u);
  const sha = build.slice(build.indexOf('let sha ='), build.indexOf('let built ='));
  assert.ok(sha.indexOf('SOURCE_COMMIT') >= 0 && sha.indexOf('SOURCE_COMMIT') < sha.indexOf('"rev-parse"'), 'build.rs: the environment before git');
  const vite = await read('../../../vite.config.js');
  const id = vite.slice(vite.indexOf('export function buildIdentity'), vite.indexOf('export function devServerIdentity'));
  assert.ok(id.indexOf('env.SOURCE_COMMIT') >= 0 && id.indexOf('env.SOURCE_COMMIT') < id.indexOf("git(['rev-parse'"), 'vite: the environment before git');
  assert.match(vite, /command === 'serve' \? devServerIdentity\(identityDeps\.now\) : buildIdentity\(\{ env, \.\.\.identityDeps \}\)/u, 'serve is the dev identity, only a build carries a commit');
});

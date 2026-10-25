// Board #454: the fullscreen wrapper must cover every method wry's
// RustWebChromeClient overrides — by signature, each forwarding from its own
// body — and the check fails closed (review P1-B).
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChromeClient, lockedWry, overridesOf, uncovered, WRAPPER, wrySource } from './wry-chrome-client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const wrapper = readFileSync(join(root, WRAPPER), 'utf8');
/** wry 0.54.2's real signatures (scripts/fixtures). */
const wry = readFileSync(new URL('./fixtures/RustWebChromeClient-0.54.2.kt', import.meta.url), 'utf8');
const WRY_0_54_2 = [
  'onShowCustomView(View,CustomViewCallback)', 'onHideCustomView()', 'onPermissionRequest(PermissionRequest)',
  'onJsAlert(WebView,String,String,JsResult)', 'onJsConfirm(WebView,String,String,JsResult)',
  'onJsPrompt(WebView,String,String,String,JsPromptResult)', 'onGeolocationPermissionsShowPrompt(String,Callback)',
  'onShowFileChooser(WebView,ValueCallback<Array<Uri>>,FileChooserParams)', 'onConsoleMessage(ConsoleMessage)',
  'onReceivedTitle(WebView,String)',
];
const sigs = (src: string, cls: string) => overridesOf(src, cls).methods?.map((m: { sig: string }) => m.sig);
/** Add a class-level member to wry's fixture, before its closing brace. */
const wryWith = (member: string) => wry.replace(/\}\n$/u, `${member}\n}\n`);

test('signatures, class level only: multi-line lists, nullability and qualifiers read as the JVM sees them; a nested object, a brace in a string do not count', () => {
  assert.deepEqual(sigs(wry, 'RustWebChromeClient'), WRY_0_54_2);
  assert.ok(!sigs(wrapper, 'FullscreenChromeClient').some((s: string) => s.startsWith('handleOnBackPressed')), 'the back callback\'s override is the object\'s');
});

test('the wrapper covers wry 0.54.2: hosts the custom view, and each of the other eight forwards from its own body', () => {
  const r = uncovered(wry, wrapper);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.notForwarded, []);
});

test('a NEW method a later wry overrides is named, never dropped silently', () => {
  assert.deepEqual(uncovered(wryWith('  override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean { return false }'), wrapper).missing,
    ['onCreateWindow(WebView,Boolean,Boolean,Message)']);
});

test('an OVERLOAD of a name the wrapper already has is still missing (the name alone does not cover it)', () => {
  const r = uncovered(wryWith('  override fun onShowCustomView(view: View, requestedOrientation: Int, callback: CustomViewCallback) {}'), wrapper);
  assert.deepEqual(r.missing, ['onShowCustomView(View,Int,CustomViewCallback)']);
});

test('the wrapper missing ONE of two overloads is named', () => {
  const both = wryWith('  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult, extra: Int): Boolean { return true }');
  const withOne = wrapper.replace(/(override fun onJsAlert\(view: WebView, url: String, message: String, result: JsResult\): Boolean =\n\s*inner\.onJsAlert\(view, url, message, result\))/u,
    '$1\n  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult, extra: Int): Boolean = inner.onJsAlert(view, url, message, result)');
  assert.notEqual(withOne, wrapper, 'the wrapper edit applied');
  assert.deepEqual(uncovered(both, wrapper).missing, ['onJsAlert(WebView,String,String,JsResult,Int)']);
  assert.deepEqual(uncovered(both, withOne).missing, []);
});

test('a forwarding call in ANOTHER method does not count for this one', () => {
  const borrowed = wrapper
    .replace('inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)', 'false')
    .replace('override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = inner.onConsoleMessage(consoleMessage)',
      'override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean { if (false) inner.onShowFileChooser(null, null, null); return inner.onConsoleMessage(consoleMessage) }');
  assert.deepEqual(uncovered(wry, borrowed).notForwarded, ['onShowFileChooser(WebView,ValueCallback<Array<Uri>>,FileChooserParams)']);
});

test('refused, not guessed: a parameter with no readable type, a signature declared twice, no class', () => {
  assert.match(uncovered(wryWith('  override fun onBroken(view) {}'), wrapper).error, /cannot be read/u);
  assert.match(uncovered(wryWith('  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean { return false }'), wrapper).error, /declared twice/u);
  assert.match(uncovered('class Other {}', wrapper).error, /no class RustWebChromeClient/u);
});

const base = mkdtempSync(join(tmpdir(), 'wry chrome $x-'));
after(() => rmSync(base, { recursive: true, force: true }));

test('fail closed: no wry source in the registry is a problem, not a skip', () => {
  const p = checkChromeClient(root, { CARGO_HOME: join(base, 'empty') });
  assert.equal(p.length, 1);
  assert.match(p[0], /is not in .*does not skip/u);
});

test('fail closed: a lock with no wry, or two, is a problem', () => {
  assert.deepEqual(lockedWry('[[package]]\nname = "tao"\nversion = "1"\n'), []);
  assert.deepEqual(lockedWry('[[package]]\nname = "wry"\nversion = "0.54.2"\n\n[[package]]\nname = "wry"\nversion = "0.55.0"\n'), ['0.54.2', '0.55.0']);
  const fake = join(base, 'lock');
  mkdirSync(join(fake, 'src-tauri'), { recursive: true });
  writeFileSync(join(fake, 'src-tauri', 'Cargo.lock'), '[[package]]\nname = "tao"\nversion = "1"\n');
  assert.match(checkChromeClient(fake, { CARGO_HOME: base })[0], /locks no wry/u);
});

test('the check reads the registry the lock names', () => {
  const [v] = lockedWry(readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8'));
  const home = join(base, 'cargo');
  const kotlin = join(home, 'registry', 'src', 'idx', `wry-${v}`, 'src', 'android', 'kotlin');
  mkdirSync(kotlin, { recursive: true });
  writeFileSync(join(kotlin, 'RustWebChromeClient.kt'), wryWith('  override fun onCloseWindow(window: WebView) {}'));
  assert.equal(wrySource(v, home), join(kotlin, 'RustWebChromeClient.kt'));
  const p = checkChromeClient(root, { CARGO_HOME: home });
  assert.equal(p.length, 1);
  assert.match(p[0], /overrides onCloseWindow\(WebView\)/u);
});

// The real locked wry, where this host has fetched it (the preflight is the
// hard gate; this row shows it on any machine that builds the app).
const cargoHome = process.env.CARGO_HOME || join(homedir(), '.cargo');
const realLocked = lockedWry(readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8'))[0];
test('the locked wry\'s real chrome client is covered, and the fixture is its signatures', { skip: !wrySource(realLocked, cargoHome) && `wry ${realLocked} not in ${cargoHome}` }, () => {
  assert.deepEqual(checkChromeClient(root, { CARGO_HOME: cargoHome }), []);
  assert.deepEqual(sigs(readFileSync(wrySource(realLocked, cargoHome), 'utf8'), 'RustWebChromeClient'), WRY_0_54_2,
    'scripts/fixtures is what the locked wry overrides — update both when wry moves');
});

test('MainActivity wires the host: the interface and the REQUEST in onWebViewCreate, release on destroy (survives `tauri android init --force` only through git)', () => {
  const main = readFileSync(join(root, 'src-tauri/gen/android/app/src/main/java/com/tmuxmobile/dev/MainActivity.kt'), 'utf8');
  const hook = main.slice(main.indexOf('override fun onWebViewCreate'), main.indexOf('override fun onResume'));
  assert.match(main, /private val fullscreen = FullscreenHost\(this\)/u);
  assert.match(hook, /webView\.addJavascriptInterface\(fullscreen, "AndroidFullscreen"\)\s*fullscreen\.attach\(webView\)/u,
    'before the first load (a later interface is invisible until a reload), and the request is synchronous (review P1-A residual)');
  assert.doesNotMatch(hook, /\.post\b/u, 'the post belongs to FullscreenReadiness, carrying the request\'s ticket');
  assert.match(main, /override fun onDestroy\(\) \{\s*fullscreen\.release\(\)/u, 'destroy revokes the answer');
});

test('fail closed: one FullscreenReadiness owns request, install and read-back; the host only backs its platform (JVM-tested in src/test)', () => {
  const host = wrapper.slice(wrapper.indexOf('class FullscreenHost'));
  const gate = readFileSync(join(root, 'src-tauri/gen/android/app/src/main/java/com/tmuxmobile/dev/FullscreenReadiness.kt'), 'utf8');
  assert.match(host, /fun available\(\): Boolean = readiness\.ready/u);
  assert.match(host, /fun attach\(webView: WebView\) = readiness\.attach\(webView\)/u);
  assert.match(host, /existing is FullscreenChromeClient && existing\.activity === activity -> Result\.success\(existing\)/u, 'a repeat hook adds no second layer');
  assert.match(host, /existing\.javaClass\.simpleName != "RustWebChromeClient"/u, 'only wry\'s client is wrapped');
  const attach = gate.slice(gate.indexOf('fun attach('), gate.indexOf('fun release('));
  assert.ok(attach.indexOf('this.view = view') < attach.indexOf('publish(false)') && attach.indexOf('publish(false)') < attach.indexOf('platform.post('),
    'synchronously: the view becomes current, the old answer is withdrawn (to that page), then the install is queued');
  assert.match(attach, /platform\.post\(view\) \{ install\(view, ticket\) \}/u, 'the ticket travels with the post');
  const install = gate.slice(gate.indexOf('private fun install('), gate.indexOf('private fun settle('));
  assert.match(install, /^\s*private fun install\(view: V, ticket: Int\) \{\s*if \(!current\(ticket\)\) return/u, 'a stale task does nothing, not even wrap');
  assert.match(install, /platform\.nextFrame\(view\) \{\s*settle\(ticket, /u, 'the read-back goes through settle, which checks the ticket again');
  assert.match(gate, /private fun settle\(ticket: Int, installed: Boolean, why: String\) \{\s*if \(!current\(ticket\)\) return/u);
  assert.doesNotMatch(install, /this\.view =/u, 'a task never re-takes the current view');
  assert.match(gate, /private fun current\(ticket: Int\) = ticket == attempt/u);
  assert.match(gate.slice(gate.indexOf('fun release(')), /released = true\s*attempt \+= 1/u, 'release ends every request in flight');
  const tests = readFileSync(join(root, 'src-tauri/gen/android/app/src/test/java/com/tmuxmobile/dev/FullscreenReadinessTest.kt'), 'utf8');
  for (const name of ['aNewRequestWithdrawsTheOldAnswerAtOnceAndTellsTheNewPage', 'anOldQueuedInstallRunningAfterTheNewOneNeitherWrapsNorPublishes',
    'releaseCancelsEverythingQueuedWithNoInstallSideEffect', 'aFailedNewInstallDoesNotLeaveTheOldTrue', 'anExistingPageSeesTheRevocationAndTheNewReadiness']) {
    assert.ok(tests.includes(`fun ${name}()`), name);
  }
});

test('the bars come back as they were, both halves: snapshot on the first show (a refused second show returns before it), the one hide path shows what was shown AND hides what was hidden (review P2-C; JVM rows for the four states, the device row checks it)', () => {
  const show = wrapper.slice(wrapper.indexOf('override fun onShowCustomView'), wrapper.indexOf('private fun exit()'));
  const hide = wrapper.slice(wrapper.indexOf('private fun hide()'), wrapper.indexOf('// Everything else is wry\'s.'));
  assert.ok(show.indexOf('if (frame != null) { callback.onCustomViewHidden(); return }') < show.indexOf('before = BarSnapshot('), 'the refusal comes before the snapshot');
  assert.match(show, /before = BarSnapshot\(\s*insets\?\.isVisible\(WindowInsetsCompat\.Type\.statusBars\(\)\) \?: true,\s*insets\?\.isVisible\(WindowInsetsCompat\.Type\.navigationBars\(\)\) \?: true,\s*bars\(\)\.systemBarsBehavior,/u);
  assert.match(hide, /val \(shown, hidden\) = was\.masks\(WindowInsetsCompat\.Type\.statusBars\(\), WindowInsetsCompat\.Type\.navigationBars\(\)\)/u);
  assert.match(hide, /systemBarsBehavior = was\.behavior\s*if \(shown != 0\) show\(shown\)\s*if \(hidden != 0\) hide\(hidden\)/u);
  assert.doesNotMatch(hide, /show\(WindowInsetsCompat\.Type\.systemBars\(\)\)/u, 'not "show every bar"');
  assert.equal([...wrapper.matchAll(/private fun hide\(\)/gu)].length, 1);
});

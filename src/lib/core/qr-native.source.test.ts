// The Android scan's native wiring is pinned from source (board #403, commit 3):
// none of it runs in this suite, and every line of it is a way for the phone to
// quietly differ from the desktop, or for the app to ask for more than it uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

test('the plugin pair is pinned exactly and is one release: the JS package and the Rust crate', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.dependencies['@tauri-apps/plugin-barcode-scanner'], '2.4.4', 'exact, no caret');
  const cargo = await read('src-tauri/Cargo.toml');
  assert.match(cargo, /tauri-plugin-barcode-scanner = \{ version = "=2\.4\.4", optional = true \}/u, 'exact in Cargo too');
  assert.match(cargo, /^gui = \[[^\]]*"dep:tauri-plugin-barcode-scanner"/mu, 'part of the shell feature, so a headless build never compiles it');
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(lock.packages['node_modules/@tauri-apps/plugin-barcode-scanner'].version, '2.4.4');
});

test('the Rust crate is a phone-only dependency, registered behind cfg(mobile)', async () => {
  const cargo = await read('src-tauri/Cargo.toml');
  const at = cargo.indexOf('tauri-plugin-barcode-scanner = {');
  const table = cargo.lastIndexOf('\n[', at);
  assert.match(cargo.slice(table, at), /\[target\.'cfg\(any\(target_os = "android", target_os = "ios"\)\)'\.dependencies\]/u, 'under the mobile target table, not the plain dependencies');
  const lib = await read('src-tauri/src/lib.rs');
  assert.match(lib, /#\[cfg\(mobile\)\]\s*let builder = builder\.plugin\(tauri_plugin_barcode_scanner::init\(\)\);/u);
  assert.equal([...lib.matchAll(/tauri_plugin_barcode_scanner/gu)].length, 1, 'registered once');
});

test('the capability is for the phone alone and grants exactly the five commands the scan uses', async () => {
  const mobile = JSON.parse(await read('src-tauri/capabilities/mobile.json'));
  assert.deepEqual(mobile.platforms, ['android', 'iOS']);
  assert.deepEqual([...mobile.permissions].sort(), [
    'barcode-scanner:allow-cancel', 'barcode-scanner:allow-check-permissions', 'barcode-scanner:allow-open-app-settings',
    'barcode-scanner:allow-request-permissions', 'barcode-scanner:allow-scan',
  ]);
  assert.doesNotMatch(await read('src-tauri/capabilities/default.json'), /barcode-scanner/u, 'the desktop capability does not mention a plugin it does not have');
});

test('the camera is optional in the manifest, and nothing blocks screenshots of the preview or the app', async () => {
  const manifest = await read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.camera\.any" android:required="false" tools:node="replace" \/>/u, 'a device without a camera still installs the app');
  assert.match(manifest, /xmlns:tools="http:\/\/schemas\.android\.com\/tools"/u);
  assert.doesNotMatch(manifest, /android\.permission\.CAMERA/u, 'the permission comes with the plugin, once');
  const java = new URL('src-tauri/gen/android/app/src/main/java/', root);
  const walk = async (dir: URL): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) => e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [await readFile(new URL(e.name, dir), 'utf8')]))).flat();
  for (const source of await walk(java)) assert.doesNotMatch(source, /FLAG_SECURE/u, 'owner decision (#403): no FLAG_SECURE');
});

test('the plugin module is imported by qr-native.ts alone', async () => {
  const walk = async (dir: URL): Promise<URL[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) => e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))).flat();
  const hits: string[] = [];
  for (const file of await walk(new URL('src/', root))) {
    if (!/\.(ts|svelte)$/u.test(file.pathname) || /\.test\.ts$/u.test(file.pathname)) continue;
    if (/plugin-barcode-scanner/u.test(await readFile(file, 'utf8'))) hits.push(file.pathname.split('/src/')[1]!);
  }
  assert.deepEqual(hits, ['lib/core/qr-native.ts']);
});

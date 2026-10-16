// The Android scan is the webview's camera, with no native plugin (board #403,
// review round 2). That decision is pinned from source because none of it runs in
// this suite: a plugin creeping back is a second scan mechanism and a Google Play
// services dependency, and a manifest that stops declaring the camera makes
// getUserMedia fail on the phone with nothing here to notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');
const walk = async (dir: URL): Promise<URL[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (e) => e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]))).flat();

test('there is no native scanner plugin anywhere: not in the packages, the crate, the registration or a capability', async () => {
  const pkg = await read('package.json');
  assert.doesNotMatch(pkg, /barcode/u);
  assert.doesNotMatch(await read('package-lock.json'), /barcode-scanner/u);
  assert.doesNotMatch(await read('src-tauri/Cargo.toml'), /barcode/u);
  assert.doesNotMatch(await read('src-tauri/Cargo.lock'), /barcode/u);
  assert.doesNotMatch(await read('src-tauri/src/lib.rs'), /barcode/u);
  for (const file of await readdir(new URL('src-tauri/capabilities/', root))) assert.doesNotMatch(await read(`src-tauri/capabilities/${file}`), /barcode/u, file);
  const hits: string[] = [];
  for (const file of await walk(new URL('src/', root))) {
    if (!/\.(ts|svelte|css)$/u.test(file.pathname) || /\.test\.ts$/u.test(file.pathname)) continue;   // tests name what they forbid
    if (/barcode-scanner|scan-native|startNativeScan/u.test(await readFile(file, 'utf8'))) hits.push(file.pathname.split('/src/')[1]!);
  }
  assert.deepEqual(hits, [], 'and nothing in the app refers to one');
});

test('the manifest lets the webview ask for the camera, and a device without one still installs the app', async () => {
  const manifest = await read('src-tauri/gen/android/app/src/main/AndroidManifest.xml');
  assert.equal([...manifest.matchAll(/<uses-permission android:name="android\.permission\.CAMERA" \/>/gu)].length, 1, 'CAMERA declared once: wry asks Android for it when the page asks for the camera');
  assert.match(manifest, /<uses-feature android:name="android\.hardware\.camera\.any" android:required="false" \/>/u, 'optional: the photo command is the way in without a camera');
  assert.doesNotMatch(manifest, /tools:node|VIBRATE/u, 'no override of a plugin manifest, no permission the app does not use');
});

test('no screen capture block anywhere in the Android project (owner decision, #403)', async () => {
  for (const file of await walk(new URL('src-tauri/gen/android/app/src/main/java/', root))) assert.doesNotMatch(await readFile(file, 'utf8'), /FLAG_SECURE/u, file.pathname);
});

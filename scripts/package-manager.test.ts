// Board #33: pnpm is the one package manager, so every place a build runs a
// package manager on its own says pnpm. A second one ignores pnpm-lock.yaml
// and resolves its own versions (the incident in development.md § package
// manager). Each of these runs without a person watching: tauri's before*
// commands, and gradle's Rust step inside `tauri android build`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('package.json names pnpm, and tauri runs the web build through it', () => {
  assert.match(JSON.parse(read('package.json')).packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(conf.build.beforeDevCommand, 'pnpm run dev');
  assert.equal(conf.build.beforeBuildCommand, 'pnpm run build');
});

test('gradle s Rust step calls pnpm, in the form tauri generates for it', () => {
  const task = read('src-tauri/gen/android/buildSrc/src/main/java/com/tmuxmobile/dev/kotlin/BuildTask.kt');
  assert.match(task, /val executable = """pnpm""";/u);
  assert.match(task, /val args = listOf\("tauri", "android", "android-studio-script"\);/u);
});

test('the iOS scaffold s Rust step calls pnpm too, in both files xcodegen keeps in step', () => {
  const xcodeproj = readdirSync(new URL('../src-tauri/gen/apple/', import.meta.url)).filter((e) => e.endsWith('.xcodeproj'));
  assert.equal(xcodeproj.length, 1, 'one Xcode project');
  for (const f of ['src-tauri/gen/apple/project.yml', `src-tauri/gen/apple/${xcodeproj[0]}/project.pbxproj`]) {
    const text = read(f);
    assert.match(text, /pnpm tauri ios xcode-script/u, f);
    assert.doesNotMatch(text, /\bnpm run\b/u, f);
  }
});

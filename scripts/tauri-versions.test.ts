// Board #33 (orchestrator's condition a). `tauri android build` refuses when
// an @tauri-apps/* npm package is on another major.minor than its Rust crate
// ("Found version mismatched Tauri packages"). That stopped the owner's build
// on 2026-11-05: pnpm resolved @tauri-apps/api 2.12.4 against tauri 2.10.2,
// and `pnpm import` deduped it to 2.11.1. The pin fails HERE, in the commit
// that moves either side, instead of at the APK build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rootVersions } from './pnpm-lock.mjs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const majorMinor = (v: string) => v.split('.').slice(0, 2).join('.');

/** `{ crate: version }` for tauri and every tauri-plugin-* in Cargo.lock. */
function tauriCrates(lock: string) {
  const out: Record<string, string> = {};
  for (const m of lock.matchAll(/^\[\[package\]\]\nname = "(tauri|tauri-plugin-[a-z-]+)"\nversion = "([^"]+)"/gm)) out[m[1]!] = m[2]!;
  return out;
}

/** The npm package that pairs with a crate: tauri ↔ @tauri-apps/api,
 * tauri-plugin-<x> ↔ @tauri-apps/plugin-<x>, as tauri-cli pairs them. */
const npmOf = (crate: string) => (crate === 'tauri' ? '@tauri-apps/api' : `@tauri-apps/plugin-${crate.slice('tauri-plugin-'.length)}`);

test('every @tauri-apps/* the app resolves is on its Rust crate s major.minor', () => {
  const crates = tauriCrates(read('../src-tauri/Cargo.lock'));
  const npm = rootVersions(read('../pnpm-lock.yaml'));
  assert.ok(crates.tauri, 'Cargo.lock holds tauri');
  const pairs = Object.entries(crates).filter(([c]) => npm[npmOf(c)]);
  assert.ok(pairs.some(([c]) => c === 'tauri'), 'tauri pairs with @tauri-apps/api');
  for (const [crate, version] of pairs) {
    assert.equal(majorMinor(npm[npmOf(crate)]!), majorMinor(version),
      `${npmOf(crate)} ${npm[npmOf(crate)]} is not on ${crate} ${version}'s major.minor: move them together`);
  }
  // A JS plugin with no crate would be a plugin the app cannot load.
  for (const name of Object.keys(npm).filter((n) => n.startsWith('@tauri-apps/plugin-'))) {
    assert.ok(pairs.some(([c]) => npmOf(c) === name), `${name} has no tauri-plugin-* crate in Cargo.lock`);
  }
});

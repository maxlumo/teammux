import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Board #323: Tauri copies EVERY [[bin]] of the crate into Contents/MacOS, so
// the app already carries `tmm`; `embed-ui` makes that tmm's gateway serve the
// web UI. A `bundle.externalBin` named tmm would be overwritten by the crate's
// own bin of that name (measured on clawdbjs: the bundled tmm was the bin).
test('build:mac bundles the crate\'s tmm with the UI embedded (#323)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['build:mac'], 'tauri build --features embed-ui');
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(conf.bundle.externalBin, undefined, 'no sidecar: it would collide with the crate\'s tmm');
  assert.match(conf.build.beforeBuildCommand, /^pnpm run build$/u, 'dist/ exists before cargo, as embed-ui requires');
  const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8');
  assert.match(cargo, /\[\[bin\]\]\nname = "tmm"/u);
});

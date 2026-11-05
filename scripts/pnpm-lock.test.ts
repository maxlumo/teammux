// Board #33: the root project's resolved versions, read from pnpm-lock.yaml.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rootVersions } from './pnpm-lock.mjs';

const sample = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@tauri-apps/api':
        specifier: 2.10.1
        version: 2.10.1
      marked:
        specifier: ^17.0.3
        version: 17.0.3
    devDependencies:
      '@sveltejs/vite-plugin-svelte':
        specifier: ^5.1.1
        version: 5.1.1(svelte@5.53.5)(vite@6.4.2(@types/node@26.0.1))
      vite:
        specifier: ^6.4.2
        version: 6.4.2(@types/node@26.0.1)

  packages/other:
    dependencies:
      marked:
        specifier: 1.0.0
        version: 1.0.0

packages:

  '@tauri-apps/api@2.11.1':
    resolution: {integrity: sha512-x}
`;

test('the root importer s direct dependencies, peer suffixes dropped, nothing from another importer or packages', () => {
  assert.deepEqual(rootVersions(sample), {
    '@tauri-apps/api': '2.10.1', marked: '17.0.3', '@sveltejs/vite-plugin-svelte': '5.1.1', vite: '6.4.2',
  });
});

test('a lock without a root importer is an error, not an empty answer', () => {
  assert.throws(() => rootVersions("lockfileVersion: '9.0'\n"), /importers '\.'/);
});

test('the repository s own lock reads: every direct dependency in package.json has a version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const v = rootVersions(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(v[name] ?? '', /^\d+\.\d+\.\d+/, name);
});

// pnpm 12 with `packageManager` set writes pnpm itself into a first YAML
// document of its own (the env lockfile); the project's importers are the
// second document. pnpm is not a dependency of the project.
const envDocument = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.16.1
        version: 12.16.1

packages:

  pnpm@12.16.1:
    resolution: {integrity: sha512-y}

---
`;

test('pnpm s own env document ahead of the project s is skipped: the project s dependencies, not pnpm', () => {
  assert.deepEqual(rootVersions(envDocument + sample), {
    '@tauri-apps/api': '2.10.1', marked: '17.0.3', '@sveltejs/vite-plugin-svelte': '5.1.1', vite: '6.4.2',
  });
});

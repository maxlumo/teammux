import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { TMM_BIN_ENV, gatewayUpdate, hashFile, tmmPath } from './gateway-update.mjs';

type Call = [string, string[]];

/** A fake toolchain: every command is recorded, none runs. `hashes` is read
 *  in order, once per hash() call (before the build, then after it). */
function harness({ hashes, status = {} }: { hashes: (string | null)[]; status?: Record<string, number> }) {
  const calls: Call[] = [];
  const said: string[] = [];
  let next = 0;
  return {
    calls,
    said,
    run: async (command: string, args: string[]) => {
      calls.push([command, args]);
      const key = command === 'npm' ? 'build' : args.join(' ');
      return status[key] ?? 0;
    },
    capture: (command: string, args: string[]) => {
      calls.push([command, args]);
      return 'abc1234 a merged commit';
    },
    hash: () => hashes[Math.min(next++, hashes.length - 1)],
    log: (line: string) => said.push(line),
    warn: (line: string) => said.push(line),
  };
}

const run = (h: ReturnType<typeof harness>) =>
  gatewayUpdate({ root: '/workspace', env: { [TMM_BIN_ENV]: '/fake/tmm' }, ...h });

const restarts = (h: ReturnType<typeof harness>) =>
  h.calls.filter(([command, args]) => command === '/fake/tmm' && args[1] === 'restart');

test('an identical binary is not restarted: no connected client is dropped', async () => {
  const h = harness({ hashes: ['same', 'same'] });
  assert.equal(await run(h), 0);

  assert.deepEqual(h.calls[0], ['npm', ['run', 'build:server']]);
  assert.deepEqual(restarts(h), []);
  assert.ok(h.said.some((l) => l.includes('byte-identical')), h.said.join('\n'));
  // The commit and the service state are still reported.
  assert.ok(h.said.some((l) => l.includes('now at abc1234 a merged commit')));
  assert.deepEqual(h.calls.at(-1), ['/fake/tmm', ['gateway', 'status']]);
});

test('new bytes restart the gateway exactly once', async () => {
  const h = harness({ hashes: ['old', 'new'] });
  assert.equal(await run(h), 0);
  assert.deepEqual(restarts(h), [['/fake/tmm', ['gateway', 'restart']]]);
});

test('a failed restart exits non-zero', async () => {
  const h = harness({ hashes: ['old', 'new'], status: { 'gateway restart': 3 } });
  assert.equal(await run(h), 3);
  assert.ok(h.said.some((l) => l.includes('restart FAILED')), h.said.join('\n'));
});

test('a failed build exits non-zero and leaves the running gateway alone', async () => {
  const h = harness({ hashes: ['old', 'new'], status: { build: 101 } });
  assert.equal(await run(h), 101);
  assert.deepEqual(h.calls, [['npm', ['run', 'build:server']]]);
  assert.ok(h.said.some((l) => l.includes('build FAILED')), h.said.join('\n'));
});

test('a green build with no binary is a failure, not a silent no-op', async () => {
  const h = harness({ hashes: ['old', null] });
  assert.equal(await run(h), 1);
  assert.deepEqual(restarts(h), []);
});

test('a first build (nothing there before) restarts', async () => {
  const h = harness({ hashes: [null, 'fresh'] });
  assert.equal(await run(h), 0);
  assert.deepEqual(restarts(h), [['/fake/tmm', ['gateway', 'restart']]]);
});

test('it never fetches or pulls: this host IS the merge', async () => {
  for (const hashes of [['same', 'same'], ['old', 'new']]) {
    const h = harness({ hashes });
    await run(h);
    const git = h.calls.filter(([command]) => command === 'git').map(([, args]) => args[0]);
    assert.deepEqual(git, ['log'], `git calls: ${JSON.stringify(git)}`);
  }
});

test('the tmm it drives is this checkout’s own, overridable for a fake', () => {
  assert.equal(tmmPath('/workspace', {}), '/workspace/src-tauri/target/release/tmm');
  assert.equal(tmmPath('/workspace', { [TMM_BIN_ENV]: '/fake/tmm' }), '/fake/tmm');
  assert.equal(TMM_BIN_ENV, 'TMUX_MOBILE_GATEWAY_TMM');
});

test('a missing file hashes to null instead of throwing', () => {
  assert.equal(hashFile('/nonexistent/tmm'), null);
  assert.equal(hashFile(new URL('./gateway-update.mjs', import.meta.url).pathname)?.length, 64);
});

test('npm run gateway:update runs this script', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['gateway:update'], 'node scripts/gateway-update.mjs');
});

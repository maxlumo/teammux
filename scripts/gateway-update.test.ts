import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  RECEIPT_FILE,
  SERVICE_ENV,
  TMM_BIN_ENV,
  gatewayUpdate,
  hashFile,
  receiptPath,
  targetDirConflict,
  tmmPath,
} from './gateway-update.mjs';

type Call = [string, string[]];

/** A throwaway checkout with a real binary file and a real receipt file, so
 *  state carries from one update to the next the way it does on a host — the
 *  only fakes are the commands. `bytes` is what the next build produces. */
async function host(t: { after: (fn: () => Promise<void> | void) => void }, env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gateway-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'src-tauri/target/release/tmm');
  await mkdir(dirname(bin), { recursive: true });

  const h = {
    root,
    bin,
    bytes: 'A' as string | null,
    build: 0,
    restart: 0,
    status: 0,
    calls: [] as Call[],
    said: [] as string[],
    async update() {
      h.calls.length = 0;
      h.said.length = 0;
      return gatewayUpdate({
        root,
        env,
        capture: () => 'abc1234 a merged commit',
        log: (line: string) => h.said.push(line),
        warn: (line: string) => h.said.push(line),
        run: async (command: string, args: string[]) => {
          h.calls.push([command, args]);
          if (command === 'npm') {
            if (h.build === 0) {
              if (h.bytes === null) await unlink(bin).catch(() => {});
              else await writeFile(bin, h.bytes);
            }
            return h.build;
          }
          return args[1] === 'restart' ? h.restart : h.status;
        },
      });
    },
    restarts() {
      return h.calls.filter(([command, args]) => command === bin && args[1] === 'restart').length;
    },
    told(fragment: string) {
      return h.said.some((line) => line.includes(fragment));
    },
    receipt() {
      return readFile(receiptPath(bin), 'utf8').then(JSON.parse, () => null);
    },
  };
  return h;
}

test('a first update deploys and records what was activated', async (t) => {
  const h = await host(t);
  assert.equal(await h.update(), 0);

  assert.deepEqual(h.calls[0], ['npm', ['run', 'build:server']]);
  assert.equal(h.restarts(), 1);
  assert.ok(h.told('no activation receipt'), h.said.join('\n'));
  assert.ok(h.told('now at abc1234 a merged commit'));
  assert.deepEqual(h.calls.at(-1), [h.bin, ['gateway', 'status']]);

  const receipt = await h.receipt();
  assert.equal(receipt.hash, hashFile(h.bin));
  assert.equal(receipt.tmm, h.bin);
  assert.equal(receipt.commit, 'abc1234 a merged commit');
});

test('the same bytes, already activated, restart nobody', async (t) => {
  const h = await host(t);
  await h.update();
  assert.equal(await h.update(), 0);

  assert.equal(h.restarts(), 0);
  assert.ok(h.told('last started with exactly these bytes'), h.said.join('\n'));
  assert.ok(h.told('now at abc1234 a merged commit'));
});

// The P1-A control: a run whose restart failed must not look, next time, like
// a run with nothing to do just because the build produced the same bytes.
test('after a failed restart the next run deploys the same bytes again', async (t) => {
  const h = await host(t);
  h.restart = 3;
  assert.equal(await h.update(), 3);
  assert.equal(h.restarts(), 1);
  assert.ok(h.told('NOTHING was deployed'), h.said.join('\n'));
  assert.equal(await h.receipt(), null, 'a failed restart records no activation');
  assert.ok(!h.told('now at'), 'and never claims the gateway runs this commit');

  h.restart = 0;
  assert.equal(await h.update(), 0, 'the bytes are unchanged, but nothing has deployed them yet');
  assert.equal(h.restarts(), 1);
  assert.ok((await h.receipt()).hash === hashFile(h.bin));
});

test('a binary built by hand between updates is deployed, not assumed', async (t) => {
  const h = await host(t);
  await h.update();

  // What `npm run build:server` on its own leaves behind: new bytes on disk
  // that no restart has ever accepted. The build in this run produces the
  // same bytes again, so a before/after hash of the file would see no change.
  await writeFile(h.bin, 'built by hand');
  h.bytes = 'built by hand';
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 1);
  assert.ok(h.told('changed since the gateway was started'), h.said.join('\n'));
});

test('new bytes after a deploy restart exactly once', async (t) => {
  const h = await host(t);
  await h.update();
  h.bytes = 'B';
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 1);
  assert.ok(h.told('changed since the gateway was started'), h.said.join('\n'));
});

test('nothing to deploy but the gateway does not answer is a failure', async (t) => {
  const h = await host(t);
  await h.update();
  h.status = 7;
  assert.equal(await h.update(), 7);
  assert.equal(h.restarts(), 0, 'a dead service is not restarted behind the owner’s back');
  assert.ok(h.told('does not answer'), h.said.join('\n'));
  assert.ok(!h.told('now at'), 'and the commit is not reported as running');
});

test('a receipt about another binary or another service is not evidence', async (t) => {
  const h = await host(t);
  await h.update();
  const receipt = await h.receipt();

  await writeFile(receiptPath(h.bin), JSON.stringify({ ...receipt, tmm: '/elsewhere/tmm' }));
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 1, 'another binary’s activation says nothing about this one');

  await writeFile(receiptPath(h.bin), JSON.stringify({ ...receipt, service: 'other.service' }));
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 1, 'another service’s activation says nothing about ours');

  await writeFile(receiptPath(h.bin), 'not json');
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 1, 'an unreadable receipt deploys rather than skips');
});

test('a service named by TMM_GATEWAY_SERVICE gets its own receipt', async (t) => {
  const h = await host(t, { [SERVICE_ENV]: 'scratch.service' });
  await h.update();
  assert.equal((await h.receipt()).service, 'scratch.service');
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 0);
});

test('a failed build exits non-zero and leaves the running gateway alone', async (t) => {
  const h = await host(t);
  h.build = 101;
  assert.equal(await h.update(), 101);
  assert.deepEqual(h.calls, [['npm', ['run', 'build:server']]]);
  assert.ok(h.told('build FAILED'), h.said.join('\n'));
});

test('a green build with no binary is a failure, not a silent no-op', async (t) => {
  const h = await host(t);
  h.bytes = null;
  assert.equal(await h.update(), 1);
  assert.equal(h.restarts(), 0);
});

test('it never fetches, never pulls, and never runs systemctl itself', async (t) => {
  const h = await host(t);
  for (const bytes of ['A', 'A', 'B']) {
    h.bytes = bytes;
    await h.update();
    const commands = new Set(h.calls.map(([command]) => command));
    assert.ok(!commands.has('systemctl') && !commands.has('launchctl'),
      `the service manager is tmm’s business: ${[...commands].join(', ')}`);
    assert.deepEqual(h.calls.filter(([c]) => c === 'git').map(([, a]) => a[0]), []);
  }
});

test('the tmm it drives belongs to the checkout it builds, never PATH', async (t) => {
  const h = await host(t);
  await h.update();
  for (const [command] of h.calls) {
    assert.ok(command === 'npm' || command === h.bin, `spawned ${command}`);
  }
  // Which is why an update run from a worktree is refused: the unit's
  // ExecStart names the launch checkout's tmm, and tmm's own identity check
  // (gateway/service.rs) rejects any other path before touching systemd.
  assert.equal(tmmPath('/repo/worktree/builder-343', {}), '/repo/worktree/builder-343/src-tauri/target/release/tmm');
  assert.equal(tmmPath('/repo', {}), '/repo/src-tauri/target/release/tmm');
  assert.equal(tmmPath('/repo', { [TMM_BIN_ENV]: '/fake/tmm' }), '/fake/tmm');
});

test('a target dir that moves the artifact is refused before anything is built', async (t) => {
  for (const key of ['CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET']) {
    const h = await host(t, { [key]: 'somewhere-else' });
    assert.equal(await h.update(), 1);
    assert.deepEqual(h.calls, [], 'nothing is built when we cannot know what we built');
    assert.ok(h.told(key), h.said.join('\n'));
    // Naming the real artifact is the way through.
    assert.equal(targetDirConflict({ [key]: 'x', [TMM_BIN_ENV]: '/real/tmm' }), null);
  }
  assert.equal(targetDirConflict({}), null);
});

test('a missing file hashes to null instead of throwing', () => {
  assert.equal(hashFile('/nonexistent/tmm'), null);
  assert.equal(hashFile(new URL('./gateway-update.mjs', import.meta.url).pathname)?.length, 64);
  assert.equal(receiptPath('/repo/src-tauri/target/release/tmm'), `/repo/src-tauri/target/release/${RECEIPT_FILE}`);
});

test('npm run gateway:update runs this script', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['gateway:update'], 'node scripts/gateway-update.mjs');
});

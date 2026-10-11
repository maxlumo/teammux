import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SERVICE,
  RECEIPT_FILE,
  SERVICE_ENV,
  TMM_BIN_ENV,
  configHome,
  serviceName,
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
    /** The bytes the service was last started with, whatever happened next. */
    running: null as string | null,
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
          if (args[1] === 'restart') {
            // What a real restart does even when its own exit is non-zero:
            // it starts the binary on disk, then waits for it to answer.
            h.running = h.bytes;
            return h.restart;
          }
          return h.status;
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

test('a first update deploys and records what is running', async (t) => {
  const h = await host(t);
  assert.equal(await h.update(), 0);

  assert.deepEqual(h.calls[0], ['npm', ['run', 'build:server']]);
  assert.equal(h.restarts(), 1);
  assert.ok(h.told('no receipt for these bytes'), h.said.join('\n'));
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
  assert.ok(h.told('not recorded as deployed'), h.said.join('\n'));
  assert.equal(await h.receipt(), null, 'a failed restart leaves nothing recorded');
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
  assert.ok(h.told('changed since the gateway was last confirmed'), h.said.join('\n'));
});

test('new bytes after a deploy restart exactly once', async (t) => {
  const h = await host(t);
  await h.update();
  h.bytes = 'B';
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 1);
  assert.ok(h.told('changed since the gateway was last confirmed'), h.said.join('\n'));
});

test('nothing to deploy but the gateway does not answer is a failure', async (t) => {
  const h = await host(t);
  await h.update();
  h.status = 7;
  assert.equal(await h.update(), 7);
  assert.equal(h.restarts(), 0, 'this run deploys nothing: it found nothing to deploy');
  assert.ok(h.told('does not answer'), h.said.join('\n'));
  assert.ok(!h.told('now at'), 'and the commit is not reported as running');
  // No exit leaves a receipt we have just seen contradicted, so the next run
  // deploys rather than reporting the same fault for ever.
  assert.equal(await h.receipt(), null);
  h.status = 0;
  assert.equal(await h.update(), 0);
  assert.equal(h.restarts(), 1);
  assert.equal((await h.receipt()).hash, hashFile(h.bin));
});

// Reviewer P1-A(i), final contract: confirm, then record, then report. A
// restart that was accepted and then died records nothing and reports nothing,
// so the next run deploys the same bytes again.
test('a restart that is accepted and then stops answering records nothing', async (t) => {
  const fresh = await host(t);
  fresh.status = 7;
  assert.equal(await fresh.update(), 7, 'no receipt yet: deploy, then the check fails');
  assert.equal(fresh.restarts(), 1);
  assert.ok(!fresh.told('now at'), fresh.said.join('\n'));
  assert.ok(fresh.told('NOTHING is recorded as deployed'));
  assert.equal(await fresh.receipt(), null, 'an unconfirmed deploy is not a deployment');

  assert.equal(await fresh.update(), 7, 'and it keeps deploying until the gateway answers');
  assert.equal(fresh.restarts(), 1);
  fresh.status = 0;
  assert.equal(await fresh.update(), 0);
  assert.equal(fresh.restarts(), 1);
  assert.equal((await fresh.receipt()).hash, hashFile(fresh.bin));

  const moved = await host(t);
  await moved.update();
  moved.bytes = 'B';
  moved.status = 7;
  assert.equal(await moved.update(), 7, 'a stale receipt: deploy, then the check fails');
  assert.equal(moved.restarts(), 1);
  assert.ok(!moved.told('now at'), moved.said.join('\n'));
  assert.equal(await moved.receipt(), null, 'and the old receipt is gone, not kept');
});

// Reviewer P1 on 3a3888fe: the receipt stops being true the moment a restart
// is attempted, because that restart may leave the new binary running however
// it exits. Keeping it would make a rollback to the old bytes a no-op while
// the service runs the other ones.
test('a rollback after an unconfirmed deploy is deployed, not skipped', async (t) => {
  const h = await host(t);
  await h.update();
  assert.equal(h.running, 'A', 'A is deployed and confirmed');

  h.bytes = 'B';
  h.status = 7;
  assert.equal(await h.update(), 7);
  assert.equal(h.running, 'B', 'the service was restarted onto B even though it does not answer');
  assert.equal(await h.receipt(), null);

  h.bytes = 'A';
  h.status = 0;
  assert.equal(await h.update(), 0, 'the rollback build is deployed');
  assert.equal(h.restarts(), 1);
  assert.equal(h.running, 'A');
  assert.equal((await h.receipt()).hash, hashFile(h.bin));
});

test('a restart that fails outright also leaves no receipt behind', async (t) => {
  const h = await host(t);
  await h.update();
  h.bytes = 'B';
  h.restart = 9;
  assert.equal(await h.update(), 9);
  assert.equal(await h.receipt(), null, 'a non-zero restart may still have started B');
  assert.ok(h.told('not recorded as deployed'), h.said.join('\n'));
});

test('a build that fails never touches the receipt', async (t) => {
  const h = await host(t);
  await h.update();
  const receipt = await h.receipt();
  h.build = 101;
  assert.equal(await h.update(), 101);
  assert.deepEqual(await h.receipt(), receipt, 'nothing was restarted, so what was deployed still is');
});

// Reviewer P1-A(ii): the service's identity is the binary AND the config root
// (gateway::service::Identity), so a receipt from one root says nothing about
// the other — even when the same binary answers for both.
test('a receipt from another config root is not evidence', async (t) => {
  const a = await host(t, { HOME: '/home/a' });
  await a.update();
  assert.equal((await a.receipt()).configHome, '/home/a/.config');

  const said: string[] = [];
  const calls: Call[] = [];
  const second = await gatewayUpdate({
    root: a.root,
    env: { HOME: '/home/b' },
    capture: () => 'abc1234 a merged commit',
    log: (line: string) => said.push(line),
    warn: (line: string) => said.push(line),
    run: async (command: string, args: string[]) => {
      if (command !== 'npm') calls.push([command, args]);
      return 0;
    },
  });
  assert.equal(second, 0);
  assert.equal(calls.filter(([, args]) => args[1] === 'restart').length, 1,
    `the same bytes under another config root are a different service: deploy (${said.join(' | ')})`);
  assert.equal((await a.receipt()).configHome, '/home/b/.config');
});

test('the config root is derived the way tmm derives it', () => {
  assert.equal(configHome('/repo', { XDG_CONFIG_HOME: '/x/cfg', HOME: '/home/a' }), '/x/cfg');
  // tmm ignores a relative XDG_CONFIG_HOME (config.rs filters on is_absolute).
  assert.equal(configHome('/repo', { XDG_CONFIG_HOME: 'rel', HOME: '/home/a' }), '/home/a/.config');
  assert.equal(configHome('/repo', {}), '/repo/.config');
});

test('a receipt about another binary or another service is not evidence', async (t) => {
  const h = await host(t);
  await h.update();
  const receipt = await h.receipt();

  assert.ok(receipt.configHome, 'a receipt names the config root it belongs to');
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

test('a receipt names the service tmm would act on, not "the default"', async (t) => {
  const h = await host(t);
  await h.update();
  const here = process.platform === 'darwin' ? DEFAULT_SERVICE.darwin : DEFAULT_SERVICE.other;
  assert.equal((await h.receipt()).service, here, 'the name tmm would act on HERE');
  assert.equal(serviceName({}, 'darwin'), DEFAULT_SERVICE.darwin);
  assert.equal(serviceName({}, 'linux'), DEFAULT_SERVICE.other);
  assert.equal(serviceName({ [SERVICE_ENV]: '' }, 'linux'), DEFAULT_SERVICE.other, 'empty = unset, as tmm reads it');
  assert.equal(serviceName({ [SERVICE_ENV]: 'other.service' }, 'linux'), 'other.service');
});

// The names belong to gateway/service.rs; this is a copy, so it is pinned to
// the original rather than maintained beside it.
test('the default service names are the ones service.rs installs', async () => {
  const rust = await readFile(new URL('../src-tauri/src/gateway/service.rs', import.meta.url), 'utf8');
  const constant = (name: string) => rust.match(new RegExp(`pub const ${name}: &str = "([^"]+)"`))?.[1];
  assert.equal(constant('LABEL'), DEFAULT_SERVICE.darwin);
  assert.equal(constant('UNIT'), DEFAULT_SERVICE.other);
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
  assert.equal(targetDirConflict({}, '/repo', () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); }), null);
});

test('a target-dir in a cargo config file is refused as well', () => {
  const files: Record<string, string> = {
    '/repo/src-tauri/.cargo/config.toml': '[build]\ntarget-dir = "/elsewhere"\n',
    '/home/a/.cargo/config.toml': '[build]\njobs = 4\n',
  };
  const read = (file: string) => {
    if (!(file in files)) throw Object.assign(new Error('no'), { code: 'ENOENT' });
    return files[file];
  };
  const why = targetDirConflict({ HOME: '/home/a' }, '/repo', read);
  assert.match(String(why), /src-tauri\/\.cargo\/config\.toml/);
  assert.match(String(why), new RegExp(TMM_BIN_ENV));

  files['/home/a/.cargo/config.toml'] = '[build]\ntarget = "aarch64-unknown-linux-gnu"\n';
  assert.match(String(targetDirConflict({ HOME: '/home/a' }, '/repo', read)), /home\/a\/\.cargo/);

  // A file with neither key, and an explicitly named artifact, both pass.
  delete files['/repo/src-tauri/.cargo/config.toml'];
  files['/home/a/.cargo/config.toml'] = '[build]\njobs = 4\n';
  assert.equal(targetDirConflict({ HOME: '/home/a' }, '/repo', read), null);
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

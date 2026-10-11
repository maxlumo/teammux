import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serviceSpecs, runDevStack, stopProcessTree, DEV_WITH_SERVER_ENV } from './dev-stack.mjs';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals[] = [];

  finish(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  kill(signal: NodeJS.Signals) {
    this.killedWith.push(signal);
    queueMicrotask(() => this.finish(null, signal));
    return true;
  }
}

class StubbornChild extends FakeChild {
  override kill(signal: NodeJS.Signals) {
    this.killedWith.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => this.finish(null, signal));
    return true;
  }
}


function fakeStack(children: FakeChild[]) {
  let index = 0;
  return runDevStack({
    root: '/workspace',
    preflight: () => 0,
    env: { TMUX_MOBILE_DEV_WITH_SERVER: '1' },
    spawnProcess: () => children[index++],
  });
}

test('the dev stack is Vite alone by default; the gateway is the backend (#343)', () => {
  assert.equal(DEV_WITH_SERVER_ENV, 'TMUX_MOBILE_DEV_WITH_SERVER');
  assert.deepEqual(serviceSpecs('/workspace', {}), [
    { name: 'web', command: '/workspace/node_modules/.bin/vite', args: ['dev'], env: { TMUX_MOBILE_DEV_SERVER_PORT: '9899' } },
  ]);
  assert.deepEqual(serviceSpecs('/workspace', { TMUX_MOBILE_DEV_WITH_SERVER: '0' }).map((s) => s.name), ['web'], 'only 1 turns the watcher on');
});

test('Vite alone preflights its own port only; the watcher adds the server port', async () => {
  const asked: string[] = [];
  const stack = (env: Record<string, string>) => runDevStack({
    root: '/workspace',
    env,
    preflight: (_root: string, mode: string) => { asked.push(mode); return 1; },
    spawnProcess: () => { throw new Error('preflight refused: nothing may be spawned'); },
  });

  assert.equal(await stack({}), 1);
  assert.equal(await stack({ TMUX_MOBILE_DEV_WITH_SERVER: '1' }), 1);
  // 'dev' checks 9899 too, which the installed gateway holds for good.
  assert.deepEqual(asked, ['web', 'dev']);
});

test('with the flag the dev stack adds the Rust watcher beside the local Vite binary', async () => {
  const specs = serviceSpecs('/workspace', { TMUX_MOBILE_DEV_WITH_SERVER: '1' });
  assert.deepEqual(specs, [
    {
      name: 'server',
      command: 'bash',
      args: ['/workspace/scripts/dev-server-watch.sh'],
      env: { HOST: '127.0.0.1', PORT: '9899', TLS_CERT: '', TLS_KEY: '' },
    },
    {
      name: 'web',
      command: '/workspace/node_modules/.bin/vite',
      args: ['dev'],
      env: { TMUX_MOBILE_DEV_SERVER_PORT: '9899' },
    },
  ]);

  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['dev:all'], 'node scripts/dev-stack.mjs');
  assert.match(pkg.scripts.dev, /preflight\.mjs web/);
  assert.match(pkg.scripts['dev:server'], /preflight\.mjs server/);
  assert.equal(pkg.scripts.predev, undefined);
});

test('when either service exits the supervisor stops its sibling', async () => {
  const children = [new FakeChild(), new FakeChild()];
  const result = fakeStack(children);

  queueMicrotask(() => children[0].finish(7));

  assert.equal(await result, 7);
  assert.deepEqual(children[1].killedWith, ['SIGTERM']);
});

test('an unexpected clean service exit still fails the stopped stack', async () => {
  const children = [new FakeChild(), new FakeChild()];
  const result = fakeStack(children);

  queueMicrotask(() => children[0].finish(0));

  assert.equal(await result, 1);
  assert.deepEqual(children[1].killedWith, ['SIGTERM']);
});


test('TERM timeout escalates to KILL for stubborn service groups', async () => {
  const children = [new StubbornChild(), new StubbornChild()];
  let index = 0;
  const result = runDevStack({
    root: '/workspace',
    preflight: () => 0,
    env: { TMUX_MOBILE_DEV_WITH_SERVER: '1' },
    spawnProcess: () => children[index++],
    stopTimeoutMs: 10,
  });

  queueMicrotask(() => children[0].finish(7));

  assert.equal(await result, 7);
  assert.deepEqual(children[0].killedWith, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(children[1].killedWith, ['SIGTERM', 'SIGKILL']);
});

test('a second Ctrl-C immediately kills stubborn service groups', async () => {
  const children = [new StubbornChild(), new StubbornChild()];
  const signals = new EventEmitter();
  let index = 0;
  const result = runDevStack({
    root: '/workspace',
    preflight: () => 0,
    env: { TMUX_MOBILE_DEV_WITH_SERVER: '1' },
    spawnProcess: () => children[index++],
    stopTimeoutMs: 10_000,
    signalSource: signals,
  });

  queueMicrotask(() => signals.emit('SIGINT'));
  setTimeout(() => signals.emit('SIGINT'), 10);

  assert.equal(await result, 130);
  assert.deepEqual(children[0].killedWith, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(children[1].killedWith, ['SIGTERM', 'SIGKILL']);
});

test('timeout kills descendants even after their process-group leader exits', {
  skip: process.platform === 'win32' ? 'Unix process groups are required by the Bash watcher' : false,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dev-stack-orphan-test-'));
  const pidFiles = [join(dir, 'child-0.pid'), join(dir, 'child-1.pid')];
  const launched: ReturnType<typeof spawn>[] = [];
  const signals = new EventEmitter();
  let index = 0;

  t.after(async () => {
    for (const child of launched) stopProcessTree(child, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  const result = runDevStack({
    root: '/workspace',
    preflight: () => 0,
    env: { TMUX_MOBILE_DEV_WITH_SERVER: '1' },
    stopTimeoutMs: 50,
    signalSource: signals,
    spawnProcess: (_command: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const pidFile = pidFiles[index++];
      const child = spawn('bash', [
        '-c',
        `trap 'exit 0' TERM INT; bash -c 'trap "" TERM INT; echo $$ > "$PID_FILE"; while :; do sleep 1; done' & wait`,
      ], {
        ...options,
        cwd: process.cwd(),
        env: { ...process.env, PID_FILE: pidFile },
        stdio: 'ignore',
      });
      launched.push(child);
      return child;
    },
  });

  for (const pidFile of pidFiles) {
    for (let i = 0; i < 100; i += 1) {
      try {
        if (Number.parseInt(await readFile(pidFile, 'utf8'), 10) > 0) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  signals.emit('SIGINT');
  assert.equal(await result, 130);

  for (const pidFile of pidFiles) {
    const descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    let descendantAlive = true;
    for (let i = 0; i < 100; i += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          descendantAlive = false;
          break;
        }
        throw error;
      }
    }
    assert.equal(descendantAlive, false, `descendant ${descendantPid} survived after its leader exited`);
  }
});

test('process-tree stop reaches a watcher foreground child', {
  skip: process.platform === 'win32' ? 'Unix process groups are required by the Bash watcher' : false,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dev-stack-test-'));
  const pidFile = join(dir, 'child.pid');
  const watcher = spawn('bash', [
    '-c',
    'trap "exit 0" INT TERM; sleep 60 & echo $! > "$PID_FILE"; wait',
  ], {
    detached: true,
    env: { ...process.env, PID_FILE: pidFile },
    stdio: 'ignore',
  });

  t.after(async () => {
    stopProcessTree(watcher, 'SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });

  let foregroundPid = 0;
  for (let i = 0; i < 100; i += 1) {
    try {
      foregroundPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
      if (foregroundPid) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(foregroundPid > 0, 'foreground child pid was not recorded');

  stopProcessTree(watcher, 'SIGTERM');
  await Promise.race([
    once(watcher, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('watcher did not stop')), 2000)),
  ]);

  let childAlive = true;
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(foregroundPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        childAlive = false;
        break;
      }
      throw error;
    }
  }
  assert.equal(childAlive, false, 'foreground child survived the process-group stop');
});

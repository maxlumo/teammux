// Board #55 (owner, 2026-11-06 15:07): live checks with real agent CLIs run only in Docker. The
// rig proves it left this host alone by hashing an ALLOW-LIST of the user's config, credential and
// link paths before and after (orchestrator 15:15: not "everything minus exclusions", which the
// user's own CLIs' session and history writes would turn into false alarms).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hostChanges, hostSnapshot, liveRunArgs, stagedCredentials } from './live-docker.mjs';

const fakeHome = (root: string) => {
  const home = join(root, 'home');
  for (const d of ['.codex', '.claude', '.local/bin', '.config/teammux', '.codex/sessions']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "x"\n');
  writeFileSync(join(home, '.codex', 'personal.config.toml'), 'p\n');
  writeFileSync(join(home, '.claude', 'settings.json'), '{}\n');
  writeFileSync(join(home, '.claude.json'), '{}\n');
  writeFileSync(join(home, '.config', 'teammux', 'config.toml'), 'port = 1\n');
  writeFileSync(join(home, '.local', 'bin', 'real-tool'), '#!/bin/sh\n');
  symlinkSync(join(home, '.local', 'bin', 'real-tool'), join(home, '.local', 'bin', 'claude'));
  return home;
};

test('the snapshot covers exactly the allow-list, with links recorded by target and absent paths as absent (#55)', () => {
  const root = mkdtempSync(join(tmpdir(), 'live-docker-test-'));
  try {
    const home = fakeHome(root);
    const snap = hostSnapshot(home);
    assert.deepEqual(Object.keys(snap).sort(), [
      '.claude.json', '.claude/settings.json', '.codex/.env', '.codex/auth.json', '.codex/config.toml', '.codex/personal.config.toml',
      '.config/teammux/config.toml', '.local/bin/claude',
    ].sort().map((p) => join(home, p)));
    assert.equal(snap[join(home, '.local/bin/claude')], `link → ${join(home, '.local/bin/real-tool')}`);
    assert.equal(snap[join(home, '.codex/.env')], null, 'absent is recorded as absent');
    assert.match(String(snap[join(home, '.codex/config.toml')]), /^sha256:[0-9a-f]{64}$/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the user's own CLI writing its sessions and history is not a change; a config, credential or link change is, by path (#55)", () => {
  const root = mkdtempSync(join(tmpdir(), 'live-docker-test-'));
  try {
    const home = fakeHome(root);
    const before = hostSnapshot(home);
    writeFileSync(join(home, '.codex', 'sessions', 'rollout.jsonl'), '{}\n');
    writeFileSync(join(home, '.codex', 'history.jsonl'), 'x\n');
    assert.deepEqual(hostChanges(before, hostSnapshot(home)), []);
    writeFileSync(join(home, '.codex', 'config.toml'), 'base_url = "http://127.0.0.1:19954/v1"\n');
    rmSync(join(home, '.local', 'bin', 'claude'));
    symlinkSync('/tmp/deleted/claude', join(home, '.local', 'bin', 'claude'));
    writeFileSync(join(home, '.codex', 'auth.json'), '{}\n');
    symlinkSync('/x', join(home, '.local', 'bin', 'codex'));
    assert.deepEqual(hostChanges(before, hostSnapshot(home)), [
      `${join(home, '.codex/auth.json')} appeared`,
      `${join(home, '.codex/config.toml')} changed`,
      `${join(home, '.local/bin/claude')} changed (link → ${join(home, '.local/bin/real-tool')} is now link → /tmp/deleted/claude)`,
      `${join(home, '.local/bin/codex')} appeared`,
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable path is a failure that names it, never absent or unchanged (#48 rule, #55)', { skip: process.getuid?.() === 0 ? 'root reads everything' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'live-docker-test-'));
  try {
    const home = fakeHome(root);
    chmodSync(join(home, '.codex', 'config.toml'), 0o000);
    chmodSync(join(home, '.local', 'bin'), 0o000);
    try {
      assert.throws(() => hostSnapshot(home), (e: Error) => e.message.includes(join(home, '.codex/config.toml')) && e.message.includes(join(home, '.local/bin')) && e.message.includes('EACCES'));
    } finally {
      chmodSync(join(home, '.codex', 'config.toml'), 0o644);
      chmodSync(join(home, '.local', 'bin'), 0o755);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// AC2: credentials enter only at `docker run`, by NAME: Docker copies each value from the caller's
// environment, so no value is ever in an argv, a log, the image or a file in the image.
test('docker run gets each allow-listed credential by NAME only, never its value, and an unset one is named (#55)', () => {
  const env = { UST_API_KEY: 'sk-SECRET-1', ANTHROPIC_AUTH_TOKEN: 'tok-SECRET-2', ANTHROPIC_BASE_URL: 'https://p.example', HOME: '/home/u', OTHER_SECRET: 'nope', UST_BASE_URL: 'https://not-passed' };
  const { args, missing } = liveRunArgs({ image: 'tmm-live:test', env, need: ['UST_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], check: 'smoke' });
  const joined = args.join('\0');
  for (const v of ['sk-SECRET-1', 'tok-SECRET-2', 'https://p.example', 'nope', '/home/u', 'https://not-passed']) assert.ok(!joined.includes(v), `no value in the argv: ${v}`);
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '-e').sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'UST_API_KEY']);
  assert.ok(!args.some((a) => a.startsWith('-v') || a.startsWith('--mount') || a.startsWith('--volume')), 'nothing of the host is mounted without a stage list');
  assert.ok(args.includes('--rm') && args.at(-2) === 'tmm-live:test' && args.at(-1) === 'smoke');
  assert.deepEqual(missing, []);
  assert.deepEqual(liveRunArgs({ image: 'i', env: { UST_API_KEY: 'x' }, need: ['UST_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], check: 'smoke' }).missing, ['ANTHROPIC_AUTH_TOKEN']);
  assert.deepEqual(liveRunArgs({ image: 'i', env: { UST_API_KEY: '' }, need: ['UST_API_KEY'], check: 'smoke' }).missing, ['UST_API_KEY'], 'an empty value is unset');
});

// Owner, 15:26: copy or map the credentials from this system. Only the measured files, each
// READ-ONLY into a staging dir; the container copies them into its own HOME, so a CLI writes only
// its copy and nothing can be written back.
test('only the staged credential files are mounted, each read-only, never a directory, HOME, the gateway config or a socket (#55)', () => {
  const root = mkdtempSync(join(tmpdir(), 'live-docker-test-'));
  try {
    const home = fakeHome(root);
    const stage = stagedCredentials(home);
    assert.deepEqual(stage.map((s) => s.dest), ['codex/config.toml', 'codex/personal.config.toml', 'claude/settings.json'], 'present files only; absent ones are not mounted');
    const { args } = liveRunArgs({ image: 'i', env: {}, check: 'smoke', stage });
    const mounts = args.filter((_, i) => args[i - 1] === '--mount');
    assert.deepEqual(mounts, stage.map((s) => `type=bind,src=${s.src},dst=/stage/${s.dest},readonly`));
    for (const m of mounts) assert.ok(!m.includes('.config/teammux') && !m.includes('.sock') && !m.endsWith(`src=${home},`), m);
    rmSync(join(home, '.codex', 'config.toml'));
    symlinkSync('/etc/passwd', join(home, '.codex', 'config.toml'));
    assert.throws(() => stagedCredentials(home), /config\.toml.*not a regular file/su, 'a link is never followed into a mount');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

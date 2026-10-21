import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Board #444: every polled read is a single() loader, every entry into it calls
// the loader, and every timer is poll(loader.tick). "One in flight" is one rule
// owned by the read (#444 review P1-A), not a guard each call site or timer
// writes (Terminal had its own; it is gone). A setInterval left in these files
// is a clock tick or a key repeat, never a request.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const sites: Record<string, { loaders: string[]; timers: string[] }> = {
  '../hub/Hub.svelte': {
    loaders: ['const reload = single(readList);', 'const loadFeed = single(readFeed, () => selected);',
      'const loadActivity = single(readActivity, () => selected);', 'const loadAgents = single(readAgents, () => selected);'],
    timers: ['poll(reload.tick, 20000, { now: true })', 'poll(loadAgents.tick, 5000)', 'poll(loadActivity.tick, 5000)', 'poll(loadFeed.tick, 10000)'],
  },
  '../hub/Board.svelte': {
    loaders: ['const loadProjects = single(readProjects);', "const load = single(readBoard, () => cur ?? '');"],
    timers: ['poll(loadProjects.tick, 20000, { now: true })', 'poll(load.tick, 8000, { now: true })'],
  },
  '../terminal/Terminal.svelte': { loaders: ['const load = single(async () => {'], timers: ['poll(load.tick, WINDOW_LIST_POLL_MS, { now: true })'] },
  '../sessions/Sessions.svelte': { loaders: ['const refresh = single(readSessions);'], timers: ['poll(refresh.tick, 20000, { now: true })'] },
};
const allowedIntervals = [
  'setInterval(() => { projectTick = Date.now(); }, 1000)',
  'setInterval(() => { tick = Date.now(); }, 1000)',
  'setInterval(() => sendSpecial(key), 80)',
];
// The raw reads: nothing but their loader may call them.
const raw = { '../hub/Hub.svelte': ['readList', 'readFeed', 'readActivity', 'readAgents'], '../hub/Board.svelte': ['readProjects', 'readBoard'], '../sessions/Sessions.svelte': ['readSessions'] } as Record<string, string[]>;

test('every polled read is one single() loader, and every timer ticks it (#444)', () => {
  for (const [file, { loaders, timers }] of Object.entries(sites)) {
    const src = read(file);
    assert.match(src, /import \{ poll, single \} from '\.\.\/core\/poll\.ts';/u, `${file} imports the rule`);
    for (const l of loaders) assert.ok(src.includes(l), `${file}: ${l}`);
    for (const p of timers) assert.ok(src.includes(p), `${file}: ${p}`);
    for (const m of src.matchAll(/setInterval\(/gu)) {
      const call = src.slice(m.index, m.index + 60);
      assert.ok(allowedIntervals.some((a) => call.startsWith(a)), `${file}: an interval that is not a poll(): ${call}`);
    }
    for (const fn of raw[file] ?? []) {
      const uses = [...src.matchAll(new RegExp(`\\b${fn}\\b`, 'gu'))].length;
      assert.equal(uses, 2, `${file}: ${fn} is declared and handed to its loader, never called around it`);
    }
  }
  assert.doesNotMatch(read('../terminal/Terminal.svelte'), /let polling = false/u, 'the per-site guard is gone');
  assert.doesNotMatch(read('./poll.ts'), /let running/u, 'the timer holds no in-flight state of its own');
});

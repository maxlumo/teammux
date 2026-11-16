// Board #144 (owner, 2026-11-16 14:27): an agent's path that Files did not find at the project
// root is searched where it ends; one match opens, several ask, none is today's not-found. The
// answer belongs to the tap that asked.
import test from 'node:test';
import assert from 'node:assert/strict';
(globalThis as any).$state = (v: unknown) => v;
const { PathFind, PATH_FIND, SHOWN } = await import('./path-find.svelte.ts');
type Stop = import('./path-find.svelte.ts').Stop;

type Ans = { root: string; matches: string[]; more: boolean; stopped?: 'time' | 'dirs' | 'unreadable' };
const rig = (answer: Ans | Error, caps: string[] = [PATH_FIND]) => {
  const asked: [string, string][] = [];
  const opened: string[] = [];
  const missing: Stop[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const finder = new PathFind(async (s, r) => { asked.push([s, r]); await gate; if (answer instanceof Error) throw answer; return answer; }, () => caps);
  return { finder, asked, opened, missing, release, open: (p: string) => opened.push(p), miss: (stopped: Stop) => missing.push(stopped) };
};
const find = { session: 'teammux', ref: 'temp/111/out.png' };

test('one match opens it, absolute under the root the server derived', async () => {
  const r = rig({ root: '/w/t', matches: ['worktree/b/temp/111/out.png'], more: false });
  const done = r.finder.afterMiss(find, r.finder.retire(), r.open, r.miss);
  r.release(); await done;
  assert.deepEqual(r.asked, [['teammux', 'temp/111/out.png']]);
  assert.deepEqual(r.opened, ['/w/t/worktree/b/temp/111/out.png']);
  assert.deepEqual(r.missing, []);
  assert.equal(r.finder.choices, null);
});

test('none is today\'s not-found; a search that stopped early or could not read a folder says which', async () => {
  for (const [stopped, said] of [[undefined, null], ['time', 'early'], ['dirs', 'early'], ['unreadable', 'unreadable']] as const) {
    const r = rig({ root: '/w/t', matches: [], more: false, ...(stopped ? { stopped } : {}) });
    const done = r.finder.afterMiss(find, r.finder.retire(), r.open, r.miss);
    r.release(); await done;
    assert.deepEqual(r.missing, [said]);
    assert.deepEqual(r.opened, []);
  }
});

test('several ask: the nearest SHOWN, "more" when there are more, a pick opens, a dismiss is not-found', async () => {
  const many = Array.from({ length: 14 }, (_, i) => `w${i}/temp/111/out.png`);
  const r = rig({ root: '/w/t', matches: many, more: false });
  const done = r.finder.afterMiss(find, r.finder.retire(), r.open, r.miss);
  r.release(); await done;
  assert.equal(SHOWN, 10);
  assert.deepEqual(r.finder.choices?.shown, many.slice(0, 10));
  assert.equal(r.finder.choices?.more, true, '14 found, 10 shown');
  r.finder.pick(2);
  assert.deepEqual(r.opened, ['/w/t/w2/temp/111/out.png']);
  assert.equal(r.finder.choices, null);
  const d = rig({ root: '/w/t', matches: many.slice(0, 2), more: false });
  const done2 = d.finder.afterMiss(find, d.finder.retire(), d.open, d.miss);
  d.release(); await done2;
  assert.equal(d.finder.choices?.more, false);
  d.finder.dismiss();
  assert.deepEqual([d.opened, d.missing], [[], [null]], 'dismissing opens nothing: today\'s not-found');
});

test('a retired find is dropped for good: its late answer and a pick from its chooser apply nothing', async () => {
  const r = rig({ root: '/w/t', matches: ['a/temp/111/out.png'], more: false });
  const done = r.finder.afterMiss(find, r.finder.retire(), r.open, r.miss);
  r.finder.retire(); // a newer reference, a navigation, a project, server or scope change
  r.release(); await done;
  assert.deepEqual([r.opened, r.missing], [[], []]);
  const s = rig({ root: '/w/t', matches: ['a/x', 'b/x'], more: false });
  const d2 = s.finder.afterMiss(find, s.finder.retire(), s.open, s.miss);
  s.release(); await d2;
  assert.ok(s.finder.choices);
  s.finder.retire();
  assert.equal(s.finder.choices, null, 'a retired chooser closes');
  s.finder.pick(0);
  assert.deepEqual(s.opened, [], 'and nothing of it can be picked');
});

test('a find whose owner was retired before it began asks nothing', async () => {
  const r = rig({ root: '/w/t', matches: ['a/x'], more: false });
  const token = r.finder.retire(); // the operation begins
  r.finder.retire(); // its owner moves on while its first await is pending
  r.release(); await r.finder.afterMiss(find, token, r.open, r.miss);
  assert.deepEqual([r.asked, r.opened, r.missing], [[], [], []]);
});

test('a token is minted for an owner: a change TO that owner never retires it, in either order', async () => {
  // begin then own (the navRequest effect first), own then begin (the owner effect first).
  for (const order of [['begin', 'own'], ['own', 'begin']] as const) {
    const r = rig({ root: '/w/t', matches: ['a/x'], more: false });
    r.finder.own('A');
    let token = 0;
    for (const step of order) { if (step === 'begin') token = r.finder.begin('B'); else r.finder.own('B'); }
    r.release(); await r.finder.afterMiss(find, token, r.open, r.miss);
    assert.deepEqual(r.opened, ['/w/t/a/x'], order.join(' → '));
  }
  // A change to any OTHER owner retires it.
  const r = rig({ root: '/w/t', matches: ['a/x'], more: false });
  const token = r.finder.begin('A');
  const done = r.finder.afterMiss(find, token, r.open, r.miss);
  r.finder.own('B');
  r.release(); await done;
  assert.deepEqual([r.asked.length, r.opened], [1, []]);
});

test('a stopped-early chooser says both facts when both hold: stopped early, and more not shown', async () => {
  const many = Array.from({ length: 11 }, (_, i) => `w${i}/x`);
  const r = rig({ root: '/w/t', matches: many, more: false, stopped: 'time' });
  const done = r.finder.afterMiss(find, r.finder.retire(), r.open, r.miss);
  r.release(); await done;
  assert.equal(r.finder.choices?.stopped, 'early');
  assert.equal(r.finder.choices?.more, true);
});

test('an older server without the capability, or a failed search, is today\'s not-found with no request', async () => {
  const r = rig({ root: '/w/t', matches: ['a'], more: false }, ['asks']);
  await r.finder.afterMiss(find, r.finder.retire(), r.open, r.miss);
  assert.deepEqual([r.asked, r.missing], [[], [null]]);
  const e = rig(new Error('boom'));
  const done = e.finder.afterMiss(find, e.finder.retire(), e.open, e.miss);
  e.release(); await done;
  assert.deepEqual(e.missing, [null]);
});

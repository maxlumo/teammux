import test from 'node:test';
import assert from 'node:assert/strict';

// Board #147: the Hub's state words, tones and two header helpers, moved out of Hub.svelte
// unchanged (code-quality.md § 2). The expected values are the English table's own words.
(globalThis as any).$state = (value: unknown) => value;
(globalThis as any).localStorage = { getItem: () => 'en', setItem: () => {} };
(globalThis as any).document ??= { documentElement: { lang: 'en' } };
const { detailLabel, feedLevelItems, spawnRefusal, stateLabel, stateTone, teamMembers, wheelX } = await import('./hub-labels.ts');

test('a state is one word, and an unknown one shows itself', () => {
  assert.equal(stateLabel('idle'), 'idle');
  assert.equal(stateLabel('waiting'), 'waiting for you');
  assert.equal(stateLabel('brand-new'), 'brand-new');
});

test('a detail names its remedy, then the error; an unknown detail reads as written', () => {
  assert.equal(detailLabel(''), '');
  assert.match(detailLabel('auth_expired'), /^auth expired — run mwinit, then restart it/u);
  assert.match(detailLabel('something_else'), /^something_else/u);
});

test('a state\u2019s tone is the family its dot paints', () => {
  assert.equal(stateTone('failed'), 'danger');
  assert.equal(stateTone('idle'), undefined);
});

test('a spawn refusal: the two gates in the page\u2019s words, anything else as the server said it', () => {
  assert.equal(spawnRefusal({ code: 'server_too_old' }), 'This server is older than the app. Update the server to start an agent inside a team.');
  assert.equal(spawnRefusal({ code: 'login_pending' }), 'Still connecting to the server. Try again in a moment.');
  assert.equal(spawnRefusal({ message: 'no such team' }), 'no such team');
  assert.equal(spawnRefusal('plain'), 'plain');
});

test('a team\u2019s members: names, a nested team as +name, broken JSON as none', () => {
  assert.deepEqual(teamMembers({ members: '[{"name":"lead"},{"team":"qa"},{"name":""}]' }), ['lead', '+qa']);
  assert.deepEqual(teamMembers({ members: 'not json' }), []);
});

test('the feed level rows: three, the current one ticked, a pick sets it', () => {
  const set: string[] = [];
  const rows = feedLevelItems({ feedLevel: 'status', setFeedLevel: (l) => set.push(l) });
  assert.deepEqual(rows.map((r) => [r.label, r.icon]), [['Chat detail · Chat', 'circle'], ['Chat detail · + Status', 'check'], ['Chat detail · + Tools', 'circle']]);
  rows[2]!.onselect();
  assert.deepEqual(set, ['tools']);
});

test('the header path pans with a vertical wheel only when it overflows', () => {
  const listeners: Record<string, (e: any) => void> = {};
  const el = { scrollWidth: 300, clientWidth: 100, scrollLeft: 0, addEventListener: (k: string, f: any) => { listeners[k] = f; }, removeEventListener: (k: string) => { delete listeners[k]; } };
  const action = wheelX(el as unknown as HTMLElement);
  let prevented = 0;
  listeners.wheel!({ deltaY: 40, deltaX: 0, preventDefault: () => { prevented++; } });
  assert.deepEqual([el.scrollLeft, prevented], [40, 1]);
  listeners.wheel!({ deltaY: 40, deltaX: 5, preventDefault: () => { prevented++; } });
  assert.deepEqual([el.scrollLeft, prevented], [40, 1], 'a trackpad already pans');
  el.scrollWidth = 100;
  listeners.wheel!({ deltaY: 40, deltaX: 0, preventDefault: () => { prevented++; } });
  assert.deepEqual([el.scrollLeft, prevented], [40, 1], 'it fits: the page keeps the wheel');
  action.destroy();
  assert.equal(listeners.wheel, undefined);
});

// The Terminal sidebar's sessions union (board #335 ③c-3): tmux's order is
// each server's rule, so the union concatenates in saved order, excludes the
// focused server (its own list is on the page already), tags by the whole
// included set, and names a server that has not published.
import test from 'node:test';
import assert from 'node:assert/strict';
(globalThis as { $state?: unknown }).$state = (v: unknown) => v;
const { createSessionsUnion } = await import('./sessions-union.svelte.ts');

const pick = (name: string, target = `${name}:1.0`, windows = 1) => ({ name, windows, attached: false, target });
const inc = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }, { id: 'c', name: 'charlie' }];

test('the focused server is left out; the others concatenate in saved order, each row named by its server and ref', () => {
  const u = createSessionsUnion();
  u.publish({ id: 'ra' }, 'a', [pick('work')]);
  u.publish({ id: 'rc' }, 'c', [pick('ops'), pick('web')]);
  u.publish({ id: 'rb' }, 'b', [pick('work')]);
  const list = u.rows(inc, 'a');
  assert.deepEqual(list.rows.map((r) => `${r.tag}:${r.item.name}`), ['beta:work', 'charlie:ops', 'charlie:web'], 'A s own list is the page s; B then C by saved order, each in tmux s order');
  assert.deepEqual(list.rows.map((r) => r.ref), [
    { kind: 'pane', serverId: 'b', session: 'work', target: 'work:1.0' },
    { kind: 'pane', serverId: 'c', session: 'ops', target: 'ops:1.0' },
    { kind: 'pane', serverId: 'c', session: 'web', target: 'web:1.0' },
  ]);
  assert.equal(new Set(list.rows.map((r) => r.key)).size, 3);
  assert.deepEqual(list.missing, []);
});

test('two included servers: the one foreign section is still tagged (the rule is the included set, not the foreign count); a server without a list is missing', () => {
  const u = createSessionsUnion();
  const rb = { id: 'rb' };
  u.publish(rb, 'b', [pick('work')]);
  const list = u.rows(inc.slice(0, 2), 'a');
  assert.deepEqual(list.rows.map((r) => r.tag), ['beta']);
  const three = u.rows(inc, 'a');
  assert.deepEqual(three.missing, ['c'], 'C has not published');
  u.withdraw({ id: 'rb' });
  assert.equal(u.rows(inc.slice(0, 2), 'a').rows.length, 1, 'keyed by the runtime object: a different object withdraws nothing');
  u.withdraw(rb);
  assert.deepEqual(u.rows(inc.slice(0, 2), 'a').rows, []);
});

test('a session the server reported without a pane still has a ref — the row can focus without opening', () => {
  const u = createSessionsUnion();
  u.publish({ id: 'rb' }, 'b', [pick('bare', '')]);
  const [row] = u.rows(inc.slice(0, 2), 'a').rows;
  assert.equal(row!.ref.target, 'bare:');
});

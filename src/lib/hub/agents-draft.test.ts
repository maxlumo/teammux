import test from 'node:test';
import assert from 'node:assert/strict';

// The Agents editor's shared working copy (board #124; validator note 43). Unit shim for a .svelte.ts module
// (conventions/testing.md): `$state` is the identity, so the store is read as plain values.
(globalThis as any).$state = (v: unknown) => v;
const { createAgentsDraft, sectionOfDraft, categoryOfDraft } = await import('./agents-draft.svelte.ts');

const agent = { kind: 'agent' as const, value: { name: 'alpha', system: 'typed' }, creating: false, original: 'fp', harness: false };

test('a new store holds nothing, at revision 0, owned by nobody', () => {
  const d = createAgentsDraft();
  assert.equal(d.held, null);
  assert.equal(d.rev, 0);
  assert.equal(d.owner, null);
});

test('a write is the writer\'s: it holds the draft, bumps the revision and makes the writer the owner', () => {
  const d = createAgentsDraft();
  const page = {}, guest = {};
  assert.equal(d.write(page, agent), 1);
  assert.deepEqual(d.held, agent);
  assert.equal(d.owner, page);
  assert.equal(d.write(guest, null), 2, 'a save or a discard writes null, still a revision');
  assert.equal(d.held, null);
  assert.equal(d.owner, guest);
});

test('adopting moves ownership without a new revision, so the adopter knows what it holds', () => {
  const d = createAgentsDraft();
  const page = {}, guest = {};
  d.write(page, agent);
  assert.equal(d.adopt(guest), 1, 'the revision the adopter now holds');
  assert.equal(d.owner, guest);
  assert.equal(d.rev, 1);
  assert.deepEqual(d.held, agent, 'the draft is untouched');
});

test('two servers\' stores are independent', () => {
  const a = createAgentsDraft(), b = createAgentsDraft();
  a.write({}, agent);
  assert.equal(b.held, null);
  assert.equal(b.rev, 0);
});

test('each kind of draft has its phone section and desktop category (Settings and the Agents page)', () => {
  const cases = [
    [{ kind: 'agent', harness: false }, 'agents', 'agents'],
    [{ kind: 'agent', harness: true }, 'backends', 'backends'],
    [{ kind: 'team', harness: false }, 'teams', 'teams'],
    [{ kind: 'skill', harness: false }, 'skills', 'skills'],
    [{ kind: 'mcp', harness: false }, 'mcp', 'mcp'],
    [{ kind: 'global', harness: false }, 'agents', 'global'],
  ] as const;
  for (const [d, section, category] of cases) {
    assert.equal(sectionOfDraft(d), section, `${d.kind}${d.harness ? ' (harness)' : ''}: section`);
    assert.equal(categoryOfDraft(d), category, `${d.kind}${d.harness ? ' (harness)' : ''}: category`);
  }
});

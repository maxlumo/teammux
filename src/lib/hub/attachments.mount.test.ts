// Board #134 (leader note 2): chat and board attachments go through the one transfer limiter, and the wait
// is TRUTHFUL: while an attachment waits for a slot the stager says waiting (the composer names its attach
// button 'Waiting for a transfer slot'), no upload session is begun, and Send stays gated (attaching).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./AttachStager.test.svelte', import.meta.url), []);

test('an attachment waits for a transfer slot as waiting, begins nothing, and uploads once a slot frees (#134)', async (context) => {
  const app = await (await compiled).mount(context, { modules: [], setup(w) {
    w.localStorage.setItem('tmux_transfer_limit', '1');
    (w as any).fetch = async () => new Response(null, { status: 201, headers: { 'Upload-Offset': '3' } });
  } });
  const att = (app.window as any).__att;
  const read = (sel: string) => app.document.querySelector(sel)!.textContent;
  const held = await att.slots.acquire();
  const file = new app.window.File(['abc'], 'notes.txt', { type: 'text/plain' });
  const staged = att.stager.stage([file]);
  for (let i = 0; i < 10 && read('.waiting') !== 'waiting'; i++) await app.flush();
  assert.equal(read('.waiting'), 'waiting', 'the composer can say Waiting');
  assert.equal(read('.attaching'), 'attaching', 'Send stays gated while it waits');
  assert.deepEqual([...att.log], [], 'no upload session is begun while it waits');
  held();
  await staged;
  for (let i = 0; i < 5; i++) await app.flush();
  assert.equal(att.log.length, 1, 'one session, begun after the slot');
  assert.match(att.log[0], /^begin .*notes\.txt$/u);
  assert.equal(read('.waiting'), 'not-waiting');
  assert.equal(read('.attaching'), 'idle');
  assert.equal(att.text, '[file:1]', 'the attachment landed in the text');
  await app.close();
});

test('an attachment of a room left behind (clear) does not make the new composer say waiting (#134, validator)', async (context) => {
  const app = await (await compiled).mount(context, { modules: [], setup(w) {
    w.localStorage.setItem('tmux_transfer_limit', '1');
    (w as any).fetch = async () => new Response(null, { status: 201, headers: { 'Upload-Offset': '3' } });
  } });
  const att = (app.window as any).__att;
  const read = (sel: string) => app.document.querySelector(sel)!.textContent;
  const held = await att.slots.acquire();
  const staged = att.stager.stage([new app.window.File(['abc'], 'old.txt', { type: 'text/plain' })]);
  for (let i = 0; i < 10 && read('.waiting') !== 'waiting'; i++) await app.flush();
  assert.equal(read('.waiting'), 'waiting');
  att.stager.clear(); // a project switch: the composer on screen is a new set
  for (let i = 0; i < 5; i++) await app.flush();
  assert.equal(read('.waiting'), 'not-waiting', 'the old room\'s wait is not this composer\'s');
  assert.equal(read('.attaching'), 'idle');
  held();
  await staged;
  for (let i = 0; i < 5; i++) await app.flush();
  assert.equal(att.text, '', 'and the stale job wrote nothing into the new set');
  await app.close();
});

test('a stage job whose .gitignore stat answers after clear() books its wait to ITS generation (#134, validator)', async (context) => {
  // The stat of the uploads dir's .gitignore is held across a project switch; it then answers 'missing',
  // the job writes the 2-byte file, and that upload waits for a slot: the new composer must not say so.
  const app = await (await compiled).mount(context, { modules: [], setup(w) {
    w.localStorage.setItem('tmux_transfer_limit', '1');
    (w as any).fetch = async () => new Response(null, { status: 201, headers: { 'Upload-Offset': '2' } });
  } });
  const att = (app.window as any).__att;
  const read = (sel: string) => app.document.querySelector(sel)!.textContent;
  const held = await att.slots.acquire();
  att.holdGitignore();
  const staged = att.stager.stage([new app.window.File(['abc'], 'old.txt', { type: 'text/plain' })]);
  for (let i = 0; i < 5; i++) await app.flush();
  att.stager.clear();
  att.answer();
  for (let i = 0; i < 10; i++) await app.flush();
  assert.equal(att.slots.waiting, 0, 'the stale job queued nothing: its completion is a no-op');
  assert.deepEqual([...att.log], [], 'and began no upload');
  assert.equal(read('.waiting'), 'not-waiting', 'and the new composer does not say it waits');
  assert.equal(read('.attaching'), 'idle');
  held();
  await staged;
  await app.close();
});

test('put takes the stage job\'s generation and has no default: a missing one is a type error, not the live value (#134)', async () => {
  const src = await readFile(new URL('./attachments.svelte.ts', import.meta.url), 'utf8');
  assert.match(src, /const put = async \(dest: string, blob: Blob, gen: number\) =>/u);
  assert.doesNotMatch(src, /gen: number = attachGen/u, 'no live-generation default');
  assert.match(src, /await ignoreSelf\(`\$\{ws\}\/\.tmm\/uploads\/\.gitignore`, gen\);/u, 'the gen goes through ignoreSelf');
  const calls = src.split('\n').filter((line) => /await put\(/u.test(line));
  assert.equal(calls.length, 3, 'the three uploads: .gitignore, an image, a file');
  for (const line of calls) assert.match(line, /, gen\);\s*$/u, `every put passes its gen: ${line.trim()}`);
});

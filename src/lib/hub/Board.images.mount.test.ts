import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';
import { clearLeaveGuardsForTests, confirmLeave, registerLeaveGuard, type LeaveGuard } from '../app/leave-guards.ts';

// Board #329: images in the Board through the chat's ONE pipeline. The real
// Board, the real stager, fake RPCs; the browser's encoder is stubbed in the
// window (jsdom has no canvas), so the upload carries a fixed webp body.
// Bound to one server's scope, as App's provider binds it (board #335 ②b).
const compiled = compileMount(new URL('./Board.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url), new URL('../app/leave-guards.ts', import.meta.url)], { serverScope: true });
const WS = '/work/fixture';
const REF = /!\[\]\(\/work\/fixture\/\.tmm\/uploads\/[a-z0-9]+-[a-z0-9]{8}\.webp\)/u;
const issueA = { id: 1, title: 'A', body: 'Body A', status: 'todo', assignee: '', editable: true, created_at: 100, updated_at: 100, notes: [] };
const issueB = { id: 2, title: 'B', body: 'Body B', status: 'todo', assignee: '', editable: true, created_at: 100, updated_at: 100, notes: [] };

type Calls = { saves: any[]; notes: any[]; posts: any[]; uploads: string[] };
type Opts = { caps?: string[]; answer?: (patch: any) => unknown; projects?: string[]; stateful?: boolean; download?: (path: string) => Promise<{ url: string }>; issues?: any[]; upload?: (path: string) => Promise<unknown>; agents?: any[]; save?: (patch: any) => Promise<unknown>; note?: () => Promise<unknown> };
const guardsSeen: LeaveGuard[] = [];
const cleanups = new Map<LeaveGuard, () => void>();
const unregister = (g: LeaveGuard) => cleanups.get(g)?.();
// The switch leaves the Board's OWN server (board #335 ②b-3: the Board now
// mounts in a scope, so its guard's owner is that scope's runtime, and a leave
// asks only the handle it destroys).
const walk = () => confirmLeave({ leaving: guardsSeen[0]?.runtime ?? null, current: 'hub', reveal: async () => {}, hold: () => {} });
async function mount(context: TestContext, opts: Opts = {}) {
  clearLeaveGuardsForTests(); guardsSeen.length = 0;
  const calls: Calls = { saves: [], notes: [], posts: [], uploads: [] };
  const issues = opts.issues ?? [issueA, issueB];
  let back!: () => boolean;
  const app = await (await compiled).mount(context, {
    props: { session: 'fixture', visible: true, guardPage: 'board', onGoBack: (fn: typeof back) => back = fn },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      const w = window as any;
      w.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
      w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
      w.HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob) => void) { cb(new w.Blob(['img'], { type: 'image/webp' })); };
      w.URL.createObjectURL = () => 'blob:thumb';
      w.URL.revokeObjectURL = () => {};
    },
    modules: [{
      getCaps: () => ('caps' in opts ? opts.caps : ['board_dispatch']), // the login answer's capabilities (board #377)
      projectList: async () => ({ projects: (opts.projects ?? ['fixture']).map((p) => ({ project: { id: p, session: p, name: p, path: `/work/${p}` }, live: true })) }),
      hubRooms: async () => ({ rooms: {} }),
      boardCounts: async () => ({ counts: Object.fromEntries((opts.projects ?? ['fixture']).map((p) => [p, { todo: issues.length, doing: 0, review: 0, done: 0, total: issues.length }])) }),
      hubAgents: async () => ({ agents: opts.agents ?? [] }),
      boardList: async () => ({ issues }),
      boardGet: async (_s: string, id: number) => issues.find((i) => i.id === id),
      boardSave: async (session: string, patch: any) => {
        calls.saves.push({ ...patch, session });
        if (opts.save) await opts.save(patch);
        // A stateful fake: the stored issue takes the patch, so boardGet answers what was saved.
        if (opts.stateful && patch.id != null) { const i = issues.find((x) => x.id === patch.id); if (i) Object.assign(i, Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'id'))); }
        return opts.answer ? opts.answer(patch) : { id: patch.id ?? 9 };
      },
      boardDelete: async () => ({}),
      boardNote: async (session: string, id: number, body: string) => { calls.notes.push({ id, body, session }); if (opts.note) await opts.note(); return {}; },
      hubPost: async (session: string, body: string) => { calls.posts.push({ session, body }); return {}; },
      fsMkdir: async () => ({}),
      fsUpload: async (path: string) => {
        if (path.endsWith('/.gitignore')) return {};
        calls.uploads.push(path);
        return opts.upload ? opts.upload(path) : {};
      },
      fsDownloadHttp: opts.download ?? (async (path: string) => ({ url: `https://dl.test/?p=${encodeURIComponent(path)}` })),
    }, {
      // The REAL registry and walk (this realm's leave-guards.ts) receive the
      // Board's own guard object; the cleanup it returns cannot cross realms.
      // The cleanup the Board's $effect returns is called at destroy; the
      // realm boundary drops the function, so the test runs it explicitly
      // (unregister) — and asserts the guard answers 'leave' once destroyed.
      registerLeaveGuard: (g: LeaveGuard) => { cleanups.set(g, registerLeaveGuard(g)); guardsSeen.push(g); return undefined; },
    }],
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await app.flush(); };
  await flush();
  const q = <E extends Element>(sel: string) => app.document.querySelector<E>(sel);
  const paste = async (target: HTMLElement) => {
    const file = new app.window.File(['raw'], 'shot.png', { type: 'image/png' });
    const event = new app.window.Event('paste', { bubbles: true, cancelable: true }) as any;
    event.clipboardData = { items: [{ kind: 'file', getAsFile: () => file }], files: [file], getData: () => '' };
    target.dispatchEvent(event);
    await flush();
  };
  const type = async (el: HTMLTextAreaElement, v: string) => {
    el.value = v; el.setSelectionRange(v.length, v.length);
    el.dispatchEvent(new app.window.Event('input', { bubbles: true })); await flush();
  };
  return { ...app, calls, flush, q, paste, type, back: () => back() };
}

test('an image pasted into a new issue is a chip, and the saved body carries its ref', async (context) => {
  const app = await mount(context, { agents: [{ name: 'alice', managed: true, state: 'idle' }] });
  try {
    app.q<HTMLButtonElement>('[aria-label="New issue"], .new-btn, [title="New issue"]')?.click();
    await app.flush();
    if (!app.q('.d-body-edit.fill')) {
      // The page head's create entry (labels vary): any button that opens the form.
      [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''))?.click();
      await app.flush();
    }
    const body = app.q<HTMLTextAreaElement>('.d-body-edit.fill')!;
    assert.ok(body, 'the create form is open');
    await app.type(body, 'See ');
    await app.paste(body);
    assert.equal(app.calls.uploads.length, 1, 'the shared pipeline uploaded it');
    assert.ok(app.q('.pend-thumb img'), 'the thumbnail chip shows');
    assert.equal(body.value, 'See [img:1]', 'the token at the caret');
    await app.type(app.q<HTMLTextAreaElement>('.n-title')!, 'With a picture');
    app.q<HTMLButtonElement>('.detail .icon-btn.go')!.click();
    await app.flush();
    assert.equal(app.calls.saves.length, 1);
    assert.match(app.calls.saves[0].body, /^See /u);
    assert.match(app.calls.saves[0].body, REF, 'the stored body has the ref, not the token');
    assert.ok(!app.calls.saves[0].body.includes('[img:'), 'no token reaches the server');
  } finally { await app.close(); }
});

test('while an image uploads, ✓ and Cmd+Enter create nothing, and leaving asks first', async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const app = await mount(context, { upload: () => gate.then(() => ({})) });
  try {
    [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''))?.click();
    await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit.fill')!;
    await app.type(body, 'Uploading ');
    await app.paste(body);
    const ok = app.q<HTMLButtonElement>('.detail .icon-btn.go')!;
    assert.equal(ok.disabled, true, 'the button is closed while it uploads');
    body.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    await app.flush();
    assert.equal(app.calls.saves.length, 0, 'the keyboard path refuses too');
    // An image-only draft is unsaved work: Back asks instead of dropping it.
    await app.type(body, '');
    assert.equal(app.back(), true);
    await app.flush();
    assert.ok(app.q('[role=alertdialog]'), 'the shared discard confirm');
    app.q<HTMLButtonElement>('.dlg-actions button:first-child')!.click(); // keep editing
    await app.flush();
    release(); await app.flush();
    assert.ok(app.q('.pend-thumb'), 'kept: the upload landed in the draft it belongs to');
    assert.equal(body.value, '[img:1]');
    assert.equal(ok.disabled, false, 'an image-only body is content');
  } finally { release(); await app.close(); }
});

test('a failed upload is a chip that blocks create; removing it takes the token whole and nothing else', async (context) => {
  const app = await mount(context, { upload: async () => { throw new Error('disk full'); } });
  try {
    [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''))?.click();
    await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit.fill')!;
    await app.type(body, 'Keep imgs [here]');
    await app.paste(body);
    assert.ok(app.q('.pend-chip.err'), 'the failure is visible');
    assert.equal(app.q<HTMLButtonElement>('.detail .icon-btn.go')!.disabled, true);
    app.q<HTMLButtonElement>('.pend-chip.err .pend-x')!.click();
    await app.flush();
    assert.equal(app.q('.pend-chip.err'), null);
    assert.equal(body.value, 'Keep imgs [here]', 'nothing of the text was touched');
  } finally { await app.close(); }
});

test('removing a staged image removes its [img:n] token whole; body characters stay (the escape fix)', async (context) => {
  const app = await mount(context);
  try {
    [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''))?.click();
    await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit.fill')!;
    await app.type(body, 'look i m g : 1 ');
    await app.paste(body);
    assert.equal(body.value, 'look i m g : 1 [img:1]');
    app.q<HTMLButtonElement>('.pend-thumb .pend-x')!.click();
    await app.flush();
    assert.equal(body.value, 'look i m g : 1', 'the token and its one space go; the letters it is made of stay');
  } finally { await app.close(); }
});

test('a note can be only an image; it posts the ref', async (context) => {
  const app = await mount(context);
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const note = app.q<HTMLTextAreaElement>('.note-input')!;
    await app.paste(note);
    assert.equal(note.value, '[img:1]');
    note.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await app.flush();
    assert.equal(app.calls.notes.length, 1);
    assert.match(app.calls.notes[0].body, new RegExp(`^${REF.source}$`, 'u'));
    assert.equal(app.q('.pend-thumb'), null, 'persisted: the chip is gone');
  } finally { await app.close(); }
});

test('an upload for issue A that lands after switching to B never enters B', async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const app = await mount(context, { upload: () => gate.then(() => ({})) });
  try {
    const cards = () => [...app.document.querySelectorAll<HTMLButtonElement>('.card')];
    cards()[0]!.click(); await app.flush();
    await app.paste(app.q<HTMLTextAreaElement>('.d-body-edit')!);
    // Leaving A asks (an upload is unsaved work); discard, then open B.
    assert.equal(app.back(), true); await app.flush();
    app.q<HTMLButtonElement>('.dlg-actions button:last-child')!.click(); await app.flush();
    cards()[1]!.click(); await app.flush();
    assert.equal(app.q<HTMLTextAreaElement>('.d-body-edit')!.value, 'Body B');
    release(); await app.flush();
    assert.equal(app.q<HTMLTextAreaElement>('.d-body-edit')!.value, 'Body B', 'the old job did not write into B');
    assert.equal(app.q('.pend-thumb'), null, 'nor add its chip');
    assert.equal(app.q<HTMLButtonElement>('.note-add .icon-btn.go')!.disabled, true, 'nor hold B\u2019s note closed (its finally released only its own job)');
  } finally { release(); await app.close(); }
});

test('saved images render through ChatImage in an editable issue; the Lightbox closes before the detail', async (context) => {
  const withImg = { ...issueA, body: 'Before\n![](/work/fixture/.tmm/uploads/a-12345678.webp)\nAfter', notes: [{ author: 'bob', body: 'note ![](/work/fixture/.tmm/uploads/b-12345678.webp)', at: 100 }, { author: 'carol', body: 'one\n\n\n\ntwo', at: 101 }] };
  const plain = { ...issueB, body: '  verbatim\n\n\n  body  ', editable: false };
  const app = await mount(context, { issues: [withImg, plain] });
  try {
    const cards = () => [...app.document.querySelectorAll<HTMLButtonElement>('.card')];
    assert.match(cards()[0]!.querySelector('.c-body')!.textContent ?? '', /^Before\s+After$/u, 'the card preview drops the ref');
    assert.ok(!(cards()[0]!.textContent ?? '').includes('.tmm/uploads'), 'no path on a card');
    cards()[0]!.click(); await app.flush();
    const shots = app.document.querySelectorAll('.shots');
    assert.equal(shots.length, 2, 'the body\u2019s and the note\u2019s images, each in the feed\u2019s strip');
    assert.ok(!app.q('.n-text')!.textContent!.includes('.tmm/uploads'), 'the note shows its text, the image below');
    assert.equal(app.document.querySelectorAll('.n-text')[1]!.textContent, 'one\n\n\n\ntwo', 'a note without images keeps its blank lines');
    app.document.querySelector<HTMLButtonElement>('.shots .ci-link, .shots button')!.click();
    await app.flush();
    assert.ok(app.q('.lightbox, .lb, [class*="light"]'), 'the shared viewer opened');
    assert.equal(app.back(), true); await app.flush();
    assert.equal(app.q('.lightbox, .lb, [class*="light"]'), null, 'Back closed the viewer');
    assert.ok(app.q('.detail'), '…and only the viewer: the detail stays');
    assert.equal(app.back(), true); await app.flush();
    cards()[1]!.click(); await app.flush();
    assert.equal(app.q('.d-body-static')!.textContent, '  verbatim\n\n\n  body  ', 'a body without images is shown byte-for-byte');
  } finally { await app.close(); }
});

test('a failed save keeps the staged image for the retry: one upload, the same ref saved', async (context) => {
  let fail = true;
  const app = await mount(context, { save: async () => { if (fail) { fail = false; throw new Error('db busy'); } } });
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit')!;
    await app.type(body, 'Body A ');
    await app.paste(body);
    const ok = () => [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!;
    ok().click(); await app.flush();
    assert.ok(app.q('.err'), 'the failure is shown');
    assert.ok(app.q('.pend-thumb'), 'the staged image is still there');
    assert.equal(body.value, 'Body A [img:1]', 'and its token');
    ok().click(); await app.flush();
    assert.equal(app.calls.uploads.length, 1, 'no second upload');
    assert.equal(app.calls.saves.length, 2);
    assert.equal(app.calls.saves[0].body, app.calls.saves[1].body, 'the retry saves the same text');
    assert.match(app.calls.saves[1].body, REF);
  } finally { await app.close(); }
});

test('deleting an issue drops its staged images; the next issue starts clean', async (context) => {
  const app = await mount(context, { });
  try {
    const cards = () => [...app.document.querySelectorAll<HTMLButtonElement>('.card')];
    cards()[0]!.click(); await app.flush();
    await app.paste(app.q<HTMLTextAreaElement>('.d-body-edit')!);
    assert.ok(app.q('.pend-thumb'));
    app.q<HTMLButtonElement>('[aria-label="Delete issue"]')!.click(); await app.flush();
    app.q<HTMLButtonElement>('.dlg-actions button:last-child')!.click(); await app.flush();
    cards()[cards().length - 1]!.click(); await app.flush();
    assert.ok(app.q('.d-body-edit'), 'another issue is open');
    assert.equal(app.q('.pend-thumb'), null, 'no chip from the deleted issue');
  } finally { await app.close(); }
});

test('a server switch asks the Board through the real leave walk; cancel keeps the image note, confirm leaves', async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const app = await mount(context, { upload: () => gate.then(() => ({})) });
  try {
    assert.equal(guardsSeen.length, 1, 'the Board registered its guard');
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const note = app.q<HTMLTextAreaElement>('.note-input')!;
    await app.type(note, 'see ');
    await app.paste(note); // still uploading
    let answer = walk();
    await app.flush();
    assert.ok(app.q('[role=alertdialog]'), 'the Board\u2019s own discard confirm asks');
    app.q<HTMLButtonElement>('.dlg-actions button:first-child')!.click(); // keep editing
    assert.equal(await answer, false, 'cancel: the switch is refused');
    release(); await app.flush();
    assert.equal(note.value, 'see [img:1]', 'nothing lost: text and token');
    assert.ok(app.q('.pend-thumb'), 'and the chip');
    answer = walk(); await app.flush();
    app.q<HTMLButtonElement>('.dlg-actions button:last-child')!.click();
    assert.equal(await answer, true, 'confirm: the switch may go');
  } finally { release(); await app.close(); }
});

test('a failed chip alone is unsaved work to the switch', async (context) => {
  const app = await mount(context, { upload: async () => { throw new Error('disk full'); } });
  try {
    [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''))?.click();
    await app.flush();
    await app.paste(app.q<HTMLTextAreaElement>('.d-body-edit.fill')!);
    assert.ok(app.q('.pend-chip.err'));
    const answer = walk(); await app.flush();
    assert.ok(app.q('[role=alertdialog]'), 'asked');
    app.q<HTMLButtonElement>('.dlg-actions button:first-child')!.click();
    assert.equal(await answer, false);
    assert.ok(app.q('.pend-chip.err'), 'kept');
  } finally { await app.close(); }
});

test('while a save runs its editors are locked and nothing navigates; the answer acts on the frozen issue', async (context) => {
  let release!: () => void;
  const app = await mount(context, { agents: [{ name: 'alice', managed: true, state: 'idle', agent: 'kiro' }], save: (patch) => patch.body ? new Promise<void>((r) => { release = r; }) : Promise.resolve() });
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit')!;
    await app.type(body, 'Body A edited ');
    await app.paste(body);
    const save = () => [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!;
    save().click(); await app.flush();
    assert.equal(body.readOnly, true, 'the body editor is locked while its request runs');
    assert.equal(app.back(), true, 'Back is consumed…');
    await app.flush();
    assert.ok(app.q('.d-body-edit'), '…and the detail stays: nothing navigates under a request');
    assert.equal(app.q('[role=alertdialog]'), null, 'no discard question over a running save');
    const note = app.q<HTMLTextAreaElement>('.note-input')!;
    assert.equal(note.readOnly, true, 'the note editor is locked too');
    release(); await app.flush();
    assert.deepEqual(app.calls.saves.map((x) => [x.session, x.id]), [['fixture', 1]], 'the frozen session and issue');
    assert.match(app.calls.saves[0].body, REF);
    assert.equal(app.q('.d-body-edit'), null, 'then the ✓ closes the detail');
  } finally { release?.(); await app.close(); }
});

test('a body Save leaves the note draft alone: the detail stays, the note text and image remain submittable', async (context) => {
  const app = await mount(context);
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    await app.type(app.q<HTMLTextAreaElement>('.d-body-edit')!, 'Body A changed');
    const note = app.q<HTMLTextAreaElement>('.note-input')!;
    await app.type(note, 'my note ');
    await app.paste(note);
    [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!.click();
    await app.flush();
    assert.equal(app.calls.saves.length, 1);
    assert.equal(app.calls.saves[0].body, 'Body A changed');
    assert.ok(app.q('.note-input'), 'the detail stays');
    assert.equal(app.q<HTMLTextAreaElement>('.note-input')!.value, 'my note [img:1]', 'the note text and token');
    assert.ok(app.q('.pend-thumb'), 'and its chip');
    app.q<HTMLButtonElement>('.note-add .icon-btn.go')!.click(); await app.flush();
    assert.equal(app.calls.notes.length, 1, 'the note still goes');
    assert.match(app.calls.notes[0].body, /^my note !\[\]\(/u);
  } finally { await app.close(); }
});

test('after a confirmed leave of A, B carries none of A\u2019s note text or token', async (context) => {
  const app = await mount(context);
  try {
    const cards = () => [...app.document.querySelectorAll<HTMLButtonElement>('.card')];
    cards()[0]!.click(); await app.flush();
    const note = app.q<HTMLTextAreaElement>('.note-input')!;
    await app.type(note, 'A note ');
    await app.paste(note);
    assert.equal(app.back(), true); await app.flush();
    app.q<HTMLButtonElement>('.dlg-actions button:last-child')!.click(); await app.flush();
    cards()[1]!.click(); await app.flush();
    assert.equal(app.q<HTMLTextAreaElement>('.note-input')!.value, '', 'no A text');
    assert.equal(app.q('.pend-thumb'), null, 'no A chip');
  } finally { await app.close(); }
});

test('a save answered after the page was destroyed (server switch) sends no brief to the new server', async (context) => {
  let release!: () => void;
  const app = await mount(context, {
    agents: [{ name: 'alice', managed: true, state: 'idle', agent: 'kiro' }],
    save: (patch) => (patch.title ? new Promise<void>((r) => { release = r; }) : Promise.resolve()),
  });
  app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
  const title = app.q<HTMLInputElement>('.d-title-input')!;
  title.value = 'A renamed'; title.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
  // Assign alice in the draft (the Select writes draft.assignee).
  const pick = app.q<HTMLButtonElement>('.detail .sel-trigger, .detail [aria-haspopup="listbox"]');
  pick?.click(); await app.flush();
  [...app.document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('alice'))?.click();
  await app.flush();
  [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!.click();
  await app.flush();
  assert.deepEqual(app.calls.saves.map((x) => [x.session, x.id, x.title]), [['fixture', 1, 'A renamed']]);
  await app.close(); // the switch destroys the page mid-request
  release();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(app.calls.saves.length, 1, 'no assignee write after the page is gone');
  assert.equal(app.calls.posts.length, 0, 'no brief typed into a pane from a dead context');
});

test('removing one of two tokens removes only it; a file token too', async (context) => {
  const app = await mount(context);
  try {
    [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''))?.click();
    await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit.fill')!;
    await app.type(body, 'a ');
    await app.paste(body);
    await app.type(body, body.value + ' b ');
    const file = new app.window.File(['x'], 'log.txt', { type: 'text/plain' });
    const ev = new app.window.Event('paste', { bubbles: true, cancelable: true }) as any;
    ev.clipboardData = { items: [{ kind: 'file', getAsFile: () => file }], files: [file], getData: () => '' };
    body.dispatchEvent(ev); await app.flush(); await app.flush();
    assert.equal(body.value, 'a [img:1] b [file:2]');
    app.q<HTMLButtonElement>('.pend-thumb .pend-x')!.click(); await app.flush();
    assert.equal(body.value, 'a b [file:2]', 'only the image token');
    app.q<HTMLButtonElement>('.pend-chip .pend-x')!.click(); await app.flush();
    assert.equal(body.value, 'a b', 'then the file token');
  } finally { await app.close(); }
});

test('after a body save with images, the draft holds refs (not orphan tokens) and a later save keeps them', async (context) => {
  const a = { ...issueA, notes: [] };
  const app = await mount(context, { issues: [a, issueB], stateful: true });
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit')!;
    await app.type(body, 'Body A ');
    await app.paste(body);
    await app.type(app.q<HTMLTextAreaElement>('.note-input')!, 'pending note'); // the note keeps the detail open
    const save = () => [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!;
    save().click(); await app.flush();
    const stored = app.calls.saves[0].body;
    assert.match(stored, REF);
    assert.equal(app.q<HTMLTextAreaElement>('.d-body-edit')!.value, stored, 'the draft shows the stored ref — no orphan [img:1]');
    assert.ok(!app.q<HTMLTextAreaElement>('.d-body-edit')!.value.includes('[img:'), 'and no token is left to be re-sent');
    // Another edit (status), saved: the body ref survives.
    [...app.document.querySelectorAll<HTMLButtonElement>('.seg-b')].find((b) => b.textContent === 'Doing')!.click(); await app.flush();
    save().click(); await app.flush();
    assert.equal(app.calls.saves.length, 2);
    assert.equal(app.calls.saves[1].body, undefined, 'the body is not re-sent');
    assert.equal(a.body, stored, 'the stored body still has its image');
    assert.equal(app.q<HTMLTextAreaElement>('.note-input')!.value, 'pending note', 'the note was never part of either save');
  } finally { await app.close(); }
});

test('while a save or create runs, NOTHING of its draft can change: title, status, assignee, chip ✕', async (context) => {
  let release!: () => void;
  const app = await mount(context, { agents: [{ name: 'alice', managed: true, state: 'idle', agent: 'kiro' }], save: () => new Promise<void>((r) => { release = r; }) });
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const body = app.q<HTMLTextAreaElement>('.d-body-edit')!;
    await app.type(body, 'x ');
    await app.paste(body);
    [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!.click();
    await app.flush();
    const title = app.q<HTMLInputElement>('.d-title-input')!;
    assert.equal(title.readOnly, true, 'title');
    const doing = [...app.document.querySelectorAll<HTMLButtonElement>('.seg-b')].find((b) => b.textContent === 'Doing')!;
    assert.equal(doing.disabled, true, 'status stops');
    doing.click(); await app.flush();
    assert.ok(!doing.classList.contains('on'), 'a click does not move the status');
    assert.ok(app.document.querySelector('.detail .d-meta button[disabled], .detail [aria-haspopup][disabled], .detail .sel[aria-disabled="true"]'), 'the assignee picker is disabled');
    app.q<HTMLButtonElement>('.pend-thumb .pend-x')!.click(); await app.flush();
    assert.ok(app.q('.pend-thumb'), 'the chip ✕ does nothing');
    assert.equal(body.value, 'x [img:1]', 'and the token stays');
    release(); await app.flush();
  } finally { release?.(); await app.close(); }
});

test('a viewer answer opens only for the LATEST tap in its own issue: A→B, A→B→A and two taps in one issue', async (context) => {
  const pending: Array<{ path: string; done: (v: { url: string }) => void }> = [];
  const img = (n: string) => `![](/work/fixture/.tmm/uploads/${n}-12345678.webp)`;
  const a = { ...issueA, body: `${img('a1')}\n${img('a2')}` };
  const b = { ...issueB, body: img('b1') };
  const app = await mount(context, { issues: [a, b], download: (path) => new Promise((done) => pending.push({ path, done })) });
  const lb = () => app.q<HTMLImageElement>('.lb img');
  const cards = () => [...app.document.querySelectorAll<HTMLButtonElement>('.card')];
  const tap = async (k = 0) => { app.document.querySelectorAll<HTMLButtonElement>('.shots .ci-link')[k]!.click(); await app.flush(); };
  const answer = async (i: number) => { const p = pending[i]!; p.done({ url: `https://dl.test/${p.path.split('/').pop()}` }); await app.flush(); };
  try {
    // A: two taps, answered out of order — only the second opens.
    cards()[0]!.click(); await app.flush();
    pending.length = 0; // the thumbnails' own signatures (answered or not, they are not taps)
    await tap(0); await tap(1);
    const [first, second] = [pending.length - 2, pending.length - 1];
    await answer(second);
    assert.match(lb()!.src, /a2-/u, 'the latest tap opens');
    await answer(first);
    assert.match(lb()!.src, /a2-/u, 'an older tap answering late does not replace it');
    // A→B: A tapped, B opened and tapped; A's late answer must not open over B.
    assert.equal(app.back(), true); await app.flush(); // close the viewer
    await tap(0);
    const aTap = pending.length - 1;
    assert.equal(app.back(), true); await app.flush(); // leave A
    cards()[1]!.click(); await app.flush();
    await tap(0);
    const bTap = pending.length - 1;
    await answer(aTap);
    assert.equal(lb(), null, 'A\u2019s answer is not B\u2019s');
    await answer(bTap);
    assert.match(lb()!.src, /b1-/u);
    // B→A: back on A, B's earlier claim cannot open anything there.
    assert.equal(app.back(), true); await app.flush();
    await tap(0); const b2 = pending.length - 1;
    assert.equal(app.back(), true); await app.flush();
    cards()[0]!.click(); await app.flush();
    await answer(b2);
    assert.equal(lb(), null, 'back on A: a tap made on B opens nothing');
  } finally { for (const p of pending) p.done({ url: 'https://dl.test/x' }); await app.close(); }
});

test('a picker opened in one create form delivers nothing into the next one', async (context) => {
  const app = await mount(context);
  try {
    const open = async () => { [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''))?.click(); await app.flush(); };
    await open();
    app.q<HTMLButtonElement>('.attach-line button')!.click(); // opens the picker for THIS form
    assert.equal(app.back(), true); await app.flush(); // the clean form closes
    await open();
    const picker = app.document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, 'files', { value: [new app.window.File(['x'], 'shot.png', { type: 'image/png' })] });
    picker.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await app.flush();
    assert.equal(app.calls.uploads.length, 0, 'nothing uploaded into the new form');
    assert.equal(app.q('.pend-thumb'), null);
  } finally { await app.close(); }
});

test('the walk reveals a hidden Board before it asks, and a destroyed Board unregisters', async (context) => {
  const revealed: string[] = [];
  const app = await mount(context);
  app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
  await app.type(app.q<HTMLTextAreaElement>('.note-input')!, 'unsent');
  const asked = confirmLeave({ leaving: guardsSeen[0]!.runtime, current: 'terminal', reveal: async (p) => { revealed.push(p); }, hold: () => {} });
  await app.flush();
  assert.deepEqual(revealed, ['board'], 'its own page is revealed first');
  app.q<HTMLButtonElement>('.dlg-actions button:first-child')!.click();
  assert.equal(await asked, false);
  assert.deepEqual(revealed, ['board', 'terminal'], 'and the user is put back');
  // Destroyed: the walk no longer reaches it (the cleanup removes it).
  await app.close();
  const owner = guardsSeen[0]!.runtime;
  for (const g of guardsSeen) unregister(g);
  assert.equal(await confirmLeave({ leaving: owner, current: 'terminal', reveal: async () => {}, hold: () => {} }), true, 'nothing left to ask');
});

test('a note in flight holds the project: a pick waits, and the answer lands on the board it was written on', async (context) => {
  let release!: () => void;
  const app = await mount(context, { projects: ['fixture', 'other'], note: () => new Promise<void>((r) => { release = r; }) });
  const current = () => app.document.querySelector('.proj-row.open .p-name')?.textContent;
  const pickOther = async () => {
    [...app.document.querySelectorAll<HTMLButtonElement>('button.proj-row')].find((r) => r.querySelector('.p-name')?.textContent === 'other')!.click();
    await app.flush();
    // A user who would discard: confirm any question that appears.
    app.q<HTMLButtonElement>('[role=alertdialog] .dlg-actions button:last-child')?.click();
    await app.flush();
  };
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    await app.type(app.q<HTMLTextAreaElement>('.note-input')!, 'for fixture');
    app.q<HTMLButtonElement>('.note-add .icon-btn.go')!.click(); await app.flush();
    await pickOther();
    assert.equal(current(), 'fixture', 'no switch under a running note — not even through the discard question');
    release(); await app.flush();
    assert.deepEqual(app.calls.notes.map((n) => [n.session, n.id, n.body]), [['fixture', 1, 'for fixture']]);
    assert.equal(app.q<HTMLTextAreaElement>('.note-input')!.value, '', 'answered on its own board: its box clears');
    await pickOther();
    assert.equal(current(), 'other', 'after the answer the pick goes');
    assert.equal(app.q('.detail'), null, 'and no issue of the old board is painted into the new one');
  } finally { release?.(); await app.close(); }
});

// Board #348: the detail editor saves from the keyboard with the chord the
// create form already speaks (board #36). The same guarded saveDraft the ✓
// runs, so every refusal of the button is a refusal of the chord.
const chord = (app: { window: any }, el: Element, init: Record<string, unknown> = { metaKey: true }) => {
  const ev = new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev as KeyboardEvent;
};

test('Cmd+Enter in the detail body saves it like ✓ and the detail closes; Ctrl+Enter in the title saves the title (board #348)', async (context) => {
  const body = await mount(context, { stateful: true });
  try {
    body.q<HTMLButtonElement>('.card')!.click(); await body.flush();
    await body.type(body.q<HTMLTextAreaElement>('.d-body-edit')!, 'Edited body');
    const ev = chord(body, body.q('.d-body-edit')!, { metaKey: true });
    await body.flush();
    assert.equal(ev.defaultPrevented, true, 'the chord is consumed, no stray newline');
    assert.deepEqual(body.calls.saves, [{ id: 1, body: 'Edited body', session: 'fixture' }], 'exactly the changed field, saved once');
    assert.equal(body.q('.d-body-edit'), null, 'saved: back to the board, as ✓ does');
  } finally { await body.close(); }
  const title = await mount(context, { stateful: true });
  try {
    title.q<HTMLButtonElement>('.card')!.click(); await title.flush();
    await title.type(title.q<HTMLTextAreaElement>('.d-title-input') as unknown as HTMLTextAreaElement, 'Edited title');
    chord(title, title.q('.d-title-input')!, { ctrlKey: true });
    await title.flush();
    assert.deepEqual(title.calls.saves, [{ id: 1, title: 'Edited title', session: 'fixture' }]);
  } finally { await title.close(); }
});

test('the detail chord obeys ✓: nothing changed, a bare/Shift Enter, an IME Enter, a contentless draft and an upload in flight all save nothing (board #348)', async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const app = await mount(context, { stateful: true, upload: () => gate.then(() => ({})) });
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const bodyEl = () => app.q<HTMLTextAreaElement>('.d-body-edit')!;
    const titleEl = () => app.q<HTMLTextAreaElement>('.d-title-input') as unknown as HTMLTextAreaElement;
    chord(app, bodyEl()); await app.flush();
    assert.equal(app.calls.saves.length, 0, 'an unchanged draft has nothing to save');
    await app.type(bodyEl(), 'Changed');
    const bare = chord(app, bodyEl(), {}); await app.flush();
    assert.equal(bare.defaultPrevented, false, 'a bare Enter is still a newline');
    chord(app, bodyEl(), { shiftKey: true }); chord(app, bodyEl(), { metaKey: true, isComposing: true }); await app.flush();
    assert.equal(app.calls.saves.length, 0, 'Shift+Enter and an IME composition\u2019s Enter never save');
    await app.type(bodyEl(), ''); await app.type(titleEl(), '');
    chord(app, bodyEl()); chord(app, titleEl()); await app.flush();
    assert.equal(app.calls.saves.length, 0, 'a contentless draft is as unsavable by the keyboard as by the button');
    await app.type(titleEl(), 'A'); await app.type(bodyEl(), 'Body A ');
    await app.paste(bodyEl());
    assert.equal(app.q<HTMLButtonElement>('.detail button[aria-label="Save"]')!.disabled, true, 'the button is closed while it uploads');
    chord(app, bodyEl()); await app.flush();
    assert.equal(app.calls.saves.length, 0, 'and so is the chord');
    release(); await app.flush();
    chord(app, bodyEl()); await app.flush();
    assert.equal(app.calls.saves.length, 1, 'once the upload landed the same chord saves');
    assert.match(app.calls.saves[0].body, REF);
  } finally { release(); await app.close(); }
});

// ── Board #377: the hand-off is the SERVER's. The page saves ONCE (asking for
// the hand-off), reads how the telling went from the answer, and never posts a
// brief of its own. These drive the real Board against a server that answers
// `dispatch: "failed"` — the save landed, the post did not — and one whose
// login answer lacks `board_dispatch`.
const alice = { name: 'alice', managed: true, state: 'idle', agent: 'kiro' };
const failedHandOff = () => ({ ok: true, id: 9, dispatch: 'failed', dispatch_error: 'the room is full' });
const newIssueButton = (app: { document: Document }) => [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /new/i.test(b.getAttribute('aria-label') ?? b.title ?? ''));
async function pickAlice(app: { q: <E extends Element>(s: string) => E | null; document: Document; flush: () => Promise<void> }, scope: string) {
  app.q<HTMLButtonElement>(`${scope} .sel-trigger, ${scope} [aria-haspopup="listbox"]`)!.click(); await app.flush();
  [...app.document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.includes('alice'))!.click();
  await app.flush();
}

test('a create with an assignee is ONE request; a hand-off that failed is reported after the form has closed, and nothing can file it twice (board #377)', async (context) => {
  const app = await mount(context, { agents: [alice], answer: failedHandOff });
  try {
    newIssueButton(app)!.click(); await app.flush();
    await app.type(app.q<HTMLTextAreaElement>('.n-title')!, 'Ship it');
    await pickAlice(app, '.detail');
    app.q<HTMLButtonElement>('.detail .icon-btn.go')!.click();
    for (let i = 0; i < 5; i++) await app.flush();
    assert.deepEqual(app.calls.saves, [{ title: 'Ship it', body: '', assignee: 'alice', dispatch: true, session: 'fixture' }], 'one request: the issue, its assignee, and the ask');
    assert.equal(app.calls.posts.length, 0, 'the page posts no brief of its own');
    assert.equal(app.q('.n-title'), null, 'the issue EXISTS, so the form is gone: there is nothing to retry');
    assert.match(app.q('.err')?.textContent ?? '', /#9: Saved, but alice was not told: the room is full/u, 'the failed hand-off is its own line');
  } finally { await app.close(); }
});

test('an edit that assigns saves once; a failed hand-off keeps the detail, rebased on what was saved, and a second ✓ sends nothing (board #377)', async (context) => {
  const app = await mount(context, { agents: [alice], stateful: true, answer: failedHandOff });
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const title = app.q<HTMLInputElement>('.d-title-input')!;
    title.value = 'A renamed'; title.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    await pickAlice(app, '.detail');
    const save = () => [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!.click();
    save();
    for (let i = 0; i < 5; i++) await app.flush();
    assert.deepEqual(app.calls.saves, [{ id: 1, title: 'A renamed', assignee: 'alice', dispatch: true, session: 'fixture' }], 'title and assignee in the SAME request');
    assert.equal(app.calls.posts.length, 0);
    assert.ok(app.q('.detail'), 'the detail stays open: the hand-off needs saying');
    assert.match(app.q('.err')?.textContent ?? '', /alice was not told: the room is full/u);
    assert.equal(app.q<HTMLInputElement>('.d-title-input')!.value, 'A renamed', 'and the draft is the saved text');
    save(); await app.flush();
    assert.equal(app.calls.saves.length, 1, 'nothing is dirty, so nothing is sent again (and no second issue is ever filed)');
  } finally { await app.close(); }
});

test('an edit that does not touch the assignee asks for no hand-off (board #377)', async (context) => {
  const app = await mount(context, { agents: [alice], stateful: true });
  try {
    app.q<HTMLButtonElement>('.card')!.click(); await app.flush();
    const title = app.q<HTMLInputElement>('.d-title-input')!;
    title.value = 'Just a rename'; title.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.detail button')].find((b) => b.getAttribute('aria-label') === 'Save')!.click();
    for (let i = 0; i < 5; i++) await app.flush();
    assert.deepEqual(app.calls.saves, [{ id: 1, title: 'Just a rename', session: 'fixture' }], 'no assignee, no dispatch flag: a plain edit never re-sends a hand-off');
  } finally { await app.close(); }
});

test('against a server whose login lacks board_dispatch the pickers are disabled and say why; an unanswered login is not a refusal (board #377)', async (context) => {
  const disabledPicker = '.detail .d-meta button[disabled], .detail [aria-haspopup][disabled], .detail .sel[aria-disabled="true"]';
  // The detail of an issue, on an older server.
  const old = await mount(context, { agents: [alice], caps: [] });
  try {
    old.q<HTMLButtonElement>('.card')!.click(); await old.flush();
    assert.ok(old.q(disabledPicker), 'the detail picker is disabled');
    assert.match(old.q('.detail .meta-bit')?.textContent ?? '', /older than the app/u, 'and says why');
  } finally { await old.close(); }
  // The create dialog, on an older server.
  const oldCreate = await mount(context, { agents: [alice], caps: [] });
  try {
    newIssueButton(oldCreate)!.click(); await oldCreate.flush();
    assert.ok(oldCreate.q(disabledPicker), 'the create picker is disabled');
    assert.match(oldCreate.q('.detail .meta-bit')?.textContent ?? '', /older than the app/u);
  } finally { await oldCreate.close(); }
  // A login that has not answered yet says nothing about the server.
  const unknown = await mount(context, { agents: [alice], caps: undefined });
  try {
    unknown.q<HTMLButtonElement>('.card')!.click(); await unknown.flush();
    assert.equal(unknown.q(disabledPicker), null, 'an unanswered question is not a no');
    assert.doesNotMatch(unknown.q('.detail')?.textContent ?? '', /older than the app/u, 'and no complaint');
  } finally { await unknown.close(); }
});

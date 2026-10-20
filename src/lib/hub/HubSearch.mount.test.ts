// The Hub's search box on screen (board #432): it opens over the header row,
// leaves the composer's draft alone, lists newest first with the match marked,
// keeps old results honestly labelled when a request fails, and collapses by
// the whole region's focus, not by its input's blur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./HubSearch.test.svelte', import.meta.url), []);
const hit = (n: number, over: Record<string, unknown> = {}) => ({ id: `m${n}`, seq: n, ts: Date.UTC(2026, 9, 20, 8, n), from: 'kiro', room: 'proj:a', body: `deploy staging ${n}`, ...over });

type Asked = { terms: string[]; scope: string; agent: string; limit: number };
function scripted(answers: (req: Asked, n: number) => unknown) {
  const asked: Asked[] = [];
  return { asked, ask: (req: Asked) => { asked.push(req); const out = answers(req, asked.length); return out instanceof Error ? Promise.reject(out) : Promise.resolve(out); } };
}
async function settle(app: { flush(): Promise<void> }, rounds = 6) { for (let i = 0; i < rounds; i++) await app.flush(); }

async function open(context: any, ask: (r: Asked) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const app = await (await compiled).mount(context, { props: { ask, ...extra }, modules: [] });
  const $ = <T extends Element = HTMLElement>(sel: string) => app.document.querySelector<T>(sel);
  const type = async (text: string) => {
    const input = $<HTMLInputElement>('.search-input')!;
    input.value = text;
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await settle(app);
  };
  const press = (target: Element, key: string, init: Record<string, unknown> = {}) =>
    target.dispatchEvent(new app.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  // A control by its visible text or accessible name: the head holds a mode switch as well as the scope and Retry buttons.
  const button = (label: string) => [...app.document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
  return { app, $, type, press, button };
}

test('it opens over the header row, takes focus, and the draft is left alone; Escape closes and gives focus back', async (context) => {
  const { asked, ask } = scripted(() => ({ messages: [hit(1)] }));
  const { app, $, type, press } = await open(context, ask);
  try {
    const draft = $<HTMLTextAreaElement>('.draft')!;
    draft.value = 'half a messa|ge';
    draft.focus();
    draft.setSelectionRange(6, 6);
    assert.equal($('.search-bar'), null, 'closed at rest');

    // Opened the way the header does it: a click on the button, which holds focus.
    $<HTMLButtonElement>('.opener')!.focus();
    $<HTMLButtonElement>('.opener')!.click();
    await settle(app);
    const bar = $('.search-bar')!;
    assert.ok(bar, 'the bar is there');
    assert.ok(bar.classList.contains('appear'), 'it enters with the shared fade, not a width animation');
    assert.equal(app.document.activeElement, $('.search-input'), 'the field takes focus');
    assert.equal(app.document.querySelector('.search-bar')?.getAttribute('role'), 'search');

    await type('deploy staging');
    assert.equal(draft.value, 'half a messa|ge', 'typing in the box never touches the draft');
    assert.equal(asked.length, 1);

    draft.focus();                                    // the user goes back to writing
    assert.equal($('.search-bar') !== null, true, 'a typed query does not collapse on blur');
    $<HTMLInputElement>('.search-input')!.focus();
    press($<HTMLInputElement>('.search-input')!, 'Escape');
    await settle(app);
    assert.equal($('.search-bar'), null, 'Escape collapses');
    assert.equal($('.search-panel'), null);
    assert.equal(draft.value, 'half a messa|ge');
    assert.equal(draft.selectionStart, 6, 'the caret is where it was');
    assert.equal(app.document.activeElement, $('.opener'), 'focus returns to what held it when the box opened');
  } finally { await app.close(); }
});

test('rows are newest first, the match is marked as text, and a hit in another room names its project', async (context) => {
  const { asked, ask } = scripted(() => ({
    messages: [hit(1, { body: 'old <b>deploy</b> note', from: 'builder-2' }), hit(2, { room: 'proj:b' }), hit(3)],
    more: true,
  }));
  const { app, button, $, type } = await open(context, ask);
  try {
    (app.window as any).__search.show();
    await settle(app);
    await type('deploy');
    const rows = [...app.document.querySelectorAll('.sr-row')];
    assert.deepEqual(rows.map((r) => r.querySelector('.sr-text')?.textContent), ['deploy staging 3', 'deploy staging 2', 'old <b>deploy</b> note'], 'newest first');
    assert.equal(rows[2]!.querySelector('.sr-text b'), null, 'a message body is text, never markup');
    assert.deepEqual([...rows[0]!.querySelectorAll('mark')].map((m) => m.textContent), ['deploy'], 'the match is marked');
    assert.equal(rows[0]!.querySelector('.sr-project'), null, 'this room: no project tag');
    assert.match($('.sr-more')?.textContent ?? '', /newest 3/u, 'older hits exist and the list says so');

    button('All rooms')!.click();
    await settle(app);
    assert.equal(asked.at(-1)!.scope, 'all');
    const tagged = [...app.document.querySelectorAll('.sr-row')].map((r) => r.querySelector('.sr-project')?.textContent);
    assert.deepEqual(tagged, ['P:proj:a', 'P:proj:b', 'P:proj:a'], 'a hit names its project when every room is searched');
  } finally { await app.close(); }
});

test('a row tap hands the hit to the jump; the box stays until the jump reports', async (context) => {
  const jumped: unknown[] = [];
  const { ask } = scripted(() => ({ messages: [hit(1), hit(2)] }));
  const { app, $, type } = await open(context, ask, { onjump: (h: unknown) => jumped.push(h) });
  try {
    (app.window as any).__search.show();
    await settle(app);
    await type('deploy');
    app.document.querySelectorAll<HTMLButtonElement>('.sr-row')[1]!.click();
    assert.equal(jumped.length, 1);
    assert.equal((jumped[0] as any).id, 'm1', 'the second row of a newest-first list is the older hit');
    assert.ok($('.search-bar'), 'the box does not close itself on a tap: the jump decides');
  } finally { await app.close(); }
});

test('a failed request keeps the old rows, names the query they answered, and Retry asks again', async (context) => {
  let call = 0;
  const { asked, ask } = scripted(() => { call += 1; return call === 2 ? new Error('boom') : { messages: [hit(call)] }; });
  const { app, button, $, type } = await open(context, ask);
  try {
    (app.window as any).__search.show();
    await settle(app);
    await type('deploy');
    assert.equal(app.document.querySelectorAll('.sr-row').length, 1);
    await type('deploy staging');
    assert.match($('.sr-status')?.textContent ?? '', /The search failed/u, 'an error, not "No matches"');
    assert.equal(app.document.querySelectorAll('.sr-row').length, 1, 'the previous answer is still there');
    assert.match($('.sr-label')?.textContent ?? '', /“deploy”/u, 'and labelled with the query it answered');
    button('Retry')!.click();
    await settle(app);
    assert.equal(asked.length, 3);
    assert.equal($('.sr-label'), null, 'a current answer carries no label');
  } finally { await app.close(); }
});

test('really nothing matching says so; it is not the error line', async (context) => {
  const { ask } = scripted(() => ({ messages: [] }));
  const { app, $, type } = await open(context, ask);
  try {
    (app.window as any).__search.show();
    await settle(app);
    await type('zzz');
    assert.match($('.sr-status')?.textContent ?? '', /No matches/u);
    assert.doesNotMatch($('.sr-status')?.textContent ?? '', /failed/u);
  } finally { await app.close(); }
});

test('collapse follows the WHOLE region: an empty box stays while focus moves between its parts, closes when focus leaves them all', async (context) => {
  const { ask } = scripted(() => ({ messages: [hit(1)] }));
  const { app, button, $ } = await open(context, ask);
  try {
    const search = (app.window as any).__search;
    search.show();
    await settle(app);
    const input = $<HTMLInputElement>('.search-input')!;
    input.focus();
    // Tab / mouse from the input to the scope control, then onto the panel itself: real focus moves, all inside.
    const scope = button('All rooms')!;
    scope.focus();
    await app.advance(5);
    assert.equal(search.open, true, 'to the scope control: still open');
    $<HTMLElement>('.search-panel')!.focus();
    await app.advance(5);
    assert.equal(search.open, true, 'to the panel itself: still open');
    input.focus();

    // A press on bare space inside the panel is inside while it is down, wherever focus lands.
    $('.search-panel')!.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
    (app.document.activeElement as HTMLElement).blur();
    await app.advance(5);
    assert.equal(search.open, true, 'a press inside the region is not leaving it');
    $('.search-panel')!.dispatchEvent(new app.window.Event('pointerup', { bubbles: true }));
    input.focus();

    // The window losing focus keeps its focused element: no move, no collapse.
    app.window.dispatchEvent(new app.window.Event('blur'));
    input.dispatchEvent(new app.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    await app.advance(5);
    assert.equal(search.open, true, 'a blurred window keeps the box');

    // Focus really goes elsewhere, query empty: collapse.
    $<HTMLButtonElement>('.outside')!.focus();
    await app.advance(5);
    assert.equal(search.open, false, 'focus left the region with nothing typed: it collapses');
  } finally { await app.close(); }
});

test('a typed query never collapses on blur, and an outside press hides only the results', async (context) => {
  const { ask } = scripted(() => ({ messages: [hit(1)] }));
  const { app, $, type } = await open(context, ask);
  try {
    const search = (app.window as any).__search;
    search.show();
    await settle(app);
    await type('deploy');
    const outside = $<HTMLButtonElement>('.outside')!;
    $<HTMLInputElement>('.search-input')!.focus();
    outside.focus();
    await app.advance(5);
    assert.equal(search.open, true, 'a typed query keeps the box');
    outside.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
    await settle(app);
    assert.equal($('.search-panel'), null, 'an outside press hides the results');
    assert.ok($('.search-bar'), 'the bar stays');
    assert.equal(search.query, 'deploy', 'and so does the query');
    $<HTMLInputElement>('.search-input')!.focus();
    await settle(app);
    assert.ok($('.search-panel'), 'focusing the field brings the results back');
  } finally { await app.close(); }
});

test('Escape is an IME’s while it composes; otherwise it closes, and nothing else on the page sees it', async (context) => {
  const { ask } = scripted(() => ({ messages: [hit(1)] }));
  const { app, $, press } = await open(context, ask);
  try {
    const search = (app.window as any).__search;
    search.show();
    await settle(app);
    const input = $<HTMLInputElement>('.search-input')!;
    press(input, 'Escape', { isComposing: true });
    await settle(app);
    assert.equal(search.open, true, 'an Escape that cancels a composition does not collapse the box');
    let seen = 0;
    app.document.body.addEventListener('keydown', () => { seen += 1; });
    press(input, 'Escape');
    await settle(app);
    assert.equal(search.open, false);
    assert.equal(seen, 0, 'the Escape was consumed here (a dialog behind it must not also close)');
  } finally { await app.close(); }
});

test('the reading filter is a token in the box: named, removable by its x and by Backspace in an empty field, and it labels what it answered (#432)', async (context) => {
  const { asked, ask } = scripted((req) => ({ messages: [hit(req.agent ? 1 : 2)] }));
  const { app, $, type, press } = await open(context, ask);
  try {
    const search = (app.window as any).__search;
    search.show('human');
    await settle(app);
    assert.equal($('.search-token .token-name')?.textContent, 'you', 'the human reads as "you"');
    assert.match($('.sr-status')?.textContent ?? '', /Type to search what you said/u);
    await type('deploy');
    assert.equal(asked.at(-1)!.agent, 'human', 'the request is scoped by the filter');
    assert.equal($('.sr-label'), null, 'a current answer carries no label');

    // The filter changes under a shown answer: the rows stay and say which agent they answered.
    search.setAgent('kiro');
    await settle(app);
    assert.equal($('.search-token .token-name')?.textContent, 'kiro');
    assert.equal(asked.at(-1)!.agent, 'kiro', 'a new scope asks again, at once');
    // Removing it: the x…
    const x = $<HTMLButtonElement>('.search-token button')!;
    x.focus();                                              // a real press focuses the button that is about to be removed
    x.click();
    await settle(app);
    assert.equal(app.document.activeElement, $('.search-input'), 'focus goes back to the field, not to the body the x was removed from');
    assert.equal((app.window as any).__cleared(), 1, 'the x asks the Hub to take the filter off');
    assert.equal($('.search-token'), null, 'and the token goes with it');
    assert.equal(asked.at(-1)!.agent, '', 'everyone again');
    // ... and Backspace in an EMPTY field, only.
    search.setAgent('kiro');
    await settle(app);
    const input = $<HTMLInputElement>('.search-input')!;
    input.value = 'deploy';
    press(input, 'Backspace');
    assert.equal((app.window as any).__cleared(), 1, 'Backspace with text in the field edits the text');
    input.value = '';
    press(input, 'Backspace', { isComposing: true });
    assert.equal((app.window as any).__cleared(), 1, 'an IME’s Backspace inside a composition edits the composition, not the filter');
    press(input, 'Backspace');
    assert.equal((app.window as any).__cleared(), 2, 'Backspace in an empty field takes the token off');
  } finally { await app.close(); }
});

test('the label of rows kept from an earlier scope names the agent they answered (#432)', async (context) => {
  let call = 0;
  const { ask } = scripted(() => ({ messages: [hit(++call)] }));
  const { app, $, type } = await open(context, ask);
  try {
    const search = (app.window as any).__search;
    search.show('kiro');
    await settle(app);
    await type('deploy');
    search.adoptAgent('');                                  // the Hub adopted a filter the jump cleared
    await settle(app);
    assert.match($('.sr-label')?.textContent ?? '', /“deploy” · this room · from kiro/u, 'old rows, labelled with who they were from');
  } finally { await app.close(); }
});

test('more words than the server takes show their own message and no Retry (#432 review)', async (context) => {
  const { asked, ask } = scripted(() => ({ messages: [hit(1)] }));
  const { app, button, $, type } = await open(context, ask);
  try {
    (app.window as any).__search.show();
    await settle(app);
    await type(Array.from({ length: 33 }, (_, n) => `w${n}`).join(' '));
    assert.equal(asked.length, 0);
    assert.match($('.sr-status')?.textContent ?? '', /Too many words: a search takes at most 32/u);
    assert.equal(button('Retry') ?? null, null, 'retrying the same words cannot help');
  } finally { await app.close(); }
});

// ── Files mode (board #432) ─────────────────────────────────────────────────

const fileRow = (path: string, over: Record<string, unknown> = {}) => ({ path, line: null, col: null, room: 'proj:a', id: `i-${path}`, seq: 7, ts: Date.UTC(2026, 9, 20, 8, 5), from: 'kiro', count: 1, ...over });
type FilesReq = { terms: string[]; scope: string; agent: string; limit: number; before: number | null };
function scriptedFiles(answers: (req: FilesReq, n: number) => unknown) {
  const asked: FilesReq[] = [];
  const resolvers: ((v: unknown) => void)[] = [];
  return {
    asked, resolvers,
    askFiles: (req: FilesReq) => {
      asked.push(req);
      const out = answers(req, asked.length);
      if (out === 'hold') return new Promise((resolve) => { resolvers.push(resolve); });
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  };
}

test('Files mode lists the files: name and line, folder, count, who and when, the typed words marked; All rooms names the project (#432)', async (context) => {
  const { ask } = scripted(() => ({ messages: [] }));
  const { askFiles } = scriptedFiles(() => ({
    files: [fileRow('docs/spec/Main.md', { line: 12, col: 3, count: 3 }), fileRow('/srv/out/report.pdf', { room: 'proj:b', from: 'human' })],
    next: null, scanned: 41,
  }));
  const { app, button, $, type } = await open(context, ask, { askFiles });
  try {
    (app.window as any).__search.show();
    await settle(app);
    button('Files')!.click();
    await settle(app);
    const rows = [...app.document.querySelectorAll('.sr-file')];
    assert.equal(rows.length, 2, 'asked at once, no word typed');
    assert.equal(rows[0]!.querySelector('.sr-name')!.textContent, 'Main.md:12:3', 'the name with the line and column the mention carried');
    assert.equal(rows[0]!.querySelector('.sr-dir')!.textContent, 'docs/spec/');
    assert.equal(rows[0]!.querySelector('.sr-count')!.textContent, '×3');
    assert.equal(rows[1]!.querySelector('.sr-count'), null, 'a single mention shows no count');
    assert.equal(rows[0]!.querySelector('.sr-who')!.textContent, 'kiro');
    assert.equal(rows[1]!.querySelector('.sr-who')!.textContent, 'you', 'the human is named the way the filter names them');
    assert.equal(rows[0]!.querySelector('.sr-project'), null, 'this room: no project tag');
    assert.match($('.sr-more')!.textContent ?? '', /41 newest messages that may name a path/u, 'what was read is said, not "all files"');
    assert.equal(button('Read older messages') ?? null, null, 'nothing older: no button');
    // Words narrow the paths and are marked in the folder and the name.
    await type('spec main');
    const marks = [...app.document.querySelectorAll('.sr-file')[0]!.querySelectorAll('mark')].map((m) => m.textContent);
    assert.deepEqual(marks, ['Main', 'spec'], 'the name (drawn first) and the folder');
    button('All rooms')!.click();
    await settle(app);
    assert.equal(app.document.querySelectorAll('.sr-file')[1]!.querySelector('.sr-project')?.textContent, 'P:proj:b', 'with all rooms each row names its project');
  } finally { await app.close(); }
});

test('a file row opens the file and its chat button shows the message; neither closes the box by itself (#432)', async (context) => {
  const { ask } = scripted(() => ({ messages: [] }));
  const { askFiles } = scriptedFiles(() => ({ files: [fileRow('a/b.md', { id: 'm9', seq: 9 })], next: null, scanned: 3 }));
  const opened: any[] = [];
  const jumped: any[] = [];
  const { app, button, $ } = await open(context, ask, { askFiles, onopenfile: (f: unknown) => opened.push(f), onjump: (h: unknown) => jumped.push(h) });
  try {
    (app.window as any).__search.show();
    await settle(app);
    button('Files')!.click();
    await settle(app);
    $<HTMLButtonElement>('.sr-file .sr-row')!.click();
    assert.equal(opened.length, 1);
    assert.equal(JSON.stringify(opened[0]), JSON.stringify(fileRow('a/b.md', { id: 'm9', seq: 9 })), 'the whole row reaches the Hub: its room is what resolves the path');
    assert.equal($('.sr-row')!.getAttribute('aria-label'), 'Open a/b.md');
    button('Show the message that named a/b.md')!.click();
    assert.deepEqual(jumped.map((h) => [h.room, h.id, h.seq]), [['proj:a', 'm9', 9]]);
    assert.equal((app.window as any).__search.open, true, 'opening is the Hub’s act, so the box stays until it has opened');
  } finally { await app.close(); }
});

test('older files: the note offers it, the button reads the next page, a failure is said beside it, and nothing is claimed as complete (#432)', async (context) => {
  const { ask } = scripted(() => ({ messages: [] }));
  const { askFiles, asked, resolvers } = scriptedFiles((req, n) => (n === 1
    ? { files: [fileRow('/a.md', { count: 2 })], next: 50, scanned: 5000 }
    : n === 2 ? new Error('down') : 'hold'));
  const { app, button, $ } = await open(context, ask, { askFiles });
  try {
    (app.window as any).__search.show();
    await settle(app);
    button('Files')!.click();
    await settle(app);
    assert.match($('.sr-more')!.textContent ?? '', /5000 newest messages/u);
    button('Read older messages')!.click();
    await settle(app);
    assert.equal(asked[1]!.before, 50);
    assert.match($('.sr-older-failed')?.textContent ?? '', /Older messages could not be read/u);
    assert.equal(app.document.querySelectorAll('.sr-file').length, 1, 'the rows stay');
    button('Read older messages')!.click();                         // retry: the third answer is held
    await settle(app);
    assert.equal($('.sr-older-failed'), null, 'a retry clears the line');
    assert.equal(button('Reading…')?.disabled, true, 'one request at a time, and the button says so');
    resolvers[0]!({ files: [fileRow('/a.md', { count: 4 }), fileRow('/z.md')], next: null, scanned: 20 });
    await settle(app);
    assert.deepEqual([...app.document.querySelectorAll('.sr-file')].map((r) => [r.querySelector('.sr-name')!.textContent, r.querySelector('.sr-count')?.textContent ?? '']), [['a.md', '×6'], ['z.md', '']]);
    assert.match($('.sr-more')!.textContent ?? '', /5020 newest/u);
    assert.equal(button('Read older messages') ?? null, null, 'the history is read');
  } finally { await app.close(); }
});

test('no file is said as no file, but the cursor still offers older messages when the scan stopped early (#432)', async (context) => {
  const { ask } = scripted(() => ({ messages: [] }));
  const { askFiles } = scriptedFiles(() => ({ files: [], next: 33, scanned: 5000 }));
  const { app, button, $ } = await open(context, ask, { askFiles });
  try {
    (app.window as any).__search.show();
    await settle(app);
    button('Files')!.click();
    await settle(app);
    assert.match($('.sr-status')?.textContent ?? '', /No files named here/u);
    assert.ok(button('Read older messages'), 'older messages are still to be read');
    assert.match($('.sr-more')?.textContent ?? '', /5000 newest/u);
  } finally { await app.close(); }
});

test('while a new question is pending, the old rows offer no "Read older messages" (#432 review P1-A)', async (context) => {
  const { ask } = scripted(() => ({ messages: [] }));
  const { askFiles, resolvers } = scriptedFiles((_req, n) => (n === 1 ? { files: [fileRow('/a.md')], next: 50, scanned: 5000 } : 'hold'));
  const { app, button, type } = await open(context, ask, { askFiles });
  try {
    (app.window as any).__search.show();
    await settle(app);
    button('Files')!.click();
    await settle(app);
    assert.ok(button('Read older messages'), 'the answer on screen is the current question’s');
    await type('spec');                                // the new question is asked and held
    assert.equal(button('Read older messages') ?? null, null, 'the old rows are labelled and not a place to read on from');
    resolvers[0]!({ files: [fileRow('/spec.md')], next: 7, scanned: 3 });
    await settle(app);
    assert.ok(button('Read older messages'), 'and the new answer offers its own');
  } finally { await app.close(); }
});

test('a server that cannot list files says so, keeps the rows, and offers no Retry (#432 review P1-D)', async (context) => {
  const { ask } = scripted(() => ({ messages: [] }));
  const { askFiles } = scriptedFiles((_req, n) => (n === 1 ? { files: [fileRow('/a.md')], next: null, scanned: 3 } : Object.assign(new Error('x'), { code: 'files-unsupported' })));
  const { app, button, $, type } = await open(context, ask, { askFiles });
  try {
    (app.window as any).__search.show();
    await settle(app);
    button('Files')!.click();
    await settle(app);
    await type('x');
    assert.match($('.sr-status')?.textContent ?? '', /This server cannot list files yet/u);
    assert.equal(button('Retry') ?? null, null, 'retrying the same server cannot help');
    assert.equal(app.document.querySelectorAll('.sr-file').length, 1, 'the last good rows stay, labelled');
  } finally { await app.close(); }
});

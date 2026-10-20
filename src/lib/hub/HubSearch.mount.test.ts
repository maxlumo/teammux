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
  return { app, $, type, press };
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
  const { app, $, type } = await open(context, ask);
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

    $<HTMLButtonElement>('button[aria-pressed]')!.click();             // All rooms
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
  const { app, $, type } = await open(context, ask);
  try {
    (app.window as any).__search.show();
    await settle(app);
    await type('deploy');
    assert.equal(app.document.querySelectorAll('.sr-row').length, 1);
    await type('deploy staging');
    assert.match($('.sr-status')?.textContent ?? '', /The search failed/u, 'an error, not "No matches"');
    assert.equal(app.document.querySelectorAll('.sr-row').length, 1, 'the previous answer is still there');
    assert.match($('.sr-label')?.textContent ?? '', /“deploy”/u, 'and labelled with the query it answered');
    $<HTMLButtonElement>('.sr-tools button:not([aria-pressed])')!.click();   // Retry
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
  const { app, $ } = await open(context, ask);
  try {
    const search = (app.window as any).__search;
    search.show();
    await settle(app);
    const input = $<HTMLInputElement>('.search-input')!;
    input.focus();
    // Tab / mouse from the input to the scope control, then onto the panel itself: real focus moves, all inside.
    const scope = $<HTMLButtonElement>('.sr-tools button')!;
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
  const { app, $, type } = await open(context, ask);
  try {
    (app.window as any).__search.show();
    await settle(app);
    await type(Array.from({ length: 33 }, (_, n) => `w${n}`).join(' '));
    assert.equal(asked.length, 0);
    assert.match($('.sr-status')?.textContent ?? '', /Too many words: a search takes at most 32/u);
    assert.equal($('.sr-tools button:not([aria-pressed])'), null, 'retrying the same words cannot help');
  } finally { await app.close(); }
});

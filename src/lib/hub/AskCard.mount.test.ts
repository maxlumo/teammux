// Board #107: the ask card in every state, its IME rule and its controls, mounted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./AskCard.svelte', import.meta.url), []);

const open = {
  seq: 7, room: 'proj:p', ts: 1_800_000_000_000, asker: 'lead', question: 'Which **layout**?',
  options: [{ key: 'A', label: 'own row' }, { key: 'B', label: 'disk to the card' }], recommend: 'A', issue: null,
  state: 'open', closed_seq: null, closed_at: null, answer_key: null, said: null, closing: null, delivery: null,
};

async function mount(context: import('node:test').TestContext, props: Record<string, unknown>) {
  const calls: unknown[][] = [];
  const app = await (await compiled).mount(context, {
    props: {
      ask: open, ...props,
      onanswer: async (...a: unknown[]) => { calls.push(['answer', ...a]); return true; },
      ondismiss: () => calls.push(['dismiss']),
      ondiscuss: () => calls.push(['discuss']),
    },
    modules: [],
  });
  return { app, calls, doc: app.document };
}

test('an open ask: the question rendered, the options in focus order with the recommended one marked, Answer, Dismiss, Discuss', async (context) => {
  const { app, calls, doc } = await mount(context, {});
  try {
    assert.equal(doc.querySelector('.ask-q strong')?.textContent, 'layout', 'markdown through core/markdown');
    const buttons = [...doc.querySelectorAll('button')].map((b) => b.textContent?.trim());
    assert.deepEqual(buttons.slice(0, 2), ['A · own row', 'B · disk to the card'], 'options first, in their order');
    assert.ok(buttons.includes('Answer') && buttons.includes('Dismiss') && buttons.includes('Discuss in chat'), `${buttons}`);
    const rec = doc.querySelectorAll('.ask-opt')[0]!;
    assert.equal(rec.querySelector('.ask-rec')?.textContent, 'recommended');
    assert.equal(doc.querySelectorAll('.ask-opt')[1]!.querySelector('.ask-rec'), null, 'only the recommended one is marked');
    (doc.querySelectorAll('.ask-opt button')[1] as HTMLButtonElement).click();
    (doc.querySelector('.ask-acts button') as HTMLButtonElement).click();
    ([...doc.querySelectorAll('.ask-acts button')][1] as HTMLButtonElement).click();
    await app.flush();
    assert.deepEqual(calls, [['answer', 'B', undefined], ['dismiss'], ['discuss']], 'an option with no comment typed');
    assert.equal(doc.querySelector('.ask-note'), null, 'a live asker: no note');
  } finally { await app.close(); }
});

test('the Answer box: Enter sends its words, Shift+Enter and an IME composition\'s Enter never do', async (context) => {
  const { app, calls, doc } = await mount(context, {});
  try {
    const ta = doc.querySelector('textarea')!;
    const key = (init: Record<string, unknown>) => ta.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
    ta.value = 'keep 24px'; ta.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    key({ isComposing: true });
    key({ shiftKey: true });
    await app.flush();
    assert.deepEqual(calls, [], 'a composition commit and a newline send nothing');
    key({});
    await app.flush();
    assert.deepEqual(calls, [['answer', undefined, 'keep 24px']]);
    await app.flush();
    assert.equal(ta.value, '', 'cleared once the server answered');
  } finally { await app.close(); }
});

test('a stopped or gone asker is said on the card; the controls stay (answering never needs the asker live)', async (context) => {
  for (const [asker, words] of [['stopped', 'lead is stopped: answer here, or after it restarts.'], ['gone', 'lead is no longer an agent of this project.']] as const) {
    const { app, doc } = await mount(context, { asker });
    try {
      assert.equal(doc.querySelector('.ask-note')?.textContent, words, asker);
      assert.ok(doc.querySelector('.ask-opts'), `${asker}: still answerable`);
    } finally { await app.close(); }
  }
});

test('closed asks show the outcome and no live controls; the delivery state sits beside the decision', async (context) => {
  const at = 1_800_000_060_000;
  const cases = [
    [{ state: 'answered', said: 'B · disk to the card — keep 24px', closed_at: at, delivery: 'found' }, 'Answered', 'B · disk to the card — keep 24px', 'Sent to lead'],
    [{ state: 'answered', said: 'A · own row', closed_at: at, delivery: null }, 'Answered', 'A · own row', 'no delivery recorded yet'],
    [{ state: 'answered', said: 'A · own row', closed_at: at, delivery: 'stopped' }, 'Answered', 'A · own row', 'not delivered: lead is stopped'],
    [{ state: 'answered', said: 'A · own row', closed_at: at, delivery: 'gone' }, 'Answered', 'A · own row', 'lead is gone'],
    [{ state: 'answered', said: 'A · own row', closed_at: at, delivery: 'unchecked' }, 'Answered', 'A · own row', 'delivery unconfirmed'],
    [{ state: 'dismissed', said: 'dismissed: I will not answer this', closed_at: at, delivery: 'found' }, 'Dismissed', null, 'Sent to lead'],
    [{ state: 'withdrawn', said: 'withdrawn: answered in chat — citing [re human 08:41: 「可以」]', closed_at: at, delivery: null }, 'Withdrawn by lead', 'answered in chat — citing [re human 08:41: 「可以」]', null],
  ] as const;
  for (const [patch, state, said, delivery] of cases) {
    const { app, doc } = await mount(context, { ask: { ...open, ...patch } });
    try {
      assert.equal(doc.querySelectorAll('button').length, 0, `${state}: no live controls`);
      assert.equal(doc.querySelector('textarea'), null);
      assert.equal(doc.querySelector('.ask-state')?.textContent, state);
      assert.equal(doc.querySelector('.ask-said')?.textContent ?? null, said, `${state}: ${patch.delivery}`);
      assert.equal(doc.querySelector('.ask-delivery')?.textContent ?? null, delivery, `${state}: ${patch.delivery}`);
      assert.ok(doc.querySelector('.ask-when')?.textContent, 'who and when');
    } finally { await app.close(); }
  }
});

test('a refused close is said on the card (already answered at HH:MM) above the winner\'s outcome', async (context) => {
  const { app, doc } = await mount(context, { ask: { ...open, state: 'answered', said: 'A · own row', closed_at: 1_800_000_060_000, delivery: 'found' }, refused: 'already answered at 08:41' });
  try {
    assert.equal(doc.querySelector('[role="alert"]')?.textContent, 'already answered at 08:41');
    assert.equal(doc.querySelector('.ask-said')?.textContent, 'A · own row', 'the winner\'s answer');
  } finally { await app.close(); }
});

test('six long options wrap instead of overflowing: each option button allows its words to wrap', async (context) => {
  const long = Array.from({ length: 6 }, (_, i) => ({ key: String.fromCharCode(65 + i), label: 'a very long option label that must wrap inside a phone bubble '.repeat(2) }));
  const { app, doc } = await mount(context, { ask: { ...open, options: long, recommend: 'C' } });
  try {
    assert.equal(doc.querySelectorAll('.ask-opt').length, 6);
    assert.equal(doc.querySelectorAll('.ask-rec').length, 1);
  } finally { await app.close(); }
});

test('a send that fails keeps the typed answer and says it was not sent (validator-2 F2); a send that lands clears it', async (context) => {
  for (const [result, kept] of [[false, true], [true, false]] as const) {
    const app = await (await compiled).mount(context, {
      props: { ask: open, onanswer: async () => result, error: result ? '' : 'network unavailable' },
      modules: [],
    });
    try {
      const ta = app.document.querySelector('textarea')!;
      ta.value = 'Irreplaceable decision detail';
      ta.dispatchEvent(new app.window.Event('input', { bubbles: true }));
      await app.flush();
      ta.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      for (let i = 0; i < 3; i++) await app.flush();
      assert.equal(ta.value, kept ? 'Irreplaceable decision detail' : '', kept ? 'a failed send loses no words' : 'a landed send clears the box');
      const alert = app.document.querySelector('[role="alert"]')?.textContent ?? '';
      if (kept) assert.equal(alert, 'Not sent: network unavailable');
      else assert.equal(alert, '');
    } finally { await app.close(); }
  }
});

test('an option tap carries the comment already typed (validator-2 F4); it clears only once the server answered', async (context) => {
  const calls: unknown[][] = [];
  const app = await (await compiled).mount(context, { props: { ask: open, onanswer: async (...a: unknown[]) => { calls.push(a); return true; } }, modules: [] });
  try {
    const ta = app.document.querySelector('textarea')!;
    ta.value = 'Only for desktop, never phone';
    ta.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.ask-opt button')][0]!.click();
    for (let i = 0; i < 3; i++) await app.flush();
    assert.deepEqual(calls, [['A', 'Only for desktop, never phone']], 'option and comment travel together');
    assert.equal(ta.value, '');
  } finally { await app.close(); }
});

test('a failed option tap keeps the comment and marks the option it tried (F2: the chosen option stays)', async (context) => {
  const app = await (await compiled).mount(context, { props: { ask: open, onanswer: async () => false, error: '' }, modules: [] });
  try {
    const ta = app.document.querySelector('textarea')!;
    ta.value = 'keep me';
    ta.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    const b = [...app.document.querySelectorAll<HTMLButtonElement>('.ask-opt button')][1]!;
    b.click();
    for (let i = 0; i < 3; i++) await app.flush();
    assert.equal(ta.value, 'keep me');
    assert.equal(b.getAttribute('aria-pressed'), 'true', 'the option it tried is marked for a one-tap retry');
    assert.equal([...app.document.querySelectorAll('.ask-opt button')].filter((x) => x.getAttribute('aria-pressed') === 'true').length, 1);
  } finally { await app.close(); }
});

test('the control that started a close shows the atom\'s pending state; its siblings are only unavailable (validator-2 F2 @ 612870ec)', async (context) => {
  for (const pick of ['option', 'answer', 'dismiss'] as const) {
    let release: (v: boolean) => void = () => {};
    let busy = false;
    const app = await (await compiled).mount(context, { props: {
      ask: open, busy: false,
      onanswer: () => { busy = true; return new Promise<boolean>((r) => { release = r; }); },
      ondismiss: () => { busy = true; },
    }, modules: [] });
    try {
      const doc = app.document;
      const ta = doc.querySelector('textarea')!;
      ta.value = 'words'; ta.dispatchEvent(new app.window.Event('input', { bubbles: true })); await app.flush();
      const target = pick === 'option' ? doc.querySelectorAll<HTMLButtonElement>('.ask-opt button')[1]!
        : [...doc.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === (pick === 'answer' ? 'Answer' : 'Dismiss'))!;
      target.click(); await app.flush();
      assert.ok(busy);
      await app.setProps({ busy: true }); await app.flush();
      assert.ok(target.classList.contains('pending'), `${pick}: the initiating control is pending`);
      assert.equal(target.getAttribute('aria-busy'), 'true');
      assert.ok(target.querySelector('.command-icon'), 'pending keeps its reserved icon slot');
      const others = [...doc.querySelectorAll<HTMLButtonElement>('.ask-card button')].filter((b) => b !== target && b.textContent?.trim() !== 'Discuss in chat');
      assert.ok(others.every((b) => b.disabled && !b.classList.contains('pending')), `${pick}: siblings unavailable, not pending`);
      release(false);
    } finally { await app.close(); }
  }
});

test('a cached CLOSED row whose refresh failed says so too (validator-2 F3 @ 612870ec)', async (context) => {
  const { app, doc } = await mount(context, { ask: { ...open, state: 'answered', said: 'A · own row', closed_at: 1_800_000_060_000, delivery: 'found' }, stale: true });
  try {
    assert.equal(doc.querySelector('.ask-stale')?.textContent, 'Could not refresh this question.');
    assert.equal(doc.querySelectorAll('.ask-card button').length, 0);
  } finally { await app.close(); }
});

// Reviewer R2 (#107 note 52, leader note 56): the server's `found` is EITHER typed into the
// asker's live pane OR held until its turn ends or it restarts (asks.md). The label is true of
// both and claims no receipt.
test('found reads "Sent to", true whether the line was typed or held, never "delivered" (R2)', async (context) => {
  const { app, doc } = await mount(context, { ask: { ...open, state: 'answered', said: 'A · own row', closed_at: 1_800_000_060_000, delivery: 'found' } });
  try {
    const line = doc.querySelector('.ask-delivery')?.textContent ?? '';
    assert.equal(line, 'Sent to lead');
    assert.doesNotMatch(line, /deliver|receiv|read/iu, 'no receipt claimed: a held line is not yet in the pane');
  } finally { await app.close(); }
});

test('options carry no icon at rest; Answer keeps send and Dismiss x (leader note 53)', async (context) => {
  const { app, doc } = await mount(context, {});
  try {
    for (const b of doc.querySelectorAll('.ask-opt button')) {
      assert.ok(b.querySelector('.command-icon'), 'the reserved pending slot');
      assert.equal(b.querySelector('.command-icon svg'), null, 'nothing drawn in it at rest');
    }
    const named = (label: string) => [...doc.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
    assert.ok(named('Answer').querySelector('.command-icon svg'));
    assert.ok(named('Dismiss').querySelector('.command-icon svg'));
  } finally { await app.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Select.svelte', import.meta.url), []);

test('select connects its trigger to its own list and returns the chosen value', async context => {
  const choices: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { options: ['a', 'b'], value: 'a', ariaLabel: 'Backend', onchange: (v: string) => choices.push(v) }, modules: [],
  });
  try {
    const trigger = app.document.querySelector<HTMLButtonElement>('.sel-trigger')!;
    trigger.click();
    await app.flush();
    const list = app.document.querySelector('[role=listbox]')!;
    assert.ok(list.id);
    assert.equal(trigger.getAttribute('aria-controls'), list.id);
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    await app.flush();
    assert.equal(trigger.getAttribute('aria-activedescendant'), app.document.querySelectorAll('[role=option]')[1]!.id);
    app.document.querySelectorAll<HTMLButtonElement>('[role=option]')[1]!.click();
    await app.flush();
    assert.deepEqual(choices, ['b']);
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(trigger.getAttribute('aria-controls'), null);
    assert.equal(app.document.activeElement, trigger, 'picking returns focus instead of leaving it on a removed option');
  } finally { await app.close(); }
});

test('IME Enter cannot choose or commit while a combobox is open', async context => {
  const changes: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { editable: true, options: ['a', 'ab'], value: 'a', ariaLabel: 'Model', onchange: (v: string) => changes.push(v) }, modules: [],
  });
  try {
    const input = app.document.querySelector('input')!;
    input.dispatchEvent(new app.window.CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'ab';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...extra }));
    }
    input.dispatchEvent(new app.window.Event('blur'));
    assert.deepEqual(changes, []);
    input.dispatchEvent(new app.window.CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await app.flush();
    assert.deepEqual(changes, ['ab']);
  } finally { await app.close(); }
});

test('IME Enter cannot commit a closed combobox either', async context => {
  const changes: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { editable: true, options: ['a', 'ab'], value: 'a', onchange: (v: string) => changes.push(v) }, modules: [],
  });
  try {
    const input = app.document.querySelector('input')!;
    input.value = 'ab';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    app.document.body.dispatchEvent(new app.window.Event('pointerdown', { bubbles: true }));
    await app.flush();
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    input.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
    assert.deepEqual(changes, []);
  } finally { await app.close(); }
});

test('locking a select closes its menu and rejects an already queued option click', async context => {
  const fixture = await compileMount(new URL('./Select.test.svelte', import.meta.url), []);
  const app = await fixture.mount(context, { modules: [] });
  try {
    app.document.querySelector<HTMLButtonElement>('.sel-trigger')!.click();
    await app.flush();
    const option = app.document.querySelectorAll<HTMLButtonElement>('[role=option]')[1]!;
    [...app.document.querySelectorAll('button')].find(b => b.textContent === 'Lock')!.click();
    option.click();
    await app.flush();
    assert.equal(app.document.querySelector('output')?.textContent, 'a/0');
    assert.equal(app.document.querySelector('[role=listbox]'), null);
  } finally { await app.close(); }
});

test('select Escape closes the list without changing its value', async context => {
  const app = await (await compiled).mount(context, {
    props: { options: ['a', 'b'], value: 'a', ariaLabel: 'Backend', onchange: () => assert.fail('Escape selected') }, modules: [],
  });
  try {
    app.document.querySelector<HTMLButtonElement>('.sel-trigger')!.click();
    await app.flush();
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await app.flush();
    assert.equal(app.document.querySelector('[role=listbox]'), null);
  } finally { await app.close(); }
});

test('Select starts ArrowUp at the last option and scrolls keyboard Home/End into view (#165)', async context => {
  const changes: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { options: ['a', 'b', 'c'], value: '', ariaLabel: 'Choice', onchange: (value: string) => changes.push(value) }, modules: [],
  });
  try {
    const trigger = app.document.querySelector<HTMLButtonElement>('.sel-trigger')!;
    trigger.click(); await app.flush();
    const options = [...app.document.querySelectorAll<HTMLButtonElement>('[role=option]')];
    const seen: number[] = [];
    options.forEach((option, i) => { option.scrollIntoView = () => { seen.push(i); }; });
    const key = async (value: string) => {
      trigger.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
      await app.flush();
    };
    await key('ArrowUp');
    assert.equal(trigger.getAttribute('aria-activedescendant'), options[2]!.id);
    await key('Home'); await key('End');
    assert.deepEqual(seen, [2, 0, 2]);
    await key('Enter');
    assert.deepEqual(changes, ['c']);
  } finally { await app.close(); }
});

test('a Select wrapped in a label closes once on a mouse pick, and Escape stays with its menu (#75)', async context => {
  const fixture = await compileMount(new URL('./SelectInLabel.test.svelte', import.meta.url), []);
  const app = await fixture.mount(context, { modules: [] });
  try {
    const trigger = app.document.querySelector<HTMLButtonElement>('.sel-trigger')!;
    trigger.click(); await app.flush();
    const pick = new app.window.MouseEvent('click', { bubbles: true, cancelable: true });
    assert.equal(app.document.querySelectorAll('[role=option]')[1]!.dispatchEvent(pick), false,
      'a click in the menu is cancelled, so the label around the field never forwards it to the trigger');
    await app.flush();
    assert.equal(app.document.querySelector('output')?.textContent, 'codex/0');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'the pick closes the menu');
    assert.equal(app.document.querySelector('[role=listbox]'), null);
    trigger.click(); await app.flush();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'the trigger opens it again');
    trigger.click(); await app.flush();
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'and closes it again');
    trigger.click(); await app.flush();
    trigger.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await app.flush();
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(app.document.querySelector('output')?.textContent, 'codex/0', 'the page never sees that Escape');
  } finally { await app.close(); }
});

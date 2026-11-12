import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./CommandButton.svelte', import.meta.url), []);

test('quiet painted tools expose controlled pressed and popup states (#166)', async context => {
  const app = await (await compiled).mount(context, {
    props: { label: 'Raw', icon: 'code', iconOnly: true, variant: 'secondary', pressed: true, hasPopup: 'menu' },
    modules: [],
  });
  try {
    const button = app.document.querySelector('button')!;
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.getAttribute('aria-haspopup'), 'menu');
    assert.ok(button.classList.contains('engaged'));
  } finally { await app.close(); }
});

test('disclosure chevrons turn with the controlled expanded state through the shared flip atom (#168)', async context => {
  for (const expanded of [false, true]) {
    const app = await (await compiled).mount(context, {
      props: { label: 'Agents', icon: 'chevron-up', variant: 'icon', expanded, controls: 'roster' }, modules: [],
    });
    try {
      const icon = app.document.querySelector('.command-icon')!;
      assert.ok(icon.classList.contains('flip'));
      assert.equal(icon.classList.contains('on'), expanded);
      assert.equal(app.document.querySelector('button')!.getAttribute('aria-expanded'), String(expanded));
    } finally { await app.close(); }
  }
});

test('a horizontal disclosure chevron turns the same way (board #174: the sidebar collapse control)', async context => {
  for (const expanded of [false, true]) {
    const app = await (await compiled).mount(context, {
      props: { label: 'Sidebar', icon: 'chevron-right', variant: 'icon', expanded, controls: 'sidebar' }, modules: [],
    });
    try {
      const icon = app.document.querySelector('.command-icon')!;
      assert.ok(icon.classList.contains('flip'), 'one glyph that turns, never two icons');
      assert.equal(icon.classList.contains('on'), expanded);
      assert.equal(app.document.querySelector('button')!.classList.contains('engaged'), expanded,
        'a disclosure of content elsewhere wears the engaged wash while open');
    } finally { await app.close(); }
  }
  // Standing INSIDE the region it discloses, the control is at rest in both
  // states — the visible region is the signal (design-language: at rest is
  // achromatic).
  const app = await (await compiled).mount(context, {
    props: { label: 'Sidebar', icon: 'chevron-right', variant: 'icon', expanded: true, inside: true, controls: 'sidebar' }, modules: [],
  });
  try {
    assert.ok(!app.document.querySelector('button')!.classList.contains('engaged'));
    assert.ok(app.document.querySelector('.command-icon')!.classList.contains('on'), 'the glyph still turns');
    assert.equal(app.document.querySelector('button')!.getAttribute('aria-expanded'), 'true');
  } finally { await app.close(); }
});

test('commands keep their name and reject activation while disabled or pending', async context => {
  const fixture = await compiled;
  for (const state of [{}, { disabled: true }, { pending: true }]) {
    let calls = 0;
    const app = await fixture.mount(context, {
      props: { label: 'Save', icon: 'check', variant: 'primary', ...state, onclick: () => { calls++; } },
      modules: [],
    });
    try {
      const button = app.document.querySelector('button')!;
      assert.equal(button.getAttribute('aria-label'), 'Save');
      assert.equal(button.textContent?.trim(), 'Save');
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(button.getAttribute('aria-busy'), state.pending ? 'true' : null);
      for (const name of ['pressed', 'expanded', 'controls']) assert.equal(button.getAttribute(`aria-${name}`), null);
      assert.equal(button.classList.contains('engaged'), false);
      button.click();
      button.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
      assert.equal(calls, state.disabled || state.pending ? 0 : 2);
      assert.equal(button.classList.contains('pending'), !!state.pending);
    } finally { await app.close(); }
  }
});

test('icon commands expose a name without a competing native title', async context => {
  const app = await (await compiled).mount(context, {
    props: { label: 'Refresh', icon: 'refresh', variant: 'icon' }, modules: [],
  });
  try {
    const button = app.document.querySelector('button')!;
    assert.equal(button.getAttribute('aria-label'), 'Refresh');
    assert.equal(button.getAttribute('title'), null);
    assert.equal(button.textContent?.trim(), '');
    assert.ok(button.querySelector('svg'));
  } finally { await app.close(); }
});

test('the icon-only stop retains native command, pending and controlled ARIA semantics (#173, icon variant since #195)', async context => {
  for (const state of [{}, { disabled: true }, { pending: true }]) {
    let calls = 0;
    const app = await (await compiled).mount(context, {
      props: {
        label: 'Interrupt alice', variant: 'icon', iconOnly: true, icon: 'stop',
        pressed: false, expanded: true, controls: 'agent-actions',
        ...state, onclick: () => { calls++; },
      },
      modules: [],
    });
    try {
      const button = app.document.querySelector('button')!;
      assert.equal(button.classList.contains('warn'), false, '#195: the warn variant is gone');
      assert.equal(button.classList.contains('icon-only'), true);
      for (const name of ['primary', 'secondary', 'danger', 'solid']) {
        assert.equal(button.classList.contains(name), false, name);
      }
      assert.equal(button.classList.contains('engaged'), true, 'an icon command that is expanded wears the engaged wash');
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(button.getAttribute('aria-label'), 'Interrupt alice');
      assert.equal(button.getAttribute('title'), null);
      assert.equal(button.getAttribute('aria-pressed'), 'false');
      assert.equal(button.getAttribute('aria-expanded'), 'true');
      assert.equal(button.getAttribute('aria-controls'), 'agent-actions');
      assert.equal(button.getAttribute('aria-busy'), state.pending ? 'true' : null);
      assert.equal(button.disabled, !!(state.pending || state.disabled));
      assert.equal(button.querySelector('.command-icon')?.classList.contains('spinning'), !!state.pending);
      assert.equal(button.querySelector('.command-label'), null);
      if (!button.disabled) {
        button.focus();
        assert.equal(app.document.activeElement, button);
      }
      button.click();
      button.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
      assert.equal(calls, state.pending || state.disabled ? 0 : 2);
    } finally { await app.close(); }
  }
});

test('tool ARIA distinguishes explicit false from absent state (#157)', async context => {
  const states = [
    {}, { pressed: false }, { pressed: true },
    { expanded: false, controls: 'bookmarks' }, { expanded: true, controls: 'recent' },
    { pressed: true, expanded: false }, { pressed: false, expanded: true },
  ];
  for (const state of states) {
    const app = await (await compiled).mount(context, {
      props: { label: 'Tool', icon: 'refresh', variant: 'icon', ...state }, modules: [],
    });
    try {
      const button = app.document.querySelector('button')!;
      assert.equal(button.getAttribute('aria-pressed'), state.pressed === undefined ? null : String(state.pressed));
      assert.equal(button.getAttribute('aria-expanded'), state.expanded === undefined ? null : String(state.expanded));
      assert.equal(button.getAttribute('aria-controls'), state.controls ?? null);
      assert.equal(button.classList.contains('engaged'), state.pressed === true || state.expanded === true);
    } finally { await app.close(); }
  }
});

test('tool clicks emit intent; only parent updates change state, including while disabled or pending (#157)', async context => {
  const fixture = await compileMount(new URL('./CommandButton.test.svelte', import.meta.url), []);
  let update!: (next: { pressed?: boolean; expanded?: boolean; controls?: string; disabled?: boolean; pending?: boolean }) => void;
  let calls = 0;
  const app = await fixture.mount(context, {
    props: { ready: (set: typeof update) => update = set, onintent: () => { calls++; } }, modules: [],
  });
  try {
    const button = app.document.querySelector('button')!;
    update({ pressed: false, expanded: false, controls: 'bookmarks' }); await app.flush();
    button.click(); await app.flush();
    assert.equal(calls, 1);
    assert.equal(button.getAttribute('aria-pressed'), 'false', 'click cannot commit its own toggle');
    assert.equal(button.getAttribute('aria-expanded'), 'false', 'click cannot open its own disclosure');
    assert.equal(button.classList.contains('engaged'), false);
    update({ pressed: true }); await app.flush();
    button.click(); await app.flush();
    assert.equal(calls, 2);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(button.classList.contains('engaged'), true);
    update({ pressed: false, expanded: true, controls: 'recent' }); await app.flush();
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.getAttribute('aria-controls'), 'recent');
    assert.equal(button.classList.contains('engaged'), true);
    for (const locked of [{ disabled: true, pending: false }, { disabled: false, pending: true }]) {
      update(locked); await app.flush();
      button.click();
      button.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
      assert.equal(calls, 2, 'disabled/pending tools cannot emit intent');
      assert.equal(button.getAttribute('aria-expanded'), 'true');
      assert.equal(button.classList.contains('engaged'), true);
    }
    update({ disabled: false, pending: false, pressed: undefined, expanded: undefined, controls: undefined });
    await app.flush();
    for (const name of ['pressed', 'expanded', 'controls']) assert.equal(button.getAttribute(`aria-${name}`), null);
    assert.equal(button.classList.contains('engaged'), false);
  } finally { await app.close(); }
});

test('tool metadata does not replace ordinary command variant styling (#157)', async context => {
  for (const variant of ['primary', 'secondary', 'danger']) {
    const app = await (await compiled).mount(context, {
      props: { label: 'Command', icon: 'refresh', variant, pressed: true, expanded: true }, modules: [],
    });
    try {
      const button = app.document.querySelector('button')!;
      assert.equal(button.classList.contains('engaged'), false);
      assert.equal(button.textContent?.trim(), 'Command');
    } finally { await app.close(); }
  }
});

// Board #107 (leader note 53): a command with no icon of its own may still go pending. The atom
// owns an EMPTY reserved slot: nothing drawn at rest, the spinner in the same slot while
// pending, so the label never moves; contrast and aria-busy are the pending contract's.
test('the reserve modifier: an empty icon slot at rest, the pending spinner in it, the label in place (#107)', async context => {
  for (const pending of [false, true]) {
    const app = await (await compiled).mount(context, { props: { label: 'A · alpha', reserve: true, pending }, modules: [] });
    try {
      const button = app.document.querySelector('button')!;
      const slot = button.querySelector('.command-icon');
      assert.ok(slot, 'the slot is reserved in both states');
      assert.equal(!!slot!.querySelector('svg'), pending, pending ? 'the spinner while pending' : 'nothing drawn at rest');
      assert.equal(button.classList.contains('pending'), pending);
      assert.equal(button.getAttribute('aria-busy'), pending ? 'true' : null);
      assert.equal(button.querySelector('.command-label')?.textContent, 'A · alpha');
    } finally { await app.close(); }
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

// A reactive host lets external requests change without remounting Preferences;
// it also gives the embedded Agents editor its guest scope, as App does
// (board #335 ②b-3).
const compiled = compileMount(new URL('./Preferences.test.svelte', import.meta.url), [
  new URL('../hub/AgentsPage.svelte', import.meta.url),
]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type AgentProps = {
  section: string;
  editRequest: { name: string; n: number } | null;
  onGuardExit?: (guard: (action: () => void) => void) => (() => void) | void;
  onGoBack: (back: () => boolean) => void;
  onDrilled: (drilled: boolean) => void;
};

async function mount(context: TestContext, options: {
  props?: Record<string, unknown>;
  tab?: string;
  agent?: (props: AgentProps) => void;
  setup?: (window: any) => void;
} = {}) {
  let update!: (props: Record<string, unknown>) => void;
  const app = await (await compiled).mount(context, {
    props: {
      initial: options.props ?? {},
      register: (fn: typeof update) => { update = fn; },
    },
    modules: [
      // This stub supplies only the agreed child navigation contract; it does
      // not simulate Agent draft logic, which the parent tests independently.
      { default: (_anchor: unknown, props: AgentProps) => { options.agent?.(props); } },
    ],
    setup(window) {
      if (options.tab) window.localStorage.setItem('tmux_settings_tab', options.tab);
      window.localStorage.setItem('tmux_locale', 'en');
      window.HTMLCanvasElement.prototype.getContext = () => null;
      options.setup?.(window);
    },
  });
  const button = (label: string) => {
    const found = [...app.document.querySelectorAll<HTMLButtonElement>('button')]
      .find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label);
    assert.ok(found, `button: ${label}`);
    return found;
  };
  return {
    ...app, button,
    async click(label: string) { button(label).click(); await app.flush(); },
    async update(props: Record<string, unknown>) { update(props); await app.flush(); },
    async wait(predicate: () => boolean) {
      for (let i = 0; i < 12 && !predicate(); i++) await app.flush();
      assert.ok(predicate(), 'expected component state settled');
    },
  };
}

test('a failover address is removed through the one write path; the active address has no delete (board #222)', async context => {
  const writes: string[][] = [];
  const app = await mount(context, {
    tab: 'connection',
    props: {
      connected: true, serverInfo: { hostname: 'A', machineId: 'a' },
      activeAddress: 'ws://a:1', addresses: ['ws://a:1', 'ws://b:2'],
      onAddressesChange: (next: string[]) => { writes.push(next); },
    },
  });
  try {
    const rows = [...app.document.querySelectorAll<HTMLElement>('[data-addr-row]')];
    assert.deepEqual(rows.map((r) => r.dataset.addrRow), ['ws://a:1', 'ws://b:2']);
    assert.equal(rows[0]!.querySelector('.command-button.danger'), null, 'the live connection is not removable');
    const del = rows[1]!.querySelector<HTMLButtonElement>('.command-button.danger')!;
    assert.equal(del.getAttribute('aria-label'), 'Delete ws://b:2');
    del.click();
    await app.flush();
    assert.deepEqual(writes, [['ws://a:1']], 'the new list goes up; App persists it');
  } finally { await app.close(); }
});

test('the grip reorders from the keyboard, one step per arrow (board #222)', async context => {
  const writes: string[][] = [];
  const app = await mount(context, {
    tab: 'connection',
    props: {
      connected: true, serverInfo: { hostname: 'A', machineId: 'a' },
      activeAddress: 'ws://a:1', addresses: ['ws://a:1', 'ws://b:2', 'ws://c:3'],
      onAddressesChange: (next: string[]) => { writes.push(next); },
    },
  });
  try {
    const grips = [...app.document.querySelectorAll<HTMLButtonElement>('.addr-grip')];
    assert.equal(grips.length, 3, 'every row carries the drag handle');
    assert.equal(grips[0]!.getAttribute('aria-label'), 'Drag to set priority');
    grips[1]!.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await app.flush();
    // The component allocates its arrays in the window's realm; copy before comparing.
    assert.deepEqual(writes.map((w) => [...w]), [['ws://b:2', 'ws://a:1', 'ws://c:3']]);
    grips[1]!.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await app.flush();
    assert.deepEqual([...writes.at(-1)!], ['ws://a:1', 'ws://c:3', 'ws://b:2'], 'each arrow commits one step');
    grips[0]!.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await app.flush();
    assert.equal(writes.length, 2, 'the top row cannot move up — no write');
  } finally { await app.close(); }
});

test('connection commands expose pending/error and reject duplicate activation', async context => {
  const share = deferred<void>();
  let calls = 0;
  const app = await mount(context, {
    tab: 'connection',
    props: { connected: true, onShare: () => ++calls === 1 ? share.promise : Promise.resolve() },
  });
  try {
    const button = app.button('Share connection link');
    button.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    assert.equal(calls, 1);
    await app.flush();
    assert.equal(button.getAttribute('aria-busy'), 'true');
    share.reject(new app.window.Error('Copy failed'));
    await app.wait(() => app.document.querySelector('[role="alert"]')?.textContent === 'Copy failed');
    assert.equal(button.disabled, false);
    await app.advance(3000);
    assert.equal(app.document.querySelector('[role="alert"]')?.textContent, 'Copy failed', 'copy errors do not expire');
    await app.click('Share connection link');
    await app.wait(() => !button.disabled);
    assert.equal(calls, 2, 'the same share command retries after failure');
    assert.equal(app.document.querySelector('[role="alert"]'), null);
  } finally { share.resolve(); await app.close(); }
});

test('notification switch remains immediate while permission/test requests are serialized', async context => {
  const permission = deferred<string>();
  let prompts = 0, sent = 0;
  const app = await mount(context, {
    tab: 'notifications',
    setup(window) {
      window.localStorage.setItem('tmux_notify', 'off');
      window.Audio = class { play() { return Promise.resolve(); } };
      window.Notification = class {
        static permission = 'default';
        static requestPermission() { prompts++; return permission.promise; }
        constructor() { sent++; }
      };
    },
  });
  try {
    const toggle = app.document.querySelector<HTMLButtonElement>('[role="switch"]');
    assert.ok(toggle, 'the boolean uses the shared Switch');
    assert.equal(prompts, 0, 'mount never prompts');
    toggle.click();
    await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_notify'), 'on');
    assert.equal(prompts, 1);
    app.button('Send a test notification').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    assert.equal(prompts, 1, 'test cannot race a pending permission request');
    app.window.Notification.permission = 'granted';
    permission.resolve('granted');
    await app.flush();
    await app.click('Send a test notification');
    await app.wait(() => sent === 1);
  } finally { permission.resolve('granted'); await app.close(); }
});

// #233: the picker offers only families the device resolves — a listed font
// that fails on pick is decoration. The probe is the same FontFace door the
// validator uses; here it resolves only for two families, and the combo's
// dropdown must show exactly those.
test('font suggestions are filtered to families the device actually has (#233)', async context => {
  const app = await mount(context, {
    setup(window) {
      window.FontFace = class {
        src: string;
        constructor(_name: string, src: string) { this.src = src; }
        load() {
          return /LXGW WenKai|Inter/.test(this.src) ? Promise.resolve(this) : Promise.reject(new Error('no such family'));
        }
      };
    },
  });
  try {
    await app.wait(() => {
      const input = app.document.querySelector<HTMLInputElement>('.sel-combo input')!;
      input.click();
      const options = [...app.document.querySelectorAll('.sel-opt')].map(el => el.textContent?.trim());
      // The bundled faces lead, unprobed (board 312); then the pool as probed.
      // 'LXGW WenKai GB' also matches the probe regex — pool order survives.
      return JSON.stringify(options) === JSON.stringify(
        ['Inter Variable', 'Space Grotesk Variable', 'Inter', 'LXGW WenKai', 'LXGW WenKai GB']);
    });
  } finally { await app.close(); }
});

test('font validation locks its row and restores the confirmed family on failure', async context => {
  const probe = deferred<void>();
  let calls = 0;
  const app = await mount(context, {
    setup(window) {
      window.localStorage.setItem('tmux_font_ui', 'Inter');
      window.FontFace = class { load() { calls++; return probe.promise; } };
    },
  });
  try {
    const input = app.document.querySelector<HTMLInputElement>('.sel-combo input')!;
    // The availability sweep (#233) probes the suggestion pool at mount with
    // the same FontFace door; the row's own probe is the one AFTER typing.
    const swept = calls;
    input.value = 'Unavailable Face';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new app.window.FocusEvent('blur'));
    await app.flush();
    assert.equal(calls, swept + 1);
    assert.equal(input.disabled, true);
    assert.equal(app.window.localStorage.getItem('tmux_font_ui'), 'Inter');
    probe.reject(new Error('not installed'));
    await app.wait(() => input.disabled === false);
    assert.equal(input.value, 'Inter');
    assert.ok(app.document.querySelector('[role="alert"].font-error'));
    input.value = '';
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    input.dispatchEvent(new app.window.FocusEvent('blur'));
    await app.wait(() => app.window.localStorage.getItem('tmux_font_ui') === null);
    // Cleared = the default, and the field names it (board 312).
    assert.equal(input.value, 'Inter Variable');
    assert.equal(app.document.querySelector('[role="alert"].font-error'), null);
  } finally { probe.resolve(); await app.close(); }
});

// Board 312 (owner, 2026-10-08): the field showed a grey "System default"
// while the titles wore the bundled Space Grotesk, which no picker offered.
// The fields name the real default in its own face, the bundled faces are
// pickable without a local() probe, and Reset restores the default at once.
test('font fields show the real default and reset to it (board 312)', async context => {
  const app = await mount(context, {
    setup(window) {
      window.localStorage.setItem('tmux_font_display', 'LXGW WenKai');
      window.FontFace = class {
        src: string;
        constructor(_name: string, src: string) { this.src = src; }
        load() { return /LXGW WenKai|Menlo/.test(this.src) ? Promise.resolve(this) : Promise.reject(new Error('none')); }
      };
    },
  });
  try {
    const inputs = () => [...app.document.querySelectorAll<HTMLInputElement>('.sel-combo input')];
    const resets = () => [...app.document.querySelectorAll<HTMLButtonElement>('.font-field button')];
    // ui · display · mono: the default by name, the display role's custom
    // pick, each in its face. Mono has no nameable default (ui-monospace):
    // empty, its placeholder worn in the mono stack — even with Menlo present.
    await app.wait(() => JSON.stringify(inputs().map(i => i.value)) === JSON.stringify(['Inter Variable', 'LXGW WenKai', '']));
    assert.match(inputs()[0]!.style.fontFamily, /Inter Variable/);
    assert.equal(inputs()[2]!.placeholder, 'System monospace');
    assert.match(inputs()[2]!.getAttribute('style') ?? '', /font-family: var\(--font-mono\)/);
    // Reset is live only where something is customized.
    assert.equal(JSON.stringify(resets().map(b => b.disabled)), JSON.stringify([true, false, true]));
    resets()[1]!.click();
    await app.wait(() => app.window.localStorage.getItem('tmux_font_display') === null && inputs()[1]!.value === 'Space Grotesk Variable');
    assert.equal(resets()[1]!.disabled, true);
    // A bundled face is valid without a probe; picking the default stores nothing.
    const ui = inputs()[0]!;
    ui.value = 'Space Grotesk Variable';
    ui.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    ui.dispatchEvent(new app.window.FocusEvent('blur'));
    await app.wait(() => app.window.localStorage.getItem('tmux_font_ui') === 'Space Grotesk Variable');
    ui.value = 'Inter Variable';
    ui.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    ui.dispatchEvent(new app.window.FocusEvent('blur'));
    await app.wait(() => app.window.localStorage.getItem('tmux_font_ui') === null && ui.value === 'Inter Variable');
  } finally { await app.close(); }
});

test('numeric preferences use shared bounds and apply without a page Save', async context => {
  const sizes: number[] = [];
  const app = await mount(context, {
    tab: 'appearance', props: { fontSize: 6, onFontSize: (size: number) => { sizes.push(size); } },
  });
  try {
    const stepper = app.document.querySelector('[role="group"][aria-label="Terminal font size"]')!;
    const minus = stepper.querySelector<HTMLButtonElement>('button:first-child')!;
    const plus = stepper.querySelector<HTMLButtonElement>('button:last-child')!;
    assert.equal(minus.disabled, true);
    plus.click();
    assert.deepEqual(sizes, [7]);
    await app.update({ fontSize: 40 });
    assert.equal(plus.disabled, true);
    const slider = app.document.querySelector<HTMLInputElement>('input[type="range"]')!;
    slider.value = '1.25';
    slider.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_line_height'), '1.25');
    app.document.querySelector<HTMLButtonElement>('.control-slider button')!.click();
    await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_line_height'), '1');
    assert.equal(app.document.querySelector('[aria-label="Save"]'), null);
  } finally { await app.close(); }
});

test('the native shortcut recorder keeps capture, conflict, clear, cancel and reset', async context => {
  const app = await mount(context, { tab: 'shortcuts', props: { showShortcuts: true } });
  try {
    const stored = () => JSON.parse(app.window.localStorage.getItem('tmux_shortcuts') ?? '{}');
    const recorder = app.document.querySelector<HTMLButtonElement>('[data-shortcut-recorder]')!;
    const key = async (key: string, code = key, mods: Partial<KeyboardEventInit> = {}) => {
      recorder.dispatchEvent(new app.window.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }));
      await app.flush();
    };
    const mac = app.window.navigator.platform.includes('Mac');
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const mod2 = mac ? { metaKey: true, altKey: true } : { ctrlKey: true, altKey: true };
    const original = mac ? 'Meta+KeyU' : 'Ctrl+Alt+KeyU'; // the default, resolved for this platform
    recorder.click();
    await key('i', 'KeyI', mac ? mod : mod2);
    assert.match(app.document.querySelector('[role="alert"]')?.textContent ?? '', /already assigned/, 'Next page owns it');
    await key('Escape');
    assert.equal(app.document.querySelector('[role="alert"]'), null);
    // A combo the browser keeps is refused, in place, with the reason.
    recorder.click();
    await key('t', 'KeyT', mod);
    assert.match(app.document.querySelector('[role="alert"]')?.textContent ?? '', /belongs to the browser/);
    assert.notEqual(stored().previousPage, 'Ctrl+KeyT', 'nothing stored');
    assert.notEqual(stored().previousPage, 'Meta+KeyT');
    await key('Backspace');
    assert.equal(stored().previousPage, '');
    recorder.click();
    await key('x', 'KeyX', mod2);
    assert.match(stored().previousPage, /\+Alt\+KeyX$/u);
    // Per-row reset (the first row's undo), then reset-all.
    const rowReset = app.document.querySelector<HTMLButtonElement>('.shortcut-control .command-button')!;
    assert.equal(rowReset.disabled, false);
    rowReset.click(); await app.flush();
    assert.equal(stored().previousPage, original);
    assert.equal(rowReset.disabled, true, 'at its default, the row reset rests');
    recorder.click(); await key('x', 'KeyX', mod);
    await app.click('Restore all defaults');
    assert.equal(stored().previousPage, original);
    assert.equal(recorder.classList.contains('recording'), false);
  } finally { await app.close(); }
});

test('the recorder ignores character input (IME, AltGr) and refuses terminal control keys (board 316 review)', async context => {
  const app = await mount(context, { tab: 'shortcuts', props: { showShortcuts: true } });
  try {
    const stored = () => JSON.parse(app.window.localStorage.getItem('tmux_shortcuts') ?? '{}').previousPage;
    const before = stored();
    const recorder = app.document.querySelector<HTMLButtonElement>('[data-shortcut-recorder]')!;
    recorder.click(); await app.flush();
    const press = async (init: KeyboardEventInit & { keyCode?: number }) => {
      const ev = new app.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      if (init.keyCode) Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
      recorder.dispatchEvent(ev); await app.flush();
    };
    await press({ key: 's', code: 'KeyS', ctrlKey: true, altKey: true, isComposing: true });
    await press({ key: 'Process', code: 'KeyS', ctrlKey: true, altKey: true, keyCode: 229 });
    await press({ key: 'ś', code: 'KeyS', ctrlKey: true, altKey: true });
    assert.equal(stored(), before, 'typing never becomes a binding');
    assert.ok(recorder.classList.contains('recording'), 'still waiting for a real chord');
    // Composing Backspace / Escape are the IME's: no clear, no cancel, not consumed.
    for (const init of [
      { key: 'Backspace', code: 'Backspace', isComposing: true },
      { key: 'Escape', code: 'Escape', isComposing: true },
      { key: 'Backspace', code: 'Backspace', keyCode: 229 },
      { key: 'Dead', code: 'Quote' },
    ] as (KeyboardEventInit & { keyCode?: number })[]) {
      const ev = new app.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      if (init.keyCode) Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
      recorder.dispatchEvent(ev); await app.flush();
      assert.equal(ev.defaultPrevented, false, `${init.key} stays the input method's`);
      assert.equal(stored(), before, `${init.key} did not clear the binding`);
      assert.ok(recorder.classList.contains('recording'), `${init.key} did not end recording`);
    }
    await press({ key: 'u', code: 'KeyU', ctrlKey: true });
    assert.match(app.document.querySelector('[role="alert"]')?.textContent ?? '', /control key in the terminal/);
    assert.equal(stored(), before);
  } finally { await app.close(); }
});

test('the Shortcuts tab is grouped by the registry and names what is unavailable here (board 316)', async context => {
  const host = { connected: true, hub: false, page: 'hub', terminalTarget: false, servers: 1, splitEligible: false, sidebarPage: true };
  const app = await mount(context, { tab: 'shortcuts', props: { showShortcuts: true, shortcutHost: host } });
  try {
    const groups = [...app.document.querySelectorAll('.shortcut-group')].map((g) => g.textContent?.trim());
    assert.equal(JSON.stringify(groups), JSON.stringify(['Pages', 'Servers', 'Panels', 'Terminal windows']));
    const row = (label: string) => app.document.querySelector<HTMLButtonElement>(`[data-shortcut-recorder][aria-label="${label}"]`)!;
    assert.equal(row('Go to Chat').disabled, true, 'no Hub on this server');
    assert.equal(row('Next server').disabled, true, 'one saved server');
    assert.equal(row('Split screen on or off').disabled, true, 'too narrow');
    assert.equal(row('Go to Files').disabled, false);
    assert.equal(row('Next terminal window').disabled, false, 'a page scope is not a refusal');
    const notes = [...app.document.querySelectorAll('.preference-row .config-note')].map((n) => n.textContent?.trim());
    assert.ok(notes.includes('This server has no Chat') && notes.includes('Needs a second saved server') && notes.includes('Needs a wider desktop window'));
  } finally { await app.close(); }
});

test('category exits use the embedded guard, with Back still delegated first', async context => {
  let apply: (() => void) | undefined;
  let registered: AgentProps | undefined;
  let back!: () => boolean;
  let backs = 0;
  const app = await mount(context, {
    tab: 'agents', props: { showAgents: true, onGoBack: (fn: () => boolean) => { back = fn; } },
    agent(props) {
      registered = props;
      props.onGuardExit?.(action => { apply = action; });
      props.onGoBack(() => { backs++; return true; });
    },
  });
  try {
    await app.click('Appearance');
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'agents');
    assert.equal(app.document.querySelector('.preferences')?.classList.contains('config-compact'), false,
      '#162: a pending category exit cannot apply compact metrics to the still-mounted Agent editor');
    assert.ok(apply, 'Preferences sends the intent to the child');
    assert.equal(back(), true);
    assert.equal(backs, 1);
    assert.equal(registered!.section, 'agents');
    apply();
    await app.flush();
    assert.equal(app.window.localStorage.getItem('tmux_settings_tab'), 'appearance');
    assert.equal(app.document.querySelector('.preferences')?.classList.contains('config-compact'), true,
      '#162: the accepted Settings category opts in without remounting its host');
  } finally { await app.close(); }
});

test('a pending child may replay an external exit later without another request', async context => {
  let replay!: () => void;
  let child!: AgentProps;
  let calls = 0;
  const app = await mount(context, {
    tab: 'teams', props: { showAgents: true },
    agent(props) {
      child = props;
      props.onGuardExit?.(action => { calls++; replay = action; });
    },
  });
  try {
    await app.update({ openRequest: { tab: 'agents', n: 1 }, agentsEditRequest: { serverId: 'test', name: 'alice', n: 7 } });
    await app.flush();
    assert.equal(calls, 1, 'host does not poll the guard');
    assert.equal(child.section, 'teams');
    replay();
    await app.flush();
    assert.equal(child.section, 'agents');
    assert.equal(child.editRequest?.n, 7);
    await app.update({ openRequest: { tab: 'agents', n: 1 } });
    assert.equal(calls, 1, 'only an applied request is consumed');
  } finally { await app.close(); }
});

test('external category requests and Agent edits wait for approval; old exits cannot win', async context => {
  const exits: Array<() => void> = [];
  let child!: AgentProps;
  const edit = () => child.editRequest;
  const app = await mount(context, {
    tab: 'teams', props: { showAgents: true },
    agent(props) { child = props; props.onGuardExit?.(action => { exits.push(action); }); },
  });
  try {
    await app.update({ openRequest: { tab: 'agents', n: 1 }, agentsEditRequest: { serverId: 'test', name: 'alice', n: 1 } });
    assert.equal(child.section, 'teams');
    assert.equal(edit(), null, 'the Agent request must not leak into Teams');
    assert.equal(exits.length, 1);
    // A rejected request was not consumed; presenting that same request again
    // must still offer the guard. A later category click invalidates old actions.
    await app.update({ openRequest: { tab: 'agents', n: 1 } });
    assert.equal(exits.length, 2);
    await app.click('Skills');
    assert.equal(exits.length, 3);
    exits[0]!();
    await app.flush();
    assert.equal(child.section, 'teams');
    exits[2]!();
    await app.flush();
    assert.equal(child.section, 'skills');
    await app.update({ openRequest: { tab: 'agents', n: 1 } });
    assert.equal(exits.length, 4, 'consumption waits until the jump applies');
    exits[3]!();
    await app.flush();
    assert.equal(child.section, 'agents');
    assert.equal(edit()?.name, 'alice');
  } finally { await app.close(); }
});

// Board #423 review P2-B: the permission caption is the switch's snapshot, so
// an unmute from the centre — with Settings open beside it — updates both the
// switch and the caption; a deferred grant shows the change only once it lands.
const withCentre = compileMount(new URL('./Preferences.centre.test.svelte', import.meta.url), [
  new URL('../hub/AgentsPage.svelte', import.meta.url),
]);

test('an unmute from the centre updates Settings  switch and its permission caption (#423)', async context => {
  const grant = deferred<string>();
  const app = await (await withCentre).mount(context, {
    props: { initial: {} },
    modules: [{ default: () => {} }],
    setup(window) {
      window.localStorage.setItem('tmux_settings_tab', 'notifications');
      window.localStorage.setItem('tmux_locale', 'en');
      window.localStorage.setItem('tmux_notify', 'off');
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.Audio = class { play() { return Promise.resolve(); } };
      window.Notification = class {
        static permission = 'denied';
        static requestPermission() { return grant.promise.then((p: string) => { (window.Notification as any).permission = p; return p; }); }
      };
    },
  });
  const settle = async () => { for (let i = 0; i < 6; i++) await app.flush(); };
  const toggle = () => app.document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  const caption = () => app.document.querySelector('.preference-row .pref-label')?.textContent ?? '';
  try {
    await settle();
    assert.equal(toggle().getAttribute('aria-checked'), 'false');
    assert.match(caption(), /blocked; sound only/u, 'denied before');
    app.document.querySelector<HTMLButtonElement>('.centre-host button[aria-label="Mute notifications"]')!.click();
    await settle();
    assert.equal(toggle().getAttribute('aria-checked'), 'true', 'Settings shows the switch the centre turned on');
    assert.match(caption(), /blocked; sound only/u, 'the grant has not landed yet');
    grant.resolve('granted');
    await settle();
    assert.doesNotMatch(caption(), /sound only/u, 'the caption follows the grant');
  } finally { grant.resolve('granted'); await app.close(); }
});

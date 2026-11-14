import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SHORTCUTS, SHORTCUT_GROUPS, actionForShortcut, cycleItem, defaultBindings, dispatchShortcut, migrateBindings,
  reservedReason, resolveDefault, shortcutFromEvent, shortcutLabel, type ShortcutHost,
} from './shortcuts.ts';

type Ev = Partial<KeyboardEvent> & { altGraph?: boolean };
function event(code: string, modifiers: Ev = {}): KeyboardEvent & { prevented: boolean } {
  const { altGraph = false, ...rest } = modifiers;
  const e = {
    code, key: '', keyCode: 0, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, prevented: false,
    getModifierState: (m: string) => m === 'AltGraph' && altGraph,
    preventDefault() { e.prevented = true; }, stopPropagation() {},
    ...rest,
  };
  return e as unknown as KeyboardEvent & { prevented: boolean };
}

test('normalizes Command and Option shortcuts by physical key', () => {
  assert.equal(shortcutFromEvent(event('KeyU', { metaKey: true })), 'Meta+KeyU');
  assert.equal(shortcutFromEvent(event('KeyI', { altKey: true })), 'Alt+KeyI');
  assert.equal(shortcutFromEvent(event('KeyK', { shiftKey: true })), '');
});

test('labels: compact glyphs on macOS, words elsewhere, punctuation by name', () => {
  assert.equal(shortcutLabel('Meta+Shift+KeyT', true), '⌘⇧T');
  assert.equal(shortcutLabel('Meta+Alt+BracketRight', true), '⌘⌥]');
  assert.equal(shortcutLabel('Ctrl+Alt+Digit3', false), 'Ctrl+Alt+3');
  assert.equal(shortcutLabel('', true), '—');
});

test('the registry: unique ids, every group used, every default resolvable and unique per platform (board 316)', () => {
  const ids = SHORTCUTS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const g of SHORTCUT_GROUPS) assert.ok(SHORTCUTS.some((s) => s.group === g), `${g} has actions`);
  // The six pre-316 ids keep their storage keys.
  for (const id of ['previousPage', 'nextPage', 'previousWindow', 'nextWindow', 'openTerminal', 'openFiles']) assert.ok(ids.includes(id), id);
  for (const mac of [true, false]) {
    const d = defaultBindings(mac);
    const values = Object.values(d).filter(Boolean);
    assert.equal(new Set(values).size, values.length, `no two defaults share a combo (mac=${mac})`);
    for (const [id, v] of Object.entries(d)) assert.equal(reservedReason(v, mac), '', `${id} default ${v} is not reserved (mac=${mac})`);
  }
  assert.equal(resolveDefault('Mod2+Digit1', true), 'Meta+Alt+Digit1');
  assert.equal(resolveDefault('Mod2+Digit1', false), 'Ctrl+Alt+Digit1');
});

test('no default on either platform is a terminal control key (validator, board 316)', () => {
  for (const mac of [true, false]) {
    for (const [id, v] of Object.entries(defaultBindings(mac))) {
      const mods = v.split('+').slice(0, -1);
      assert.ok(!(mods.includes('Ctrl') && !mods.includes('Alt') && !mods.includes('Meta')), `${id} = ${v} is a Ctrl-only chord (mac=${mac})`);
    }
  }
  // And a user cannot bind one either, on any platform.
  for (const mac of [true, false]) {
    assert.equal(reservedReason('Ctrl+KeyU', mac), 'shortcutReservedTerminal');
    assert.equal(reservedReason('Ctrl+Backslash', mac), 'shortcutReservedTerminal');
    assert.equal(reservedReason('Ctrl+Shift+KeyL', mac), 'shortcutReservedTerminal');
    assert.equal(reservedReason('Ctrl+Alt+KeyS', mac), '', 'a full Ctrl+Alt chord is not a control key');
  }
});

test('reserved combos are refused with a reason; ordinary ones are not', () => {
  assert.equal(reservedReason('Meta+KeyT', true), 'shortcutReservedBrowser', 'new tab');
  assert.equal(reservedReason('Meta+Shift+KeyT', true), 'shortcutReservedBrowser', 'reopen tab');
  assert.notEqual(reservedReason('Ctrl+KeyW', false), '', 'close tab');
  assert.equal(reservedReason('Meta+Digit2', true), 'shortcutReservedBrowser', 'tab 2');
  assert.equal(reservedReason('Alt+Digit2', false), 'shortcutReservedBrowser', 'tab 2 on Linux');
  assert.equal(reservedReason('Meta+Alt+KeyI', true), 'shortcutReservedBrowser', 'devtools');
  assert.equal(reservedReason('Ctrl+Shift+KeyJ', false), 'shortcutReservedBrowser', 'devtools');
  assert.equal(reservedReason('Meta+Shift+Digit4', true), 'shortcutReservedSystem', 'macOS screenshot');
  assert.equal(reservedReason('Meta+KeyH', true), 'shortcutReservedSystem', 'hide');
  assert.equal(reservedReason('Ctrl+Alt+KeyT', false), 'shortcutReservedSystem', 'Linux terminal');
  assert.equal(reservedReason('Meta+KeyU', true), '');
  assert.equal(reservedReason('Meta+Alt+Digit2', true), '');
  assert.equal(reservedReason('Meta+Alt+KeyK', true), 'shortcutReservedBrowser', 'Firefox console');
  assert.equal(reservedReason('Meta+Alt+KeyM', true), 'shortcutReservedSystem', 'minimize all');
  assert.equal(reservedReason('Alt+KeyI', false), '');
});

test('migration: stored choices stay, legacy and reserved defaults follow the new default, conflicts resolve to the choice', () => {
  const d = defaultBindings(true);
  // The old full-object store: every id at its old default, openTerminal on ⌘T (reserved).
  const legacy = { previousPage: 'Meta+KeyU', nextPage: 'Meta+KeyI', previousWindow: 'Alt+KeyU', nextWindow: 'Alt+KeyI', openTerminal: 'Meta+KeyT', openFiles: 'Meta+KeyF' };
  const m = migrateBindings(legacy, true);
  assert.equal(m.openTerminal, d.openTerminal, '⌘T never reached the page: re-defaulted');
  assert.equal(m.openFiles, d.openFiles, 'an untouched legacy default follows the new one');
  assert.equal(m.goHub, d.goHub, 'new ids get their defaults');
  // A user choice survives, and a new default that lands on it gives way.
  const chosen = migrateBindings({ previousPage: 'Meta+Alt+Digit1', bogus: 'Meta+KeyZ' }, true);
  assert.equal(chosen.previousPage, 'Meta+Alt+Digit1');
  assert.equal(chosen.goHub, '', 'goHub’s default met a stored choice: unbound, never a duplicate');
  assert.ok(!('bogus' in chosen));
  assert.equal(migrateBindings({ nextPage: '' }, true).nextPage, '', 'a cleared binding stays cleared');
  assert.equal(actionForShortcut(d, d.nextServer!), 'nextServer');
});

function host(over: Partial<ShortcutHost> = {}): ShortcutHost & { calls: string[] } {
  const calls: string[] = [];
  const h = {
    connected: true, hub: true, page: 'hub', terminalTarget: true, servers: 2, splitEligible: true, sidebarPage: true,
    goTo: (p: string) => calls.push(`goTo ${p}`), cyclePage: (d: number) => calls.push(`page ${d}`),
    cycleServer: (d: number) => calls.push(`server ${d}`), openServers: () => calls.push('servers'),
    toggleSidebar: () => calls.push('sidebar'), toggleSplit: () => calls.push('split'),
    focusComposer: () => calls.push('composer'), focusTerminal: () => calls.push('terminal'),
    cycleWindow: (d: number) => calls.push(`window ${d}`), toggleScratch: () => calls.push('scratch'), calls, ...over,
  };
  return h;
}

test('every action runs one host primitive, and says why when it cannot', () => {
  for (const def of SHORTCUTS) {
    const h = host({ page: def.group === 'terminal' ? 'terminal' : 'hub' });
    assert.equal(def.need(h), '', `${def.id} is available in a full context`);
    def.run(h);
    assert.equal(h.calls.length, 1, `${def.id} calls exactly one primitive`);
  }
  const need = (id: string, over: Partial<ShortcutHost>) => SHORTCUTS.find((s) => s.id === id)!.need(host(over));
  assert.equal(need('goHub', { hub: false }), 'shortcutNeedHub');
  assert.equal(need('nextServer', { servers: 1 }), 'shortcutNeedServers');
  assert.equal(need('toggleSplit', { splitEligible: false }), 'shortcutNeedWide');
  assert.equal(need('nextWindow', { page: 'files' }), 'shortcutNeedTerminalPage');
  assert.equal(need('openFiles', { connected: false }), 'shortcutNeedConnection');
  assert.equal(need('goSettings', { connected: false }), '', 'Settings works disconnected');
});

test('App’s handler reads only the registry: one lookup, one need check, one run (board 316)', async () => {
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  const handler = app.match(/const onShortcut = \(event\) => \{[\s\S]*?\n    \};/u)?.[0] ?? '';
  assert.match(handler, /dispatchShortcut\(event, shortcuts\.action, shortcutHost\);/u, 'the one dispatch: parse → binding → need → run');
  assert.doesNotMatch(handler, /action ===|'previousPage'|'openFiles'|shortcutFromEvent/u, 'no per-action branch, no second parse');
  const mod = await readFile(new URL('./shortcuts.ts', import.meta.url), 'utf8');
  const dispatch = mod.match(/export function dispatchShortcut[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.match(dispatch, /const def = shortcutDef\(actionOf\(shortcutFromEvent\(event\)\)\);\s*if \(!def \|\| def\.need\(host\)\) return '';/u);
  const prefs = await readFile(new URL('./Preferences.svelte', import.meta.url), 'utf8');
  assert.match(prefs, /function recordShortcut[\s\S]*?const value = shortcutFromEvent\(event\);/u, 'the recorder parses through the same entry');
  assert.match(app, /const shortcutsOn = \$derived\(!layout\.phone\);/u, 'the gate is the desktop form factor');
  assert.match(app, /showShortcuts=\{shortcutsOn\}/u);
  assert.doesNotMatch(app, /showShortcuts=\{isTauriDesktop\}/u);
  // Every rail page shows its binding on hover.
  const rail = /const RAIL_SHORTCUT = \{([^}]+)\}/u.exec(app)?.[1] ?? '';
  for (const slot of ['hub', 'board', 'terminal', 'files', 'agents', 'prefs']) assert.match(rail, new RegExp(`\\b${slot}: '`, 'u'), slot);
});

test('cycles page and window lists in both directions', () => {
  const items = ['sessions', 'terminal', 'team', 'files'];
  assert.equal(cycleItem(items, 'sessions', -1), 'files');
  assert.equal(cycleItem(items, 'files', 1), 'sessions');
  assert.equal(cycleItem(items, 'terminal', 1), 'team');
});

test('character input is never a shortcut: AltGr, IME composition, keyCode 229 (review P1)', () => {
  const bindings = defaultBindings(false);           // Ctrl+Alt defaults (Windows/Linux)
  const actionOf = (v: string) => actionForShortcut(bindings, v);
  const fire = (ev: KeyboardEvent & { prevented: boolean }) => {
    const h = host({ page: 'terminal' });
    const ran = dispatchShortcut(ev, actionOf, h);
    return { ran, calls: h.calls, prevented: ev.prevented };
  };
  // Polish AltGr+S types ś: with the AltGraph state, and without it (a browser
  // that reports AltGr as plain Ctrl+Alt) — neither opens the switcher.
  for (const ev of [
    event('KeyS', { ctrlKey: true, altKey: true, altGraph: true, key: 'ś' }),
    event('KeyS', { ctrlKey: true, altKey: true, key: 'ś' }),
    event('Digit7', { ctrlKey: true, altKey: true, key: '{' }),          // German AltGr+7
    event('KeyS', { ctrlKey: true, altKey: true, altGraph: true, key: 'Dead' }), // an AltGr dead key
    event('KeyS', { ctrlKey: true, altKey: true, key: 'Dead' }),        // the same, reported without the AltGraph state
    event('BracketRight', { ctrlKey: true, altKey: true, key: 'Dead' }),
    event('KeyS', { ctrlKey: true, altKey: true, isComposing: true, key: 's' }),
    event('KeyS', { ctrlKey: true, altKey: true, keyCode: 229, key: 'Process' }),
  ]) {
    const r = fire(ev);
    assert.equal(r.ran, '', `not a shortcut: ${ev.key}`);
    assert.deepEqual(r.calls, [], 'nothing navigated or switched');
    assert.equal(r.prevented, false, 'the character reaches the terminal');
  }
  // The real chord still fires.
  const real = fire(event('KeyS', { ctrlKey: true, altKey: true, key: 's' }));
  assert.equal(real.ran, 'openServers');
  assert.deepEqual(real.calls, ['servers']);
  assert.equal(real.prevented, true);
  assert.equal(fire(event('Digit3', { ctrlKey: true, altKey: true, key: '3' })).ran, 'openTerminal');
  assert.equal(fire(event('BracketRight', { ctrlKey: true, altKey: true, key: ']' })).ran, 'nextServer');
  // Plain Alt (the terminal window keys) is untouched by the AltGr rule.
  assert.equal(fire(event('KeyI', { altKey: true, key: 'i' })).ran, 'nextWindow');
  // The same parse entry serves the recorder: it yields no combo for typing.
  assert.equal(shortcutFromEvent(event('KeyS', { ctrlKey: true, altKey: true, altGraph: true, key: 'ś' })), '');
  assert.equal(shortcutFromEvent(event('KeyS', { ctrlKey: true, altKey: true, isComposing: true })), '');
});

test('the scratch terminal has a registry shortcut, ⌘⌥` / Ctrl+Alt+`, free of the reserved chords (#324)', () => {
  const def = SHORTCUTS.find((x) => x.id === 'toggleScratch')!;
  assert.equal(def.default, 'Mod2+Backquote');
  for (const mac of [true, false]) {
    const b = defaultBindings(mac);
    assert.ok(b.toggleScratch, `bound on ${mac ? 'mac' : 'other'}`);
    assert.equal(reservedReason(b.toggleScratch!, mac), '', 'not a system or browser chord');
    assert.equal(Object.values(b).filter((v) => v === b.toggleScratch).length, 1, 'no other action shares it');
  }
  const h = host();
  def.run(h);
  assert.deepEqual(h.calls, ['scratch']);
  assert.equal(def.need(host({ connected: false })), 'shortcutNeedConnection');
});

// Desktop keyboard shortcuts (board 316): ONE registry. Every action is
// declared here once — its id (the storage key), label, group, default and
// what it needs — and both App's handler and the Settings › Shortcuts tab are
// derived from it. App supplies a ShortcutHost (the primitives the actions
// call); there is no per-action branch anywhere else.
//
// The gate is the desktop FORM FACTOR (a pointer and a keyboard, i.e. not the
// touch layout), not the Tauri shell: the owner runs the app in a desktop
// browser, where the old isTauriDesktop gate hid the tab and the handler, and
// "the shortcuts don't work" (owner, 2026-10-08).

export const SHORTCUT_STORAGE_KEY = 'tmux_shortcuts';

export type ShortcutGroup = 'pages' | 'servers' | 'panels' | 'terminal';
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['pages', 'servers', 'panels', 'terminal'];

/** What the actions can do and know. App implements it. */
export interface ShortcutHost {
  connected: boolean;
  hub: boolean;               // the server hosts the Hub (hub / board / agents pages)
  page: string;
  terminalTarget: boolean;    // a pane is open
  servers: number;            // saved servers
  splitEligible: boolean;     // a wide desktop window
  sidebarPage: boolean;       // the current page has the shell sidebar
  goTo(page: string): void;
  cyclePage(direction: number): void;
  cycleServer(direction: number): void;
  openServers(): void;
  toggleSidebar(): void;
  toggleSplit(): void;
  focusComposer(): void;
  focusTerminal(): void;
  cycleWindow(direction: number): void;
  toggleScratch(): void;
}

/** '' = available; otherwise the i18n key of the reason it is not. A reason
 * means "not here, not now": the key is left to the browser. */
type Need = (h: ShortcutHost) => string;
const connected: Need = (h) => (h.connected ? '' : 'shortcutNeedConnection');
const hub: Need = (h) => connected(h) || (h.hub ? '' : 'shortcutNeedHub');

export interface ShortcutDef {
  id: string;
  label: string;
  group: ShortcutGroup;
  /** Platform-neutral default: `Mod` is ⌘ on macOS and Ctrl elsewhere;
   * `Mod2` is ⌘⌥ on macOS and Ctrl+Alt elsewhere. An object picks a
   * different key per platform. */
  default: string | { mac: string; other: string };
  need: Need;
  run: (h: ShortcutHost) => void;
}

// Defaults are chosen OUTSIDE three things (board 316 review):
//  - what a browser or the OS keeps (reservedReason);
//  - the terminal's control keys: a chord whose only modifier is Ctrl (with
//    or without Shift) is ^U / ^I / ^\ … in the shell, and the handler runs
//    over the terminal, so it is refused on every platform (AGENTS.md rule 7);
//  - character input: on Windows/Linux the second modifier is Alt, i.e.
//    Ctrl+Alt, which is what AltGr reports — so the parse entry drops AltGr
//    and IME events before any binding is looked up (shortcutFromEvent).
// `Mod` is ⌘ on macOS, Ctrl elsewhere; `Mod2` is ⌘⌥ / Ctrl+Alt. The six ids
// from before board 316 keep their storage keys.
export const SHORTCUTS: readonly ShortcutDef[] = Object.freeze([
  { id: 'previousPage', label: 'shortcutPreviousPage', group: 'pages', default: { mac: 'Mod+KeyU', other: 'Mod2+KeyU' }, need: connected, run: (h) => h.cyclePage(-1) },
  { id: 'nextPage', label: 'shortcutNextPage', group: 'pages', default: { mac: 'Mod+KeyI', other: 'Mod2+KeyI' }, need: connected, run: (h) => h.cyclePage(1) },
  { id: 'goHub', label: 'shortcutGoHub', group: 'pages', default: 'Mod2+Digit1', need: hub, run: (h) => h.goTo('hub') },
  { id: 'goBoard', label: 'shortcutGoBoard', group: 'pages', default: 'Mod2+Digit2', need: hub, run: (h) => h.goTo('board') },
  { id: 'openTerminal', label: 'shortcutOpenTerminal', group: 'pages', default: 'Mod2+Digit3', need: connected, run: (h) => h.goTo('terminal') },
  { id: 'openFiles', label: 'shortcutOpenFiles', group: 'pages', default: 'Mod2+Digit4', need: connected, run: (h) => h.goTo('files') },
  { id: 'goAgents', label: 'shortcutGoAgents', group: 'pages', default: 'Mod2+Digit5', need: hub, run: (h) => h.goTo('agents') },
  { id: 'goSettings', label: 'shortcutGoSettings', group: 'pages', default: 'Mod2+Digit6', need: () => '', run: (h) => h.goTo('prefs') },
  { id: 'previousServer', label: 'shortcutPreviousServer', group: 'servers', default: 'Mod2+BracketLeft',
    need: (h) => (h.servers > 1 ? '' : 'shortcutNeedServers'), run: (h) => h.cycleServer(-1) },
  { id: 'nextServer', label: 'shortcutNextServer', group: 'servers', default: 'Mod2+BracketRight',
    need: (h) => (h.servers > 1 ? '' : 'shortcutNeedServers'), run: (h) => h.cycleServer(1) },
  { id: 'openServers', label: 'shortcutOpenServers', group: 'servers', default: 'Mod2+KeyS', need: connected, run: (h) => h.openServers() },
  { id: 'toggleSidebar', label: 'shortcutToggleSidebar', group: 'panels', default: { mac: 'Mod+Backslash', other: 'Mod2+Backslash' },
    need: (h) => connected(h) || (h.sidebarPage ? '' : 'shortcutNeedSidebarPage'), run: (h) => h.toggleSidebar() },
  { id: 'toggleSplit', label: 'shortcutToggleSplit', group: 'panels', default: { mac: 'Mod2+Backslash', other: 'Mod2+Digit0' },
    need: (h) => connected(h) || (h.splitEligible ? '' : 'shortcutNeedWide'), run: (h) => h.toggleSplit() },
  { id: 'focusComposer', label: 'shortcutFocusComposer', group: 'panels', default: { mac: 'Mod2+Semicolon', other: 'Mod2+KeyM' }, need: hub, run: (h) => h.focusComposer() },
  { id: 'focusTerminal', label: 'shortcutFocusTerminal', group: 'panels', default: { mac: 'Mod2+Quote', other: 'Mod2+KeyK' },
    need: (h) => connected(h) || (h.terminalTarget ? '' : 'shortcutNeedPane'), run: (h) => h.focusTerminal() },
  // Board #324: the scratch terminal, from any page (⌘⌥` / Ctrl+Alt+`).
  { id: 'toggleScratch', label: 'shortcutToggleScratch', group: 'panels', default: 'Mod2+Backquote', need: connected, run: (h) => h.toggleScratch() },
  { id: 'previousWindow', label: 'shortcutPreviousWindow', group: 'terminal', default: 'Alt+KeyU',
    need: (h) => connected(h) || (h.page === 'terminal' ? '' : 'shortcutNeedTerminalPage'), run: (h) => h.cycleWindow(-1) },
  { id: 'nextWindow', label: 'shortcutNextWindow', group: 'terminal', default: 'Alt+KeyI',
    need: (h) => connected(h) || (h.page === 'terminal' ? '' : 'shortcutNeedTerminalPage'), run: (h) => h.cycleWindow(1) },
] satisfies ShortcutDef[]);

export type ShortcutAction = string;
export const shortcutDef = (id: string) => SHORTCUTS.find((s) => s.id === id);

export const isMac = (platform = typeof navigator === 'undefined' ? '' : navigator.platform) => /Mac|iPhone|iPad/u.test(platform);

/** A default with `Mod` / `Mod2` resolved for this platform. */
export function resolveDefault(value: ShortcutDef['default'], mac = isMac()): string {
  const v = typeof value === 'string' ? value : mac ? value.mac : value.other;
  return v.replace(/^Mod2\+/u, mac ? 'Meta+Alt+' : 'Ctrl+Alt+').replace(/^Mod\+/u, mac ? 'Meta+' : 'Ctrl+');
}
export function defaultBindings(mac = isMac()): Record<string, string> {
  return Object.fromEntries(SHORTCUTS.map((s) => [s.id, resolveDefault(s.default, mac)]));
}

/** The defaults the six pre-316 ids shipped with: a stored copy of one of
 * these is a default the user never chose, so it follows the new default. */
const LEGACY_DEFAULTS: Record<string, string> = {
  previousPage: 'Meta+KeyU', nextPage: 'Meta+KeyI', previousWindow: 'Alt+KeyU',
  nextWindow: 'Alt+KeyI', openTerminal: 'Meta+KeyT', openFiles: 'Meta+KeyF',
};

/** Stored bindings → the current registry. Unknown ids are dropped; a value
 * the browser would never deliver (a reserved combo) falls back to the
 * default; a legacy default is re-defaulted; any other stored choice stays. */
export function migrateBindings(stored: unknown, mac = isMac()): Record<string, string> {
  const defaults = defaultBindings(mac);
  const raw = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const s of SHORTCUTS) {
    const v = raw[s.id];
    if (typeof v !== 'string') { out[s.id] = defaults[s.id]!; continue; }
    if (v && (reservedReason(v, mac) || LEGACY_DEFAULTS[s.id] === v)) { out[s.id] = defaults[s.id]!; continue; }
    out[s.id] = v;
  }
  // Two ids on one combo (a new default met an old stored choice): the
  // user's stored choice keeps it, the default gives way.
  const owner = new Map<string, string>();
  for (const s of SHORTCUTS) {
    const v = out[s.id]!;
    if (!v) continue;
    const other = owner.get(v);
    if (!other) { owner.set(v, s.id); continue; }
    const chosen = raw[s.id] === v;
    if (chosen) { out[other] = ''; owner.set(v, s.id); } else out[s.id] = '';
  }
  return out;
}

/**
 * Combos the page never receives, or must not take: the browsers keep them
 * (Chrome, Safari and Firefox do not let a page prevent new tab / window /
 * close / quit, tab switching, or the developer tools), or the OS does
 * (macOS screenshots, hide, minimize, Spotlight, app switching). Conservative
 * on purpose: a refused combo costs a second try; an accepted one that never
 * fires is the "shortcuts don't work" report again. Returns the i18n key of
 * the reason, '' when the combo is usable.
 */
export function reservedReason(value: string, mac = isMac()): string {
  const parts = value.split('+');
  const code = parts.at(-1) ?? '';
  const mod = new Set(parts.slice(0, -1));
  const primary = mod.has(mac ? 'Meta' : 'Ctrl');
  const plain = !mod.has('Alt');
  if (mac && mod.has('Meta')) {
    if (mod.has('Shift') && ['Digit3', 'Digit4', 'Digit5'].includes(code)) return 'shortcutReservedSystem';
    if (plain && ['KeyH', 'KeyM', 'Space', 'Backquote'].includes(code)) return 'shortcutReservedSystem';
  }
  if (primary && plain && ['KeyN', 'KeyT', 'KeyW', 'KeyQ', 'Tab'].includes(code)) return 'shortcutReservedBrowser';
  if (mod.has('Ctrl') && code === 'Tab') return 'shortcutReservedBrowser';
  if (primary && plain && /^Digit[1-9]$/u.test(code)) return 'shortcutReservedBrowser'; // tab N
  if (!mac && mod.has('Alt') && !mod.has('Ctrl') && !mod.has('Meta') && /^Digit[1-9]$/u.test(code)) return 'shortcutReservedBrowser'; // Linux tab N
  // Developer tools and page source: ⌘⌥I/J/C/U, Ctrl+Shift+I/J/C.
  // Developer tools on macOS: ⌘⌥I/J/C/U, and Firefox's ⌘⌥K console.
  if (mac && mod.has('Meta') && mod.has('Alt') && ['KeyI', 'KeyJ', 'KeyC', 'KeyU', 'KeyK'].includes(code)) return 'shortcutReservedBrowser';
  if (mac && mod.has('Meta') && mod.has('Alt') && ['KeyM', 'KeyH', 'KeyD', 'Space', 'Escape'].includes(code)) return 'shortcutReservedSystem'; // minimize all, hide others, Dock, Finder search, Force Quit
  // Ctrl+Shift letters Chrome/Firefox keep (devtools panels, bookmarks,
  // private window, reopen tab, screenshots, clear data).
  if (!mac && mod.has('Ctrl') && mod.has('Shift') && !mod.has('Alt')
    && ['KeyB', 'KeyC', 'KeyE', 'KeyI', 'KeyJ', 'KeyK', 'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyS', 'KeyT', 'KeyW', 'Delete'].includes(code)) return 'shortcutReservedBrowser';
  if (!mac && mod.has('Ctrl') && mod.has('Alt') && ['KeyT', 'Delete'].includes(code)) return 'shortcutReservedSystem';
  // The terminal's control keys, every platform: Ctrl as the only modifier
  // besides Shift (^U kill line, ^I Tab, ^\ SIGQUIT, ^C …).
  if (mod.has('Ctrl') && !mod.has('Alt') && !mod.has('Meta')) return 'shortcutReservedTerminal';
  return '';
}

const MODIFIER_CODES = new Set([
  'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight',
  'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight',
]);

/** The one "is this character input?" predicate: an IME composition
 * (isComposing / 229), AltGr (its modifier state), or a dead key (`Dead`: a
 * composition start, whatever modifiers it is reported with). The handler
 * (through shortcutFromEvent) and the recorder (before any of its own key
 * handling) both ask it, so no key that is typing can act. */
export function isCharacterInput(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || event.key === 'Dead') return true;
  return typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
}

/** THE parse entry, used by the handler and the recorder alike (board 316
 * review): an event that is character input is never a shortcut — an IME
 * composition (isComposing / keyCode 229), or AltGr, which Windows and Linux
 * report as Ctrl+Alt while it types a character. Plain Alt stays usable (the
 * terminal window keys use it). */
export function shortcutFromEvent(event: KeyboardEvent): string {
  if (!event.code || MODIFIER_CODES.has(event.code)) return '';
  if (isCharacterInput(event)) return '';
  // A browser that reports AltGr as plain Ctrl+Alt (no AltGraph state) still
  // gives the TYPED character as `key` (Polish AltGr+S → 'ś', German AltGr+7 →
  // '{'). A real Ctrl+Alt chord's key is the key's own base character, so a
  // different printable character means typing, not a chord.
  if (event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && typedOther(event)) return '';
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return '';
  const parts = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.code);
  return parts.join('+');
}

/** The character a key types unmodified, for codes that type one. */
function baseChar(code: string): string {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  return ({ BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Comma: ',', Period: '.',
    Slash: '/', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=' } as Record<string, string>)[code] ?? '';
}
function typedOther(event: KeyboardEvent): boolean {
  const key = event.key ?? '';
  if ([...key].length !== 1) return false;   // Unidentified, Dead, named keys
  const base = baseChar(event.code);
  return !!base && key.toLowerCase() !== base;
}

const KEY_LABELS: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Comma: ',', Period: '.',
  Slash: '/', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=', Space: 'Space',
};

export function shortcutLabel(value: string | null | undefined, mac = isMac()): string {
  if (!value) return '—';
  const parts = value.split('+');
  const key = parts.pop()!;
  const name = KEY_LABELS[key] ?? key.replace(/^Key([A-Z])$/u, '$1').replace(/^Digit([0-9])$/u, '$1');
  const mods = parts.map((m) => (mac
    ? ({ Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' } as Record<string, string>)[m] ?? m
    : `${({ Meta: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' } as Record<string, string>)[m] ?? m}+`));
  return mods.join('') + name;
}

/** The handler's whole decision, framework-free so it is testable with real
 * events: parse (character input is never a shortcut) → binding → the
 * action's need → run. Returns the action run, or '' when the key is left to
 * the page/browser. App adds only the input-target and modal checks. */
export function dispatchShortcut(event: KeyboardEvent, actionOf: (value: string) => string, host: ShortcutHost): string {
  const def = shortcutDef(actionOf(shortcutFromEvent(event)));
  if (!def || def.need(host)) return '';
  event.preventDefault();
  event.stopPropagation();
  def.run(host);
  return def.id;
}

export function actionForShortcut(bindings: Record<string, string>, value: string): string {
  if (!value) return '';
  return SHORTCUTS.find((s) => bindings[s.id] === value)?.id || '';
}

export function cycleItem<T>(items: T[], current: T, direction: number): T | null {
  if (!items.length) return null;
  const index = items.indexOf(current);
  const start = index >= 0 ? index : 0;
  return items[(start + direction + items.length) % items.length]!; // modulo keeps the index in range
}

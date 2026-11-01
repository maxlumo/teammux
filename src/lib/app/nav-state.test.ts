import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, agentsLivesInSettings, defaultPage, landingPage, restoreNav, restorePage, retarget } from './nav-state.ts';

test('a saved tab is restored, and only a known one', () => {
  for (const p of PAGES) {
    assert.equal(restorePage(p), p, `${p} survives a reload`);
  }
  // The tab used to be dropped unless a terminal target was saved with it, so
  // reading the chat and refreshing landed on the device default.
  assert.equal(restorePage('hub'), 'hub', 'a phone may sit on the chat');
  assert.equal(restorePage('terminal'), 'terminal', 'a desktop may sit on the terminal');
});

test('anything else falls back to the default, Chat (#333)', () => {
  for (const bad of [undefined, null, '', 'crew', 'Hub', 42, {}, []]) {
    assert.equal(restorePage(bad), 'hub', `${JSON.stringify(bad)} lands on Chat`);
  }
  assert.equal(defaultPage(), 'hub', 'Chat on every form factor, phone included (#333)');
});

test('retarget follows a renamed session, and only that session', () => {
  assert.equal(retarget('old:1.0', 'old', 'new'), 'new:1.0');
  assert.equal(retarget('old:12.3', 'old', 'renamed-probe'), 'renamed-probe:12.3');
  // A name that merely STARTS with the old one is a different session.
  assert.equal(retarget('older:1.0', 'old', 'new'), 'older:1.0');
  assert.equal(retarget('other:1.0', 'old', 'new'), 'other:1.0');
  // Nothing to do, nothing broken.
  const noops: [string, string, string][] = [
    ['', 'old', 'new'], ['old:1.0', '', 'new'], ['old:1.0', 'old', ''], ['old:1.0', 'x', 'x'],
  ];
  for (const [target, from, to] of noops) assert.equal(retarget(target, from, to), target);
});

test('Agents is a Settings category on touch, a page on the desktop', () => {
  // One definition, because four places must agree or the page becomes
  // unreachable in one of them: the tab bar, the swipe order, the Settings
  // category list, and the Hub's "configure agent" jump.
  assert.equal(agentsLivesInSettings(true), true, 'a phone reaches it through Settings');
  assert.equal(agentsLivesInSettings(false), false, 'the desktop rail keeps it as a page');
});

test('a saved `agents` comes back as Settings on touch, never as a stranded page', () => {
  // On touch the icon is gone from the bottom bar and the swipe skips it, so a
  // saved 'agents' would restore a page with no way in and no way out.
  assert.deepEqual(restoreNav('agents', true), { page: 'prefs', settingsTab: 'agents' });
  // On the desktop it is still a page with its own draggable rail icon.
  assert.deepEqual(restoreNav('agents', false), { page: 'agents', settingsTab: null });
});

test('restoreNav is restorePage everywhere else, on both devices', () => {
  for (const p of PAGES) {
    if (p === 'agents') continue;
    assert.deepEqual(restoreNav(p, true), { page: restorePage(p), settingsTab: null }, `${p} on a phone`);
    assert.deepEqual(restoreNav(p, false), { page: restorePage(p), settingsTab: null }, `${p} on a desktop`);
  }
  for (const bad of [undefined, null, '', 'Agents', 'crew', 42, {}, ['agents']]) {
    assert.deepEqual(restoreNav(bad, true), { page: 'hub', settingsTab: null }, `${JSON.stringify(bad)} on a phone`);
    assert.deepEqual(restoreNav(bad, false), { page: 'hub', settingsTab: null }, `${JSON.stringify(bad)} on a desktop`);
  }
  // 'agents' is still a real page name — the redirect is about the DEVICE, not
  // about retiring the page (the rail needs it).
  assert.ok((PAGES as readonly string[]).includes('agents'));
});

// Board #491 (owner 2026-11-01: "每次好像重新连接之类的，或者首次打开的时候，好像默认页面总是 terminal
// 页面，应该是 chat 页面才对"), a restore-policy adjustment: a page reached by a jump out of
// Chat is SAVED as Chat; a page chosen directly is saved as itself (#333).
test('a page reached by a jump out of Chat is saved as Chat; one chosen directly as itself (#491)', () => {
  for (const p of ['terminal', 'files', 'board'] as const) {
    assert.equal(landingPage(p, 'hub'), 'hub', `a jumped ${p} reopens on Chat`);
    assert.equal(landingPage(p, null), p, `a ${p} chosen directly reopens there`);
  }
  for (const p of PAGES) {
    if (p === 'terminal' || p === 'files' || p === 'board') continue;
    assert.equal(landingPage(p, 'hub'), p, `${p} is never a jump target, so a stale origin cannot move it`);
  }
  assert.equal(landingPage('terminal', 'files'), 'terminal', 'only a jump out of Chat counts');
  // The saved value goes through the ordinary restore, unchanged.
  assert.equal(restorePage(landingPage('terminal', 'hub')), 'hub');
  assert.equal(restorePage(landingPage('terminal', null)), 'terminal');
});

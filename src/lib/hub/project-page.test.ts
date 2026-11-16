import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { capExpiry, contentHeight, decide, editedFields, fieldSnapshot, inProgress, pageSheet, playingMedia, staleness, PAGE_TOKENS } from './project-page.ts';

const head = (rev: number) => ({ rev, by: 'leader', at: 1 });
const T = 1_700_000_000_000; // ms
const doc = (rev: number, expSec = T / 1000 + 3600) => ({ rev, exp: expSec });

test('the cap expiry is read at its position after the door\u2019s own prefix; anything else is already expired (F4)', () => {
  assert.equal(capExpiry('http://gw:1/dl/s/1700014400/7.9/ab/L3A/.tmm/dashboard/3/', 'http://gw:1/dl/s/'), 1700014400);
  // Validator's fixture (note 30): a supported proxy prefix that itself holds /dl/s/<digits>/.
  const prefix = 'http://gw.test/proxy/dl/s/123/route/dl/s/';
  assert.equal(capExpiry(`${prefix}1794840782/1.2/${'1'.repeat(64)}/L3c/.tmm/dashboard/1/`, prefix), 1794840782);
  assert.ok(Number.isNaN(capExpiry('http://other/dl/s/9/x/', prefix)), 'not under its prefix');
  assert.ok(Number.isNaN(capExpiry(`${prefix}abc/1.2/x/`, prefix)), 'not digits at the position');
  assert.equal(staleness({ rev: 1, exp: Number.NaN }, head(1), T), 'outdated');
});

// The one adoption rule as a literal table (board-dashboard.md § 6; AC6 as
// amended by leader Q2): [doc, head, busy, now] -> decision.
test('decide: one adoption rule', () => {
  const rows: [ReturnType<typeof doc> | null, ReturnType<typeof head> | null | undefined, boolean, number, string][] = [
    [null, undefined, false, T, 'none'],          // the read could not say: nothing changes
    [doc(3), undefined, true, T, 'none'],
    [null, null, false, T, 'none'],               // no page: the section is absent (caller)
    [null, head(3), false, T, 'load'],            // first entry loads the newest
    [null, head(3), true, T, 'load'],
    [doc(3), head(3), false, T, 'none'],          // current
    [doc(3), head(3), true, T, 'none'],
    [doc(3), head(4), false, T, 'load'],          // newer, nothing in progress: adopted
    [doc(3), head(4), true, T, 'offer'],          // newer, in progress: Refresh offered
    [doc(3, T / 1000 - 1), head(3), false, T, 'load'], // past its 4 h, idle: reloads quietly (Q2)
    [doc(3, T / 1000 - 1), head(3), true, T, 'offer'], // past its 4 h, in progress: out of date + Refresh
    [doc(3, T / 1000), head(3), true, T, 'offer'],     // exp is exclusive: at exp it is out of date
  ];
  for (const [d, h, busy, now, want] of rows) {
    assert.equal(decide(d, h, busy, now), want, JSON.stringify({ d, h, busy }));
  }
  assert.equal(staleness(doc(3), head(4), T), 'newer');
  assert.equal(staleness(doc(3, T / 1000 - 1), head(4), T), 'newer', 'a newer revision is said first');
});

const page = (html: string) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

test('an edited field is one that differs from the page as it LOADED, not from an attribute (F3)', () => {
  const d = page(`
    <input id=t value="pre-filled"><input id=e><textarea id=a>draft</textarea>
    <input id=c type=checkbox checked><input id=r type=radio name=g><input id=r2 type=radio name=g checked>
    <select id=s><option>a</option><option selected>b</option></select>
    <select id=i><option>A</option><option>B</option></select>
    <input id=g type=range><input id=k type=color>
    <input type=hidden id=h value=1><input type=submit id=b value=Go>`);
  // The browser's own values of untouched controls (validator measured, Chromium and WebKit):
  // an implicit first option is selected with defaultSelected false; a range is 50 and a colour
  // #000000 with an empty defaultValue. jsdom is made to say the same here.
  const by = <T extends Element>(id: string) => d.getElementById(id) as unknown as T;
  by<HTMLInputElement>('g').value = '50';
  by<HTMLInputElement>('k').value = '#000000';
  const snap = fieldSnapshot(d);
  assert.equal(editedFields(d, snap), 0, 'untouched, whatever the attributes say');
  by<HTMLInputElement>('e').value = 'typed';
  assert.equal(editedFields(d, snap), 1);
  by<HTMLInputElement>('e').value = '';
  assert.equal(editedFields(d, snap), 0, 'typed and erased again is not an edit');
  by<HTMLTextAreaElement>('a').value = 'draft!';
  by<HTMLInputElement>('c').checked = false;
  by<HTMLInputElement>('r').checked = true;
  (d.getElementById('s') as HTMLSelectElement).selectedIndex = 0;
  (d.getElementById('i') as HTMLSelectElement).selectedIndex = 1;
  by<HTMLInputElement>('g').value = '70';
  by<HTMLInputElement>('k').value = '#ff0000';
  assert.equal(editedFields(d, snap), 8, 'textarea, checkbox, both radios, two selects, range, colour');
  by<HTMLInputElement>('h').value = '2';
  by<HTMLInputElement>('b').value = 'Stop';
  assert.equal(editedFields(d, snap), 8, 'hidden and button values are not the person\u2019s edits');
  assert.ok(inProgress(d, snap));
  assert.ok(!inProgress(null, snap));
});

test('playing media is in progress; paused or ended is not', () => {
  const d = page('<audio id=a></audio><video id=v></video>');
  const set = (id: string, paused: boolean, ended: boolean) => {
    const el = d.getElementById(id)!;
    Object.defineProperty(el, 'paused', { configurable: true, value: paused });
    Object.defineProperty(el, 'ended', { configurable: true, value: ended });
  };
  set('a', true, false); set('v', true, false);
  assert.equal(playingMedia(d), 0);
  assert.ok(!inProgress(d, fieldSnapshot(d)));
  set('a', false, false);
  assert.equal(playingMedia(d), 1);
  assert.ok(inProgress(d, fieldSnapshot(d)));
  set('a', false, true);
  assert.equal(playingMedia(d), 0, 'an ended track is not playing');
});

test('the height is the document block, rounded up', () => {
  const d = page('<p>x</p>');
  d.documentElement.getBoundingClientRect = () => ({ height: 412.2 } as DOMRect);
  assert.equal(contentHeight(d), 413);
});

test('the sheet carries the current token values and no literal of its own', () => {
  const values: Record<string, string> = Object.fromEntries(PAGE_TOKENS.map((n) => [n, ` value-of${n} `]));
  const dark = pageSheet((n) => values[n]!, true);
  assert.ok(dark.startsWith(':root{color-scheme:dark;--bg:value-of--bg;'), dark.slice(0, 60));
  for (const n of PAGE_TOKENS) assert.ok(dark.includes(`${n}:value-of${n}`), n);
  assert.ok(pageSheet((n) => values[n]!, false).startsWith(':root{color-scheme:light;'));
  const sheet = dark.slice(dark.indexOf('}') + 1);
  assert.doesNotMatch(sheet, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu, 'no literal colour');
  assert.doesNotMatch(sheet, /font-size:\s*(?!var\(--fs-)/iu, 'type sizes are the type steps only');
  assert.doesNotMatch(sheet, /font-family:\s*(?!var\(--font-)/iu, 'font families are the three roles only');
  for (const used of sheet.match(/var\(--[a-z0-9-]+\)/gu) ?? []) {
    assert.ok((PAGE_TOKENS as readonly string[]).includes(used.slice(4, -1)), `${used} is a token the frame receives`);
  }
});

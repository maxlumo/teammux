// Board #132 (design record #131): the Hub's drawer goes beside the chat only when the chat
// keeps its head's minimum and the drawer its own. Expected values are the ruled measurements
// and the owner's screens (content width = viewport − the 46 px rail), not recomputed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawerFits, CHAT_HEAD_MIN_FINE, CHAT_HEAD_MIN_COARSE, DRAWER_MIN } from './drawer-fit.ts';

test('the measured minimums (#131): the chat head 324 fine / 414 coarse, the drawer 320', () => {
  assert.equal(CHAT_HEAD_MIN_FINE, 324);
  assert.equal(CHAT_HEAD_MIN_COARSE, 414);
  assert.equal(DRAWER_MIN, 320);
});

test('the owner\'s screens, sidebar collapsed (0) and shown (240), touch', () => {
  const cases: [string, number, boolean, boolean][] = [
    ['776×717', 730, false, false],
    ['800×700', 754, true, false],
    ['900×820', 854, true, false],
    ['980×740', 934, true, false],
    ['1280×800', 1234, true, true],
  ];
  for (const [screen, content, collapsed, shown] of cases) {
    assert.equal(drawerFits({ content, sidebar: 0, coarse: true }), collapsed, `${screen} collapsed`);
    assert.equal(drawerFits({ content, sidebar: 240, coarse: true }), shown, `${screen} sidebar shown`);
  }
});

test('a fine pointer needs less: 644 is the first content width beside with the sidebar collapsed', () => {
  assert.equal(drawerFits({ content: 643, sidebar: 0, coarse: false }), false);
  assert.equal(drawerFits({ content: 644, sidebar: 0, coarse: false }), true);
  assert.equal(drawerFits({ content: 884, sidebar: 240, coarse: false }), true);
  assert.equal(drawerFits({ content: 883, sidebar: 240, coarse: false }), false);
});

test('an unmeasured width (0, NaN) never claims room it has not measured', () => {
  assert.equal(drawerFits({ content: 0, sidebar: 0, coarse: false }), false);
  assert.equal(drawerFits({ content: Number.NaN, sidebar: 0, coarse: false }), false);
});

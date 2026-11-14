// Auto's rule on the owner's screens (board #124). Each case is a panel from
// the owner's 2026 foldable table (physical px), converted to CSS px at the
// model's DPR, or a measured reading. The DPRs come from #124 note 1: Samsung
// 2.625 (stock 420 dpi), Apple 3, OPPO/vivo/Xiaomi assumed 2.75-3. None is
// measured on a device here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { autoPhone, PHONE_BELOW } from './layout-rule.ts';

const css = (px: number, dpr: number) => Math.round(px / dpr);

test('the threshold is the smallest side, 600 CSS px (Android sw600dp; leader #124 note 2)', () => {
  assert.equal(PHONE_BELOW, 600);
  assert.equal(autoPhone(599, 1000, true), true, 'one px below: phone');
  assert.equal(autoPhone(600, 1000, true), false, 'at the threshold: desktop');
  assert.equal(autoPhone(1000, 599, true), true, 'a landscape phone is still a phone: the SMALLEST side decides');
  assert.equal(autoPhone(1000, 600, true), false);
});

test('every outer screen in the owner\'s table is a phone (67-77 mm wide, 1120-1398 px physical)', () => {
  for (const [w, h, dpr, what] of [
    [1120, 1712, 2.625, 'narrowest outer at Samsung DPR'],
    [1120, 1712, 3, 'narrowest outer at DPR 3'],
    [1398, 2616, 2.625, 'widest outer at Samsung DPR (533 CSS px)'],
    [1398, 2616, 3, 'widest outer at DPR 3'],
    [1080, 2520, 2.625, 'Samsung Fold outer, 411 × 960 CSS px'],
  ] as const) {
    assert.equal(autoPhone(css(w, dpr), css(h, dpr), true), true, `${what}: ${css(w, dpr)} × ${css(h, dpr)}`);
    assert.equal(autoPhone(css(h, dpr), css(w, dpr), true), true, `${what}, rotated`);
  }
});

test('the inner screens are the desktop layout, in both orientations', () => {
  for (const [w, h, what] of [
    [717, 776, 'the owner\'s inner screen, measured from his screenshot (#124 note 3)'],
    [css(1848, 2.625), css(2184, 2.625), 'Fold8-class inner at 2.625: 704 × 832'],
    [749, 654, 'Fold7 inner, measured with the browser bar expanded (macmyths.com, #124 note 1)'],
    [css(2312, 2.625), css(2504, 2.625), 'widest inner at 2.625: 881 × 954'],
    [css(2312, 3), css(2504, 3), 'widest inner at 3: 771 × 835'],
    [css(1672, 2.625), css(2364, 2.625), 'narrowest inner at 2.625: 637 × 901'],
  ] as const) {
    assert.equal(autoPhone(w, h, true), false, `${what}`);
    assert.equal(autoPhone(h, w, true), false, `${what}, rotated`);
  }
});

test('known limit, open until the device reads it: the narrowest inner panel at DPR 3 is a phone', () => {
  // 1672 / 3 = 557 < 600 (#124 note 1). The leader rules the number again from
  // the owner's Settings → About reading, not before (note 2).
  assert.equal(autoPhone(css(1672, 3), css(2364, 3), true), true);
});

test('a screen that cannot be touched keeps the desktop layout however small its window', () => {
  assert.equal(autoPhone(400, 300, false), false, 'a narrow desktop browser window is not a phone');
  assert.equal(autoPhone(1280, 800, false), false);
});

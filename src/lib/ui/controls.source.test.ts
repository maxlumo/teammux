import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import { hoverGuard } from '../../../scripts/hover-guard.mjs';

const css = await readFile(new URL('../../app.css', import.meta.url), 'utf8');

test('compact entity fields share inline rows and content-aware narrow wrapping (#163)', () => {
  assert.match(css, /--config-entity-label:\s*110px/u);
  assert.match(css, /--config-entity-value:\s*360px/u);
  assert.match(css, /--config-entity-height:\s*44px/u);
  assert.match(css, /--config-editor-min:\s*128px/u);
  assert.match(css, /\.config-compact\.config-entity \{[^}]*--config-editor-min:\s*140px/u);
  assert.match(css, /\.config-entity \.config-row:has\(> label\.config-field\)/u);
  assert.match(css, /grid-template-columns:\s*minmax\(var\(--config-entity-label\), 1fr\) minmax\(0, var\(--config-entity-value\)\)/u);
  assert.match(css, /\.config-entity label\.config-field:has\(> input, > \.sel-trigger, > \.sel-combo\) \{\s*display: flex; flex-direction: row; flex-wrap: wrap/u,
    'short rows must override the base field column direction before using a horizontal label basis');
  assert.match(css, /flex:\s*1 1 max-content; width: auto; max-width: 100%/u);
  assert.match(css, /\.config-entity label\.config-field > :is\(input, \.sel-combo\) \{ flex-basis: 0; \}/u,
    'native 20-character input sizing must not force a short editable value onto another row');
  assert.doesNotMatch(css, /container-type:|contain:\s*(?:layout|paint)/u,
    'field rows must not become a containing block for fixed Selects');
});

test('checkbox legends inherit the same configuration label rhythm (#163)', async () => {
  const checkbox = await readFile(new URL('./CheckboxGroup.svelte', import.meta.url), 'utf8');
  assert.match(checkbox, /margin-bottom: var\(--config-label-gap, 8px\)/u);
  assert.match(checkbox, /font: var\(--config-label-weight, 600\) var\(--fs-ui\)/u);
});

test('compact controls separate paint from hit geometry without retuning terminal metrics (#161)', () => {
  // Owner selected #160, then asked for lower dropdowns. These replace #155's
  // painted 32/44px boxes, not its native touch-target or keyboard contracts.
  assert.match(css, /--control-height:\s*28px/u);
  assert.match(css, /--control-paint-inset:\s*2px/u);
  assert.match(css, /--control-field-inset:\s*2px/u);
  assert.match(css, /--control-icon-size:\s*16px/u);
  assert.match(css, /--config-width:\s*860px/u);
  assert.equal(/--config-width:\s*860px;\s*--config-editor-width:\s*(\d+)px;/u.exec(css)?.[1], '480',
    'the editing-column budget is shared beside the configuration canvas width (#156)');
  assert.match(css, /@media \(any-pointer: coarse\)[\s\S]*?--control-height:\s*44px/u);
  assert.match(css, /@media \(any-pointer: coarse\)[\s\S]*?--control-paint-inset:\s*6px/u);
  assert.match(css, /@media \(any-pointer: coarse\)[\s\S]*?--control-field-inset:\s*8px/u);
  assert.match(css, /--ui-control-height:\s*24px/u, 'legacy consumers migrate explicitly, never via a global size change');
  assert.match(css, /@supports \(-webkit-touch-callout: none\)[\s\S]*?@media \(any-pointer: coarse\)[\s\S]*?\.config-input \{ font-size: var\(--fs-input-touch\); \}/u,
    'the shared native field keeps the iOS no-auto-zoom exception');
});

test('configuration navigation rows have the approved pointer/touch floor (#156)', () => {
  assert.match(css, /--config-nav-height:\s*40px/u);
  assert.match(css, /@media \(any-pointer: coarse\)[^]*?--config-nav-height:\s*44px/u);
  assert.match(css, /\.config-navigation \.side-row \{ min-height: var\(--config-nav-height\); \}/u);
});

test('compact page rhythm is opt-in, while preference rows share one inline layout (#162)', () => {
  const compact = css.match(/\.config-compact \{([^}]+)\}/u)?.[1] ?? '';
  for (const [name, value] of [
    ['header-height', '44px'], ['nav-height', '36px'], ['label-gap', '6px'],
    ['field-gap', '12px'], ['section-gap', '20px'], ['form-inset', '12px'],
  ]) assert.ok(compact.includes(`--config-${name}: ${value};`), `${name} is explicit opt-in`);
  assert.match(css, /@media \(any-pointer: coarse\) \{\s*\.config-compact \{ --config-header-height: 56px; --config-nav-height: 44px;/u);
  const row = css.match(/\.preference-row \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(row, /display: grid/u);
  assert.match(row, /grid-template-columns: minmax\(var\(--config-pref-label\), 1fr\) minmax\(0, var\(--config-pref-value\)\)/u);
  assert.doesNotMatch(row, /flex-wrap/u, 'a 240px field floor must not force 390px rows into two lines');
  const control = css.match(/\.preference-row > \.pref-control \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(control, /min-width: 0/u);
  assert.doesNotMatch(control, /240px/u);
  // The compact row wraps from intrinsic content, not the old arbitrary 240px
  // floor. Fixed columns clipped English/custom-font commands at 360px.
  assert.match(css, /@media \(max-width: 760px\) \{\s*\.preference-row \{ display: flex; flex-wrap: wrap;/u);
  assert.match(css, /\.preference-row > \.pref-control \{ flex: 1 1 max-content; width: auto; \}/u);
});

test('compact control shapes have one explicit round policy, not flattened capsule caps (#161)', () => {
  assert.match(css, /--control-radius:\s*12px/u);
  assert.match(css, /--control-menu-radius:\s*16px/u);
  assert.match(css, /--control-dialog-radius:\s*22px/u);
  assert.match(css, /:where\(\s*\/\* shared vocabulary/u,
    'the legacy default cannot borrow a three-class selector weight and defeat a round variant');
  const round = css.match(/:is\(([^)]*\.control-field[^)]*)\) \{\s*corner-shape: round;/u)?.[1] ?? '';
  // #165 moves the Select-only menu policy to shared menu surface/item roles.
  for (const selector of ['.command-button', '.config-input', '.segmented', '.slide-pill.control', '.menu-surface', '.menu-item', '.dlg[role="alertdialog"]']) {
    assert.ok(round.includes(selector), `${selector}: same approved round treatment`);
  }
});

test('native fields own their full hit box while only the padding box is painted (#161)', () => {
  assert.match(css, /input\.config-input, \.control-field \{/u,
    'shortcut/address command variants keep their existing explicit state-border contract');
  const field = css.match(/\.control-field \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(field, /height:\s*var\(--control-height\)/u);
  assert.match(field, /border:\s*solid transparent/u);
  assert.match(field, /border-width:\s*var\(--control-field-inset\) 0/u);
  assert.match(field, /background-clip:\s*padding-box/u);
  assert.match(field, /border-radius:\s*var\(--control-radius\) \/ calc\(var\(--control-radius\) \+ var\(--control-field-inset\)\)/u,
    'the inner paint keeps the full radius when the transparent vertical border grows');
  assert.doesNotMatch(field, /pointer-events|transform|clip-path|overflow/u);
});

test('configuration headers wrap whole action groups instead of squeezing or eliding titles (#156)', () => {
  const head = /\.config-head-inner \{([^}]+)\}/u.exec(css)?.[1] ?? '';
  const title = /\.config-head-inner h1 \{([^}]+)\}/u.exec(css)?.[1] ?? '';
  const actions = /\.config-actions \{([^}]+)\}/u.exec(css)?.[1] ?? '';
  assert.match(head, /flex-wrap:\s*wrap;/u);
  for (const declaration of ['flex: 1 1 160px;', 'white-space: normal;', 'overflow-wrap: anywhere;',
    'overflow: visible;', 'text-overflow: clip;']) {
    assert.ok(title.includes(declaration), `configuration title keeps ${declaration}`);
  }
  assert.match(actions, /margin-left:\s*auto;/u);
  assert.match(actions, /display:\s*flex;/u);
  assert.match(actions, /flex:\s*none;/u);
});

function color(body: string, name: string): number[] {
  const hex = new RegExp(`${name}:\\s*#([\\da-f]{6})`, 'iu').exec(body)?.[1];
  assert.ok(hex, `${name} has an explicit, auditable color`);
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
}
function luminance(rgb: number[]): number {
  return rgb.map(c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
}
function contrast(a: number[], b: number[]): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('command and supporting-text tokens meet the accepted contrast floors in both themes (#155/#161)', () => {
  for (const theme of ['light', 'dark']) {
    const body = new RegExp(`html\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`, 'u').exec(css)?.[1];
    assert.ok(body);
    const ink = color(body, '--accent-fill-ink');
    for (const name of ['--accent-fill', '--danger-fill']) {
      const fill = color(body, name);
      assert.ok(contrast(fill, ink) >= 4.5, `${theme} ${name} text`);
      const hover = fill.map(c => c * 0.96 + 255 * 0.04);
      assert.ok(contrast(hover, ink) >= 4.5, `${theme} ${name} hover text`);
    }
    assert.ok(contrast(color(body, '--text2'), color(body, '--bg2')) >= 4.5, `${theme} supporting text`);
    // This still serves checkbox/switch boundaries. It no longer establishes
    // contrast for compact fields, which deliberately have no drawn outline.
    assert.ok(contrast(color(body, '--control-border'), color(body, '--bg')) >= 3, `${theme} retained control boundary`);
    for (const surface of ['--control-surface', '--control-hover', '--control-selected', '--control-field-bg']) {
      assert.ok(contrast(color(body, '--text'), color(body, surface)) >= 4.5, `${theme} text on ${surface}`);
    }
    assert.ok(contrast(color(body, '--text2'), color(body, '--control-field-bg')) >= 4.5, `${theme} field placeholder`);
    assert.ok(contrast(color(body, '--accent-ink'), color(body, '--control-field-bg')) >= 3, `${theme} field focus ring`);
  }
});

test('tokenized command overlays preserve the original sRGB composites and contrast (#156)', () => {
  const root = /html \{([\s\S]*?)\n\}/u.exec(css)?.[1];
  assert.ok(root);
  const light = color(root, '--control-overlay-light');
  const dark = color(root, '--control-overlay-dark');
  assert.deepEqual(light, [255, 255, 255]);
  assert.deepEqual(dark, [0, 0, 0]);
  for (const theme of ['light', 'dark']) {
    const body = new RegExp(`html\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`, 'u').exec(css)?.[1];
    assert.ok(body);
    assert.doesNotMatch(body, /--control-overlay-(?:light|dark):/u, 'overlay endpoints do not vary by theme');
    const ink = color(body, '--accent-fill-ink');
    for (const name of ['--accent-fill', '--danger-fill']) {
      const fill = color(body, name);
      for (const [endpoint, alpha, original] of [[light, 0.04, 255], [dark, 0.06, 0]] as const) {
        const mixed = fill.map((c, i) => c * (1 - alpha) + endpoint[i]! * alpha);
        const before = fill.map(c => c * (1 - alpha) + original * alpha);
        assert.deepEqual(mixed, before, `${theme} ${name} alpha ${alpha}: unchanged composite`);
        assert.equal(contrast(mixed, ink), contrast(before, ink), 'unchanged contrast');
        assert.ok(contrast(mixed, ink) >= 4.5, `${theme} ${name} alpha ${alpha}: readable text`);
      }
    }
  }
});

test('a dense tool group on the phone keeps its paint but sits on a 32px pitch (boards #192, #193)', async () => {
  // Owner 2026-09-13: "手机上的按钮可以紧凑一些，现在按钮太大了…空间利用不够", then
  // "最上边一行能显示全，不要...折叠了". Measured coarse: nine Files tools 412 px
  // at 44 (More needed at 390); the APK's TEN (Git, Downloads) 390 px at 36 —
  // still 8 + More on a 360–384 phone; 338 px at 32, all ten fit at 360 but
  // not on the owner's 347 px viewport (#309: 3 px short); 318 px at 30, all
  // ten fit from 330. The icon (17 px) is unchanged; the paint is 26 inside 30.
  assert.match(css, /\.compact-tools \{ --control-paint-inset: 4px; --control-paint-radius: 5px; \}/u,
    'pointer: 20 px paint inside 28, with the corner scaled to that paint (#219: 7px on 20px read as a circle)');
  assert.match(css, /@media \(any-pointer: coarse\)[\s\S]*?\.compact-tools \{ --control-height: 30px; --control-paint-inset: 2px; \}/u,
    'touch: 26 px paint inside 30 — the one deliberate exception to the 44 px icon hit box');
  const files = await readFile(new URL('../files/Files.svelte', import.meta.url), 'utf8');
  for (const group of ['toolbar', 'bc-path-row', 'file-actions', 'preview-header']) {
    assert.match(files, new RegExp(`class="${group} compact-tools"`, 'u'), `${group} is a dense tool group`);
  }
});

// Board #478 (owner, 2026-10-28: "不要高亮下划线显示了，只是鼠标放上去才有下划线，减少注意力分散"): the app's prose
// links are the accent colour with no underline at rest and an underline on hover. ONE pair of rules in app.css
// holds it; a surface that wants the look joins its lists and never declares a link rule of its own.
test('prose links share one rule: accent at rest, underline on hover only (#478)', async () => {
  const rest = css.match(/^([^{}\n]*)\{\s*color: var\(--accent\); text-decoration: none; \}/mu);
  assert.ok(rest, 'one resting rule: colour, no underline');
  assert.deepEqual(rest![1]!.split(',').map((x) => x.trim()), ['.md a', '.md-render a', '.step .st-text a', '.m-unfold'],
    'message bodies and skill docs, the file preview, a tool row\u2019s paths, the Show-the-rest control');
  const hover = css.match(/^([^{}\n]*:hover[^{}\n]*)\{\s*text-decoration: underline; text-underline-offset: 2px; \}/mu);
  assert.ok(hover, 'one hover rule: underline, at the offset the Show-the-rest control uses');
  assert.deepEqual(hover![1]!.split(',').map((x) => x.trim()), ['.md a:hover', '.md-render a:hover', '.step .st-text a:hover', '.m-unfold:hover']);
  assert.ok(css.indexOf(hover![0]) > css.indexOf(rest![0]), 'the hover arm comes after the resting arm it overrides');
  assert.doesNotMatch(rest![0] + hover![0], /--accent-ink|var\(--t-|transition|font-|padding|margin/u, 'no new token, no new tempo, no size or spacing: the underline is the only thing that appears');
  // no surface keeps a copy: a link rule in a component would be a fourth species of link
  for (const file of ['../files/FilePreview.svelte', '../hub/Feed.svelte', '../hub/AgentsPage.svelte']) {
    const src = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /(?:^|[\s,}])(?:[.\w-]+ )*(?::global\()?a(?::hover|\))?[^{}\n]*\{[^}]*text-decoration/mu, `${file}: no text-decoration on an anchor`);
    assert.doesNotMatch(src, /\.(?:md|md-render|step \.st-text)(?: :global\(a(?::hover)?\)| a(?::hover)?) \{[^}]*(?:color|text-decoration)/u, `${file}: no per-surface link paint`);
  }
  // Show-the-rest keeps only its layout and font: its colour and underline are the shared rule's
  const feed = await readFile(new URL('../hub/Feed.svelte', import.meta.url), 'utf8');
  const unfold = feed.match(/\n  \.m-unfold \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(unfold, /display: inline-flex/u, 'the control\u2019s own block is there');
  assert.doesNotMatch(unfold, /(?:^|[\s;])(?:color|text-decoration)\s*:/u, 'and holds no colour or underline of its own');
  assert.doesNotMatch(feed, /\.m-unfold:hover/u, 'nor a hover of its own');
  // the guard wraps the hover arm in the PRIMARY input's capability (design-language.md section 4 states the mixed-device limit)
  const guarded = (await postcss([hoverGuard()]).process(rest![0] + '\n' + hover![0], { from: undefined })).css;
  const [before, after] = guarded.split('@media');
  assert.match(before!, /text-decoration: none/u, 'the resting rule stays outside any media query: a link reads as one on every pointer');
  assert.match(after ?? '', /^\s*\(hover: hover\), \(pointer: none\)[\s\S]*text-decoration: underline/u,
    'the hover guard wraps the underline arm in (hover: hover), (pointer: none), the primary input\u2019s capability');
});

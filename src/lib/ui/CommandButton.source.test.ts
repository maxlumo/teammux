import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./CommandButton.svelte', import.meta.url), 'utf8');
const style = source.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? '';

// #155 review: sharing the rotation must not change the pending command's tempo.
test('pending commands use the shared spin while retaining their loading tempo and reduced-motion guard (#156)', () => {
  assert.match(style, /\.spinning \{ animation: spin 0\.6s linear infinite; \}/u);
  assert.doesNotMatch(style, /@keyframes\s+(?:command-spin|spin)\b/u);
  assert.match(style, /@media \(prefers-reduced-motion: reduce\) \{[^}]*\}[^}]*\.spinning \{ animation: none; \}/u);
});

// The token/contrast test owns the endpoints; these assertions pin their use
// at the actual hover/press boundary instead of merely testing unused tokens.
test('solid command overlays mix the shared endpoints at the accepted opacity without literals (#156)', () => {
  const hover = style.match(/\.command-button\.solid:hover:not\(:disabled\) \{([^}]+)\}/u)?.[1] ?? '';
  const pressed = style.match(/\.command-button\.solid:active:not\(:disabled\) \{([^}]+)\}/u)?.[1] ?? '';
  // #161 moves the unchanged composites to the smaller paint layer.
  assert.match(hover, /--command-overlay:\s*color-mix\(in srgb, var\(--control-overlay-light\) 4%, transparent\);/u);
  assert.match(pressed, /--command-overlay:\s*color-mix\(in srgb, var\(--control-overlay-dark\) 6%, transparent\);/u);
  assert.match(style, /box-shadow: inset 0 0 0 100px var\(--command-overlay, transparent\)/u);
  assert.doesNotMatch(style, /(?:rgba?|hsla?)\(|#[\da-f]{3,8}\b/iu);
});

// Engaged tools retain their state wash on hover/press, without another size or fill dialect.
test('engaged icon tools keep token wash and readable ink through hover and press (#157)', () => {
  const engaged = style.match(/\.command-button\.engaged,\s*\.command-button\.engaged:hover:not\(:disabled\),\s*\.command-button\.engaged:active:not\(:disabled\) \{([^}]+)\}/u)?.[1] ?? '';
  // Neutral selected surface is the owner-selected compact skin; state ink remains.
  assert.match(engaged, /--command-paint:\s*var\(--control-surface\);/u);
  assert.match(engaged, /color:\s*var\(--accent-ink\);/u);
  assert.doesNotMatch(engaged, /(?:height|width|padding|transform|box-shadow):/u);
});

test('command paint is inset inside the native target, with a visible keyboard ring (#161)', () => {
  const button = style.match(/\.command-button \{([^}]+)\}/u)?.[1] ?? '';
  const paint = style.match(/\.command-button::before \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(button, /height: var\(--control-height\)/u);
  assert.match(button, /border: 0/u, 'a transparent border would subtract another two pixels from the paint');
  assert.match(paint, /inset: var\(--control-paint-inset\) 0/u);
  assert.match(paint, /pointer-events: none/u);
  assert.match(style, /\.icon-only::before \{ inset: var\(--control-paint-inset\); \}/u);
  assert.match(style, /\.command-button:focus-visible::before \{ outline: 2px solid var\(--accent-ink\); outline-offset: 2px; \}/u);
});

test('command ink is quiet at rest and full on hover; solid, danger and engaged keep their own (board #220)', () => {
  // Owner 2026-09-20: "这些按钮上显示的线条太黑了，甚至有点喧宾夺主。因为我系统里很多文字，
  // 包括 tab 上的文字，其实都没有那么黑" — rest was --text, the darkest ink.
  const button = style.match(/\.command-button \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(button, /color: var\(--text2\)/u, 'rest: the .icon-btn / secondary-text layer, not body ink');
  assert.match(style, /\.command-button:not\(\.solid\):not\(\.danger\):hover:not\(:disabled\) \{ color: var\(--text\); \}/u,
    'hover brightens to body ink; solid and danger are excluded so Send stays fill-ink and Stop stays red');
  assert.match(style, /\.danger \{ color: var\(--danger-ink\); \}/u);
  assert.match(style, /\.solid \{ --command-paint: var\(--accent-fill\); color: var\(--accent-fill-ink\); \}/u);
  assert.match(style, /\.command-button\.engaged,\s*\.command-button\.engaged:hover:not\(:disabled\),\s*\.command-button\.engaged:active:not\(:disabled\) \{[^}]*color: var\(--accent-ink\);/u,
    'engaged (pressed/expanded) keeps its state ink through hover');
});

test('every command is a rounded rectangle; `round` is the composer Send\'s one circle (board #218)', async () => {
  // Owner 2026-09-20: "这个图标按钮应该都用圆角矩形，不要用圆圈…除了 agent 自己的原型 logo，
  // 发送按钮以外，都要圆角矩形的按钮设计，还有像 file 里什么的…弹出窗口确认的按键等等".
  const button = style.match(/\.command-button \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(button, /border-radius: var\(--ui-radius-control\)/u, 'the hit box');
  const paint = style.match(/\.command-button::before \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(paint, /border-radius: var\(--control-paint-radius\)/u,
    'the PAINT corner is its own token: --ui-radius-control (10) on a 24px square is a circle');
  assert.doesNotMatch(paint, /border-radius: inherit/u);
  assert.match(source, /round\?: boolean;/u);
  assert.match(source, /class:round\b/u);
  assert.match(style, /\.round, \.round::before \{ border-radius: var\(--ui-radius-pill\); \}/u);
  assert.equal([...style.matchAll(/ui-radius-pill/gu)].length, 1, 'the pill appears once: the round modifier');
  // Exactly one wearer in the app: the composer's Send.
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = new URL('../', import.meta.url);
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(path));
      else if (entry.name.endsWith('.svelte') && !entry.name.endsWith('.test.svelte')) out.push(path);
    }
    return out;
  }
  const wearers: string[] = [];
  for (const file of await walk(root.pathname)) {
    const text = await readFile(file, 'utf8');
    if (/<CommandButton[^>]*\bround\b/u.test(text)) wearers.push(file.slice(root.pathname.length));
  }
  assert.deepEqual(wearers, ['hub/Composer.svelte'], 'only Send is round');
  assert.match(await readFile(new URL('../hub/Composer.svelte', import.meta.url), 'utf8'),
    /<CommandButton variant="primary" iconOnly round icon="send-up"/u);
});

test('the source glyph `code` replaces ⌘ for Raw; the unused `command` glyph is gone (board #218)', async () => {
  const icon = await readFile(new URL('./Icon.svelte', import.meta.url), 'utf8');
  assert.match(icon, /name === 'code'[\s\S]*?<polyline points="16 18 22 12 16 6"\/><polyline points="8 6 2 12 8 18"\/><line x1="14" y1="4" x2="10" y2="20"\/>/u,
    '</> in the set\'s stroke style');
  assert.doesNotMatch(icon, /name === 'command'/u, 'one consumer, replaced — the glyph goes with it');
});

test('bare is a modifier, not a variant: no paint in any state, never on solid, focus ring kept (board #211)', () => {
  // Owner 2026-09-20: "停止按钮就不用加背景了，就红色方块我直接点就行". Every variant
  // carries a hover wash, so "no paint at all" cannot be said with a variant;
  // like `inside`, it modifies one. The paint layer stays for the focus ring.
  assert.match(source, /bare\?: boolean;/u);
  assert.match(source, /class:bare=\{bare && !solid\}/u, 'meaningless on primary/solid paint');
  assert.match(style, /\.command-button\.bare,\s*\.command-button\.bare:hover:not\(:disabled\),\s*\.command-button\.bare:active:not\(:disabled\) \{ --command-paint: transparent; \}/u);
  assert.doesNotMatch(source, /variant\?: [^;]*'bare'/u, 'not a fifth variant');
});

test('the warn variant is gone whole; icon commands keep the focus layer (#173 → #195)', () => {
  // #173 mixed amber into the roster's Stop ink to clear 3:1 on a selected card;
  // the owner found the result ugly ("颜色也不好看", 2026-09-13) and the Stop now
  // wears the plain icon ink. A variant with one consumer is removed, not kept.
  assert.match(source, /variant\?: 'primary' \| 'secondary' \| 'icon' \| 'danger';/u);
  assert.doesNotMatch(source, /warn/u);
  assert.match(style, /\.command-button:focus-visible::before \{ outline: 2px solid var\(--accent-ink\); outline-offset: 2px; \}/u);
});

test('icon-command ink clears 3:1 on normal and selected cards in both themes (#173 floor, #195 ink)', async () => {
  const css = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  const rgb = (body: string, name: string) => {
    const value = new RegExp(`${name}:\\s*([^;]+)`, 'u').exec(body)?.[1] ?? '';
    if (value.startsWith('#')) return [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
    assert.match(value, /^rgba\(/u);
    return value.slice(5, -1).split(',').map(Number);
  };
  const mix = (a: number[], b: number[], weight: number) => a.slice(0, 3).map((n, i) => n * weight + b[i]! * (1 - weight));
  const luminance = (c: number[]) => c.map(n => {
    n /= 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
  const contrast = (a: number[], b: number[]) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  for (const theme of ['light', 'dark']) {
    const body = new RegExp(`html\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`, 'u').exec(css)?.[1];
    assert.ok(body);
    const ink = rgb(body, '--text2');
    for (const base of ['--bg', '--bg2']) {
      for (const paint of ['--surface', '--accent-bg']) {
        const overlay = rgb(body, paint);
        const surface = mix(overlay, rgb(body, base), overlay[3]!);
        const ratio = contrast(ink, surface);
        assert.ok(ratio >= 3, `${theme} ${base}/${paint}: ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

// Board #127 (owner, 2026-11-14 17:41: "桌面模式的时候 那个展开左侧边栏按钮比较丑 和手机模式一样三个横线就可以。
// 然后展开以后 折叠的按钮不要背景色了"): the sidebar toggle is the phone's three-line `menu`
// glyph, which does not turn; the drawn `panel-left` window and its turning `.turn` chevron
// (#202/#215) are removed whole, with the atom's special case for them.
test('the sidebar toggle glyph is the three-line menu; the panel-left drawing and its turning part are gone (board #127)', async () => {
  assert.match(source, /const disclosure = \$derived\(!pending && expanded !== undefined && icon\.startsWith\('chevron-'\)\);/u, 'only a chevron turns');
  assert.doesNotMatch(source, /panel-left/u);
  const icon = await readFile(new URL('./Icon.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(icon, /panel-left|class="turn"/u, 'no drawing left for it');
  assert.match(icon, /name === 'menu'[\s\S]*?<line x1="3" y1="6" x2="21" y2="6"\/><line x1="3" y1="12" x2="21" y2="12"\/><line x1="3" y1="18" x2="21" y2="18"\/>/u, 'the phone\'s three lines');
  const css = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.turn\b/u, 'the turning-part rules went with it');
});

// Board #107 F6: a wrapping label is the atom's variant, not a restyle around it. The button
// grows by its lines and keeps the one-line command's space above and below the text, so a
// wrapped label never crosses the inset paint (touch: 44 tall, paint inset 6).
test('the wrap variant keeps the one-line vertical inset in tokens and lets the label wrap (#107 F6)', () => {
  const wrap = style.match(/\.wrap \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(wrap, /height:\s*auto;/u);
  assert.match(wrap, /min-height:\s*var\(--control-height\)/u);
  assert.match(wrap, /padding-block:\s*calc\(\(var\(--control-height\) - var\(--control-line-height\)\) \/ 2\)/u);
  assert.doesNotMatch(wrap, /\d+px/u, 'tokens only');
  assert.match(style, /\.wrap \.command-label \{[^}]*white-space:\s*normal/u);
  assert.match(style, /\.command-label \{ white-space: nowrap; \}/u, 'every other command stays one line');
});

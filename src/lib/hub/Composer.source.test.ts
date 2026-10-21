import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./Composer.svelte', import.meta.url), 'utf8');
// The attachment strip and the staging pipeline moved out of Composer
// unchanged (board #329): the same contracts, read where they now live.
const strip = await readFile(new URL('./AttachStrip.svelte', import.meta.url), 'utf8');
const pipeline = await readFile(new URL('./attachments.svelte.ts', import.meta.url), 'utf8');
const ruleIn = (src: string, selector: string) =>
  src.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
const rule = (selector: string) =>
  source.match(new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';

test('All, attachment and Send are a measured last-line signature (#186)', () => {
  assert.match(source, /class="compose-line"/u);
  assert.match(rule('.compose-line'), /position: relative/u);
  assert.doesNotMatch(rule('.compose-line'), /display: flex/u);
  assert.match(rule('.composer-actions'), /position: absolute/u);
  assert.match(rule('.c-input'), /width: 100%/u);
  assert.match(rule('.c-input'), /min-width: 0/u);
  assert.doesNotMatch(source, /class="all-choice"|onall|allMenuOpen/u, '#204: Everyone lives in the roster, beside Spawn');
  assert.ok(source.indexOf("label={t('hubEveryone')}") < source.indexOf("label={t('hubAttach')}"));
  assert.doesNotMatch(source, /justify-content: space-between/u, 'no separate footer distributes the controls');
  assert.match(source, /signatureLayout\(/u);
});

test('composer measurement observes available geometry, not the textarea it resizes (#180)', () => {
  assert.doesNotMatch(source, /observer\.observe\(composerEl\)/u);
  assert.match(source, /observer\.observe\(available\)/u);
  assert.match(source, /observer\.observe\(actionsEl\)/u);
  assert.match(source, /style\.maxHeight/u, 'a height-only viewport change refreshes the scroll ceiling');
  const observer = source.slice(source.indexOf("let measured = ''"), source.indexOf('observer.observe(available)'));
  assert.match(observer, /actionsEl\.offsetWidth/u, '#186: action-only changes cannot be deduplicated away');
  assert.match(observer, /actionsEl\.offsetHeight/u);
  assert.match(observer, /columnGap/u);
});

test('the composer measures once per frame, never in the input handler (#444)', () => {
  // A key ran the measurement twice (oninput and the composerText effect), each
  // a forced layout inside the input handler: about 56 ms a key at phone CPU on
  // a long room. Every trigger now asks for the next frame and they share it.
  assert.match(source, /function requestGrow\(\) \{\s*if \(growFrame\) return;\s*growFrame = requestAnimationFrame\(\(\) => \{ growFrame = 0; growComposer\(\); \}\);/u);
  assert.equal([...source.matchAll(/growComposer\(\)/gu)].length, 2, 'declared once and called only from the frame');
  assert.doesNotMatch(source, /oninput=\{growComposer\}/u, 'the input handler measures nothing');
  assert.match(source, /onDestroy\(\(\) => \{ if \(growFrame\) cancelAnimationFrame\(growFrame\); \}\);/u);
});

test('natural textarea measurement cannot transiently expand the Feed (#180)', () => {
  const grow = source.slice(source.indexOf('function growComposer()'), source.indexOf('let lastShellH'));
  assert.match(grow, /row\.style\.minHeight = `\$\{row\.offsetHeight\}px`/u);
  assert.ok(grow.indexOf('row.style.minHeight = `${row.offsetHeight}px`') < grow.indexOf("el.style.height = 'auto'"));
  assert.match(grow, /finally \{\s*row\.style\.minHeight = previousMin;/u);
  assert.ok(grow.indexOf('row.style.minHeight = previousMin') < grow.indexOf('const shellH'));
});

test('retired recipient and send-arm mechanisms stay removed when measurement returns (#186)', () => {
  assert.doesNotMatch(source, /recipientOpen|toChipW|toExtras|toChipInfo|toMenuH|managedAgents|managedNames|setRecipient/u);
  assert.doesNotMatch(source, /closeRecipient|recipientChanged|intArm|intTimer|intTargets|intWho|recipientBusy|armInterrupt|fireInterrupt/u);
  assert.doesNotMatch(source, /SEND_ZONE|lastLineCollides|c-mirror|ss-ring|stop-spin|int-pill/u);
  assert.doesNotMatch(source, /setTimeout|clearTimeout/u,
    'the keyboard-only sequence expires by elapsed time, not a hidden send-button timer');
});

test('Composer retains its stacking context around the one remaining palette (#168)', () => {
  const composer = /\n  \.composer \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(composer, /position:\s*relative/u);
  assert.match(composer, /z-index: 15/u, 'Feed.source pins the feed below this context');
  assert.match(rule('.cmd-menu'), /z-index: 14/u);
  assert.match(source, /:global\(\.hub-root\.compact\) \.composer/u,
    'the compact ancestor crosses the component boundary without another wrapper');
  assert.match(rule(':global(.hub-root.compact) .composer'), /padding: 3px var\(--composer-inset\);\s*$/u,
    'equal air above and below the field (owner, 2026-09-23); the compacting belongs within the tabs');
  assert.match(rule('.composer'), /padding: 6px var\(--composer-inset\);/u, 'desktop too: the bottom was 10px against a 6px top');
  assert.doesNotMatch(source, /^\s*\.(st|note-dot|live-dot) \{/mu, 'shared atoms are not copied');
});

test('/, @ and # are ONE palette: one derived value, one listbox, one accept (#242, #340)', () => {
  // A second popover for board references would be a second species of the
  // same job (design-language: one popover mechanism). The `#` completion is
  // one more source chained into the same `palette`; Hub owns the board read.
  assert.match(source, /const palette = \$derived\(paletteOff \? null : offeredPalette\(\s*commandPalette\(composerText, cmdModels\[paletteBackend\] \?\? \[\], paletteBackend\) \?\? mentionPalette\(composerText, mentionCandidates\)\s*\?\? issuePalette\(composerText, issues\), composerText\)\);/u,
    'every source chained into one value, through the one "would accepting change anything" rule (#398)');
  assert.match(source, /if \(!wantsFetchedArgs\(composerText, backend\) \|\| cmdModels\[backend\]\) return;/u,
    'the models are fetched by the declaration, never because a list is showing (#398 review P1-A)');
  assert.equal(source.split('role="listbox"').length - 1, 1, 'one listbox');
  assert.equal(source.split('class="cmd-menu').length - 1, 1, 'one menu');
  assert.match(source, /issues = \[\], onissues = \(\) => \{\}/u, 'the list and its refresh come from Hub');
  assert.doesNotMatch(source, /boardList/u, 'no board RPC here');
});

test('Composer owns local UI state, while transport and capture ordering stay outside (#133)', () => {
  assert.match(source, /composerText = \$bindable\(''\)/u, 'one explicit draft binding');
  assert.doesNotMatch(source, /feedEl|cardsEl|hubPrefs|core\/ws|window\.addEventListener|popstate|pushState/u,
    '#186 font-face completion is a measurement signal, not an input-capture listener');
  assert.match(source, /const paletteBackend = \$derived\(paletteBackendFor\(composerText, recipient, agents\)\);/u);
  assert.match(source, /onmodels: modelsList/u, 'models use the explicit transport command');
  assert.match(source, /if \(shellH !== lastShellH\) \{\s*lastShellH = shellH;\s*onheightchange\(\);/u,
    'height intent fires only when the shell really changed');
  assert.doesNotMatch(source, /onfocus/u, 'focusing the composer is not navigation (#303)');
  assert.match(source, /export function caret\(\) \{ return composerEl\?\.selectionStart; \}/u);
  assert.match(source, /export function focus\(\) \{ composerEl\?\.focus\(\); \}/u);
  assert.match(source, /export function feedbackAnchor\(\) \{ return shellEl; \}/u);
  assert.match(source, /export function hasTransient\(\) \{ return !!palette; \}/u);
});

test('Composer registers only palette Back and preserves the capture boundary (#168)', () => {
  assert.equal([...source.matchAll(/registerBack\('/gu)].length, 1);
  assert.match(source, /return registerBack\('palette', \(\) => \{ if \(palette\) \{ paletteOff = true; return true; \} return false; \}\);/u);
  assert.match(source, /if \(palette && !t\?\.closest\?\.\('\.cmd-menu, \.compose-shell'\)\) paletteOff = true;/u);
  const escape = source.slice(source.indexOf('export function dismissEscape'), source.indexOf('let composerEl'));
  assert.match(escape, /ctrlCTapAt = null;/u);
  assert.match(escape, /if \(palette\) \{ paletteOff = true; e\.preventDefault\(\); e\.stopPropagation\(\); \}/u);
});

test('Composer attachment rendering and button gates retain the coordinator verdicts (#133)', () => {
  assert.match(source, /disabled=\{!selected \|\| attaching \|\| failed \|\| !sendable\}/u);
  assert.match(source, /<AttachStrip \{pending\} onremove=\{removeAttachment\} \{onpreview\}/u, 'the composer renders the ONE strip');
  assert.match(strip, /\{#each pending as a, i \(a\.key\)\}\s*\n\s*\{#if a\.error\}/u);
  const err = ruleIn(strip, '.pend-row :global(.pend-chip.err)');
  assert.match(err, /var\(--status-danger\)/u);
  assert.doesNotMatch(err, /#[0-9a-f]{3,8}\b/iu);
  assert.match(strip, /onclick=\{\(\) => onremove\(i\)\}/u);
  assert.match(strip, /onpreview\(a\.thumb\)/u, 'the preview opens the original local thumbnail URL');
  assert.doesNotMatch(source, /class="pend-thumb/u, 'one thumbnail species: the strip owns it');
});

test('the remaining command palette keeps its measured upward placement (#168)', () => {
  assert.match(source, /<div class="cmd-menu pop-layer" class:ready=\{cmdMenuH > 0\} style:--pop-origin="bottom left"[^>]*bind:clientHeight=\{cmdMenuH\}/u);
  // A closed menu forgets its height, so the NEXT opening is measured (and
  // animated) again instead of appearing already `.ready`.
  assert.match(source, /if \(!palette\?\.items\.length\) cmdMenuH = 0;/u, 'the palette re-measures per opening');
  assert.match(rule('.cmd-menu'), /position: absolute; bottom: calc\(100% \+ 6px\)/u, 'the palette keeps its own placement');
});

test('the signature mirror reads the actual prose or command font (#186)', () => {
  // The look mirrors send()'s own branch (slashCommand + a target), so the
  // capsule never promises a command that send() would deliver as prose.
  assert.match(source, /class:cmd=\{composerIsCmd\}/u);
  assert.match(source, /const composerIsCmd = \$derived/u);
  assert.match(rule('.compose-shell.cmd .c-input'), /font-family: var\(--font-mono\)/u);
  // And the height re-measures when the font flips, not just when text changes.
  assert.match(source, /void composerIsCmd;/u);
  assert.match(source, /getComputedStyle\(el\)/u);
  assert.match(source, /measureText\.style\.setProperty\(property, style\.getPropertyValue\(property\)\)/u);
  assert.match(source, /void fonts\.custom; void uiFont\.custom/u);
  assert.match(source, /fontSet\.ready\.then\(remeasure\)/u);
  assert.match(source, /fontSet\.addEventListener\('loadingdone', remeasure\)/u);
  assert.match(source, /fontSet\.removeEventListener\('loadingdone', remeasure\)/u);
  assert.match(source, /onDestroy\(\(\) => measureRoot\?\.remove\(\)\)/u);
});

test('paste and the + button stage attachments through ONE pipeline (board #25)', () => {
  // The composer textarea accepts pasted images/files: onpaste routes through
  // pastedFiles() (files win over co-riding text) into the SAME stageFiles()
  // the file picker uses — a second upload path would drift (token insertion,
  // re-encode, .tmm/uploads layout) the moment either one changed.
  assert.match(source, /class="c-input"[^>]*onpaste=\{onComposerPaste\}/su,
    'the composer textarea must wire onpaste');
  const composerHandler = /function onComposerPaste\(e\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(composerHandler, /attachPaste\(e, stageFiles\)/u, 'the composer routes a paste through the shared rule');
  const handler = /export function attachPaste\([^)]*\)[^{]*\{([\s\S]*?)\n\}/u.exec(pipeline)?.[1] ?? '';
  assert.match(handler, /pastedFiles\(e\.clipboardData\)/u, 'files come from the pure extractor');
  assert.match(handler, /preventDefault/u, 'a file paste suppresses the default text insertion');
  // Office/browser pastes ship a PNG rendering beside the words; the words are
  // the paste. The decision is the pure textIsThePaste and it runs BEFORE the
  // default insertion is suppressed (owner, 2026-09-08: "从 ppt 上粘贴过来的文字，
  // 总是被粘贴为了一个图片").
  assert.match(handler, /if \(textIsThePaste\(e\.clipboardData\?\.getData\('text\/plain'\), files\)\) return;[\s\S]*preventDefault/u,
    'text beside an image-only set wins, decided before preventDefault');
  assert.match(handler, /stage\(files\)/u, 'staging is the shared pipeline');
  const picker = /async function onPickFiles\(e\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(picker, /stageFiles\(files\)/u, 'the + button goes through the same pipeline');
  assert.doesNotMatch(picker, /fsUpload|encodeImage/u, 'the picker holds no upload logic of its own');
});

test('the composer scrollbar follows measured overflow and the placeholder names its destination (#168)', () => {
  // hidden → auto → hidden: the base CSS state is hidden (an empty composer
  // never shows a track), growComposer flips it in its ONE measurement — the
  // same `scrollHeight > maxH + 1` verdict that drives the padding — so a
  // shrink or the post-send reset (growComposer re-runs on composerText)
  // lands back on hidden immediately.
  assert.match(source, /naturalHeight: el\.scrollHeight/u, 'natural height comes from the native field');
  assert.match(source, /el\.style\.overflowY = layout\.overflow \? 'auto' : 'hidden';/u, 'the measured layout owns the scroll verdict');
  assert.match(source, /resize: none; overflow-y: hidden;/u, 'the base state is hidden');
  // Not hidden PERMANENTLY: a long message must really scroll — the .c-input
  // block declares overflow-y exactly once (the hidden base; auto comes only
  // from the JS toggle), and no masking the scrollbar.
  const cInput = source.match(/\n  \.c-input \{[^}]*\}/su)?.[0] ?? '';
  assert.equal([...cInput.matchAll(/overflow-y/g)].length, 1, 'one overflow-y in .c-input, the hidden base');
  assert.ok(!/\.c-input[^}]*scrollbar-width:\s*none/su.test(source), 'the real scrollbar is never masked away');

  // Parent-owned wording can change; these are the existing destination keys,
  // now carried by the textarea rather than an inline recipient control.
  assert.match(source, /recipient === ALL_TARGET \? t\('hubComposerAll'\)[\s\S]{0,160}?targetTeam\(recipient\) \? t\('hubComposerTeam'\)[\s\S]{0,160}?t\('hubComposerRoom'\)/u,
    'a team has its own visible destination instead of looking like one agent');
  assert.doesNotMatch(source, /t\('hubTo(?:All|Room)Hint'\)/u,
    'destination labels need no explanatory subtitle');
});

test('measured signature actions reuse shared commands without hardcoded avoidance (#186)', async () => {
  assert.match(source, /import CommandButton from '\.\.\/ui\/CommandButton\.svelte';/u);
  assert.match(source, /<div class="composer-actions" class:compact-tools=\{compact\} bind:this=\{actionsEl\}>/u,
    '#228: on the phone the two controls are a dense 32px group');
  assert.match(rule('.composer-actions'), /display: flex/u);
  // #229: centred on the line's captured height, not glued to the bottom.
  assert.match(rule('.composer-actions'), /position: absolute; right: 0; bottom: calc\(\(var\(--composer-line-h\) - var\(--control-height\)\) \/ 2\)/u);
  assert.match(rule('.compose-line'), /--composer-line-h: var\(--control-height\)/u, 'captured before the dense group redefines the token');
  assert.match(source, /const lift = parseFloat\(actionsStyle\.bottom\) \|\| 0;/u, 'the layout math reads the same offset back');
  // #203: an input's radius and the row content inset — 16px on a 32px desktop
  // shell was a semicircle (owner: "在电脑上这个输入框左边是一个半圆").
  // #236 round 3: the shell is its OWN field again (full border, all four
  // corners) inside the composer BAND — the owner's Chrome screenshot: the
  // toolbar and the active tab share one fill, the omnibox stands in it.
  assert.match(rule('.compose-shell'), /border: 1px solid var\(--border\); border-radius: var\(--ui-radius-control\)/u);
  // No top border of its own: the band's top edge is the strip's floor line
  // (Roster), which the lit tab breaks — a border here would cross under it.
  assert.match(rule('.composer'), /background: var\(--bubble-in\);\n\s*border: 1px solid var\(--bubble-line\); border-top: 0;\n[\s\S]{0,320}?border-radius: 0;/u,
    'the band wears the agent bubble and closes the enclosure the lit tab opens');
  // #288: over the touch tab bar the bar's top line is the band's floor — two
  // stacked 1px lines read as a seam. Keyed to the bar's own condition.
  // The selector is exactly when the bar SHOWS: drawn under touch-layout,
  // hidden by the soft keyboard and by Files' reading mode — there the band
  // keeps its own edge (validator 06:19: typing must not open its floor).
  assert.match(source, /:global\(html:not\(\.keyboard-open\) main\.touch-layout:not\(\.immersive\)\) \.composer \{ border-bottom: 0; \}/u, 'one line where the band meets the tab bar');
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /class:touch-layout=\{shell && layout\.isTouchDevice\}/u);
  assert.match(app, /\{#if shell && layout\.isTouchDevice\}\s*<nav class="tabbar"/u, 'the bar is drawn under the same condition');
  const hides = [...app.matchAll(/^\s*([^\n{]*)\.tabbar \{ display: none; \}/gmu)].map((m) => m[1]!.trim());
  assert.deepEqual(hides, [':global(html.keyboard-open)', '.immersive'], 'the bar hides for exactly the two reasons the selector excludes');
  assert.match(rule('.compose-shell'), /padding: var\(--tool-inset-block\) var\(--menu-item-padding-x\)/u);
  assert.match(source, /const paintInset = parseFloat\(actionsStyle\.getPropertyValue\('--control-paint-inset'\)\) \|\| 0;/u);
  assert.match(source, /const inkInset = Math\.max\(0, \(\(parseFloat\(style\.lineHeight\) \|\| 0\) - \(parseFloat\(style\.fontSize\) \|\| 0\)\) \/ 2\);/u);
  assert.match(source, /controlsWidth, controlsHeight, gap, empty, paintInset, inkInset,/u);
  const appCss = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(appCss, /\.compose-shell\b/u, 'native round corners do not opt into the shared squircle list');
  assert.doesNotMatch(source, /corner-shape:/u, 'this property stays in its shared owner; the Svelte CSS service does not support it yet');
  assert.doesNotMatch(source, /\.send-btn|\.attach-btn|backdrop-filter|SEND_ZONE/u);
  assert.match(source, /if \(empty\) el\.style\.paddingRight = `\$\{controlsWidth \+ gap\}px`/u,
    'only an empty placeholder gives width to the controls, never a typed line');
  assert.match(source, /row\.style\.paddingBottom = layout\.reserved \? `\$\{layout\.reserved\}px` : ''/u);
  assert.match(rule('.compose-line :global(.composer-measure)'), /height: 0/u);
  assert.match(rule('.compose-line :global(.composer-measure)'), /overflow: hidden; visibility: hidden; pointer-events: none/u,
    'the mirror neither paints, handles input nor adds scrollable space');
});

test('double Ctrl+C has only a timestamp and asks the parent about the current recipient (#168)', () => {
  assert.match(source, /interruptible = false/u);
  assert.match(source, /let ctrlCTapAt = null;/u);
  assert.match(source, /if \(e\.repeat\) return;/u);
  assert.match(source, /e\.keyCode !== 229/u);
  assert.match(source, /!e\.metaKey && !e\.altKey/u);
  assert.match(source, /composerEl\?\.selectionStart !== composerEl\?\.selectionEnd/u);
  assert.match(source, /selection && !selection\.isCollapsed/u);
  assert.match(source, /!selected \|\| !recipient \|\| !interruptible/u);
  assert.match(source, /const now = performance\.now\(\);/u);
  assert.match(source, /ctrlCTapAt !== null && now - ctrlCTapAt <= 3000/u);
  assert.match(source, /ctrlCTapAt = null;\s*void oninterrupt\(recipient\);/u);
  assert.equal([...source.matchAll(/oninterrupt\(/gu)].length, 1, 'one keyboard dispatch site, never a send-button path');
  assert.match(source, /void selected; void recipient; void composerText; void interruptible; ctrlCTapAt = null;/u);
});

test('a reply is a removable chip in the pending row, never text in the field (#290)', () => {
  assert.match(source, /<AttachStrip [^>]*lead=\{replyTo \? replyChip : undefined\} \/>/u, 'the reply chip leads the pending row');
  assert.match(strip, /\{#if pending\.length \|\| lead\}\s*<div class="pend-row">\s*\{@render lead\?\.\(\)\}/u);
  assert.match(source, /<span class="pend-chip reply appear-pop" title=\{replyTo\.preview\}>/u, 'the pending-chip species');
  assert.match(source, /<button class="pend-x" aria-label=\{t\('hubReplyClear'\)\} onclick=\{onclearreply\}>/u);
  assert.doesNotMatch(source, /\[re /u, 'the composer never writes the token: the server builds it');
});

test('ONE attachment pipeline in the app: upload, encode and paste rules live in attachments.svelte.ts (board #329)', async () => {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = new URL('../', import.meta.url).pathname;
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(svelte|ts)$/u.test(e.name) && !/\.test\.ts$/u.test(e.name)) files.push(p);
    }
  };
  await walk(root);
  const hits: { encode: string[]; ceiling: string[]; uploads: string[]; paste: string[] } = { encode: [], ceiling: [], uploads: [], paste: [] };
  for (const f of files) {
    const text = await readFile(f, 'utf8');
    const rel = f.slice(root.length);
    if (/canvas\.toBlob\(/u.test(text)) hits.encode.push(rel);
    if (/1568/u.test(text)) hits.ceiling.push(rel);
    if (/\.tmm\/uploads\/\.gitignore/u.test(text)) hits.uploads.push(rel);
    if (/textIsThePaste\(/u.test(text) && !rel.endsWith('hub/hub.ts')) hits.paste.push(rel);
  }
  for (const [what, where] of Object.entries(hits)) {
    assert.deepEqual(where, ['hub/attachments.svelte.ts'], `${what} lives in ONE place: ${where.join(', ')}`);
  }
});

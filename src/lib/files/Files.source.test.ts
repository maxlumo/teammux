import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Files.svelte', import.meta.url), 'utf8');

test('copy and download feedback share the UI owner and never restore private toast/ring chrome (#167)', () => {
  // The slots may coexist, but two absolutely positioned toasts overlapped.
  // OperationFeedback owns paint; Files only composes a single in-flow stack.
  assert.match(source, /import OperationFeedback from '\.\.\/ui\/OperationFeedback\.svelte'/u);
  assert.match(source, /import \{ createFeedbackLifetime \} from '\.\.\/ui\/feedback-lifetime\.ts'/u);
  assert.equal(source.match(/<OperationFeedback /gu)?.length, 5, 'copy, download, earlier download (#301), upload, and a running row in the Downloads view (#308) — one owner');
  assert.match(source, /\.files-feedback \{[^}]*flex-direction: column/u);
  assert.doesNotMatch(source, /copyToast|copyTimer|downloadToast|downloadedPath|dlProgress|displayedDlProgress|copy-toast|download-toast|dl-ring|toast-fade/u);
});

test('upload feedback rides the same slot: one batch runner for both transports, honest phases, a size guard (board #214)', () => {
  // Owner 2026-09-20: "文件上传要有个进度或者提示，让我知道传上去了没有". A success used
  // to be a silent listing refresh.
  assert.match(source, /import \{ uploadProgress, uploadSummary, uploadSizeError \} from '\.\/file-upload\.ts'/u);
  assert.match(source, /const uploadLifetime = createFeedbackLifetime\(value => \{ uploadFeedback = value; \}\);/u);
  assert.match(source, /\{#if copyFeedback \|\| downloadFeedback \|\| uploadFeedback \|\| earlierFeedback\}/u, 'the slot renders for an upload (and an earlier download, #301) too');
  assert.match(source, /<OperationFeedback value=\{uploadFeedback\}\s*ondismiss=\{uploadFeedback\?\.kind === 'error' \? uploadLifetime\.clear : undefined\} \/>/u,
    'errors are dismissable; progress has no cancel, success expires by itself');
  assert.equal(source.match(/await runUploadBatch\(/gu)?.length, 2, 'picker/drop Files and native paths share ONE runner');
  assert.doesNotMatch(source, /await fsUpload\(uploadDest\(dir, (?:file\.)?name\)/u, 'no transport uploads on its own');
  // Uploaded = the server answered: the RPC resolves before the count.
  assert.match(source, /await fsUpload\(uploadDest\(dir, item\.name\), b64\);\s*outcome\.ok\.push\(item\.name\);/u);
  assert.match(source, /step\.phase = 'sending';\s*show\(step\);/u, 'the send is a discrete beat, not an invented percentage');
  assert.match(source, /uploadLifetime\.clear\(\); \};/u, 'a context exit stops the line, like copy/download');
});

test('back retraces the USER\u2019s steps — a history, not a parent walk (board #17)', () => {
  // Every user navigation pushes where they WERE…
  assert.match(source, /function navTo\(path, slide = ''\) \{\s*\n\s*fileNav\.rememberDirectory\(cwd, path\);/u,
    'one navigate-with-history helper delegates to the tested state owner');
  for (const site of [
    /navTo\(entry\.path, 'fwd'\);/u,   // entering a directory
    /navTo\(parent, 'back'\);/u,       // the up button
    /onclick=\{\(\) => \{ if \(!selecting\(\)\) navTo\('\/', 'back'\); \}\}/u, // the root crumb (#187: not over a text selection)
    /navTo\(bc\.path, 'back'\)/u,      // a crumb
    /navTo\(bm, 'fwd'\);/u,            // a bookmark
  ]) assert.match(source, site, `user navigation pushes: ${site}`);
  // …back pops exactly that path FIRST; the user's own steps always outrank
  // the parent climb below them (board #47 reopened the climb — see the next
  // test — but never above the pop, and never through navTo).
  assert.match(source, /if \(popDir\(\)\) return true;[\s\S]{0,900}?directoryBackFloor\(cwd, jumped\)/u,
    'the back gesture\u2019s directory step is the pop, before the gated climb');
  assert.ok(!source.includes('if (cwd !== \'/\') { goUp(); return true; }'),
    'the UNGATED history-pushing parent walk stays retired (goUp/navTo would bounce)');
  // External moves are new ENTRY POINTS, not steps: they reset the history.
  // (#187: the host's resetDirectories() wrapper is the one call into
  // fileNav — it also ticks the toolbar's Back/Forward enablement.)
  assert.equal(source.split('fileNav.resetDirectories()').length - 1, 1, 'one definition of the reset');
  const resets = source.split('\n').filter(line => /^\s*resetDirectories\(\);/u.test(line)).length;
  assert.equal(resets, 3, 'session switch, cwd follow and directory handoff reset; a file reference keeps its origin (#106)');
  assert.doesNotMatch(source, /let (?:dirHist|fileHist|fileSeq)\b/u, 'history and request state live only in file-nav.ts');
});

test('a directory\u2019s entrance is ONE beat, at answer time (board #93)', () => {
  // Owner: "旧的页面滑出去，新的页面进来。同时新的页面应该从上到下按行显示过渡
  // 加载。新页面加载和滑入是同时进行的，有可能加载慢就可能慢半拍。" The
  // tap-time slide was the flash: it finished over the OLD rows and the swap
  // then read as a detached blink. Now the navigation only RECORDS its
  // direction (pendingSlide), and the slide + the top-to-bottom unfold start
  // together when the answer lands.
  assert.match(source, /const navigated = path !== cwd;\s*\n\s*if \(navigated && pendingSlide\) navAnim\(pendingSlide\);/u,
    'the slide fires when the answer lands, in the recorded direction');
  assert.match(source, /revealDir = navigated \|\| !entries\.length \? path : '';/u,
    'the unfold plays for a navigation or a first fill — a same-dir refresh is a cut');
  assert.match(source, /revealTimer = setTimeout\(\(\) => \{ revealDir = ''; \}, revealMs\(\)\);/u,
    'the class is dropped after the stagger — a later mount never rises (the atom\u2019s contract)');
  // The directions: deeper is fwd, up/back is back; instant view switches
  // (preview→editor and back) still slide at tap time — they swap in the
  // same frame. But a FILE OPEN is async like a directory (round three,
  // owner: "打开新的文件，看到的是当前的目录文件动画加载了一遍，然后又才打开
  // 文件" — the tap-time slide replayed over the STILL-VISIBLE list): it
  // records pendingViewSlide and the slide fires only when the view actually
  // swaps to the answer (enterView), never over the list it is leaving.
  assert.match(source, /pendingViewSlide = 'fwd';/u, 'a file open records its slide');
  assert.ok(!/navAnim\('fwd'\); \/\/ a file preview swaps views now/u.test(source),
    'the tap-time file slide is retired');
  assert.match(source, /function enterView\(v\) \{\s*\n\s*if \(pendingViewSlide\) \{ navAnim\(pendingViewSlide\); pendingViewSlide = ''; \}\s*\n\s*view = v;/u,
    'the swap fires the recorded slide exactly once');
  assert.match(source, /enterView\('info'\);/u, 'the unpreviewable path swaps through the same gate');
  assert.match(source, /enterView\('preview'\);/u, 'the preview swap goes through the same gate');
  assert.ok(!/view = 'preview';(?![\s\S]*loadPreviewContent)/u.test(source.slice(source.indexOf('async function loadPreviewContent'), source.indexOf('async function reloadPreview'))),
    'no preview branch bypasses the gate');
  assert.match(source, /pendingSlide = 'back';\s*\n\s*loadDir\(prev\);/u, 'the history pop rides its answer');
  assert.ok(!/function goBack\(\) \{\s*\n\s*navAnim\('back'\);/u.test(source),
    'goBack has no blanket tap-time slide — only its instant view branches');
  // Found in the same investigation: the restored-park branch tracked
  // entries/loading, so an EMPTY directory re-listed itself forever (each
  // load toggles the deps and re-arms the effect). One shot is the intent.
  assert.match(source, /if \(cwd && !entries\.length && !loading && !loadSeq\) loadDir\(cwd\);/u,
    'the restored park lists once — an empty directory is not a retry');
});

test('an OS drag onto the listing uploads into the CURRENT directory (board #22)', () => {
  // ONE destination rule for every upload entry point — and the DIR is a
  // PARAMETER bound at the gesture, never a live read: navigating away while
  // a batch uploads must not re-route the remaining files (review of
  // 82da1c9). Both helpers snapshot cwd on entry, every fsUpload routes
  // through uploadDest(dir, …), and nothing inside the loops re-reads cwd.
  assert.match(source, /const uploadDest = \(dir, name\) => dir\.replace\(\/\\\/\$\/, ''\) \+ '\/' \+ name;/u,
    'one destination rule, dir as a parameter');
  const helper = (name: string) => {
    const m = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`, 'u').exec(source)?.[0] ?? '';
    assert.ok(m, `${name} exists`);
    return m;
  };
  for (const name of ['uploadBlobFiles', 'uploadTauriPaths']) {
    const body = helper(name);
    assert.match(body, /const dir = cwd; \/\/ the batch's target, fixed at the gesture/u,
      `${name} snapshots its target ONCE, at entry`);
    assert.match(body, /\}\)\), dir\);/u, `${name} hands the snapshot to the one batch runner (#214)`);
    assert.equal(body.split('cwd').length - 1, 1,
      `${name} reads cwd exactly once — the snapshot; nothing in the loop can see a navigation`);
  }
  // The runner (#214) takes the dir as a PARAMETER and never looks at cwd.
  const runner = helper('runUploadBatch');
  assert.match(runner, /uploadDest\(dir, /u, 'uploads to the snapshot');
  assert.match(runner, /refreshAfterBatch\(dir\);/u, 'refreshes via the snapshot rule');
  assert.equal(runner.split('cwd').length - 1, 0, 'the runner cannot see a navigation');
  // The refresh rule: still looking at the target → show the arrivals; moved
  // on → touch NOTHING (reloading the snapshot dir would hijack the view
  // back, reloading the new dir would announce files that landed elsewhere).
  assert.match(source, /const refreshAfterBatch = \(dir\) => \{ if \(cwd === dir\) loadDir\(dir\); \};/u,
    'refresh only the directory the user is still in');
  // The browser transport: HTML5 events on the listing, files only (an app-
  // internal drag carries no Files type and must pass through untouched).
  assert.match(source, /ondragover=\{onListDragOver\} ondragleave=\{onListDragLeave\} ondrop=\{onListDrop\}/u,
    'the listing is the drop target');
  assert.match(source, /Array\.from\(e\.dataTransfer\?\.types \|\| \[\]\)\.includes\('Files'\)/u,
    'only real OS file drags engage');
  assert.match(source, /if \(e\.currentTarget\.contains\(e\.relatedTarget\)\) return;/u,
    'entering a child row is not leaving the listing');
  // The compiled app's transport: the webview INTERCEPTS native drags, so the
  // drop arrives as the webview's event with PATHS. The listener exists ONLY
  // while this instance is visible — the real gate against the parked
  // page-layer twin, because bare checkVisibility() does NOT check the
  // visibility property (visibilityProperty defaults FALSE — review of
  // 82da1c9) and .page-layer.hidden is exactly visibility:hidden.
  assert.match(source, /if \(!isTauri \|\| !visible\) return;[\s\S]{0,700}?onDragDropEvent/u,
    'the webview listener mounts only while visible, and unmounts with it');
  assert.match(source, /checkVisibility\(\{ visibilityProperty: true, checkVisibilityCSS: true \}\)/u,
    'the defense-in-depth check names the option — a bare call ignores visibility:hidden');
  assert.match(source, /getComputedStyle\(el\)\.visibility !== 'hidden'/u,
    'and falls back to computed style where the API is missing');
  assert.match(source, /pos\.x \/ dpr/u, 'physical pixels are converted before the rect test');
  // A missed drop must not navigate the tab away (that tears down the app):
  // stray drags are neutralized at the window while Files is visible, browser
  // only — and removed when it is not.
  assert.match(source, /if \(!visible \|\| isTauri\) return;/u, 'the guard is visible-gated and browser-only');
  assert.match(source, /window\.removeEventListener\('drop', block\);/u, 'and it cleans up after itself');
});

test('below its own path, a tab visit climbs to the parent — never the terminal (board #47)', () => {
  // popDir retraces the user's OWN steps (board #17); when that stack is
  // exhausted a TAB visit climbs parent directories via loadDir — NEVER
  // navTo, which would push the child back onto DIR history for the next
  // back to bounce down. The synthetic climb has no forward browser entry,
  // so it must replenish the APP entry consumed by this pop; otherwise a
  // deep path stalls after the pre-existing entries run out. Only a
  // chat-jumped visit falls through to App's return slot (the conversation).
  assert.match(source, /if \(popDir\(\)\) return true;[\s\S]{0,900}?const parent = directoryBackFloor\(cwd, jumped\);\s*if \(parent\) \{\s*pendingSlide = 'back';\s*navPush\(\);\s*loadDir\(parent\);\s*return true;\s*\}/u,
    'the climb sits under the user-path pop, replenishes app history, and loads without pushing dir history');
});

test('Files delegates preview markup to FilePreview without a second markdown pipeline (#110)', () => {
  // A README in any cloned repo is untrusted input rendered with {@html} in
  // the app origin, next to the token in localStorage. core/markdown.ts
  // escapes `&`/`<` first (rule 13); Files had its own renderer that did not,
  // so `<img src=x onerror=…>` in a README ran as script.
  assert.match(source, /import FilePreview from '\.\/FilePreview\.svelte';/u);
  assert.doesNotMatch(source, /marked\.parse\(|from 'marked'|from 'katex'/u, 'no second markdown/KaTeX pipeline');
  assert.match(source, /<FilePreview \{currentFile\} \{fontSize\} \{wrapLines\} \{hljs\}/u, 'the existing preview state is forwarded');
  assert.doesNotMatch(source, /\{#if mimeCategory\(currentFile\.stat/u, 'the render branch chain moved whole');
});

test('heavy preview libraries load on first use, never at startup', () => {
  // Files is statically imported by App and the Hub drawer, so a static import
  // here lands in the entry chunk of the primary (Android) target: pdf.js,
  // mermaid and highlight.js + 15 grammars were 1.5 MB of a 2.3 MB main chunk
  // that most sessions never open.
  assert.doesNotMatch(source, /^\s*import [^\n]* from '(?:pdfjs-dist|mermaid|highlight\.js)/mu, 'no static import of a preview library');
  assert.doesNotMatch(source, /^\s*import 'highlight\.js\/styles/mu, 'the highlighter CSS rides with the highlighter');
  // The moved loaders are tested in file-preview.test.ts. The host keeps the
  // same lifetime and live reads so preview unmounts do not reset their cache.
  assert.match(source, /const renderers = createPreviewRenderers\(\{/u);
  assert.match(source, /get currentFile\(\) \{ return currentFile; \}/u);
  assert.match(source, /get pdfContainer\(\) \{ return pdfContainer; \}/u);
  assert.match(source, /onHighlight: \(value\) => \{ hljs = value; \}/u);
  assert.match(source, /\$effect\(\(\) => \(\) => renderers\.dispose\(\)\);/u);
  assert.match(source, /let hljs = \$state\(null\);/u);
});

test('the lined preview retains host-owned cap state across editor round-trips (#110)', () => {
  // One DOM row + one hljs call per line: a 512 KB log is 20k rows and a
  // multi-second freeze on a phone. The head renders; the reader asks for the
  // rest. The split lives in a $derived so a wrap toggle does not re-split.
  assert.match(source, /let showAllLines = \$state\(false\);/u);
  assert.match(source, /bind:showAllLines bind:previewBodyEl bind:previewEl bind:htmlPreviewEl bind:pdfContainer/u,
    'cap and DOM references remain owned by the existing Files lifetime');
  assert.match(source, /showAllLines = false; \/\/ the cap is per file/u, 'a new file starts capped again');
});

test('navRequest can ask for a FILE: land in its directory with the preview open (board #99)', async () => {
  const source = await readFile(new URL('./Files.svelte', import.meta.url), 'utf8');
  // The imperative "go there" grew a file form: the list shows the file's
  // parent (so back lands somewhere sensible) and the preview opens on the
  // file itself — one request, both halves.
  assert.match(source, /if \(navRequest\.file\)/u, 'the file form exists');
  assert.match(source, /await loadDir\(parent, 'refresh'\)/u, 'the parent listing cannot race and close the preview');
  assert.match(source, /leaveEditor\(\(\) => openFileRef\(file\)\)/u,
    'external file requests retain their origin too');
  assert.match(source, /openEntry\(\{ type: 'file', name: file\.slice\(file\.lastIndexOf\('\/'\) \+ 1\), path: file \}, true\)/u,
    'and the preview opens through the one openEntry path (stat, recents, nav history)');
  // Round two (owner: "文件侧边栏上有一个报错 stat error… 然后弹出了一个新的
  // 页面"): the markdown PREVIEW renders anchors too, and a path href there
  // used to be a raw navigation — the webview left the app. The preview now
  // intercepts its own path links: relative refs resolve against the
  // PREVIEWED FILE's directory, and the target opens through openEntry like
  // any row tap. Real URLs keep the browser's behaviour.
  assert.match(source, /handlePathLinkClick\(e, openPreviewRef\)/u, 'preview and chat share one path handler');
  assert.match(source, /\{previewLinkClick\} \{attachHtmlPreviewLinks\} onview=/u, 'the body receives the same click/load handlers (and, #188, the image viewer)');
  assert.match(source, /resolvePathRef\(docDir, ref\)/u, 'relative refs resolve against the document');
  assert.match(source, /openPath: openPreviewRef,/u, 'iframe documents retain the same context-aware path callback');
  assert.match(source, /fileNav\.backFromPreview\(\{ cwd, currentFile, fromGit \}\)/u, 'the tested history owner chooses Back before the directory floor');
  assert.match(source, /step\.kind === 'restore'\) \{ restoreFileLocation\(step\.location\); return; \}/u, 'the component applies the captured location, including DOM scroll');
  assert.match(source, /if \(view === 'preview'\) \{ backToList\(\); return true; \}/u, 'the browser back handler uses the same preview history');
  assert.match(source, /handoff \|\| \(!!sourceRequest && !lastSourceDir\)/u, 'the first cwd response records the baseline without overriding a path handoff');
  const listPanel = source.slice(source.indexOf('{#snippet listPanel()}'), source.indexOf('{#snippet previewPanel()}'));
  assert.ok(!listPanel.includes('{#if error}'), 'the error banner belongs to Files, not only its hidden list: missing preview refs must be visible');
  // A dead reference fails in WORDS, not errno (round four: "即使路径不对，
  // 应该友好的提示，不要弹出新的窗口" — the window half is path-link-net.ts).
  assert.match(source, /error = \/No such file\|os error 2\/iu\.test\(e\.message \?\? ''\) \? `\$\{t\('fileMissing'\)\}: \$\{entry\.path\}` : e\.message;/u,
    'ENOENT on a file open reads as a sentence with the path');
});

test('the path row scrolls; its segments never squash (board #185)', () => {
  // Owner 2026-09-12: "当文件预览路径超过预览框宽度的时候显示有问题，文字有上下重叠了".
  // .bc-path-row is a flex row with overflow-x:auto that scrolls to its tail,
  // but a flex item's explicit min-width REPLACES its automatic min-content
  // floor: with min-width: var(--control-height) every segment shrank to
  // 28 px (measured in Chromium at 390/520 px: 14 segments × 28 px, text
  // 34–87 px wide) and the nowrap glyphs of neighbours painted over each
  // other. A segment keeps its width; the ROW is what moves.
  const seg = source.match(/\.bc-seg \{[^}]*\}/u)?.[0] ?? '';
  assert.match(seg, /flex-shrink: 0;/u, 'a breadcrumb segment never shrinks below its text');
  assert.match(source, /\.bc-scroll \{[^}]*overflow-x: auto;/u, 'the crumb strip scrolls instead');
});

test('the root reads as the first separator, not a wide first crumb (board #187)', () => {
  // Owner 2026-09-12: "首个 / 斜线后边的文件夹间距比较大，整体看的不是很和谐".
  // Measured: the segment min-width put the root glyph 15 px from "local"
  // where every other glyph sits 5 px from its neighbours; after, 5/5/5.
  assert.match(source, /<button class="bc-seg bc-root" onclick=\{\(\) => \{ if \(!selecting\(\)\) navTo\('\/', 'back'\); \}\}/u);
  // (#191: every crumb hugs its text now, so the root no longer needs its own min-width: 0.)
  assert.match(source, /\.bc-seg\.bc-root \{ padding-right: 0; color: var\(--text3\); font-size: var\(--fs-sub\); \}/u);
});

test('a crumb hugs its text — touch height, not a control-wide box (board #191)', () => {
  // Owner 2026-09-12: "文件路径显示可以紧凑一点". Measured at 390 coarse: with
  // min-width: var(--control-height) "src"/"lib"/"files" sat in 44/44/44 px
  // boxes for 23–30 px glyphs and the strip was 646 px; hugging, 594 px —
  // the same as pointer — with every box = glyph + 8 px.
  const seg = source.match(/\.bc-seg \{[^}]*\}/u)?.[0] ?? '';
  assert.doesNotMatch(seg, /min-width: var\(--control-height\)/u, 'no control-wide crumb');
  assert.match(seg, /min-height: var\(--control-height\)/u, 'the touch height stays');
});

test('surface long-presses keep the finger point; element presses take the element (board #196)', () => {
  // The directory background (toolbar, list) is a SURFACE — anchoring its menu
  // to the whole list's left/bottom would put it off the finger. Rows and crumbs
  // are elements and take what longpress hands them.
  assert.equal([...source.matchAll(/onlongpress: \(\{ x, y \}\) => openFileMenu\(\{ x, y \}, 'directory'\)/gu)].length, 2);
  assert.match(source, /onlongpress: \(at\) => openFileMenu\(at, 'entry', entry\)/u);
  assert.match(source, /onlongpress: \(at\) => openFileMenu\(at, 'path', \{ name: bc\.name, path: bc\.path, type: 'dir' \}\)/u);
});

test('reading mode: the header hides as a cut, the return floats above the safe area, the host is told (board #226)', () => {
  // Owner 2026-09-20: "放大按钮全屏显示，上下向上和向下隐藏起来，悬浮一个按钮，在回到普通模式".
  // The header's exit is a cut — the same treatment the tab bar gets while the
  // keyboard is up (motion principle 5); the floating control is one 44px
  // CommandButton, no new visual species.
  assert.match(source, /\.files\.reading \.preview-header \{ display: none; \}/u, 'the header steps away');
  const exit = source.match(/\.reading-exit \{[^}]*\}/u)?.[0] ?? '';
  assert.match(exit, /position: fixed;/u);
  assert.match(exit, /bottom: calc\(16px \+ var\(--sab\)\);/u, 'above the phone\'s safe area');
  assert.match(exit, /min-width: 44px; min-height: 44px;/u, 'a touch target');
  assert.match(source, /<CommandButton variant="secondary" iconOnly icon="minimize" label=\{t\('filesReadingExit'\)\}/u);
  assert.match(source, /<CommandButton variant="icon" icon="maximize" label=\{t\('filesReading'\)\} onclick=\{\(\) => \{ reading = true; navPush\(\); \}\}/u, 'entering is a layer: Back can leave it');
  // Reading mode is offered on the touch layout only, never for an image or a
  // video (the Lightbox / the player are their fullscreen), and it does not
  // outlive the preview or the page.
  assert.match(source, /let readingEligible = \$derived\(layout\.isTouchDevice && view === 'preview' && !!currentFile\n\s+&& !\['image', 'video'\]\.includes\(mimeCategory\(currentFile\.stat\?\.mime_hint\)\)\);/u);
  assert.match(source, /\$effect\(\(\) => \{ if \(!readingEligible \|\| !visible\) reading = false; \}\);/u);
  assert.match(source, /\$effect\(\(\) => \{ onimmersive\?\.\(reading\); \}\);/u, 'the host hides its chrome from this one signal');
  // Back order: the viewer, then reading mode, then the file menu.
  const back = source.indexOf("if (imageView) { imageView = ''; return true; }");
  const reading = source.indexOf('if (reading) { reading = false; return true; }');
  const menu = source.indexOf('if (fileMenu) { closeFileMenu(); return true; }');
  assert.ok(back > 0 && back < reading && reading < menu, 'reading mode is the layer under the viewer');
});

test('a download that lost its slot reports once, outside the live slot (board #301)', () => {
  assert.match(source, /const earlierLifetime = createFeedbackLifetime\(value => \{ earlierFeedback = value; \}\);/u);
  assert.match(source, /if \(!operation\.current\(\)\) \{ earlier\(\{ kind: 'success', message: t\('saved'\), detail: savedPath \}\); return; \}/u);
  assert.match(source, /if \(operation\.current\(\)\) downloadLifetime\.update\(token, failed\); else earlier\(failed\);/u);
  assert.doesNotMatch(source.slice(source.indexOf('return () => { copyLifetime.clear();'), source.indexOf('return () => { copyLifetime.clear();') + 120), /earlierLifetime/u,
    'leaving the context is the case it reports, so the context exit does not clear it');
});

test('the download feedback slot shows the store row; it keeps no copy of its own (board #308)', () => {
  // The rows are this server's record, from the scope (board #335 ②b-2-1);
  // what to show is the module's pure `feedbackOf` over the row.
  assert.match(source, /const store = files\.downloads;/u);
  assert.match(source, /const show = \(\) => \{ if \(operation\.current\(\)\) downloadLifetime\.update\(token, feedbackOf\(row, strings\(\)\)\); \};/u);
  assert.match(source, /const progress = \(fraction, received = 0, total = 0\) => \{ store\.progress\(rowId, received, total\); show\(\); \};/u);
  assert.doesNotMatch(source, /shown = \{ kind: 'progress'/u, 'the old private progress copy is gone');
  assert.match(source, /store\.done\(rowId, savedPath\);/u);
});

// The Files page's server door (board #358, owner 2026-10-13: "在 File 页面…能
// 很快速、方便地切换不同的 server 连接"): ONE mechanism — App's server popover,
// the same the rail and Settings open — never a second switcher species;
// shown by the ③c-1 tag rule; Files stays this server's tree (D3).
const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');

test('the door opens App s ONE server popover and is shown by the tag rule (#358)', () => {
  const door = source.slice(source.indexOf('{#snippet serverDoor()}'), source.indexOf('{#snippet listPanel()}'));
  assert.match(door, /\{#if onServers && scope\.tag\}/u, 'host-provided toggle AND the ③c-1 tag: more than one server included');
  assert.match(door, /<button type="button" class="server-door"[^>]*aria-haspopup="dialog" aria-expanded=\{serversOpen\}\s*aria-controls=\{serversOpen \? serversControls : undefined\}/u, 'the popover s own dialog semantics, like the phone s Settings row');
  assert.match(door, /onclick=\{\(e\) => onServers\?\.\(e\)\}/u, 'the host toggles; Files owns no server list');
  assert.ok(!/ServerList|loadServers|focusServer|currentServerId/u.test(source), 'no second switcher: Files imports nothing of the registry');
  // App hands Files the SAME toggle and open state the rail and Settings use.
  assert.match(app, /<Files [\s\S]*?onServers=\{toggleServerMenu\} serversOpen=\{serverMenuOpen\} serversControls=\{serverPickerId\} \/>/u);
  assert.match(app, /onServers=\{connected && layout\.isTouchDevice \? toggleServerMenu : null\} serversOpen=\{serverMenuOpen\} serversControls=\{serverPickerId\}/u, '(Settings phone row: the same three)');
});

// #366 (owner 2026-10-14: "你切换的按钮单独占了一整行…把它放到路径的最左侧，用一个
// 非常小的 button 来做切换，保留机器的前几个字母就好"): no row of its own — ONE
// snippet, rendered at the head of the line that says where you are.
test('the door is a small pill at the head of the path line, not a row of its own (#366)', () => {
  assert.equal(source.match(/class="server-door"/gu)?.length, 1, 'one door in the template (the snippet)');
  assert.doesNotMatch(source, /<div class="files" bind:this=\{filesEl\}[\s\S]*?>\n\s*\{#if onServers/u, 'no page-level row above the views');
  const door = source.slice(source.indexOf('{#snippet serverDoor()}'), source.indexOf('{#snippet listPanel()}'));
  assert.match(door, /<ServerTag name=\{serverShort \?\? scope\.tag\} title=\{scope\.tag\} \/>/u, 'the one tag atom, SHORT label, full name in its tooltip');
  assert.match(door, /aria-label=\{`\$\{t\('serversTitle'\)\}: \$\{scope\.tag\}`\}/u, 'the full name in its accessible name');
  assert.doesNotMatch(door, /<Icon /u, 'the glyph went: the pill is the door');
  const listPanel = source.slice(source.indexOf('{#snippet listPanel()}'), source.indexOf('{#snippet previewPanel()}'));
  assert.match(listPanel, /<div class="bc-path-row compact-tools">\s*\{@render serverDoor\(\)\}\s*<CommandButton variant="icon" icon="arrow-left"/u, 'the path row s FIRST item, before Back/Forward and the crumbs');
  // Every other view on one pane (#358: reachable from preview/edit/info/
  // downloads/git): after its Back. Two panes: the list column holds it.
  const after = source.slice(source.indexOf('{#snippet previewPanel()}'));
  // Whether a view's header carries it is ONE derived condition: the list
  // column is ON SCREEN (two panes AND >= 900px — forced Desktop below 900
  // takes the split DOM yet hides the list; #366 review P1), not which DOM
  // branch renders.
  assert.match(source, /const listShown = \$derived\(splitEligible && wideEnough\);/u, 'the list is visible: split AND the 900 the stylesheet needs');
  assert.match(source, /@media \(max-width: 899px\) \{[^}]*\.preview-open \.files-left \{ display: none; \}/u, 'the stylesheet rule that condition mirrors (SPLIT_MIN_WIDTH 900)');
  assert.equal(after.match(/\{#if !listShown\}\{@render serverDoor\(\)\}\{\/if\}/gu)?.length, 4, 'preview, edit, downloads, info');
  assert.equal(source.match(/<GitPanel bind:this=\{gitPanelRef\} \{cwd\} \{fontSize\} lead=\{listShown \? null : serverDoor\}/gu)?.length, 2, 'git, on both layouts chains');
  assert.doesNotMatch(source, /!splitEligible\}\{@render serverDoor|lead=\{splitEligible/u, 'no door decision reads the DOM branch');
  const git = readFileSync(new URL('./GitPanel.svelte', import.meta.url), 'utf8');
  assert.match(git, /<button class="back-btn"[^\n]*\n\s*\{@render lead\?\.\(\)\}/u, 'git: after its Back');
  assert.match(source, /\.files\.reading \.server-door \{ display: none; \}/u, 'reading mode hides it');
  assert.match(app, /serverShort=\{shortServerTag\(tagScope, runtime\.id\)\} onServers=\{toggleServerMenu\}/u, 'the short form is the host s, from the one tag rule');
});

test('the door wears tokens: a control-height box that never shrinks, the pill as its paint (#358, #366)', () => {
  const css = source.slice(source.indexOf('<style>'));
  const rule = css.match(/\.server-door \{([^}]*)\}/u)?.[1] ?? '';
  assert.ok(rule, 'the rule exists');
  assert.match(rule, /height: var\(--control-height\)/u, 'the row s touch height, like Back/Forward beside it');
  assert.match(rule, /flex: none/u, 'pinned: a long path scrolls in its strip, never pushes the door');
  assert.ok(!/font-size|\d+px|#[0-9a-f]{3,8}\b/iu.test(rule), 'tokens only');
  assert.match(css, /\.server-door:hover :global\(\.server-tag\), \.server-door\.open :global\(\.server-tag\) \{ background: var\(--control-hover\); color: var\(--text\); \}/u, 'hover/open lift the pill');
});

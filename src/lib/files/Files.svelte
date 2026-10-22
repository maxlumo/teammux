<script module>
  // What the Files pages remember about ONE server — browse positions keyed
  // by session name, the one-writer claim per part, each running attempt's
  // abort handle and settle, and the download rows — belongs to that server's
  // RUNTIME since board #335 ②b-2-1 (`app/server-state.ts`, `files`). Both
  // instances, this page and the Hub's drawer, sit in one server's subtree and
  // so share that record, and it outlives either of them. The rows and the
  // memory travel TOGETHER, as ②a ruled: removing a runtime has to forbid new
  // attempts, then suspend and AWAIT, then release — dropping the reference
  // is not stopping a download.
  //
  // A fresh page has no writer yet: drop claims a previous page (a webview
  // reload in a live process) left in Rust, or its parts could never be
  // resumed. Once per realm, before any download can start — a property of
  // the PROCESS, not of any server. `save-file.ts` owns it (memoised; every
  // download awaits it, board #447), and it is still begun here, at load.
  realmReady();

</script>

<script>
  import FilePreview from './FilePreview.svelte';
  import FileReview from './FileReview.svelte';
  import { createPreviewRenderers, defaultWrapForMime, highlightCode, isPreviewable, mimeCategory, streamsInline } from './file-preview.ts';
  import { isAndroid, isTauri, tauriReady } from '../core/platform.ts';
  import { invokeNative } from '../core/native.ts';
  import { bytesToB64 } from './download.ts';
  import { saveServerFile, realmReady } from './save-file.ts';
  import { speed as bytesPerSecond, feedbackOf } from './downloads.svelte.ts';
  import { useServerScope } from '../app/server-context.ts';
  import Icon from '../ui/Icon.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import ServerTag from '../ui/ServerTag.svelte';
  import Segmented from '../ui/Segmented.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import OperationFeedback from '../ui/OperationFeedback.svelte';
  import { createFeedbackLifetime } from '../ui/feedback-lifetime.ts';
  import ContextMenu from '../ui/ContextMenu.svelte';
  import { longpress } from '../ui/longpress.ts';
  import Lightbox from '../ui/Lightbox.svelte';
  import { createViewerDownload, viewerOpen } from './viewer-download.svelte.ts';
  import { anchorOf } from '../ui/placement.ts';
  import { systemOwnsContextMenu } from '../ui/native-context-menu.ts';
  import { copyActions, entryToolActions, visibleToolCount } from './file-tools.ts';
  import SideHandle from '../ui/SideHandle.svelte';
  import GitPanel from './GitPanel.svelte';
  import { hoverInfo } from '../ui/hover.ts';
  import { revealMs } from '../ui/motion.ts';
  import { createPersistedList } from './persisted-list.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { layout } from '../app/layout.svelte.ts';
  import { copyText } from '../core/clipboard.ts';
  import { tick, untrack } from 'svelte';
  import { registerLeaveGuard } from '../app/leave-guards.ts';
  import { directoryLoadState, leaveDecision, cwdFollowStep } from './file-view-state.ts';
  import { createFileNavigation, directoryBackFloor } from './file-nav.ts';
  import { handlePathLinkClick, resolvePathRef } from '../core/path-links.ts';
  import { uploadProgress, uploadSummary, uploadSizeError } from './file-upload.ts';

  // This server's Files record — memory and download rows together — and its
  // RPCs, from the scope this subtree is bound to (board #335 ②b-2-1, ②b-3),
  // read once at init. The machine id is the live socket's, as before: it
  // stamps a download row with the machine that served it.
  const scope = useServerScope();
  const { files } = scope.state;
  const memory = files.memory;
  const store = files.downloads;
  const { fsCwd, fsList, fsStat, fsRead, fsWrite, fsMkdir, fsDelete, fsRename, fsDownload, fsDownloadHttp, fsPreviewBase, fsUpload, getBookmarks, saveBookmarks, gitCmd, getPrefs, setPref, fsConvert } = scope.runtime.api;
  const { getMachineId } = scope.runtime.connection;
  // What one download attempt needs from this server (`save-file.ts`).
  const saveDeps = { memory, store, fsDownload, fsDownloadHttp, getMachineId };

  // Tauri plugin imports (tree-shaken in browser builds). The platform flags
  // come from the ONE module (rule 3); `tauriPlugins` is this file's own
  // "modules are in" promise, chained on the shared `tauriReady` gate.
  let tauriFs, tauriDialog, tauriOpener, tauriPath, tauriWebview;
  const tauriPlugins = isTauri ? tauriReady.then(() => Promise.all([
    import('@tauri-apps/plugin-fs').then(m => tauriFs = m),
    import('@tauri-apps/plugin-dialog').then(m => tauriDialog = m),
    import('@tauri-apps/plugin-opener').then(m => tauriOpener = m),
    import('@tauri-apps/api/path').then(m => tauriPath = m),
    import('@tauri-apps/api/webview').then(m => tauriWebview = m),
  ])) : Promise.resolve();

  // ── Heavy preview libraries load on FIRST USE, never at startup ──────────
  // highlight.js (+15 grammars), mermaid and pdf.js are 1.5 MB of the app that
  // most sessions never open; Files is statically imported by App and the Hub
  // drawer, so a static import here landed all of it in the entry chunk of the
  // primary (Android) target (2.30 MB before, review 2026-09-03). Each loader
  // is idempotent and memoizes its promise; the highlighter is a $state so the
  // preview it was loaded for re-renders highlighted once it arrives —
  // until then the same lines show escaped and unhighlighted.
  let hljs = $state(null);
  const renderers = createPreviewRenderers({
    get currentFile() { return currentFile; },
    get pdfContainer() { return pdfContainer; },
    get htmlPreviewEl() { return htmlPreviewEl; },
    download: fsDownload,
    onHighlight: (value) => { hljs = value; },
    openPath: openPreviewRef,
  });
  const { loadHljs, renderPdf, renderMermaidBlocks, resolveImages, attachHtmlPreviewLinks } = renderers;

  // `root` is the PROJECT'S DECLARED PATH (board #181, owner 2026-09-12: "你应该
  // 默认从我们选定的项目路径去跑"): when set, it is where this instance starts and
  // the source the follow rule watches — never the pane cwd, which is an
  // accident of whatever the user last touched in tmux (a zsh window, an
  // agent in a worktree). Empty = no declaration (a direct/adopted session):
  // follow the pane cwd, the pre-#181 rule. The Session-directory tool
  // (goSessionDir) keeps offering the pane cwd explicitly either way.

  let { session = '', root = '', guardPage = '', onGoBack = null, onimmersive = null, visible = false, fontSize = 14, singlePane = false, navRequest = null, jumped = false, currentDir = $bindable(''),
    // The server door (board #358, owner 2026-10-13: "在 File 页面…能很快速、
    // 方便地切换不同的 server 连接"): App's ONE server popover, the same the
    // rail and Settings open — the host hands the toggle (null = no door: a
    // single included server). Files stays this server's tree (D3); picking
    // another server is the ordinary focus move, and the next tree shows its
    // own parked cwd. Since #366 it is a small pill at the head of the path
    // line (and of each other view's header on one pane), `serverShort` its
    // label (`shortServerTag`), the full name in its tooltip and label.
    onServers = null, serversOpen = false, serversControls = undefined, serverShort = null,
    // Review feedback has landed in that room's composer or draft (#434): the
    // page's host may take the person there; the Hub's drawer needs nothing.
    onfeedback = undefined } = $props();
  const panelId = $props.id();
  const LIST_WIDTH = { min: 320, max: 520, default: 400 };
  $effect(() => {
    const saved = Number(localStorage.getItem('tmux_files_list_w'));
    if (saved >= LIST_WIDTH.min && saved <= LIST_WIDTH.max) {
      document.documentElement.style.setProperty('--files-list-w', `${saved}px`);
    }
  });

  /* The confirmation becomes a bottom sheet on a phone-sized viewport, the same
     rule the Hub's dialogs use. */
  let narrowViewport = $state(typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const onChange = () => { narrowViewport = mq.matches; };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  });

  function navPush() { history.pushState({ app: true }, ''); }

  // Register goBack for Android back gesture
  $effect(() => {
    if (onGoBack) onGoBack(() => {
      if (cancelPendingAct()) return true;
      if (imageView) { closeImage(); return true; } // the viewer is the topmost layer (board #188)
      if (reading) { reading = false; return true; } // reading mode is a layer over the preview (board #226)
      if (fileMenu) { closeFileMenu(); return true; }
      // navAnim('back') rides only the branches that CHANGE the view — the
      // git panel's internal peel and the unsaved-changes dialog move
      // nothing, so they must not slide the page.
      if (view === 'git') {
        if (gitPanelRef?.goBack()) return true;
        navAnim('back'); view = 'list'; return true;
      }
      if (view === 'edit') {
        leaveEditor(() => { navAnim('back'); view = 'preview'; });
        return true;
      }
      if (view === 'info') { backFromInfo(); return true; }
      if (view === 'preview') { backToList(); return true; }
      if (view === 'local') { navAnim('back'); view = 'list'; return true; }
      // The directory step retraces the user's OWN path (board #17); at the
      // entry point the stack is empty and the floor decides — App returns a
      // chat jump to the chat, a tab visit to the root.
      if (popDir()) return true;
      // Own path exhausted: a TAB visit CLIMBS to the parent instead of
      // leaving the page (board #47: "应该返回上级目录 不是去terminal") —
      // via loadDir, never navTo, or the climb would push DIR history for the
      // next back to bounce back down. This climb itself has no forward
      // navigation entry to consume (unlike popDir), so replenish the APP
      // history entry that this pop just spent; otherwise a deep path stalls
      // once the older entries run out. At / there is nothing above, so it
      // falls through (App re-pushes). A chat-jumped visit stands aside:
      // its floor is the conversation, App's return slot below.
      const parent = directoryBackFloor(cwd, jumped);
      if (parent) {
        pendingSlide = 'back';
        navPush();
        loadDir(parent);
        return true;
      }
      return false;
    });
  });

  // State
  let cwd = $state('');
  let entries = $state([]);
  let showHidden = $state(false);
  let loading = $state(false);        // directory listing in flight (left list)
  let previewLoading = $state(false); // file content in flight (right preview)
  let error = $state('');

  // View modes: 'list', 'preview', 'edit', 'info', 'local'
  let view = $state('list');
  let previewZoom = $state(100);

  // ─── Desktop two-pane (folder browser | preview) ──────────────────────────
  // On a wide, non-touch screen Files becomes a desktop-style file manager:
  // the list is always on the left, the preview fills the right. On mobile /
  // narrow / touch we keep the single-pane `view` chain unchanged. Mirrors the
  // split the Team tab already ships (Team.svelte).
  const SPLIT_MIN_WIDTH = 900;
  let wideEnough = $state(typeof window !== 'undefined' && window.innerWidth >= SPLIT_MIN_WIDTH);
  // singlePane: the embedder (Hub's drawer) opts into the phone view chain —
  // its column is 320–900px of a WIDE window, so the window-width heuristic
  // lies there (owner, 2026-08-28: "文件的侧边栏可以是类似手机的单页模式").
  let splitEligible = $derived(!singlePane && !layout.isTouchDevice && (layout.forceDesktop || wideEnough));
  /** The list column is ON SCREEN beside a view (#366 review P1): two panes
   * AND the 900px the stylesheet's `.preview-open .files-left` rule needs —
   * forced Desktop below 900 takes the split DOM yet hides the list. The ONE
   * condition for whether a view's own header carries the server door: the
   * list's path row carries it whenever the list is visible. */
  const listShown = $derived(splitEligible && wideEnough);
  /** The fixed system-status strip (App's `.sys-sidebar`, bottom-left over
   * the sidebar width) is over THIS page's content, not over the list
   * column that reserves its height (#434 validator on 4500d422): the
   * single-pane chain, or the split with its list hidden below 900px. App's
   * one reserve rule then gives the page the same `--sys-sidebar-h` bottom
   * the sidebars take, so a bottom control (the review fold, Show all lines)
   * is never under the strip. */
  const stripOverContent = $derived(!splitEligible || (view !== 'list' && !wideEnough));

  $effect(() => {
    const onResize = () => { wideEnough = window.innerWidth >= SPLIT_MIN_WIDTH; };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Drag the splitter to adjust the browser/preview width ratio (desktop only).

  // Android local files
  let localFiles = $state([]);
  let localDir = $state('');

  async function getLocalDir() {
    if (!isTauri) return '';
    return '/storage/emulated/0/Download/TmuxMobile/';
  }

  // The Downloads view (board #308): this session's rows come from the
  // store; what outlives the app (resumable parts everywhere, finished files
  // on Android) is read from the shell. The browser has only the store.
  let diskParts = $state([]);
  async function readDownloads() {
    if (!isTauri) return;
    const [files, parts] = await Promise.all([
      isAndroid ? invokeNative('list_downloads') : Promise.resolve([]),
      invokeNative('download_list_parts'),
    ]);
    localFiles = files.map(file => typeof file === 'string' ? { name: file, modified: 0 } : file);
    diskParts = parts;
    localDir = '/storage/emulated/0/Download/TmuxMobile/';
  }
  async function openLocalFiles() {
    try {
      await readDownloads();
      view = 'local';
      navPush();
    } catch (e) { error = e.message; }
  }
  const sessionRows = $derived(store.rows);
  const activeRows = $derived(sessionRows.filter((r) => r.state === 'downloading' || r.state === 'saving'));
  const failedRows = $derived(sessionRows.filter((r) => r.state === 'failed'));
  // The feedback stack's cards (board #420): every running download, newest
  // first, straight from the store; none in the Downloads view, which lists
  // the same rows itself.
  const stackedRows = $derived(view === 'local' ? [] : activeRows);
  // Resumable: a part on disk with no attempt. The store knows this
  // session's paused rows; the disk knows every part. One row per id.
  const resumableRows = $derived.by(() => {
    const busy = new Set(activeRows.map((r) => r.id));
    const out = new Map();
    for (const p of diskParts) if (!busy.has(p.id)) out.set(p.id, { id: p.id, name: p.name || p.id, path: p.path, server: p.server, received: p.received });
    for (const r of sessionRows) if (r.state === 'paused' && !busy.has(r.id)) out.set(r.id, { ...out.get(r.id), id: r.id, name: r.name, path: r.path, server: out.get(r.id)?.server ?? getMachineId(), received: out.get(r.id)?.received ?? r.received });
    return [...out.values()];
  });
  // Finished: on Android the folder itself (it outlives the app), on the
  // desktop and in the browser what this session saved.
  const finishedRows = $derived(isAndroid
    ? localFiles.map((f) => ({ key: `f:${f.name}`, name: f.name, local: f.name }))
    : sessionRows.filter((r) => r.state === 'done').map((r) => ({ key: r.id, name: r.name, savedPath: r.savedPath, requested: r.requested })));
  // A download changes what is on disk: refresh the lists when one ends.
  let lastActive = 0;
  $effect(() => {
    const n = store.active;
    if (n < lastActive && view === 'local') readDownloads().catch(() => {});
    lastActive = n;
  });
  function cancelDownload(id) { memory.abort(id); }
  async function deletePart(id) {
    try { await invokeNative('download_abort', { id }); store.forget(id); await readDownloads(); }
    catch (e) { error = e.message; }
  }
  async function openSaved(row) {
    try {
      if (row.local) await openFileNative(localDir + row.local);
      else if (row.savedPath && isTauri) { await tauriPlugins; await tauriOpener.openPath(row.savedPath); }
    } catch (e) { error = t('openFailed') + (e.message || e); }
  }
  const rowSpeed = (row) => {
    const bps = bytesPerSecond(row);
    return bps ? `${formatSize(Math.round(bps))}/s` : '';
  };
  const rowFeedback = (row) => {
    const value = feedbackOf(row, { downloading: t('downloading'), changed: t('downloadFileChanged'), saving: t('saving') });
    const speedText = rowSpeed(row);
    return { ...value, detail: speedText ? `${row.name} · ${speedText}` : row.name };
  };

  function getFileOpener() {
    try {
      const opener = window.AndroidFileOpener;
      return opener?.ping?.() === 'ok' ? opener : null;
    } catch {
      return null;
    }
  }

  async function waitForFileOpener(maxWait = 5000) {
    let opener = getFileOpener();
    if (opener) return opener;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      await new Promise(r => setTimeout(r, 100));
      opener = getFileOpener();
      if (opener) return opener;
    }
    return null;
  }

  async function openFileNative(path) {
    const opener = getFileOpener() || await waitForFileOpener();
    if (!opener) throw new Error('No file opener available after app resume');
    const result = opener.openFile(path);
    if (result !== 'ok') throw new Error(result);
  }

  async function openLocalFile(name) {
    try {
      await openFileNative(localDir + name);
    } catch (e) { error = t('openFailed') + (e.message || e); }
  }

  async function deleteLocalFile(name) {
    await invokeNative('delete_download', { name });
  }
  let currentFile = $state(null); // { path, name, stat, content }
  let editContent = $state('');
  let editOriginal = $state('');
  let undoStack = $state([]);
  // Refs for the three stacked editor layers (line-number gutter, syntax
  // highlight, and the transparent textarea on top). The textarea is the only
  // scrollable layer; the gutter and highlight are kept in lockstep with it via
  // syncEditorScroll so line numbers always line up with their lines — even
  // when a long line scrolls horizontally instead of soft-wrapping.
  let taEl;     // textarea
  let numsEl;   // gutter
  let hlEl;     // highlight <pre>
  let layerEl;  // .editor-layer (sized to the highlight/textarea content box)
  let mirrorEl; // off-screen per-line mirror used to measure wrapped line heights
  // Per-logical-line pixel heights, measured from the mirror. The gutter renders
  // one number block per entry at that height, so numbers stay aligned with the
  // text whether or not lines wrap. Empty until first measure (the gutter then
  // falls back to natural line height via the `h ? … : ''` guard).
  let lineHeights = $state([]);
  // Soft-wrap toggle. Prose (markdown / plain text) defaults to wrapped — no
  // horizontal scrolling while writing, and line numbers are hidden since they
  // can't track wrapped rows. Code/config (yaml, json, rs, …) defaults to
  // no-wrap so the gutter stays exactly aligned (long lines scroll sideways).
  let wrapLines = $state(false);
  /** The destructive action awaiting confirmation:
   *   { kind: 'file', path }     — delete on the server, no trash, no undo
   *   { kind: 'local', name }    — delete a downloaded copy (had NO confirm)
   *   { kind: 'leave', run }     — abandon unsaved edits; `run` is the parked
   *                                move (was a native confirm(), i.e. an OS
   *                                dialog in the middle of our UI)
   * Tap-to-confirm is gone: it re-labelled the button for 3s, said nothing about
   * what is lost, and differed from every other destructive verb in the app. */
  let pendingAct = $state(null);
  let acting = $derived(!!pendingAct?.busy);
  let alive = true;
  $effect(() => () => { alive = false; });
  const actCurrent = (act) => alive && visible && session === act.context.session
    && root === act.context.root && cwd === act.context.cwd && view === act.context.view
    && currentFile === act.context.file && navRequest === act.context.request
    && loadSeq === act.context.load && (act.kind !== 'local' || localFiles === act.context.files);
  function requestAct(act) {
    untrack(() => {
      if (pendingAct?.busy && actCurrent(pendingAct)) return;
      pendingAct = { ...act, busy: false, error: '',
        context: { session, root, cwd, view, file: currentFile, request: navRequest, load: loadSeq, files: localFiles } };
    });
  }
  function cancelPendingAct() {
    if (!pendingAct) return false;
    if (!pendingAct.busy) { pendingAct.cancel?.(); pendingAct = null; }
    return true;
  }
  $effect(() => {
    // loadSeq is deliberately plain; loading observes a new directory request.
    void loading;
    if (pendingAct && !actCurrent(pendingAct)) { pendingAct.cancel?.(); pendingAct = null; }
  });
  // A server switch destroys this instance (board 315): it asks through the
  // editor's own discard dialog first, after any delete in flight finished.
  $effect(() => registerLeaveGuard({
    runtime: scope.runtime,
    page: guardPage,
    dirty: () => untrack(() => !!pendingAct?.busy || leaveDecision({ view, edited: isEdited }) !== 'go'),
    ask: async () => {
      while (untrack(() => pendingAct?.busy)) await new Promise((r) => setTimeout(r, 50));
      if (untrack(() => leaveDecision({ view, edited: isEdited })) === 'go') return true;
      await tick(); // the revealed layer is visible before the dialog asks
      return new Promise((resolve) => {
        requestAct({ kind: 'leave', run: () => resolve(true), cancel: () => resolve(false) });
        if (!untrack(() => pendingAct?.kind === 'leave')) resolve(false);
      });
    },
  }));
  /** EVERY way out of the editor goes through here — the back button/gesture,
   *  a session switch, the cwd follow, the drawer's "look here". No edits:
   *  `run` moves now. Unsaved edits: `run` waits behind the discard dialog and
   *  fires on confirm; cancel DROPS it — a move is never queued. Until
   *  2026-09-03 only the back button asked; the other three set view = 'list'
   *  outright and the text was gone. `untrack` because the callers are
   *  $effects that must not start re-running on every keystroke. */
  function leaveEditor(run) {
    if (untrack(() => pendingAct?.busy && actCurrent(pendingAct))) return;
    if (untrack(() => leaveDecision({ view, edited: isEdited })) === 'go') { run(); return; }
    requestAct({ kind: 'leave', run });
  }
  const ACT_COPY = {
    file:  { title: 'confirmDeleteFileTitle',  note: 'confirmDeleteFileNote',  go: 'delete' },
    local: { title: 'confirmDeleteLocalFileTitle', note: 'confirmDeleteLocalFileNote', go: 'delete' },
    leave: { title: 'confirmDiscardTitle',     note: 'confirmDiscardNote',     go: 'confirmDiscard' },
  };
  const actName = (a) => (a?.kind === 'file' ? (a.path.split('/').pop() ?? a.path) : a?.name ?? '');
  async function runPendingAct() {
    const act = pendingAct;
    if (!act || act.busy || !actCurrent(act)) return;
    act.busy = true;
    act.error = '';
    try {
      if (act.kind === 'file') await fsDelete(act.path);
      else if (act.kind === 'local') await deleteLocalFile(act.name);
      else act.run();
    } catch (e) {
      if (pendingAct === act && actCurrent(act)) act.error = String(e?.message ?? e);
      return;
    } finally { act.busy = false; }
    if (pendingAct !== act) return;
    pendingAct = null;
    if (!actCurrent(act)) return;
    if (act.kind === 'local') localFiles = localFiles.filter(f => f.name !== act.name);
    if (act.kind === 'file') {
      entries = entries.filter(entry => entry.path !== act.path);
      // Only the deleted file (or a child of a deleted directory) loses its
      // preview. Another row's deletion must not discard the active draft.
      if (currentFile?.path === act.path || currentFile?.path.startsWith(act.path.replace(/\/$/, '') + '/')) {
        fileNav.nextFile();
        fileNav.resetFiles();
        view = 'list';
        currentFile = null;
      }
      // The mutation already succeeded. A listing error is not a failed
      // delete and must never leave a retryable destructive confirmation.
      loadDir(act.context.cwd, 'refresh');
    }
  }
  let newName = $state('');
  let newType = $state(''); // 'file' or 'dir'
  let renaming = $state(null); // path being renamed
  let renameValue = $state('');
  let bcPathEl = $state(null);
  let pdfContainer = $state(null);
  let filesEl = $state(null);
  let bookmarks = $state([]);
  let showBookmarks = $state(false);
  let recentFiles = $state([]);
  let showRecent = $state(false);
  let fileMenu = $state(null);
  let toolbarBox = $state({ width: 0, target: 0, gap: 0 });
  const rowHandlers = {
    open: (entry) => { const target = { ...entry }; leaveEditor(() => openEntry(target)); },
    copy: copyPath,
    download: handleDownload,
    rename: (entry) => { renaming = entry.path; renameValue = entry.name; },
    remove: (path) => requestAct({ kind: 'file', path }),
  };
  const rowActions = (entry) => entryToolActions(entry, t, rowHandlers);
  const toolbarActions = $derived([
    // The house, not the terminal glyph: in this app "terminal" means "open a
    // terminal" (owner, 2026-09-13: "第一个按钮有歧义，应该变成小房子"; board #194).
    { key: 'cwd', label: t('filesSessionDir'), icon: 'home', run: goSessionDir },
    { key: 'refresh', label: t('filesRefresh'), icon: 'refresh', pending: loading, run: () => loadDir(cwd) },
    { key: 'new', label: t('filesNew'), icon: 'plus', expanded: !!newType, controls: newType ? `${panelId}-new` : undefined,
      run: () => { newType = newType ? '' : 'file'; newName = ''; } },
    { key: 'upload', label: t('filesUpload'), icon: 'upload', run: handleUpload },
    { key: 'hidden', label: t('filesShowHidden'), icon: showHidden ? 'eye' : 'eye-off', pressed: showHidden,
      run: () => { showHidden = !showHidden; loadDir(cwd); } },
    { key: 'bookmark', label: t('filesBookmark'), icon: isBookmarked(cwd) ? 'star-filled' : 'star', pressed: isBookmarked(cwd),
      run: () => toggleBookmark(cwd) },
    { key: 'bookmarks', label: t('filesBookmarks'), icon: 'folder-star', expanded: showBookmarks,
      controls: showBookmarks ? `${panelId}-bookmarks` : undefined, run: () => { showBookmarks = !showBookmarks; showRecent = false; } },
    { key: 'recent', label: t('filesRecent'), icon: 'clock', expanded: showRecent,
      controls: showRecent ? `${panelId}-recent` : undefined, run: () => { showRecent = !showRecent; showBookmarks = false; } },
    ...(hasGit ? [{ key: 'git', label: 'Git', icon: 'git-branch', run: openGitView }] : []),
    { key: 'downloads', label: t('downloads'), icon: 'download', run: openLocalFiles },
  ]);
  const toolCount = $derived(visibleToolCount(toolbarActions.length, toolbarBox.width, toolbarBox.target, toolbarBox.gap));
  const closeFileMenu = () => { fileMenu = null; };
  const menuCurrent = (menu) => fileMenu === menu && visible && session === menu.session
    && cwd === menu.cwd && entries === menu.entries && view === menu.view
    && (menu.kind !== 'overflow' || toolCount < toolbarActions.length);
  const menuActions = $derived.by(() => {
    const menu = fileMenu;
    if (!menu) return [];
    // A path crumb offers its name and its path (board #187/#191); a row its
    // file; the rest the tools.
    const actions = menu.kind === 'path'
      ? copyActions(menu.entry, t, rowHandlers.copy)
      : menu.entry ? rowActions(menu.entry)
      : menu.kind === 'overflow' ? toolbarActions.slice(toolCount) : toolbarActions;
    return actions.map(action => ({
      label: action.label, icon: action.icon, danger: action.danger,
      disabled: !!action.disabled || !!action.pending, checked: action.pressed ?? action.expanded,
      onselect: () => { if (menuCurrent(menu) && !action.disabled && !action.pending) action.run(); },
    }));
  });
  function openFileMenu(at, kind, entry = null) {
    if (!visible || pendingAct || acting) return;
    fileMenu = { at, kind, entry, session, cwd, entries, view };
  }
  function contextFile(event, entry = null) {
    if (systemOwnsContextMenu(event)) { event.preventDefault(); return; }
    event.preventDefault(); event.stopPropagation();
    const at = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY }
      : { anchor: anchorOf(event.currentTarget), align: 'left' };
    openFileMenu(at, entry ? 'entry' : 'directory', entry);
  }
  const directoryPress = (target) => !target?.closest?.('.file-row');
  /** Right-click / long-press on a crumb: the one context-menu mechanism,
   * offering that segment's path (board #187: "这个路径最好可以复制"). */
  function contextCrumb(event, crumb) {
    if (systemOwnsContextMenu(event)) { event.preventDefault(); return; }
    event.preventDefault(); event.stopPropagation();
    const at = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY }
      : { anchor: anchorOf(event.currentTarget), align: 'left' };
    openFileMenu(at, 'path', { name: crumb.name, path: crumb.path, type: 'dir' });
  }
  /** A tap that ends a text selection is a copy gesture, not a navigation —
   * crumb and file-name text are selectable (owner: "文件夹文件的名字我也可以
   * 选中复制"); Feed's bubbles use the same guard. */
  const selecting = () => typeof getSelection === 'function' && !(getSelection()?.isCollapsed ?? true);
  function measureToolbar(node) {
    const measure = () => {
      if (!node.clientWidth) return;
      const style = getComputedStyle(node);
      const width = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (fileMenu?.kind === 'overflow' && width !== toolbarBox.width) closeFileMenu();
      toolbarBox = { width, target: parseFloat(style.getPropertyValue('--control-height')), gap: parseFloat(style.columnGap) || 0 };
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node); measure();
    return { destroy: () => observer.disconnect() };
  }
  $effect(() => { if (fileMenu && !menuCurrent(fileMenu)) closeFileMenu(); });
  const bookmarksRead = $state({ ready: false, error: '' });
  const recentsRead = $state({ ready: false, error: '' });

  // Both lists are server-persisted whole arrays with clobber/race guards
  // (single-flighted first load, generation-counter staleness checks) —
  // the shared discipline lives in persisted-list.ts; these are mirrors.
  const recentsList = createPersistedList({
    fetch: async () => (await getPrefs()).recentFiles || [],
    persist: (items) => setPref('recentFiles', items),
    onChange: (items) => { recentFiles = items; recentsRead.ready = true; recentsRead.error = ''; },
  });

  $effect(() => {
    // Depend on `visible` so this re-runs when the user opens the Files tab.
    // Files is always mounted now (even before the socket connects), and this
    // effect has no other reactive dep — without the `visible` gate it would
    // fire once at mount (often pre-connection), fail, and never retry, leaving
    // Recent empty forever.
    if (!visible) return;
    loadRecents();
  });

  function addRecent(path, name) {
    return recentsList.mutate(items => [{ path, name }, ...items.filter(f => f.path !== path)].slice(0, 20));
  }

  // Git: the panel itself (status/log/diff/commit/push) lives in
  // GitPanel.svelte and owns all git state. Files keeps only the
  // "is this a repo?" probe for the toolbar button, the view routing,
  // and the fromGit flag for back-navigation out of previews.
  let hasGit = $state(false);
  let fromGit = $state(false);
  let gitPanelRef = $state(null);

  $effect(() => {
    if (cwd) {
      gitCmd('rev-parse', ['--git-dir'], cwd).then(r => { hasGit = r.code === 0; }).catch(() => { hasGit = false; });
    }
  });

  function openGitView() {
    view = 'git';
    navPush();
  }

  const bookmarksList = createPersistedList({
    fetch: async () => (await getBookmarks()).bookmarks || [],
    persist: (items) => saveBookmarks(items),
    onChange: (items) => { bookmarks = items; bookmarksRead.ready = true; bookmarksRead.error = ''; },
  });

  $effect(() => {
    // Same visible-gate rationale as the recents effect above.
    if (!visible) return;
    loadBookmarks();
  });

  function loadBookmarks() {
    bookmarksRead.error = '';
    bookmarksList.load().catch(e => { bookmarksRead.error = String(e?.message ?? e); });
  }
  function loadRecents() {
    recentsRead.error = '';
    recentsList.load().catch(e => { recentsRead.error = String(e?.message ?? e); });
  }
  function isBookmarked(path) { return bookmarks.includes(path); }

  function toggleBookmark(path) {
    return bookmarksList.mutate(items => (
      items.includes(path) ? items.filter(b => b !== path) : [...items, path]
    ));
  }

  // Edge-swipe back, INTERACTIVE (owner, 2026-08-25: "文件浏览页面的滑动手势
  // …做的更丝滑一些"): the page follows the finger with damping instead of
  // firing blind at finger-lift, releases spring back, and a commit plays the
  // drill-back slide. Two guards the old two-liner lacked: an intent lock
  // (a diagonal scroll that drifted 60px right used to trigger goBack), and
  // cancelability (drag out, drag back, release = nothing). The transform
  // lives only while the finger does — a resting transform would make .files
  // a containing block and break fixed popovers (design-language.md §2).
  // (Pull-to-refresh stays removed — it conflicts with top-edge scrolling.)
  const SWIPE_EDGE = 40, SWIPE_COMMIT = 60, SWIPE_DAMP = 0.4, SWIPE_CAP = 96;
  let swipeStartX = 0, swipeStartY = 0;
  let swipeEdge = false;      // started at the left edge
  let swipeIntent = 0;        // 0 undecided, 1 horizontal, -1 vertical
  let swipeDX = $state(0);    // damped, drives the live translate
  let swipeSnap = $state(false); // animate the spring-back

  function onTouchStart(e) {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipeEdge = swipeStartX < SWIPE_EDGE && !splitEligible;
    swipeIntent = 0;
    swipeSnap = false;
  }
  function onTouchMove(e) {
    if (!swipeEdge) return;
    const dx = e.touches[0].clientX - swipeStartX;
    const dy = e.touches[0].clientY - swipeStartY;
    if (swipeIntent === 0 && (Math.abs(dx) > 8 || Math.abs(dy) > 8))
      swipeIntent = Math.abs(dx) > Math.abs(dy) * 1.2 ? 1 : -1;
    swipeDX = swipeIntent === 1 ? Math.min(Math.max(dx, 0) * SWIPE_DAMP, SWIPE_CAP) : 0;
  }
  function onTouchEnd(e) {
    if (!swipeEdge) return;
    const dx = e.changedTouches[0].clientX - swipeStartX;
    swipeEdge = false;
    if (swipeIntent === 1 && dx > SWIPE_COMMIT) { swipeDX = 0; goBack(); }
    else if (swipeDX > 0) { swipeSnap = true; swipeDX = 0; }
  }
  function onTouchCancel() {
    if (!swipeEdge) return;
    swipeEdge = false;
    if (swipeDX > 0) { swipeSnap = true; swipeDX = 0; }
  }

  // Navigation motion (the drill grammar in design-language.md §1): going
  // deeper enters from the right, back from the left — single-pane touch
  // layout only; the desktop split has no view chain to slide. The class is
  // dropped and re-added a frame later so a second hop in the SAME direction
  // replays the animation.
  let navAnimClass = $state('');
  function navAnim(dir) {
    if (splitEligible) return;
    navAnimClass = '';
    requestAnimationFrame(() => { navAnimClass = dir; });
  }
  // A FILE open's slide waits for its answer like a directory's (board #93
  // round three): openEntry records it here, and the view swap that shows
  // the answer fires it — never the list the tap is leaving.
  let pendingViewSlide = '';
  function enterView(v) {
    if (pendingViewSlide) { navAnim(pendingViewSlide); pendingViewSlide = ''; }
    view = v;
  }

  // ── BACK is a HISTORY, not a parent walk (board #17) ─────────────────
  // "实现一个类似于'后退'的逻辑": every navigation the USER makes inside the
  // page (entering a directory, a crumb, a bookmark, the up/home buttons)
  // pushes where they WERE, and back pops exactly that path — so back retraces
  // the user's own steps. An EXTERNAL move (session switch, the cwd follow
  // rule, a directory handoff) RESETS the stack instead: it is a new entry point.
  // Below the stack, a tab visit climbs parent directories to / (board #47);
  // only a chat-jumped visit leaves the page, via App's return slot.
  const fileNav = createFileNavigation();
  // Linked previews sit above the directory history: Back returns to the
  // document/list that supplied the link, including its reading position.
  let previewBodyEl = $state(null);
  function fileLocation() {
    return { cwd, entries, view, currentFile, fromGit, scroll: previewBodyEl?.scrollTop ?? 0,
      frameScroll: htmlPreviewEl?.contentDocument?.scrollingElement?.scrollTop ?? 0 };
  }
  function restoreFileLocation(previous) {
    fileNav.nextFile();
    ++loadSeq;
    previewLoading = false;
    loading = false;
    pendingViewSlide = '';
    ({ cwd, entries, view, currentFile, fromGit } = previous);
    navAnim('back');
    requestAnimationFrame(() => {
      if (previewBodyEl) previewBodyEl.scrollTop = previous.scroll;
      if (htmlPreviewEl?.contentDocument?.scrollingElement) htmlPreviewEl.contentDocument.scrollingElement.scrollTop = previous.frameScroll;
    });
  }
  // fileNav is plain state; this tick lets the toolbar's Back/Forward
  // enablement follow it (board #187).
  let navTick = $state(0);
  const canGoBack = $derived.by(() => { void navTick; return fileNav.canGoBack(); });
  const canGoForward = $derived.by(() => { void navTick; return fileNav.canGoForward(); });
  function resetDirectories() { fileNav.resetDirectories(); navTick++; }
  function navTo(path, slide = '') {
    fileNav.rememberDirectory(cwd, path);
    navTick++;
    pendingSlide = slide;
    loadDir(path);
  }
  function popDir() {
    const prev = fileNav.popDirectory(cwd);
    navTick++;
    if (prev == null) return false;
    // A directory link's step (board #431): back to the preview it was
    // followed from, with its reading position.
    if (typeof prev !== 'string') { restoreFileLocation(prev.location); return true; }
    pendingSlide = 'back';
    loadDir(prev);
    return true;
  }
  /** Forward undoes the last Back — the browser pair (board #187, owner:
   * "类似浏览器后退前进的按钮，方便我跳转位置后快速回来"). */
  function fwdDir() {
    const next = fileNav.forwardDirectory(cwd);
    navTick++;
    if (next == null) return false;
    pendingSlide = 'fwd';
    loadDir(next);
    return true;
  }

  function goBack() {
    if (cancelPendingAct()) return;
    // The view branches slide NOW (they swap instantly); the directory pop's
    // slide rides its answer (board #93 — the entrance is one beat).
    if (view === 'edit') { navAnim('back'); view = 'preview'; }
    else if (view === 'info') backFromInfo();
    else if (view === 'preview') backToList();
    else popDir();
  }


  // Breadcrumb parts
  let breadcrumbs = $derived.by(() => {
    if (!cwd) return [];
    const parts = cwd.split('/').filter(Boolean);
    return parts.map((name, i) => ({
      name,
      path: '/' + parts.slice(0, i + 1).join('/')
    }));
  });

  let isEdited = $derived(view === 'edit' && editContent !== editOriginal);
  // True when the preview is the per-line code/text view (where a wrap toggle
  // makes sense) — not markdown/csv/html/pdf/image/converted output.
  let isLinedPreview = $derived.by(() => {
    if (!currentFile?.stat || currentFile?.convertedHtml) return false;
    const cat = mimeCategory(currentFile.stat.mime_hint);
    return cat === 'code' || cat === 'other';
  });

  $effect(() => {
    cwd;
    setTimeout(() => { if (bcPathEl) bcPathEl.scrollLeft = bcPathEl.scrollWidth; }, 0);
  });

  // Sync Files to the terminal/team working directory — but only when that dir
  // CHANGES (you switched pane/team, or cd'd). If it's unchanged, your own
  // in-Files navigation is preserved across tab switches. Re-checked whenever
  // Files becomes visible or the session changes.
  //
  // Per-SESSION browse memory (owner, 2026-08-22: "一个project刷新路径后 这个
  // project当前又动过路径需要暂时记下来，在切到其他project再切回来能返回之前
  // 这个project的路径状态位置"): switching projects parks where you were
  // browsing under the project you leave and restores the other project's
  // parked position. In-memory on purpose — it is a temporary reading
  // position, not a preference — and the existing rule still outranks it:
  // when THAT project's tmux cwd moved while you were away (someone cd'd),
  // following the real cwd wins over the parked position.
  // svelte-ignore state_referenced_locally — the INITIAL session is exactly
  // what "previous" means before the first switch; the effect updates it.
  let prevSession = session;
  // A NEW instance starts from the shared parked position (the Hub's drawer
  // mounts a fresh Files on every open — without this it forgot its place;
  // owner, 2026-08-28: "每个 project 自己记录自己的 current路径").
  // svelte-ignore state_referenced_locally — the MOUNT-time session is the one
  // whose parked position a new instance should wake up in.
  const parked0 = memory.position(session);
  let lastSourceDir = parked0?.sourceDir ?? '';
  if (parked0?.cwd) cwd = parked0.cwd;
  // Park on unmount too — the drawer instance dies with the drawer, and a
  // position recorded only at the next session switch would never be written.
  $effect(() => () => { memory.park(prevSession, { cwd, sourceDir: lastSourceDir }); });
  $effect(() => {
    if (!visible) { void session; return; }
    if (session !== prevSession) {
      fileNav.nextFile();
      fileNav.resetFiles();
      // cwd still holds the OLD session's position — nothing else resets it.
      memory.park(prevSession, { cwd, sourceDir: lastSourceDir });
      prevSession = session;
      const parked = memory.position(session);
      lastSourceDir = parked?.sourceDir ?? '';
      resetDirectories(); // a session switch is a new entry point, not a step
      if (parked?.cwd) {
        // An unsaved editor holds the switch behind the discard dialog
        // (leaveEditor); the parked position is a hint, the text is not.
        leaveEditor(() => { cwd = parked.cwd; view = 'list'; loadDir(parked.cwd); });
      }
    }
    // Restored park: list it ONCE. The guard is loadSeq (non-reactive on
    // purpose): this effect tracks entries/loading, so without it an EMPTY
    // directory re-armed the branch on its own completion and re-listed
    // itself forever (board #93's investigation).
    if (cwd && !entries.length && !loading && !loadSeq) loadDir(cwd);
    // session may be '' when Files is opened before any terminal pane exists —
    // the server then reports the user's home directory. Once a terminal/team
    // session appears, its cwd differs from home and we follow it.
    const sourceSession = session;
    const sourceRequest = navRequest;
    const handoff = !!sourceRequest && sourceRequest.n !== lastNav;
    // Declaration over pane accident: a declared root IS the source; only a
    // session without one asks tmux where its active pane is.
    const source = root ? Promise.resolve({ path: root }) : fsCwd(sourceSession);
    source.then(r => {
      if (session !== sourceSession || navRequest !== sourceRequest) return;
      // The follow is DISARMED before it asks (lastSourceDir moves first): a
      // cancelled follow is skipped for this event, not queued — the next
      // re-run sees the same cwd and stays quiet (file-view-state.test.ts).
      const step = cwdFollowStep(r.path, lastSourceDir, untrack(() => ({ view, edited: isEdited })),
        handoff || (!!sourceRequest && !lastSourceDir));
      lastSourceDir = step.lastSourceDir;
      if (step.move === 'none') return;
      leaveEditor(() => {
        cwd = r.path;
        view = 'list';
        resetDirectories(); // the follow rule moved us — a new entry point
        loadDir(r.path);
      });
    }).catch(() => {
      if (session === sourceSession && !navRequest && !lastSourceDir) { lastSourceDir = '/'; cwd = '/'; loadDir('/'); }
    });
  });

  // Refresh the preview content when returning to the tab on a preview.
  $effect(() => {
    if (visible && view === 'preview') reloadPreview();
  });

  // The embedder can read where this instance is (the drawer's maximize
  // button hands its cwd to the Files PAGE instance).
  $effect(() => { currentDir = cwd; });

  // An imperative "go there" from outside. Same shape as AgentsPage's
  // editRequest: a bumped `n` re-fires an identical path.
  let lastNav = 0;
  $effect(() => {
    if (!navRequest || navRequest.n === lastNav) return;
    lastNav = navRequest.n;
    if (navRequest.file) {
      // A FILE request (board #99: a chat path reference): the list lands in
      // the file's parent — so back and the crumbs mean something — and the
      // preview opens on the file itself through the one openEntry path
      // (stat, previewability, recents, nav history).
      const file = navRequest.file;
      leaveEditor(() => openFileRef(file));
    } else if (navRequest.path) {
      const to = navRequest.path;
      leaveEditor(() => {
        view = 'list';
        resetDirectories(); // a drawer/see-here handoff is a new entry point
        loadDir(to);
      });
    }
  });

  // The ENTRANCE is ONE beat, at answer time (board #93, owner: "旧的页面滑
  // 出去，新的页面进来。同时新的页面应该从上到下按行显示过渡加载。新页面加载和
  // 滑入是同时进行的"): the drill slide and the top-to-bottom unfold start
  // TOGETHER when the new directory lands. The tap-time slide was the flash —
  // it finished over the OLD rows, and the swap then read as a detached blink.
  // A slow answer starts its entrance late (the owner's "慢半拍" — that is the
  // honest reading); the busy dim (150ms threshold) covers the wait. The
  // unfold also plays for a first fill and for slide-less navigations (the
  // desktop split, an external jump), where it IS the whole entrance; a
  // same-directory refresh keeps its nodes and animates nothing.
  let revealDir = $state('');
  let revealTimer = null;
  let pendingSlide = ''; // 'fwd' | 'back' — set by the navigation, consumed when its answer lands
  let loadSeq = 0;
  async function loadDir(path, purpose = 'navigate') {
    if (purpose === 'navigate') { fileNav.nextFile(); fileNav.resetFiles(); }
    const my = ++loadSeq; // several callers can navigate concurrently around a
    loading = true;       // session switch — the NEWEST intent wins (DirPicker's rule)
    error = '';
    try {
      const r = await fsList(path, showHidden);
      if (my !== loadSeq) return;
      const navigated = path !== cwd;
      if (navigated && pendingSlide) navAnim(pendingSlide);
      revealDir = navigated || !entries.length ? path : '';
      // The atom's contract (motion.md): the class is DROPPED once the
      // stagger has played, so a row that mounts later — an upload landing,
      // hidden files toggled on — never rises.
      if (revealDir) {
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => { revealDir = ''; }, revealMs());
      }
      entries = r.entries;
      cwd = path;
      ({ view, currentFile } = directoryLoadState({ view, currentFile }, purpose));
    } catch (e) {
      if (my !== loadSeq) return;
      error = e.message;
    }
    pendingSlide = '';
    loading = false;
  }

  // After a reconnect, refresh the directory data without treating it as
  // navigation. The active preview/editor belongs to the user and must survive
  // an app resume even though the underlying file list may have changed.
  $effect(() => {
    // Only for THIS page's server (board #335 ②b-4).
    const onReconn = (e) => { if (e?.detail?.serverId === scope.runtime.id && visible && cwd) loadDir(cwd, 'refresh'); };
    window.addEventListener('ws-reconnected', onReconn);
    return () => window.removeEventListener('ws-reconnected', onReconn);
  });

  function goUp() {
    const parent = cwd.replace(/\/[^/]+\/?$/, '') || '/';
    navTo(parent, 'back');
  }

  function scrollEnd(el) { el.scrollLeft = el.scrollWidth; }

  // Back to the SESSION's working directory (the pane's cwd) — not the user's
  // home. The button wore the house icon until 2026-09-03 while DirPicker's
  // house meant `~`: one glyph, two destinations. Home now means `~`
  // everywhere; this control is the terminal glyph, labelled for what it is.
  function goSessionDir() {
    fsCwd(session).then(r => navTo(r.path)).catch(() => navTo('/'));
  }

  const PREVIEW_SIZE_LIMIT = 5 * 1024 * 1024;
  /** Bumped by a refresh: an HTML preview mints a new base on it (#433). */
  let previewRenew = $state(0);
  /** Bumped by every re-read of the preview (Reload, a return): review cards follow (#434). */
  let reviewRefresh = $state(0);
  /** The picture open in the one fullscreen viewer (ui/Lightbox), board #188. One open = one
   * record { src, ref } taken at the tap (board #447): the data URL it shows and the server
   * file its download saves are never completed from the live selection, so a viewer open on
   * A still saves A when the preview moves on to B. */
  let imageView = $state.raw(null);
  // A download starts only for the CURRENT open while this Files is active (the door, not just
  // the effect that removes the button).
  const viewerDl = createViewerDownload(scope, (record) => imageView === record && imageActive);
  function closeImage() {
    viewerDl.retire();
    imageView = null;
  }
  // The viewer retires on the host's own gate, on its false edge, in the same tick: a hidden
  // or unfocused Files is not destroyed, and coming back is a fresh tap.
  const imageActive = $derived(visible && (scope.eligible ? scope.eligible() : true));
  $effect(() => { if (!imageActive) untrack(closeImage); });
  $effect(() => () => viewerDl.dispose());

  /** Reading mode (board #226, owner: "放大按钮全屏显示，上下隐藏起来，悬浮一个按钮
   * 回到普通模式"): the preview header and the app's tab bar step away, the
   * content takes the phone's whole screen, one floating control returns.
   * A layer over the preview, so Back exits it first; it does not survive a
   * view change or a page switch (the tab bar must be back before either). */
  let reading = $state(false);
  let readingEligible = $derived(layout.isTouchDevice && view === 'preview' && !!currentFile
    && !['image', 'video', 'audio'].includes(mimeCategory(currentFile.stat?.mime_hint)));
  $effect(() => { if (!readingEligible || !visible) reading = false; });
  $effect(() => { onimmersive?.(reading); });


  async function loadPreviewContent(file, my = fileNav.nextFile()) {
    previewLoading = true;
    try {
      const { path, name, stat } = file;
      if (stat.mime_hint === 'application/pdf') {
        const r = await fsDownload(path);
        if (!fileNav.isCurrentFile(my)) return false;
        currentFile = { ...file, pdfData: r.data };
        enterView('preview');
      } else if (stat.mime_hint.startsWith('image/')) {
        const r = await fsDownload(path);
        if (!fileNav.isCurrentFile(my)) return false;
        currentFile = { ...file, dataUrl: `data:${stat.mime_hint};base64,${r.data}` };
        enterView('preview');
      } else if (streamsInline(stat)) {
        // A video or a sound STREAMS (board #182, #416): the <video> / <audio>
        // fetches its own ranges from /dl under a media-lived signature; no
        // bytes cross the RPC.
        const { url } = await fsDownloadHttp(path, { stream: true });
        if (!fileNav.isCurrentFile(my)) return false;
        currentFile = { ...file, mediaUrl: url };
        enterView('preview');
      } else if (stat.is_text && stat.size <= 512 * 1024) {
        const r = await fsRead(path);
        if (!fileNav.isCurrentFile(my)) return false;
        if (mimeCategory(stat.mime_hint || '') !== 'markdown') loadHljs(); // lined view: highlight when it lands
        showAllLines = false; // the cap is per file
        // `revision` is the server's hash of exactly these bytes (#434): a
        // review comment is made against it, and highlights are painted only
        // while the listing's revision is this one.
        currentFile = { ...file, content: r.content, revision: r.revision };
        wrapLines = defaultWrapForMime(stat.mime_hint || '');
        enterView('preview');
      } else if (/\.pptx$/i.test(name)) {
        const r = await fsConvert(path);
        if (!fileNav.isCurrentFile(my)) return false;
        currentFile = { ...file, convertedHtml: r.html };
        enterView('preview');
      }
    } catch (e) {
      if (!fileNav.isCurrentFile(my)) return false;
      pendingViewSlide = '';
      error = e.message;
      previewLoading = false;
      return false;
    }
    previewLoading = false;
    return true;
  }

  function openFileRef(file) {
    return openEntry({ type: 'file', name: file.slice(file.lastIndexOf('/') + 1), path: file }, true);
  }

  function openPreviewRef(ref) {
    const docDir = currentFile?.path ? currentFile.path.slice(0, currentFile.path.lastIndexOf('/')) : cwd;
    void openFileRef(resolvePathRef(docDir, ref));
  }
  function previewLinkClick(e) {
    handlePathLinkClick(e, openPreviewRef);
  }

  async function openEntry(entry, linked = false) {
    if (entry.type === 'dir') {
      navPush();
      navTo(entry.path, 'fwd');
      return;
    }
    // A file open is async like a directory: record the slide, fire it when
    // the view swaps to the ANSWER (board #93 round three — the tap-time
    // slide replayed over the still-visible list before the preview landed).
    const my = fileNav.nextFile();
    let previous = linked ? fileLocation() : null;
    if (!linked) fileNav.resetFiles();
    pendingViewSlide = 'fwd';
    if (entry.type === 'broken') {
      pendingViewSlide = '';
      // Dangling symlink — nothing to preview, surface a clear error.
      const tgt = entry.link_target ? ` → ${entry.link_target}` : '';
      error = `Broken symlink: ${entry.name}${tgt}`;
      return;
    }
    // File open: use previewLoading (right pane), NOT loading — `loading` drives
    // the left directory list's spinner, and toggling it here would make the
    // whole list flash/re-render every time you click a file in the desktop
    // two-pane layout (on mobile the list was hidden so it went unnoticed).
    previewLoading = true;
    error = '';
    try {
      const stat = await fsStat(entry.path);
      if (!fileNav.isCurrentFile(my)) return;
      const path = stat.path || entry.path; // server expands ~ without resolving symlinks
      if (linked && stat.type === 'dir') {
        // A DIRECTORY link lists the directory (board #431): through the
        // file path it landed on the file info card. It is a real navigation
        // with a real history entry (#431 review P1). From a preview, the
        // entry IS that preview (fileNav.rememberLink), so Back returns to it
        // with its reading position, even for a link to the directory already
        // listed. The entry also holds that preview's linked-file history,
        // so its own Back still reaches its origin after any browsing in the
        // listing. From a listing it is an ordinary directory step.
        previewLoading = false;
        pendingViewSlide = '';
        if (previous && previous.view !== 'list') {
          navPush();
          fileNav.rememberLink(previous);
          navTick++;
          currentFile = null;
          view = 'list';
          pendingSlide = 'fwd';
          loadDir(path);
        } else if (path !== cwd) {
          navPush();
          navTo(path, 'fwd');
        } else {
          loadDir(path, 'refresh');
        }
        return;
      }
      if (linked) {
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        // Listing and preview used to race: a late navigate-list response
        // erased the new preview. Position the listing without closing it.
        await loadDir(parent, 'refresh');
        if (!fileNav.isCurrentFile(my)) return;
        if (!previous.cwd) previous = fileLocation();
      }
      currentFile = { path, name: entry.name, stat };
      addRecent(entry.path, entry.name);
      navPush();
      // The size gate protects the RPC's inline bytes; a streamed kind sends none.
      if ((stat.size > PREVIEW_SIZE_LIMIT && !streamsInline(stat)) || !isPreviewable(stat, entry.name)) {
        if (previous) fileNav.rememberFile(previous);
        enterView('info');
        previewLoading = false;
        return;
      }
    } catch (e) {
      if (!fileNav.isCurrentFile(my)) return;
      pendingViewSlide = '';
      // A dead path reference is an EXPECTED miss (a chat link may outlive
      // its file) — say so in words, not in errno (board #99: "即使路径不对，
      // 应该友好的提示").
      error = /No such file|os error 2/iu.test(e.message ?? '') ? `${t('fileMissing')}: ${entry.path}` : e.message;
      previewLoading = false;
      return;
    }
    previewLoading = false;
    if (await loadPreviewContent(currentFile, my)) {
      if (previous) fileNav.rememberFile(previous);
    } else if (previous && fileNav.isCurrentFile(my)) {
      restoreFileLocation(previous);
    }
  }

  async function reloadPreview(renew = false) {
    const file = currentFile;
    if (!file?.path) return;
    try {
      if (file.stat?.is_text) {
        const r = await fsRead(file.path);
        if (currentFile !== file) return;
        currentFile.content = r.content;
        currentFile.revision = r.revision;
        currentFile = currentFile; // trigger reactivity
        reviewRefresh++; // the review cards are read again (#434): no live sync
        // The Refresh button renews an HTML preview's base even when the text
        // is unchanged: an expired or refused one is minted again (#433). A
        // counter, not a new file object: the tab-return effect calling us
        // reads currentFile, and a new object would re-run it for ever.
        if (renew && mimeCategory(file.stat.mime_hint) === 'html') { error = ''; previewRenew++; }
      } else if (file.stat?.mime_hint?.startsWith('image/')) {
        const r = await fsDownload(file.path);
        if (currentFile !== file) return;
        currentFile.dataUrl = `data:${file.stat.mime_hint};base64,${r.data}`;
        currentFile = currentFile;
      }
      // A stream is NOT re-fetched here: swapping a media element's src restarts it
      // at 0, and its signature lives the whole viewing (board #182).
    } catch {}
  }

  function startEdit() {
    loadHljs(); // the editor's highlight overlay follows the same lazy load
    editContent = currentFile.content;
    editOriginal = currentFile.content;
    undoStack = [];
    wrapLines = defaultWrapForMime(currentFile?.stat?.mime_hint || '');
    view = 'edit';
    navPush();
  }

  function undo() {
    if (undoStack.length) {
      editContent = undoStack.pop();
      undoStack = undoStack; // trigger reactivity
    } else {
      editContent = editOriginal;
    }
  }

  function onEditInput(e) {
    undoStack.push(editContent);
    if (undoStack.length > 50) undoStack.shift();
    undoStack = undoStack;
    editContent = e.target.value;
    // Content changed (line count / cursor may have moved) — realign the gutter
    // and highlight layer on the next frame, after the DOM reflows.
    requestAnimationFrame(syncEditorScroll);
  }

  // Keep the line-number gutter and highlight layer scrolled in lockstep with
  // the textarea. The textarea owns the scroll (vertical + horizontal, since we
  // no longer soft-wrap); the gutter follows vertically only (numbers stay
  // pinned left) and the highlight follows both axes so the coloured text sits
  // exactly under the caret.
  function syncEditorScroll() {
    if (!taEl) return;
    if (numsEl) numsEl.scrollTop = taEl.scrollTop;
    if (hlEl) {
      hlEl.scrollTop = taEl.scrollTop;
      hlEl.scrollLeft = wrapLines ? 0 : taEl.scrollLeft;
    }
  }

  // Measure each logical line's rendered height via the off-screen mirror, then
  // feed the gutter so line numbers line up with (possibly wrapped) lines.
  function measureLineHeights() {
    if (view !== 'edit' || !mirrorEl || !layerEl) return;
    const cw = layerEl.clientWidth - 24; // minus the 12px left+right padding
    if (cw <= 0) return;
    mirrorEl.style.width = cw + 'px';
    lineHeights = Array.from(mirrorEl.children).map(c => c.offsetHeight);
  }
  // Re-measure when content, wrap mode, or font size changes (after the DOM
  // reflows). The reads below register the reactive dependencies.
  $effect(() => {
    editContent; wrapLines; fontSize; view;
    requestAnimationFrame(measureLineHeights);
  });
  // Re-measure on width changes (rotation, split-pane drag, keyboard show/hide).
  $effect(() => {
    if (!layerEl) return;
    const ro = new ResizeObserver(() => measureLineHeights());
    ro.observe(layerEl);
    return () => ro.disconnect();
  });

  async function saveFile() {
    try {
      await fsWrite(currentFile.path, editContent);
      editOriginal = editContent;
      currentFile.content = editContent;
      // The text on screen is no longer the one the server hashed: until the
      // next read there is no revision, so nothing is painted or added (#434).
      currentFile.revision = undefined;
      undoStack = [];
    } catch (e) {
      error = e.message;
    }
  }

  function backToList() {
    applyFileBack(fileNav.backFromPreview({ cwd, currentFile, fromGit }));
  }

  function applyFileBack(step) {
    if (step.kind === 'preview') { navAnim('back'); view = 'preview'; return; }
    if (step.kind === 'restore') { restoreFileLocation(step.location); return; }
    fileNav.nextFile();
    navAnim('back');
    if (step.kind === 'git') { fromGit = false; view = 'git'; } else {
      // Stay in the file's parent directory, not session cwd
      view = 'list';
      if (step.path !== cwd) loadDir(step.path);
    }
    currentFile = null;
  }

  function backFromInfo() {
    applyFileBack(fileNav.backFromInfo({ cwd, currentFile, fromGit }));
  }

  function backToPreview() {
    // navAnim rides INSIDE the move: the dialog itself moves nothing.
    leaveEditor(() => { navAnim('back'); view = 'preview'; });
  }

  async function handleNewItem() {
    if (!newName.trim()) return;
    const path = cwd.replace(/\/$/, '') + '/' + newName.trim();
    try {
      if (newType === 'dir') {
        await fsMkdir(path);
      } else {
        await fsWrite(path, '');
      }
      newName = '';
      newType = '';
      loadDir(cwd);
    } catch (e) { error = e.message; }
  }

  async function handleRename() {
    if (!renameValue.trim() || !renaming) return;
    const dir = renaming.replace(/\/[^/]+$/, '');
    const newPath = dir + '/' + renameValue.trim();
    try {
      await fsRename(renaming, newPath);
      renaming = null;
      renameValue = '';
      loadDir(cwd);
    } catch (e) { error = e.message; }
  }

  let copyFeedback = $state(null);
  let downloadFeedback = $state(null);
  let uploadFeedback = $state(null);
  let downloadOperation = $state.raw(null);
  let downloadOutput = $state(null);
  // Every download in progress has its own card in the stack, read from the
  // store (board #420); `downloadFeedback` holds only an OUTCOME. A download
  // that ends while this Files is hidden tells its outcome ONCE here when
  // Files is seen again (#301). One slot, latest wins: a notice, not a list.
  let earlierFeedback = $state(null);
  const earlierLifetime = createFeedbackLifetime(value => { earlierFeedback = value; });
  const copyLifetime = createFeedbackLifetime(value => { copyFeedback = value; });
  const downloadLifetime = createFeedbackLifetime(value => { downloadFeedback = value; });
  const uploadLifetime = createFeedbackLifetime(value => { uploadFeedback = value; });

  function feedbackContext() {
    const context = { session, root, cwd, view, file: currentFile?.path, request: navRequest };
    return () => alive && visible && session === context.session && root === context.root
      && cwd === context.cwd && view === context.view && currentFile?.path === context.file
      && navRequest === context.request;
  }
  $effect(() => {
    // Context exits invalidate pending callbacks even if the same path reopens.
    session; root; cwd; view; currentFile?.path; navRequest; visible;
    return () => { copyLifetime.clear(); dismissDownload(); uploadLifetime.clear(); };
  });
  $effect(() => () => { copyLifetime.dispose(); downloadLifetime.dispose(); uploadLifetime.dispose(); earlierLifetime.dispose(); });

  async function openDownloaded(output) {
    if (!output || output !== downloadOutput || !output.operation.current() || output.opening) return;
    const { path, operation } = output;
    output.opening = true;
    try {
      if (isAndroid) {
        await openFileNative(path);
      } else if (isTauri) {
        await tauriPlugins;
        await tauriOpener.openPath(path);
      }
      dismissDownload(operation);
    } catch (e) {
      if (operation.current()) downloadLifetime.update(operation.token,
        { kind: 'error', message: t('openFailed') + (e.message || e), detail: path });
    } finally { output.opening = false; }
  }

  function dismissDownload(operation = null) {
    if (operation && !operation.current()) return;
    downloadLifetime.clear();
    downloadOutput = null;
    downloadOperation = null;
  }


  /** One writer per part id (board #305). The id is stable per server +
   * file so a later session can resume; two concurrent attempts on one id
   * would append to the same part and corrupt it. A second Download of a
   * file already downloading starts nothing: in THIS Files it does nothing
   * (its card is already in the stack, board #420); in the other Files (page
   * vs drawer) it says the file is already downloading, because the outcome
   * is told where the download was started. `inFlight` is the module-level
   * table. */
  const instance = {};

  /** A download's OUTCOME (board #420; progress is the store's card). While
   * this Files is seen, it takes the outcome slot — a saved file with its
   * Open action, latest wins; while hidden, it is HELD (latest wins) and the
   * earlier notice tells it once when Files is seen again (#301), with no
   * Open — its 1500 ms life starts only then (review P1-B). */
  let heldOutcome = null;
  $effect(() => {
    if (!visible || !heldOutcome) return;
    const value = heldOutcome;
    heldOutcome = null;
    earlierLifetime.update(earlierLifetime.begin(), value);
  });
  function tell(value, savedPath = null) {
    if (!alive) return;
    if (!visible) {
      heldOutcome = value.kind === 'result' ? { ...value, kind: 'success' } : value;
      return;
    }
    const token = downloadLifetime.begin();
    const contextCurrent = feedbackContext();
    const operation = { token, current: () => downloadLifetime.current(token) && contextCurrent() };
    downloadOperation = operation;
    downloadOutput = savedPath ? { path: savedPath, operation, opening: false } : null;
    downloadLifetime.update(token, value);
  }

  /** The download attempt itself is `save-file.ts` (board #447: the viewers share
   * it); this is where ITS outcome is told, in this Files' slot. */
  function handleDownload(path) {
    return saveServerFile(saveDeps, path, instance, {
      inProgress: (p) => tell({ kind: 'success', message: t('downloadInProgress'), detail: p }),
      saved: (savedPath) => tell({ kind: 'result', message: t('saved'), detail: savedPath }, savedPath),
      kept: (name) => tell({ kind: 'success', message: t('downloadPartKept'), detail: name }),
      requested: (name) => tell({ kind: 'success', message: t('downloadRequested'), detail: name }),
      error: (message, p) => tell({ kind: 'error', message, detail: p }),
    });
  }

  // ONE destination rule and ONE byte→b64 encoder for every upload entry point
  // (toolbar picker and drag-drop), so they cannot disagree about where a file
  // lands or how it travels. The DIR is a parameter, never a live read: a
  // batch SNAPSHOTS its target at the gesture (drop / picker confirm), so
  // navigating away mid-upload cannot re-route the rest of the files.
  const uploadDest = (dir, name) => dir.replace(/\/$/, '') + '/' + name;

  // After a batch: refresh ONLY if the user is still looking at the target.
  // Reloading the snapshot dir after they navigated away would hijack their
  // view back; refreshing their NEW dir would announce files that landed
  // elsewhere. Still there → show the arrivals; moved on → touch nothing.
  const refreshAfterBatch = (dir) => { if (cwd === dir) loadDir(dir); };

  // ONE batch runner for both transports (board #214: "文件上传要有个进度或者提示，
  // 让我知道传上去了没有"). Per file: refuse over the server's message cap up
  // front, read (the only phase with real byte progress), send — ONE atomic
  // fs_upload RPC, shown as a discrete "sending" beat — and count it uploaded
  // only when the server has answered. A per-file try/catch: one unreadable
  // item (a dropped DIRECTORY reads as a File whose FileReader errors) must
  // not abandon the rest of the batch; the closing line names every file
  // that failed. The feedback follows the existing copy/download slot and
  // its context rule: leave the directory and the line stops updating.
  const uploadStrings = () => ({
    uploading: t('uploading'), uploadReading: t('uploadReading'), uploadSending: t('uploadSending'),
    uploaded: t('uploaded'), uploadedMany: t('uploadedMany'), uploadFailed: t('uploadFailed'), uploadPartial: t('uploadPartial'),
  });
  async function runUploadBatch(items, dir) {
    const token = uploadLifetime.begin();
    const contextCurrent = feedbackContext();
    const current = () => uploadLifetime.current(token) && contextCurrent();
    const s = uploadStrings();
    const outcome = { ok: [], failed: [] };
    const total = items.length;
    items.forEach((item, i) => {
      item.step = { name: item.name, index: i + 1, total, phase: 'reading', loaded: 0, size: item.size };
    });
    const show = (step) => { if (current()) uploadLifetime.update(token, uploadProgress(step, dir, s)); };
    for (const item of items) {
      const step = item.step;
      try {
        const tooLarge = uploadSizeError(item.size, t('uploadTooLarge'));
        if (tooLarge) throw new Error(`${item.name}: ${tooLarge}`);
        show(step);
        const b64 = await item.read((loaded) => { step.loaded = loaded; show(step); });
        step.phase = 'sending';
        show(step);
        await fsUpload(uploadDest(dir, item.name), b64);
        outcome.ok.push(item.name);
      } catch (e) {
        outcome.failed.push({ name: item.name, error: e.message });
        error = e.message;
      }
    }
    if (current()) uploadLifetime.update(token, uploadSummary(outcome, dir, s));
    refreshAfterBatch(dir);
  }

  // Browser File objects (the picker's input, a drop's DataTransfer).
  async function uploadBlobFiles(files) {
    const dir = cwd; // the batch's target, fixed at the gesture
    await runUploadBatch(files.map((file) => ({
      name: file.name, size: file.size,
      read: (onProgress) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error(`cannot read: ${file.name}`));
        reader.readAsDataURL(file);
      }),
    })), dir);
  }

  // Tauri filesystem paths (the native picker, the webview's drag-drop event).
  // The plugin reads whole files, so the size is learned with the bytes and
  // the cap is checked when they are in hand.
  async function uploadTauriPaths(paths) {
    const dir = cwd; // the batch's target, fixed at the gesture
    await tauriPlugins;
    await runUploadBatch(paths.map((filePath) => ({
      name: String(filePath).split('/').pop().split('\\').pop(), size: 0,
      read: async () => {
        const bytes = new Uint8Array(await tauriFs.readFile(filePath));
        const tooLarge = uploadSizeError(bytes.length, t('uploadTooLarge'));
        if (tooLarge) throw new Error(tooLarge);
        return bytesToB64(bytes);
      },
    })), dir);
  }

  async function handleUpload() {
    if (isTauri) {
      await tauriPlugins;
      const selected = await tauriDialog.open({ multiple: true });
      if (!selected) return;
      await uploadTauriPaths(Array.isArray(selected) ? selected : [selected]);
      return;
    }
    // Browser fallback
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    document.body.appendChild(input);
    input.onchange = async () => {
      await uploadBlobFiles(Array.from(input.files || []));
      document.body.removeChild(input);
    };
    input.click();
  }

  // ── Drag a file in from OUTSIDE, drop it on the listing, it uploads to the
  //    current directory (board #22). Two transports for one gesture:
  //    · Browser: the HTML5 events on the listing itself.
  //    · Compiled app: the webview INTERCEPTS native drags (Tauri's default
  //      dragDropEnabled), so DataTransfer never carries files there — the
  //      drop arrives as the webview's own drag-drop event with fs PATHS, and
  //      a hit-test against the listing's rect stands in for event targeting.
  let dragOver = $state(false);
  let fileListEl = $state(null);

  const dragHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  function onListDragOver(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragOver = true;
  }
  function onListDragLeave(e) {
    // dragleave also fires when the cursor enters a CHILD row; only a real
    // exit (relatedTarget outside the listing) parks the highlight.
    if (e.currentTarget.contains(e.relatedTarget)) return;
    dragOver = false;
  }
  async function onListDrop(e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragOver = false;
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) await uploadBlobFiles(files);
  }

  // A missed drop must not NAVIGATE the tab to the file (which tears down the
  // whole app, socket included). While Files is visible in a browser, stray
  // drags over the window are neutralized; the listing's own handlers still
  // run first in the bubble.
  $effect(() => {
    if (!visible || isTauri) return;
    const block = (e) => { if (dragHasFiles(e)) e.preventDefault(); };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  });

  // The compiled app's half: the listener EXISTS only while this instance is
  // visible — that is the real gate against the parked page-layer twin (App's
  // hidden layer keeps LAYOUT under visibility:hidden, and bare
  // checkVisibility() does NOT check the visibility property — its
  // visibilityProperty option defaults false — so a rect test alone, or a
  // bare checkVisibility, would still let the hidden instance double-claim a
  // drop). The in-test visibility check stays as defense in depth, with the
  // option set and a computed-style fallback for engines without the API.
  function listHit(pos) {
    const el = fileListEl;
    if (!el) return false;
    const shown = el.checkVisibility
      ? el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })
      : getComputedStyle(el).visibility !== 'hidden';
    if (!shown) return false;
    // The webview reports PHYSICAL pixels; client rects are CSS pixels.
    const dpr = window.devicePixelRatio || 1;
    const x = pos.x / dpr, y = pos.y / dpr;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }
  $effect(() => {
    if (!isTauri || !visible) return;
    let unlisten = null, dead = false;
    (async () => {
      await tauriPlugins;
      const un = await tauriWebview.getCurrentWebview().onDragDropEvent((ev) => {
        const t = ev.payload.type;
        if (t === 'leave') { dragOver = false; return; }
        const hit = listHit(ev.payload.position);
        if (t === 'enter' || t === 'over') dragOver = hit;
        else if (t === 'drop') {
          dragOver = false;
          if (hit && ev.payload.paths?.length) uploadTauriPaths(ev.payload.paths);
        }
      });
      if (dead) un(); else unlisten = un;
    })();
    return () => { dead = true; dragOver = false; unlisten?.(); };
  });

  async function copyPath(path) {
    const token = copyLifetime.begin();
    const currentContext = feedbackContext();
    const copied = await copyText(path);
    if (!currentContext()) return;
    copyLifetime.update(token, copied
      ? { kind: 'success', message: t('copied') }
      : { kind: 'error', message: t('copyFailed') });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  function formatDate(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleString();
  }

  // The row's facts for the hover card (motion.md principle 16), through the
  // SAME formatters the info view uses — never a second one.
  function entryKind(entry) {
    if (entry.type === 'broken') return t('kindBroken');
    const target = entry.type === 'dir' ? t('kindDir') : t('kindFile');
    return entry.is_symlink ? `${t('kindSymlink')} → ${entry.link_target || target}` : target;
  }
  function entryInfo(entry) {
    const lines = [{ label: t('type'), value: entryKind(entry) }];
    if (entry.type !== 'dir') lines.push({ label: t('size'), value: formatSize(entry.size) });
    if (entry.modified) lines.push({ label: t('modified'), value: formatDate(entry.modified) });
    return { title: entry.name, lines };
  }

  function fileIcon(entry) {
    if (entry.type === 'dir') return 'folder';
    return 'file';
  }

  // This state survives preview/editor round-trips, as before the extraction.
  let showAllLines = $state(false);

  let previewEl = $state(null);
  let htmlPreviewEl = $state(null);

  $effect(() => () => renderers.dispose());

  $effect(() => {
    if (view === 'preview' && mimeCategory(currentFile?.stat?.mime_hint) === 'markdown' && previewEl) {
      setTimeout(() => { renderMermaidBlocks(previewEl); resolveImages(previewEl); }, 50);
    }
    if (view === 'preview' && currentFile?.pdfData && pdfContainer) {
      setTimeout(() => renderPdf(currentFile.pdfData), 50);
    }
  });

</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- View blocks live in snippets so both layouts (mobile single-pane + desktop
     two-pane) render the same markup. -->
{#snippet serverDoor()}
  {#if onServers && scope.tag}
    <!-- Whose files these are, and the door to another server's (board #358,
         #366): App's one server popover (aria-controls names it), shown only
         with more than one server included (the tag rule). Since #366 (owner
         2026-10-14: "你切换的按钮单独占了一整行…把它放到路径的最左侧，用一个
         非常小的 button 来做切换，保留机器的前几个字母就好") it is not a row of
         its own: a small pill, the server's SHORT name, at the head of the
         line that says where you are — the path row in the list, the header
         after Back in every other view on one pane (the desktop's list column
         keeps it in view beside them). `flex: none`: the path scrolls, the
         door never moves. -->
    <button type="button" class="server-door" class:open={serversOpen} aria-haspopup="dialog" aria-expanded={serversOpen}
      aria-controls={serversOpen ? serversControls : undefined} aria-label={`${t('serversTitle')}: ${scope.tag}`}
      onclick={(e) => onServers?.(e)}>
      <ServerTag name={serverShort ?? scope.tag} title={scope.tag} />
    </button>
  {/if}
{/snippet}

{#snippet listPanel()}
    <div class="toolbar compact-tools" role="group" aria-label={t('filesTools')} use:measureToolbar
      oncontextmenu={(event) => contextFile(event)}
      use:longpress={{ onlongpress: ({ x, y }) => openFileMenu({ x, y }, 'directory') }}>
      {#each toolbarActions.slice(0, toolCount) as action (action.key)}
        <CommandButton variant="icon" icon={action.icon} label={action.label} pending={!!action.pending} disabled={!!action.disabled}
          pressed={action.pressed} expanded={action.expanded} controls={action.controls} onclick={action.run} />
      {/each}
      {#if toolCount < toolbarActions.length}
        <CommandButton variant="icon" icon="dots" label={t('filesMore')}
          expanded={fileMenu?.kind === 'overflow'} controls={fileMenu?.kind === 'overflow' ? `${panelId}-menu` : undefined}
          onclick={(event) => fileMenu?.kind === 'overflow' ? closeFileMenu()
            : openFileMenu({ anchor: anchorOf(event.currentTarget), trigger: event.currentTarget }, 'overflow')} />
      {/if}
    </div>

    <!-- Path. The browser pair sits at its head, beside the address as a
         browser keeps them (board #187, owner: "类似浏览器后退前进的按钮，方便我
         跳转位置后快速回来") — not in the tools bar, which already overflows at
         390 (#164). Back retraces the user's steps (#17), Forward undoes a
         Back; both rest disabled at their end. The crumbs scroll in their own
         strip so the pair stays put. -->
    <div class="bc-path-row compact-tools">
      {@render serverDoor()}
      <CommandButton variant="icon" icon="arrow-left" label={t('back')} disabled={!canGoBack} onclick={popDir} />
      <CommandButton variant="icon" icon="arrow-right" label={t('forward')} disabled={!canGoForward} onclick={fwdDir} />
      <div class="bc-scroll" bind:this={bcPathEl}>
      <button class="bc-seg bc-root" onclick={() => { if (!selecting()) navTo('/', 'back'); }}
        oncontextmenu={(event) => contextCrumb(event, { name: '/', path: '/' })}
        use:longpress={{ onlongpress: (at) => openFileMenu(at, 'path', { name: '/', path: '/', type: 'dir' }) }}>/</button>
      {#each breadcrumbs as bc, i (bc.path)}
        <button class="bc-seg" class:appear={i === breadcrumbs.length - 1} onclick={() => { if (!selecting()) navTo(bc.path, 'back'); }}
          oncontextmenu={(event) => contextCrumb(event, bc)}
          use:longpress={{ onlongpress: (at) => openFileMenu(at, 'path', { name: bc.name, path: bc.path, type: 'dir' }) }}
          use:hoverInfo={() => ({ title: bc.name, text: bc.path })}>{bc.name}</button>
        <span class="bc-sep">/</span>
      {/each}
      </div>
    </div>

    {#if showBookmarks}
      <div class="bookmarks-panel appear-rise" id={`${panelId}-bookmarks`}>
        {#each bookmarks as bm}
          <div class="bm-row">
            <span class="bm-icon"><Icon name="star-filled" size={13} /></span>
            <button class="bm-path" onclick={() => { navTo(bm, 'fwd'); showBookmarks = false; }} use:scrollEnd use:hoverInfo={() => ({ text: bm })}>
              {bm}
            </button>
            <CommandButton variant="icon" icon="x" label={`${t('filesRemoveBookmark')}: ${bm}`} onclick={() => toggleBookmark(bm)} />
          </div>
        {/each}
        {#if bookmarksRead.error}
          <div class="panel-status"><span class="config-error" role="alert">{bookmarksRead.error}</span>
            <CommandButton variant="icon" icon="refresh" label={t('filesRefresh')} onclick={loadBookmarks} /></div>
        {:else if !bookmarksRead.ready}<p class="panel-empty">{t('loading')}</p>
        {:else if !bookmarks.length}<p class="panel-empty">{t('filesNoBookmarks')}</p>{/if}
      </div>
    {/if}

    {#if showRecent}
      <div class="bookmarks-panel appear-rise" id={`${panelId}-recent`}>
        {#each recentFiles as rf}
          <div class="bm-row">
            <span class="bm-icon"><Icon name="clock" size={13} /></span>
            <button class="bm-path" onclick={() => { showRecent = false; openEntry({ type: 'file', path: rf.path, name: rf.name }); }} use:scrollEnd
              use:hoverInfo={() => ({ title: rf.name, text: rf.path })}>
              <span style="color:var(--text3);font-size:var(--fs-meta)">{rf.path.replace(/\/[^/]+$/, '')}/</span>{rf.name}
            </button>
            <CommandButton variant="icon" icon="x" label={`${t('filesRemoveRecent')}: ${rf.name}`}
              onclick={() => { recentFiles = recentFiles.filter(f => f.path !== rf.path); setPref('recentFiles', recentFiles).catch(() => {}); }} />
          </div>
        {/each}
        {#if recentsRead.error}
          <div class="panel-status"><span class="config-error" role="alert">{recentsRead.error}</span>
            <CommandButton variant="icon" icon="refresh" label={t('filesRefresh')} onclick={loadRecents} /></div>
        {:else if !recentsRead.ready}<p class="panel-empty">{t('loading')}</p>
        {:else if !recentFiles.length}<p class="panel-empty">{t('filesNoRecent')}</p>{/if}
      </div>
    {/if}

    <!-- New item input -->
    {#if newType}
      <div class="new-item appear-rise" id={`${panelId}-new`}>
        <div class="new-kind">
          <Segmented value={newType} ariaLabel={t('type')}
            options={[{ value: 'file', label: t('filesFile') }, { value: 'dir', label: t('filesFolder') }]}
            onchange={value => newType = value} />
        </div>
        <input
          class="config-input"
          type="text"
          aria-label={newType === 'dir' ? t('folderName') : t('fileName')}
          bind:value={newName}
          placeholder={newType === 'dir' ? t('folderName') : t('fileName')}
          onkeydown={(e) => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && handleNewItem()}
          autocapitalize="off"
          autocomplete="off"
        />
        <CommandButton variant="icon" icon="plus" label={t('create')} disabled={!newName.trim()} onclick={handleNewItem} />
        <CommandButton variant="icon" icon="x" label={t('cancel')} onclick={() => newType = ''} />
      </div>
    {/if}

    <!-- Rename input -->
    {#if renaming}
      <div class="new-item appear-rise">
        <input
          class="config-input"
          type="text"
          aria-label={t('newName')}
          bind:value={renameValue}
          placeholder={t('newName')}
          onkeydown={(e) => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && handleRename()}
          autocapitalize="off"
        />
        <CommandButton variant="icon" icon="edit" label={t('filesRename')} disabled={!renameValue.trim()} onclick={handleRename} />
        <CommandButton variant="icon" icon="x" label={t('cancel')} onclick={() => renaming = null} />
      </div>
    {/if}

    <!-- File list. Also the drop target for OS files (board #22): the browser
         path via the HTML5 events here, the compiled app via the webview's
         drag-drop event hit-testing this element's rect. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="file-list" class:panel-open={showBookmarks || showRecent} class:drop-hot={dragOver} class:busy={loading} class:reveal={!!revealDir}
      bind:this={fileListEl}
      oncontextmenu={(event) => { if (!event.target.closest('.file-row')) contextFile(event); }}
      use:longpress={{ accept: directoryPress, onlongpress: ({ x, y }) => openFileMenu({ x, y }, 'directory') }}
      ondragover={onListDragOver} ondragleave={onListDragLeave} ondrop={onListDrop}>
      {#if dragOver}
        <div class="drop-hint appear"><Icon name="upload" size={16} />{t('dropToUpload')}</div>
      {/if}
      <!-- A directory load KEEPS the rows on screen and dims them after a beat
           (DirPicker's rule, motion.md): swapping them for "Loading…" made
           every tap blank-then-repaint. The placeholder is for the very first
           answer only, when there is nothing to keep. -->
      {#if loading && !entries.length}
        <div class="loading">{t('loading')}</div>
      {:else}
        {#each entries as entry (entry.path)}
          <div class="file-row" class:broken={entry.type === 'broken'} oncontextmenu={(event) => contextFile(event, entry)}
            use:longpress={{ onlongpress: (at) => openFileMenu(at, 'entry', entry) }}>
            <button class="file-main" onclick={() => { if (!selecting()) rowHandlers.open(entry); }} use:hoverInfo={() => entryInfo(entry)}>
              <span class="file-icon" class:is-link={entry.is_symlink}>
                <Icon name={fileIcon(entry)} size={16} />
              </span>
              <span
                class="file-name"
                class:dir-name={entry.type === 'dir'}
                class:link-name={entry.is_symlink}
              >{entry.name}</span>
              {#if entry.type !== 'dir'}
                <span class="file-size">{formatSize(entry.size)}</span>
              {/if}
            </button>
            <div class="file-actions compact-tools">
              {#each rowActions(entry).filter(action => action.inline) as action (action.key)}
                <CommandButton variant={action.danger ? 'danger' : 'icon'} iconOnly icon={action.icon}
                  label={`${action.label}: ${entry.name}`} onclick={action.run} />
              {/each}
            </div>
          </div>
        {/each}
        {#if !entries.length && !loading}
          <div class="empty">{t('emptyDir')}</div>
        {/if}
      {/if}
    </div>
{/snippet}

{#snippet previewPanel()}
    <!-- File preview -->
    <div class="preview-header compact-tools">
      <CommandButton variant="icon" icon="arrow-left" label={t('back')} onclick={backToList} />
      {#if !listShown}{@render serverDoor()}{/if}
      <span class="preview-name" title={currentFile.name}>{currentFile.name}</span>
      <div class="preview-actions">
        {#if isLinedPreview}
          <CommandButton variant="icon" icon={wrapLines ? 'wrap-text' : 'no-wrap'} label={t('editorWrap')}
            pressed={wrapLines} onclick={() => wrapLines = !wrapLines} />
        {/if}
        {#if currentFile.stat?.is_text && currentFile.stat?.writable}
          <CommandButton variant="icon" icon="edit" label={t('edit')} onclick={startEdit} />
        {/if}
        <CommandButton variant="icon" icon="download" label={t('filesDownload')} onclick={() => handleDownload(currentFile.path)} />
        <CommandButton variant="icon" icon="refresh" label={t('filesRefresh')} onclick={() => reloadPreview(true)} />
        <CommandButton variant="icon" icon="info" label={t('filesInfo')} onclick={() => { view = 'info'; navPush(); }} />
        {#if readingEligible}
          <CommandButton variant="icon" icon="maximize" label={t('filesReading')} onclick={() => { reading = true; navPush(); }} />
        {/if}
      </div>
    </div>
    <FileReview file={currentFile} body={previewBodyEl} {session} refresh={reviewRefresh} compact={narrowViewport} {onfeedback} context={feedbackContext}>
      <FilePreview {currentFile} {fontSize} {wrapLines} {hljs}
        bind:showAllLines bind:previewBodyEl bind:previewEl bind:htmlPreviewEl bind:pdfContainer
        {previewLinkClick} {attachHtmlPreviewLinks} onview={(src) => { viewerDl.retire(); imageView = viewerOpen(src, currentFile?.path ?? null, currentFile?.name ?? ''); }} {visible}
        previewBase={fsPreviewBase} renew={previewRenew} onpreviewerror={(message) => { error = message; }} />
    </FileReview>
    {#if reading}
      <!-- The one way back that is not a gesture: a floating control above the
           safe area, where the thumb is. -->
      <div class="reading-exit appear">
        <CommandButton variant="secondary" iconOnly icon="minimize" label={t('filesReadingExit')} onclick={() => { reading = false; }} />
      </div>
    {/if}
{/snippet}

{#snippet editPanel()}
    <!-- File editor -->
    <div class="preview-header">
      <CommandButton variant="icon" icon="arrow-left" label={t('back')} onclick={backToPreview} />
      {#if !listShown}{@render serverDoor()}{/if}
      <span class="preview-name" title={currentFile.name}>{currentFile.name}</span>
      {#if isEdited}<span class="preview-dirty">*</span>{/if}
      <div class="preview-actions">
        <CommandButton variant="icon" icon={wrapLines ? 'wrap-text' : 'no-wrap'} label={t('editorWrap')} pressed={wrapLines}
          onclick={() => { wrapLines = !wrapLines; requestAnimationFrame(syncEditorScroll); }} />
        <CommandButton variant="icon" icon="undo" label={t('filesUndo')} onclick={undo} disabled={!undoStack.length && editContent === editOriginal} />
        <CommandButton variant="primary" iconOnly icon="check" label={t('save')} onclick={saveFile} disabled={!isEdited} />
      </div>
    </div>
    <div class="editor-wrap" class:wrap={wrapLines} style="--file-font-size:{fontSize}px">
      <div class="editor-nums" bind:this={numsEl}>
        {#each lineHeights as h, i}
          <div class="eln" style={h ? `height:${h}px` : ''}>{i + 1}</div>
        {/each}
      </div>
      <div class="editor-layer" bind:this={layerEl}>
        <pre class="editor-highlight" bind:this={hlEl} aria-hidden="true"><code>{@html highlightCode(editContent, currentFile?.stat?.mime_hint, hljs)}</code>{'\n'}</pre>
        <!-- Off-screen mirror: one block per logical line, same width/font/wrap
             as the highlight layer, so each block's measured height tells the
             gutter how tall to make that line number — keeping numbers aligned
             even when a line soft-wraps. -->
        <div class="editor-mirror" bind:this={mirrorEl} aria-hidden="true">
          {#each editContent.split('\n') as line}
            <div class="emir">{line || '\u200b'}</div>
          {/each}
        </div>
        <textarea
          class="editor"
          aria-label={currentFile.name}
          bind:this={taEl}
          value={editContent}
          oninput={onEditInput}
          onscroll={syncEditorScroll}
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        ></textarea>
      </div>
    </div>
{/snippet}

{#snippet activeDownload(row)}
    <!-- ONE card per running download (board #420), read from the store:
         the Downloads view lists it, the feedback stack shows it. -->
    {#snippet cancelAction()}
      <CommandButton variant="icon" icon="x" label={`${t('cancel')}: ${row.name}`} onclick={() => cancelDownload(row.id)} />
    {/snippet}
    <!-- Cancel only while it is honored (review P2-C): while downloading.
         Saving (a dialog, a finish) offers no action rather than a cancel
         that would not happen. -->
    <OperationFeedback value={rowFeedback(row)} actions={row.state === 'downloading' ? cancelAction : undefined} />
{/snippet}

{#snippet localPanel()}
    <!-- Downloads (board #308): four groups from ONE store plus what the
         shell keeps on disk. Same list atoms as the file list; a running
         download is the same OperationFeedback the slot shows. -->
    <div class="preview-header">
      <CommandButton variant="icon" icon="arrow-left" label={t('back')} onclick={() => { navAnim('back'); view = 'list'; }} />
      {#if !listShown}{@render serverDoor()}{/if}
      <span class="preview-name">{t('downloads')}</span>
      <div class="preview-actions">
        {#if isTauri}<CommandButton variant="icon" icon="refresh" label={t('filesRefresh')} onclick={() => readDownloads().catch((e) => { error = e.message; })} />{/if}
      </div>
    </div>
    <div class="file-list downloads-list">
      {#if activeRows.length}
        <div class="side-h">{t('downloadsActive')}</div>
        {#each activeRows as row (row.id)}
          <div class="dl-active">{@render activeDownload(row)}</div>
        {/each}
      {/if}
      {#if resumableRows.length}
        <div class="side-h">{t('downloadsResumable')}</div>
        {#each resumableRows as part (part.id)}
          {@const here = !!part.path && part.server === getMachineId()}
          <div class="file-row">
            <button class="file-main" disabled={!here} onclick={() => handleDownload(part.path)}>
              <Icon name="download" size={16} />
              <span class="file-name">{part.name}</span>
              <span class="file-size">{here ? formatSize(part.received) : t('downloadsOtherServer')}</span>
            </button>
            {#if here}<CommandButton variant="icon" icon="download" label={`${t('downloadsResume')}: ${part.name}`} onclick={() => handleDownload(part.path)} />{/if}
            <CommandButton variant="danger" iconOnly icon="trash" label={`${t('delete')}: ${part.name}`} onclick={() => deletePart(part.id)} />
          </div>
        {/each}
      {/if}
      {#if failedRows.length}
        <div class="side-h">{t('downloadsFailed')}</div>
        {#each failedRows as row (row.id)}
          <div class="file-row">
            <div class="file-main">
              <Icon name="info" size={16} />
              <span class="file-name">{row.name}</span>
              <span class="file-size config-error">{row.error}</span>
            </div>
            <CommandButton variant="icon" icon="refresh" label={`${t('downloadsRetry')}: ${row.name}`} onclick={() => handleDownload(row.path)} />
          </div>
        {/each}
      {/if}
      {#if finishedRows.length}
        <div class="side-h">{t('downloadsFinished')}</div>
        {#each finishedRows as f (f.key)}
          <div class="file-row">
            <button class="file-main" disabled={!f.local && !f.savedPath} onclick={() => openSaved(f)}>
              <Icon name="file" size={16} />
              <span class="file-name">{f.name}</span>
            </button>
            {#if f.local}
              <CommandButton variant="danger" iconOnly icon="trash" label={`${t('delete')}: ${f.name}`}
                onclick={() => requestAct({ kind: 'local', name: f.local })} />
            {/if}
          </div>
        {/each}
      {/if}
      {#if !activeRows.length && !resumableRows.length && !failedRows.length && !finishedRows.length}
        <div class="empty">{t('noDownloads')}</div>
      {/if}
      {#if !isTauri}<p class="panel-empty">{t('downloadsBrowserNote')}</p>{/if}
    </div>
{/snippet}

{#snippet infoPanel()}
    <!-- File info -->
    <div class="preview-header">
      <CommandButton variant="icon" icon="arrow-left" label={t('back')} onclick={backFromInfo} />
      {#if !listShown}{@render serverDoor()}{/if}
      <span class="preview-name" title={currentFile?.name}>{currentFile?.name}</span>
      <div class="preview-actions">
        {#if isPreviewable(currentFile?.stat, currentFile?.name)}
          <CommandButton variant="icon" icon="eye" label={t('preview')} onclick={() => loadPreviewContent(currentFile)} />
        {/if}
        <CommandButton variant="icon" icon="download" label={t('filesDownload')} onclick={() => handleDownload(currentFile.path)} />
        <CommandButton variant="icon" icon="copy" label={t('filesCopyPath')} onclick={() => copyPath(currentFile.path)} />
      </div>
    </div>
    <div class="info-body">
      {#if currentFile?.stat}
        <div class="info-row"><span class="info-label">{t('path')}</span><button class="info-path" onclick={() => copyPath(currentFile.stat.path)}>{currentFile.stat.path}</button></div>
        <div class="info-row"><span class="info-label">{t('type')}</span><span class="info-val">{currentFile.stat.mime_hint}</span></div>
        <div class="info-row"><span class="info-label">{t('size')}</span><span class="info-val">{formatSize(currentFile.stat.size)}</span></div>
        <div class="info-row"><span class="info-label">{t('modified')}</span><span class="info-val">{formatDate(currentFile.stat.modified)}</span></div>
        <div class="info-row"><span class="info-label">{t('permissions')}</span><span class="info-val mono">{currentFile.stat.permissions}</span></div>
        <div class="info-row"><span class="info-label">{t('readable')}</span><span class="info-val">{currentFile.stat.readable ? t('yes') : t('no')}</span></div>
        <div class="info-row"><span class="info-label">{t('writable')}</span><span class="info-val">{currentFile.stat.writable ? t('yes') : t('no')}</span></div>
        <div class="info-row"><span class="info-label">{t('textFile')}</span><span class="info-val">{currentFile.stat.is_text ? t('yes') : t('no')}</span></div>
      {/if}
    </div>
{/snippet}


<!-- Touch handlers implement the edge-swipe back gesture; not an interactive element. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="files" bind:this={filesEl} class:reading class:strip-over={stripOverContent}
  class:snap={swipeSnap} class:drill-fwd={navAnimClass === 'fwd'} class:drill-back={navAnimClass === 'back'}
  style:transform={swipeDX > 0 ? `translateX(${swipeDX}px)` : ''}
  style:--files-list-default={`${LIST_WIDTH.default}px`}
  ontouchstart={onTouchStart} ontouchmove={onTouchMove} ontouchend={onTouchEnd} ontouchcancel={onTouchCancel}>
  {#if error}
    <div class="error appear">{error}</div>
  {/if}
  {#if splitEligible}
    <!-- Desktop: folder browser (left) | draggable splitter | preview (right). -->
    <div class="files-split" class:preview-open={view !== 'list'}>
      <!-- A content listing owns its width, independently of app navigation. -->
      <div class="files-left">
        {#if view !== 'list'}
          <SideHandle varName="--files-list-w" storeKey="tmux_files_list_w"
            min={LIST_WIDTH.min} max={LIST_WIDTH.max} def={LIST_WIDTH.default} label={t('filesResizeList')} />
        {/if}
        {@render listPanel()}
      </div>
      {#if view !== 'list'}
      <div class="files-right">
        {#if view === 'preview'}{@render previewPanel()}
        {:else if view === 'edit'}{@render editPanel()}
        {:else if view === 'info'}{@render infoPanel()}
        {:else if view === 'git'}<GitPanel bind:this={gitPanelRef} {cwd} {fontSize} lead={listShown ? null : serverDoor} onOpenFile={(entry) => { fromGit = true; openEntry(entry); }} onClose={() => { view = 'list'; }} />
        {:else if view === 'local'}{@render localPanel()}
        {/if}
      </div>
      {/if}
    </div>
  {:else}
    <!-- Mobile / narrow / touch: single-pane view chain (unchanged). -->
    {#if view === 'list'}{@render listPanel()}
    {:else if view === 'preview'}{@render previewPanel()}
    {:else if view === 'edit'}{@render editPanel()}
    {:else if view === 'local'}{@render localPanel()}
    {:else if view === 'info'}{@render infoPanel()}
    {:else if view === 'git'}<GitPanel bind:this={gitPanelRef} {cwd} {fontSize} lead={listShown ? null : serverDoor} onOpenFile={(entry) => { fromGit = true; openEntry(entry); }} onClose={() => { view = 'list'; }} />
    {/if}
  {/if}
  {#if copyFeedback || stackedRows.length || downloadFeedback || uploadFeedback || earlierFeedback}
    {@const operation = downloadOperation}
    {@const output = downloadOutput}
    {#snippet downloadActions()}
      {#if output}
        <CommandButton icon="file" label={t('open')} pending={output.opening} onclick={() => openDownloaded(output)} />
      {/if}
    {/snippet}
    <div class="files-feedback">
      <OperationFeedback value={copyFeedback}
        ondismiss={copyFeedback?.kind === 'error' ? copyLifetime.clear : undefined} />
      <!-- Every download in progress, newest first (board #420); the
           Downloads view lists the same rows, so it shows none here. -->
      {#each stackedRows as row (row.id)}{@render activeDownload(row)}{/each}
      <OperationFeedback value={downloadFeedback} actions={output ? downloadActions : undefined}
        ondismiss={downloadFeedback?.kind === 'error' || downloadFeedback?.kind === 'result'
          ? () => dismissDownload(operation) : undefined} />
      <OperationFeedback value={earlierFeedback}
        ondismiss={earlierFeedback?.kind === 'error' ? earlierLifetime.clear : undefined} />
      <OperationFeedback value={uploadFeedback}
        ondismiss={uploadFeedback?.kind === 'error' ? uploadLifetime.clear : undefined} />
    </div>
  {/if}
</div>

{#if imageView}
  {@const open = imageView}
  <Lightbox src={open.src} alt={open.label} onclose={closeImage}
    ondownload={open.ref ? () => viewerDl.start(open) : undefined} downloading={viewerDl.busy(open)}
    status={viewerDl.status} onstatusdismiss={viewerDl.dismiss} />
{/if}
<ContextMenu at={fileMenu?.at} items={menuActions} who={fileMenu?.entry?.name || fileMenu?.cwd || t('filesTools')}
  id={`${panelId}-menu`} oncancel={closeFileMenu} />
<ConfirmDialog open={!!pendingAct} busy={acting} compact={narrowViewport}
  title={pendingAct ? t(ACT_COPY[pendingAct.kind].title).replace('{name}', actName(pendingAct)) : ''}
  note={pendingAct ? t(ACT_COPY[pendingAct.kind].note) : ''}
  confirmLabel={pendingAct ? t(ACT_COPY[pendingAct.kind].go) : ''}
  confirmIcon={pendingAct?.kind === 'leave' ? 'check' : 'trash'}
  danger={pendingAct?.kind !== 'leave'} cancelLabel={pendingAct?.kind === 'leave' ? t('configKeepEditing') : t('cancel')}
  error={pendingAct?.error || ''} onconfirm={runPendingAct} oncancel={cancelPendingAct} />

<style>
  .files { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; background: var(--bg); }
  /* Interactive edge-swipe: the drag itself sets an inline translate (no
     transition — the finger is the animation); releasing under the commit
     threshold springs back on --t-fast; a committed back plays the shared
     drill grammar (120ms, from the left; deeper from the right). Transforms
     exist only during these beats, so .files is never a resting containing
     block (design-language.md §2). */
  .files.snap { transition: transform var(--t-fast); }
  .files.drill-fwd  { animation: drill-in-right 0.12s linear; }
  .files.drill-back { animation: drill-in-left 0.12s linear; }
  @media (prefers-reduced-motion: reduce) {
    .files.drill-fwd, .files.drill-back { animation: none; }
    .files.snap { transition: none; }
  }

  /* Desktop two-pane: folder browser | splitter | preview. The columns must be
     flex-column themselves so each panel's sticky header (flex-shrink:0) +
     scrollable body (flex:1; overflow) constrain correctly — `.files` gave them
     that in single-pane mode; here the columns must. */
  .files-split { display: flex; flex: 1; min-width: 0; min-height: 0; width: 100%; }
  .files-left, .files-right {
    display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden;
  }
  /* Listing width is a content budget, not the global navigation width. */
  .files-left { position: relative; flex: 1; width: 100%; background: var(--bg2); }
  .preview-open .files-left { flex: none; width: var(--files-list-w, var(--files-list-default)); }
  .files-right { flex: 1; border-left: 1px solid var(--border); }
  @media (max-width: 899px) {
    /* Forced desktop on a narrow screen retains the same Back/view chain. */
    .preview-open .files-left { display: none; }
  }

  /* The server door (#358, #366): a small pill at the head of the path line
     (and of each one-pane view's header) — the ONE tag atom at --fs-micro,
     the server's short name. Its BOX is the row's control height (the
     touch target the Back/Forward beside it have); only its paint is small.
     Hover and open lift the pill's own wash; it never shrinks (flex: none),
     so a long path scrolls under the crumbs, never past the door. */
  .server-door {
    display: inline-flex; align-items: center; flex: none; height: var(--control-height);
    padding: 0; border: 0; background: transparent; cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .server-door:hover :global(.server-tag), .server-door.open :global(.server-tag) { background: var(--control-hover); color: var(--text); }
  .toolbar {
    display: flex; flex-wrap: nowrap; align-items: center; gap: var(--tool-gap); min-width: 0;
    min-height: var(--control-height); padding: var(--tool-inset-block) var(--tool-inset-inline); box-sizing: border-box;
    border-bottom: 1px solid var(--border); background: transparent; flex-shrink: 0;
  }

  /* Path row */
  .bc-path-row {
    /* A dense tool group: Back/Forward sit on the toolbar's gap (board #195). */
    display: flex; align-items: center; gap: var(--tool-gap); padding: 4px 10px;
    font-size: var(--fs-ui); font-family: var(--font-mono);
    border-bottom: 1px solid var(--border2); flex-shrink: 0;
  }
  /* The crumbs' own strip: it scrolls (to its tail after every navigation);
     the Back/Forward pair before it stays put. */
  .bc-scroll {
    display: flex; align-items: center; gap: 1px; flex: 1; min-width: 0;
    overflow-x: auto; scrollbar-width: none;
  }
  .bc-scroll::-webkit-scrollbar { display: none; }
  /* A segment keeps its width — the ROW scrolls (to its tail, see the
     breadcrumbs effect). An explicit min-width replaces a flex item's
     automatic min-content floor, so without flex-shrink: 0 every segment
     shrank to the control size and neighbours' glyphs painted over each
     other once the path outgrew the pane (board #185). */
  /* A crumb hugs its text (owner, 2026-09-12: "文件路径显示可以紧凑一点"): the
     control min-width made "src" a 44 px box on the phone and the strip read
     spaced out (measured: /src/lib/files boxes 44/44/44 for 23–30 px glyphs).
     The touch HEIGHT stays the row's; width is the name's plus its padding. */
  .bc-seg {
    min-height: var(--control-height); flex-shrink: 0;
    padding: 2px 4px; border: none; background: none; color: var(--text2);
    cursor: pointer; white-space: nowrap; font-size: var(--fs-ui); font-family: inherit;
    user-select: text; -webkit-user-select: text; /* a name you can drag-select and copy (board #187) */
    transition: color var(--t-fast);
  }
  /* The root reads as the FIRST SEPARATOR, not as a wide first crumb: the
     segment min-width put its glyph 15 px from "local" where every other
     glyph sits 5 px from its neighbours (measured, board #187: "首个 / 斜线
     后边的文件夹间距比较大"). It keeps the row's touch height; its width is
     the glyph's. */
  .bc-seg.bc-root { padding-right: 0; color: var(--text3); font-size: var(--fs-sub); }
  .bc-seg:last-of-type { color: var(--accent); }
  .bc-sep { color: var(--text3); font-size: var(--fs-sub); }

  /* Bookmarks / Recent panel */
  .bookmarks-panel {
    border-bottom: 1px solid var(--border2); flex-shrink: 0;
    max-height: calc(40vh / var(--ui-zoom, 1)); overflow-y: auto;
    -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
  }
  .bm-row {
    display: flex; align-items: center; gap: 6px; padding: 0 10px;
    border-bottom: 1px solid var(--border2);
  }
  .bm-icon { color: var(--accent); display: flex; flex-shrink: 0; }
  .bm-path {
    flex: 1; display: block;
    padding: 8px 0; border: none; background: none; color: var(--text);
    font-size: var(--fs-ui); font-family: var(--font-mono);
    cursor: pointer; text-align: left; overflow-x: auto;
    white-space: nowrap; scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    transition: color var(--t-fast);
    min-height: var(--control-height);
  }
  .bm-path::-webkit-scrollbar { display: none; }
  .bm-path:active { color: var(--accent); }
  .panel-empty { margin: 0; padding: 12px; color: var(--text2); font-size: var(--fs-sub); }
  .panel-status { display: flex; align-items: center; gap: 8px; padding: 8px 12px; }

  /* New item / rename */
  .new-item {
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; padding: 6px 10px;
    border-bottom: 1px solid var(--border2); min-width: 0;
  }
  .new-kind { grid-column: 1 / -1; }

  .error {
    padding: 8px 12px; background: var(--bg2); color: var(--danger);
    font-size: var(--fs-ui); border-bottom: 1px solid var(--danger);
  }

  /* File list */
  .file-list {
    flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; position: relative;
    transition: opacity var(--t-fast) ease;
  }
  /* In-flight cue that never flashes (DirPicker's rule): the dim starts only
     after 150ms, so a fast listing — the normal case — navigates with no
     visible blink. The delay is a threshold, not a tempo. */
  .file-list.busy { opacity: 0.55; transition-delay: 0.15s; }
  /* The drop target speaks the attach-affordance dialect (dashed accent, like
     the composer's +): a frame over the listing while an OS drag hovers it,
     pointer-events none so dragleave/drop still land on the list itself. */
  .drop-hint {
    position: absolute; inset: 6px; z-index: 5;
    display: flex; align-items: center; justify-content: center; gap: 8px;
    border: 2px dashed var(--accent-line); border-radius: var(--ui-radius-panel);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    color: var(--accent); font-size: var(--fs-ui); font-weight: 600;
    pointer-events: none;
  }
  /* When the bookmarks/recent panel is open, lock the file list so touch
     gestures on the panel can't bleed through and drag the list too. */
  .file-list.panel-open { overflow: hidden; touch-action: none; }
  .file-row {
    display: flex; align-items: center; border-bottom: 1px solid var(--border2);
  }
  /* A running download in the Downloads view is the slot's own card, inset
     like the list's rows. */
  .dl-active { padding: 4px 8px; }
  .file-main:disabled { cursor: default; }
  .file-main {
    flex: 1; display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    border: none; background: none; color: var(--text); cursor: pointer; text-align: left;
    font-size: var(--fs-body); min-width: 0; -webkit-tap-highlight-color: transparent;
    font-family: var(--font-ui); /* file names are data, not chrome */
    transition: background var(--t-fast);
    min-height: var(--files-row-height);
  }
  .file-main:active { background: var(--input-bg); }
  /* Symlink badge — small ↗ arrow overlaid on the bottom-right of the
     file/folder icon. Renders for both symlink-to-dir and symlink-to-file
     so the link nature is visible without changing the base icon. */
  .file-icon {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    line-height: 0;
  }
  .file-icon.is-link::after {
    content: '↗';
    position: absolute;
    right: -4px;
    bottom: -4px;
    font-size: var(--fs-meta);
    line-height: 1;
    color: var(--accent);
    background: var(--bg);
    border-radius: 50%;
    padding: 1px 2px;
    pointer-events: none;
    font-weight: 700;
  }
  .file-row.broken { opacity: 0.55; }
  .file-row.broken .file-icon.is-link::after { color: var(--danger, #f87171); }
  .link-name { font-style: italic; }
  .file-name { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
  .dir-name { color: var(--accent-ink); }
  .file-size { flex: none; color: var(--text2); font-size: var(--fs-sub); font-family: var(--font-mono); white-space: nowrap; }
  .file-actions { display: flex; flex: none; gap: 0; padding-right: 4px; }
  .empty, .loading { padding: 40px; text-align: center; color: var(--text3); font-size: var(--fs-body); }

  /* Preview header: one list row high (board #435, owner 2026-10-20: "文件预览
     页的上边标题栏有点过高了，和本身文件那个栏里的一行的高度一致吧"). The row's
     own metric, `--files-row-height` (32px pointer / 44px coarse), is its
     minimum, with no block padding: its controls (28px pointer / 30px on
     touch inside .compact-tools) sit inside that height. The NAME is one
     line here, cut with an ellipsis, and shrinks first (flex-basis 0), so
     the bar stays one row on a 390px phone too; its full text is the
     span's title. A list row's name still wraps (#164): that rule is for
     the list, where the name is the content; here the bar is chrome. */
  .preview-header {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 10px;
    min-height: var(--files-row-height);
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .preview-name {
    flex: 1 1 0; min-width: 0; font-size: var(--fs-body); font-weight: 500;
    white-space: pre; overflow: hidden; text-overflow: ellipsis;
  }
  /* The editor's unsaved mark sits OUTSIDE the cut name, so a long name can
     never hide it (validator P1 on 07f4c8f5). */
  .preview-dirty { flex: none; font-size: var(--fs-body); font-weight: 500; }
  .preview-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; max-width: 100%; }
  /* Reading mode (board #226): the header steps away as a cut — the same
     treatment the tab bar gets while the keyboard is up (motion principle
     5: exits are cuts) — and the floating return sits above the safe area,
     one 44px target at the thumb. */
  .files.reading .preview-header { display: none; }
  .files.reading .server-door { display: none; } /* the door steps away with the header (#358) */
  .reading-exit {
    position: fixed; right: 16px; bottom: calc(16px + var(--sab)); z-index: 12;
    display: flex; align-items: center; justify-content: center;
    min-width: 44px; min-height: 44px;
  }
  /* Floating over running text, the control lifts like a popover — the one
     shadow token — or it vanishes into a white page (measured, 390×844). */
  .reading-exit :global(.command-button) { box-shadow: var(--menu-shadow); }

  /* Editor */
  .editor-wrap {
    flex: 1; display: flex; overflow: hidden; -webkit-overflow-scrolling: touch; min-height: 0;
  }
  .editor-nums {
    padding: 12px 8px 12px 0; text-align: right; color: var(--text3); font-family: var(--font-mono);
    font-size: var(--file-font-size, 13px); line-height: 1.5; white-space: pre; user-select: none; flex-shrink: 0;
    border-right: 1px solid var(--border); overflow: hidden;
  }
  /* One block per logical line; its height is set inline from the measured
     mirror so the number aligns with the (possibly wrapped) line. The number
     sits at the top of its block. */
  .eln { padding: 0 8px; box-sizing: border-box; overflow: hidden; }
  .editor-layer { position: relative; flex: 1; min-width: 0; overflow: hidden; }
  .editor-highlight {
    margin: 0; padding: 12px; font-family: var(--font-mono); font-size: var(--file-font-size, 13px);
    line-height: 1.5; white-space: pre; color: var(--text);
    pointer-events: none; position: absolute; inset: 0; overflow: hidden;
  }
  .editor-highlight :global(code) { font-family: inherit; background: none; padding: 0; }
  /* Off-screen line-height probe: same font/line-height/wrap as the highlight
     layer; width is set in JS to the layer's content width before measuring. */
  .editor-mirror {
    position: absolute; top: 0; left: -99999px; visibility: hidden; pointer-events: none;
    font-family: var(--font-mono); font-size: var(--file-font-size, 13px); line-height: 1.5;
    white-space: pre; padding: 0;
  }
  .editor-mirror .emir { white-space: pre; }
  .editor {
    position: absolute; inset: 0; width: 100%; height: 100%; padding: 12px; border: none; resize: none;
    background: transparent; color: transparent; caret-color: var(--text);
    font-family: var(--font-mono); font-size: var(--file-font-size, 13px); line-height: 1.5; outline: none;
    white-space: pre; overflow: auto; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y;
  }
  /* Wrapped mode: soft-wrap the text + mirror (so measured heights match), drop
     horizontal scroll. The gutter stays visible — line numbers are aligned via
     the measured per-line heights. */
  .editor-wrap.wrap .editor-highlight,
  .editor-wrap.wrap .editor,
  .editor-wrap.wrap .editor-mirror .emir {
    white-space: pre-wrap; word-break: break-word; overflow-x: hidden;
  }
  .editor-wrap.wrap .editor { touch-action: pan-y; }
  .info-body { flex: 1; overflow: auto; padding: 12px; }
  .info-row {
    display: flex; padding: 10px 0; border-bottom: 1px solid var(--border2);
  }
  .info-label { width: 100px; flex-shrink: 0; color: var(--text3); font-size: var(--fs-ui); }
  .info-val { flex: 1; font-size: var(--fs-body); word-break: break-all; }
  .info-val.mono { font-family: var(--font-mono); }
  .info-path {
    min-height: var(--control-height);
    flex: 1; font-size: var(--fs-body); word-break: break-all; text-align: left;
    background: none; border: none; color: var(--text); cursor: pointer; padding: 0;
    display: flex; align-items: center; gap: 4px; -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast);
  }
  .info-path:active { color: var(--accent); }

  /* One card per running download (board #420): the stack is a bounded
     region of its own, so every card and its Cancel stays reachable while
     the list or preview keeps its space (review P1-A). The bookmarks panel's
     fraction and scroll rule, not a new size. */
  .files-feedback {
    display: flex; flex: none; flex-direction: column; gap: var(--ui-gap);
    min-width: 0; padding: var(--ui-gap);
    max-height: calc(40vh / var(--ui-zoom, 1)); overflow-y: auto;
    -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
  }
  /* The stack scrolls, its cards do not shrink (review round 2): a card in a
     bounded column flex could otherwise be squeezed below its content and
     scroll inside itself instead of the stack. This boundary only; the
     shared card keeps its own rules everywhere else. */
  .files-feedback > :global(.operation-feedback) { flex: none; }
  @media (prefers-reduced-motion: reduce) {
    .file-list { transition: none; }
  }

</style>

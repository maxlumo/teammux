<script lang="ts">
  // Review comments on a previewed file (board #434, files-review.md): the
  // ＋ on a selection, the cards, their highlights, and "Send as feedback".
  // It wraps the preview (`children`) so it can lay the cards out by the
  // preview's OWN width: a column beside it when there is room, a folded list
  // under it otherwise. The anchors, relocation and the feedback block are
  // the server's (`projects::review`); the DOM ↔ range mapping is
  // `review-anchor.ts` / `review-ui.ts`. Off — the preview alone — for a file
  // that is not code or markdown, or not inside a project.
  import type { Snippet } from 'svelte';
  import { tick, untrack } from 'svelte';
  import { t } from '../core/i18n.svelte.ts';
  import CommandButton from '../ui/CommandButton.svelte';
  import ContextMenu from '../ui/ContextMenu.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Select from '../ui/Select.svelte';
  import { longpress } from '../ui/longpress.ts';
  import { anchorOf, menuPlacement, viewBox, uiZoom, type AnchorRect } from '../ui/placement.ts';
  import { systemOwnsContextMenu } from '../ui/native-context-menu.ts';
  import { useServerScope } from '../app/server-context.ts';
  import { mimeCategory } from './file-preview.ts';
  import { reviewLines, type Mapped, type Range } from './review-anchor.ts';
  import { markdownSourceMap } from '../core/markdown.ts';
  import { codeSelection, markdownSelection, codeHighlight, markdownHighlight, ownHighlight, reviewProjects, draftKey, HIGHLIGHT, HIGHLIGHT_HOT, type NoteDraft } from './review-ui.ts';
  import { landFeedback, recipientIntent } from './review-state.ts';
  import type { ReviewAnnotation, ReviewListing, ReviewTarget } from '../core/ws-api.ts';
  import type { Project } from '../projects/projects.ts';

  type File = { path: string; content?: string; revision?: string; convertedHtml?: string; stat?: { mime_hint?: string } };
  interface Props {
    file: File | null;
    /** The preview's scroll container (FilePreview's `.preview-body`). */
    body: HTMLElement | null;
    /** The Files instance's project room: the declared one among several
     * projects at the file's root (the Hub drawer's room). */
    session?: string;
    /** Bumped on Reload and on returning to the preview: the cards are read
     * again then (a `tmm review` change appears); there is no live sync. */
    refresh?: number;
    /** Phone-sized viewport: the confirmation is a bottom sheet. */
    compact?: boolean;
    /** The feedback block has landed in that room's composer or draft. */
    onfeedback?: (session: string) => void;
    /** Files' own operation gate (`feedbackContext`): captured when a request
     * starts, it answers whether that request may still act — this Files is
     * alive and visible, and its session, root, directory, view, file and
     * navigation request are the ones it started on (reviewer P1-B). */
    context?: () => () => boolean;
    children: Snippet;
  }
  let { file, body, session = '', refresh = 0, compact = false, onfeedback = () => {}, context = () => () => true, children }: Props = $props();

  const scope = useServerScope()!;
  const api = scope.runtime.api;
  const memory = scope.state.review;
  let alive = true;
  $effect(() => () => { alive = false; });
  /** The preview's life (reviewer P1-B on 5b2a004f and 93c1b929): a
   * monotonic generation, bumped on EVERY exit — Files hidden or its
   * operation context changing (session, root, directory, view, file,
   * navigation request), the host's binding changing (a server away, or
   * back), another review target — and never restored by a return. A
   * request captures it when it starts and may act only while it is
   * unchanged and this component lives; a request that saw any exit is dead
   * even when the same preview comes back. */
  let lifeGen = 0;
  function capture() {
    const life = lifeGen;
    return () => alive && life === lifeGen;
  }


  /** The card column needs this much beside the text; below it, the fold.
   * CARD_W is also the column's CSS width (`--rv-card-w`), one value. */
  const CARD_W = 260;
  const TEXT_MIN = 440;
  const QUOTE_MAX = 60;

  const kind = $derived.by((): 'code' | 'markdown' | null => {
    if (!file || file.content == null || file.convertedHtml) return null;
    const c = mimeCategory(file.stat?.mime_hint);
    return c === 'markdown' ? 'markdown' : c === 'code' || c === 'other' ? 'code' : null;
  });
  const lines = $derived(kind && file?.content != null ? reviewLines(file.content) : []);
  /** What each rendered markdown block shows, tied to the source: the same
   * pipeline as the preview's span render (reviewer P1-A on 5b2a004f). */
  const mdMap = $derived(kind === 'markdown' && file?.content != null ? markdownSourceMap(file.content) : null);

  // ── Which project (delta 2 P1-C) ─────────────────────────────────────────
  let projects = $state.raw<Project[] | null>(null);
  /** A failed `project_list` is an error with a Retry, never "not in a
   * project" (reviewer P2): nothing is read or written until it answers. */
  let projectsError = $state('');
  let projectsRetry = $state(0);
  let picked = $state('');
  $effect(() => {
    void refresh; void projectsRetry;
    const path = file?.path;
    if (!kind || !path) return;
    let live = true;
    api.projectList().then((r: { projects: { project: Project }[] }) => {
      if (live) { projects = r.projects.map((row) => row.project).filter((p) => !p.archived); projectsError = ''; }
    }).catch((e: Error) => { if (live) { projects = null; projectsError = e?.message ?? String(e); } });
    return () => { live = false; };
  });
  const resolved = $derived(projects && file && kind ? reviewProjects(projects, file.path, session) : { candidates: [] as Project[], chosen: null });
  const project = $derived(resolved.chosen ?? resolved.candidates.find((p) => p.id === picked) ?? null);
  const target = $derived<ReviewTarget | null>(project && file && kind ? { project_id: project.id, path: file.path } : null);
  const on = $derived(!!kind && (resolved.candidates.length > 0 || !!projectsError));
  /** The target as a value, so a re-read project list is not an exit. */
  const targetId = $derived(target ? draftKey(target.project_id!, target.path) : '');

  // ── The cards ────────────────────────────────────────────────────────────
  let listing = $state.raw<ReviewListing | null>(null);
  let error = $state('');
  let showResolved = $state(false);
  let listSeq = 0;
  async function loadList() {
    const tg = target;
    if (!tg) { listing = null; return; }
    const my = ++listSeq;
    try {
      const l = await api.reviewList(tg);
      if (my === listSeq) { listing = l; error = ''; }
    } catch (e) {
      if (my === listSeq) error = (e as Error)?.message ?? String(e);
    }
  }
  $effect(() => {
    const tg = target;
    void refresh;
    untrack(() => {
      if (!tg) { listing = null; return; }
      void loadList();
    });
  });
  // A new target starts clean: no cards of the previous file, its unsaved
  // notes restored from the server's review memory.
  let targetKey = '';
  $effect(() => {
    const tg = target;
    const key = tg ? draftKey(tg.project_id!, tg.path) : '';
    if (key === targetKey) return;
    targetKey = key;
    untrack(() => {
      // A new target is never stuck behind the old one's work.
      listing = null;
      error = '';
      feedbackNote = '';
      menu = null;
      pick = null;
      restoreNotes(tg);
    });
  });

  const annotations = $derived(listing?.annotations ?? []);
  const openCount = $derived(annotations.filter((a) => a.status === 'open').length);
  const resolvedCount = $derived(annotations.length - openCount);
  const shown = $derived(annotations.filter((a) => showResolved || a.status === 'open')
    .slice().sort((a, b) => lineOf(a) - lineOf(b)));
  function lineOf(a: ReviewAnnotation) { return a.at?.state === 'located' ? a.at.range.line : Number.MAX_SAFE_INTEGER; }
  /** The positions belong to the text on screen only when the revisions agree. */
  const current = $derived(!!listing && !!file?.revision && listing.revision === file.revision);

  // ── Unsaved notes, kept per (project, file[, id]) ────────────────────────
  /** id → text; '' is the new comment. */
  let notes = $state<Record<string, string>>({});
  /** id → the draft object THIS instance displays (reviewer P1-B on
   * 3a33f2ea): the one source a save sends, and the identity it, a Cancel
   * and a success compare against. The Files page and the Hub drawer share
   * one server's notes map, so the map's latest object can be another
   * editor's; it is never taken for this one's. */
  let held: Record<string, NoteDraft> = {};
  let newAt = $state.raw<{ range: Range; revision: string; quote: string } | null>(null);
  let stale = $state(false);
  let saving = $state('');
  /** Which request owns `saving` / `sending`: a request clears only its own
   * flag when it ends, retired or not, and every exit starts clean. */
  let saveSeq = 0, sendSeq = 0;
  function restoreNotes(tg: ReviewTarget | null) {
    const next: Record<string, string> = {};
    held = {};
    newAt = null; stale = false;
    if (tg) {
      for (const [key, d] of memory.notes) {
        const [pid, path, id] = JSON.parse(key) as [string, string, string];
        if (pid !== tg.project_id || path !== tg.path) continue;
        next[id] = d.text;
        held[id] = d;
        if (!id && d.range && d.revision) newAt = { range: d.range, revision: d.revision, quote: d.quote ?? '' };
      }
    }
    notes = next;
  }
  function writeNote(id: string, text: string) {
    const tg = target;
    if (!tg) return;
    notes = { ...notes, [id]: text };
    // Every write makes a NEW object: the draft's identity, held by this
    // instance and stored as the key's latest draft (the last keystroke on
    // a key is the one a rebuilt editor gets back). Removal is the other
    // way round: only by identity, so no editor ever clears another's.
    const draft: NoteDraft = id ? { text } : { text, ...(newAt ?? {}) };
    held[id] = draft;
    memory.notes.set(draftKey(tg.project_id!, tg.path, id), draft);
  }
  /** The draft a request submits: its key and the object this instance
   * displays, whose text (and selection) is what is sent. */
  function submitted(id: string): { key: string; draft: NoteDraft } | null {
    const tg = target, draft = held[id];
    return tg && draft ? { key: draftKey(tg.project_id!, tg.path, id), draft } : null;
  }
  /** The server took `sub`: forget THAT draft, and only it, by identity
   * (reviewer P1-B on 93c1b929, 58df654c and 3a33f2ea). The shared map loses
   * it only if it still holds that very object; this editor closes only if
   * it still displays it. A note written meanwhile — in this editor, in
   * another one on the same key, after a Cancel, after leaving and coming
   * back — is another object and stays, saveable. An accepted draft never
   * reappears. */
  function forget(sub: { key: string; draft: NoteDraft }, id: string) {
    if (memory.notes.get(sub.key) === sub.draft) memory.notes.delete(sub.key);
    if (!alive || held[id] !== sub.draft) return;
    delete held[id];
    const { [id]: _, ...rest } = notes;
    notes = rest;
    if (!id) { newAt = null; stale = false; }
  }
  /** Cancel: this editor's draft goes; the shared map loses it only if it
   * still holds this editor's object, never another editor's. */
  function dropNote(id: string) {
    const tg = target;
    const mine = held[id];
    delete held[id];
    const { [id]: _, ...rest } = notes;
    notes = rest;
    if (tg && mine) {
      const key = draftKey(tg.project_id!, tg.path, id);
      if (memory.notes.get(key) === mine) memory.notes.delete(key);
    }
    if (!id) { newAt = null; stale = false; }
  }

  // ── The ＋ on a selection ────────────────────────────────────────────────
  let pick = $state.raw<{ mapped: Mapped; quote: string; anchor: AnchorRect } | null>(null);
  let pickEl = $state<HTMLElement | null>(null);
  let pickW = $state(0), pickH = $state(0);
  /** A press on the ＋ itself: the selection may collapse under the finger
   * before the click lands; that collapse is not "the selection went away". */
  let holding = false;
  function reviewRoot(): HTMLElement | null {
    return body?.querySelector<HTMLElement>(kind === 'markdown' ? '.md-render' : '.code-lined') ?? null;
  }
  function rangeAnchor(r: globalThis.Range): AnchorRect {
    const box = typeof r.getBoundingClientRect === 'function' ? r.getBoundingClientRect() : null;
    const z = uiZoom();
    return box ? { left: box.left / z, right: box.right / z, top: box.top / z, bottom: box.bottom / z } : { left: 0, right: 0, top: 0, bottom: 0 };
  }
  function onSelectionChange() {
    if (holding) return;
    const root = reviewRoot();
    if (!root || !target || !kind || file?.content == null) { pick = null; return; }
    const sel = root.ownerDocument.getSelection();
    const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!r || r.collapsed || !root.contains(r.commonAncestorContainer)) { pick = null; return; }
    const mapped = kind === 'code' ? codeSelection(root, r, lines) : markdownSelection(root, r, file.content, mdMap);
    if (!mapped || ('refused' in mapped && (mapped.refused === 'reviewRefusedOutside' || mapped.refused === 'reviewRefusedEmpty'))) { pick = null; return; }
    pick = { mapped, quote: r.toString(), anchor: rangeAnchor(r) };
  }
  $effect(() => {
    if (!on) return;
    const doc = body?.ownerDocument;
    if (!doc) return;
    const release = () => { setTimeout(() => { holding = false; }, 0); };
    doc.addEventListener('selectionchange', onSelectionChange);
    doc.defaultView?.addEventListener('pointerup', release, true);
    return () => {
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.defaultView?.removeEventListener('pointerup', release, true);
    };
  });
  const pickPos = $derived(pick ? menuPlacement(pick.anchor, { w: pickW, h: pickH }, viewBox(), undefined, undefined, 'left') : null);

  function openComposer() {
    holding = false;
    const p = pick, f = file;
    if (!p || !('range' in p.mapped) || !f?.revision) return;
    newAt = { range: p.mapped.range, revision: f.revision, quote: p.quote };
    stale = false;
    writeNote('', notes[''] ?? '');
    pick = null;
    folded = false;
    body?.ownerDocument.getSelection()?.removeAllRanges();
    void tick().then(() => wrapEl?.querySelector<HTMLTextAreaElement>('.rv-new textarea')?.focus());
  }

  async function saveNew() {
    const tg = target, sub = submitted('');
    // What is sent IS the held draft: its text and its selection.
    const d = sub?.draft, text = (d?.text ?? '').trim();
    if (!tg || !sub || !d?.range || !d.revision || !text || saving) return;
    const ok = capture();
    saving = 'new';
    const mine = ++saveSeq;
    try {
      const r = await api.reviewAdd(tg, d.range, text, d.revision);
      if ('stale' in r) { if (ok()) stale = true; return; }
      // Stored: the draft it submitted is no longer unsaved, wherever the
      // page went; a newer one stays.
      forget(sub, '');
      if (!ok()) return;
      await loadList();
    } catch (e) {
      if (ok()) error = (e as Error)?.message ?? String(e);
    } finally { if (mine === saveSeq) saving = ''; }
  }

  async function saveEdit(a: ReviewAnnotation) {
    const tg = target, sub = submitted(a.id);
    const text = (sub?.draft.text ?? '').trim();
    if (!tg || !sub || !text) return;
    await act(a.id, () => api.reviewUpdate(tg, a.id, { note: text }), () => {}, () => forget(sub, a.id));
  }
  /** One card write. `stored` runs once the server took it, whatever the
   * page did meanwhile; `done` and the re-read only while the request may
   * still act. */
  async function act(id: string, run: () => Promise<unknown>, done: () => void = () => {}, stored: () => void = () => {}) {
    if (saving) return;
    const ok = capture();
    saving = id;
    const mine = ++saveSeq;
    try {
      await run();
      stored();
      if (!ok()) return;
      done();
      await loadList();
    } catch (e) {
      if (ok()) error = (e as Error)?.message ?? String(e);
    } finally { if (mine === saveSeq) saving = ''; }
  }
  const saveKeys = (e: KeyboardEvent, save: () => void) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
  };

  // ── The card menu and the one confirm ────────────────────────────────────
  let menu = $state.raw<{ at: unknown; id: string } | null>(null);
  let pendingDelete = $state.raw<ReviewAnnotation | null>(null);
  const menuItems = $derived.by(() => {
    const a = menu && annotations.find((x) => x.id === menu!.id);
    if (!a) return [];
    return [
      { label: t('reviewEdit'), icon: 'edit', onselect: () => writeNote(a.id, notes[a.id] ?? a.note) },
      a.status === 'open'
        ? { label: t('reviewResolve'), icon: 'check', onselect: () => { const tg = target; if (tg) void act(a.id, () => api.reviewUpdate(tg, a.id, { status: 'resolved' })); } }
        : { label: t('reviewReopen'), icon: 'undo', onselect: () => { const tg = target; if (tg) void act(a.id, () => api.reviewUpdate(tg, a.id, { status: 'open' })); } },
      { label: t('delete'), icon: 'trash', danger: true, onselect: () => { pendingDelete = a; } },
    ];
  });
  function contextCard(event: MouseEvent, a: ReviewAnnotation) {
    if (systemOwnsContextMenu(event)) { event.preventDefault(); return; }
    event.preventDefault(); event.stopPropagation();
    menu = { at: { x: event.clientX, y: event.clientY }, id: a.id };
  }
  async function confirmDelete() {
    const a = pendingDelete, tg = target;
    if (!a || !tg) { pendingDelete = null; return; }
    // Deleted: no draft of its edit survives, whatever its revision.
    await act(a.id, () => api.reviewDelete(tg, a.id), () => { dropNote(a.id); }, () => { if (tg) memory.notes.delete(draftKey(tg.project_id!, tg.path, a.id)); });
    pendingDelete = null;
  }

  // ── Highlights, the range-hit click, hover ───────────────────────────────
  let hl: ReturnType<typeof ownHighlight> = null;
  let hot: ReturnType<typeof ownHighlight> = null;
  /** id → its DOM range in the preview, for the painted cards. */
  let ranges = new Map<string, globalThis.Range>();
  let painted = $state.raw<Set<string>>(new Set());
  let rowsShown = $state(Number.MAX_SAFE_INTEGER);
  let hotId = $state('');
  function paint() {
    const root = reviewRoot();
    const next = new Map<string, globalThis.Range>();
    if (root && current && kind) {
      if (kind === 'code') rowsShown = root.querySelectorAll('.cl-row').length;
      for (const a of shown) {
        if (a.at?.state !== 'located') continue;
        const r = kind === 'code' ? codeHighlight(root, a.at.range, lines) : markdownHighlight(root, a.at.range, file!.content!, mdMap);
        if (r) next.set(a.id, r);
      }
    }
    ranges = next;
    painted = new Set(next.keys());
    // Where the comment being written sits, to place its card (no highlight).
    newRange = root && newAt && kind && file?.revision === newAt.revision
      ? (kind === 'code' ? codeHighlight(root, newAt.range, lines) : markdownHighlight(root, newAt.range, file!.content!, mdMap))
      : null;
    hl?.set([...next.values()]);
    hot?.set(hotId && next.has(hotId) ? [next.get(hotId)!] : []);
    placeCards();
  }
  let newRange: globalThis.Range | null = null;
  let paintQueued = false;
  function queuePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paint(); });
  }
  $effect(() => {
    const el = body;
    if (!on || !el) return;
    const win = el.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    hl = win ? ownHighlight(win, HIGHLIGHT) : null;
    hot = win ? ownHighlight(win, HIGHLIGHT_HOT) : null;
    // The preview re-renders under us (the highlighter landing, mermaid, a
    // Reload): paint again whenever its DOM changes.
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(queuePaint) : null;
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    // A scroll of the preview moves nothing in it, so only the cards move:
    // the lane follows the scroller that moved (reviewer P1-C).
    const onScroll = (e: Event) => {
      const sc = e.target as HTMLElement;
      if (sc === scrollerOf() && laneEl) laneEl.scrollTop = sc.scrollTop;
      queuePlace();
    };
    el.addEventListener('scroll', onScroll, true);
    el.addEventListener('click', onPreviewClick);
    return () => {
      mo?.disconnect();
      el.removeEventListener('scroll', onScroll, true);
      el.removeEventListener('click', onPreviewClick);
      hl?.clear(); hot?.clear(); hl = null; hot = null;
      ranges = new Map();
    };
  });
  $effect(() => {
    // Every change to the cards or what they point at paints AND places,
    // once the DOM shows it: the list read, an add, a resolve, a delete, an
    // editor opened for a new comment, a Reload, the layout changing.
    void shown; void current; void kind; void file?.content; void hotId; void wide; void newAt;
    if (!on) return;
    void tick().then(paint);
  });
  function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
    const d = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null };
    const p = d.caretPositionFromPoint?.(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
    const r = d.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  /** A click on highlighted text focuses its card. A link and a selection
   * keep the click (they win); nothing is ever preventDefault'ed here. */
  function onPreviewClick(e: MouseEvent) {
    if (!ranges.size || !body) return;
    const doc = body.ownerDocument;
    const sel = doc.getSelection();
    if (sel && !sel.isCollapsed) return;
    if ((e.target as Element | null)?.closest?.('a')) return;
    const at = caretAt(doc, e.clientX, e.clientY);
    if (!at) return;
    for (const [id, r] of ranges) {
      try { if (r.isPointInRange(at.node, at.offset)) { focusCard(id); return; } } catch {}
    }
  }
  function focusCard(id: string) {
    folded = false;
    hotId = id;
    void tick().then(() => {
      const el = [...(wrapEl?.querySelectorAll<HTMLElement>('[data-review-id]') ?? [])].find((x) => x.dataset.reviewId === id);
      el?.scrollIntoView?.({ block: 'nearest' });
      el?.focus({ preventScroll: true });
    });
  }

  // ── Layout: by the preview's own width (review P2) ───────────────────────
  let wrapEl = $state<HTMLElement | null>(null);
  let laneEl = $state<HTMLElement | null>(null);
  let wide = $state(false);
  let folded = $state(true);
  $effect(() => {
    const el = wrapEl;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      wide = w >= CARD_W + TEXT_MIN;
    });
    ro.observe(el);
    return () => ro.disconnect();
  });
  let innerEl = $state<HTMLElement | null>(null);
  /** The element the preview scrolls in: the lined code view scrolls
   * itself, the markdown preview scrolls its body. */
  const scrollerOf = (): HTMLElement | null =>
    (kind === 'code' ? body?.querySelector<HTMLElement>('.code-lined') : null) ?? body;
  /**
   * The wide column's protocol (reviewer P1-C, validator on 5b2a004f).
   *
   * The lane is a real scroller (`overflow-y: auto`), and its content is as
   * tall as the preview's content or the card stack, whichever is taller.
   * Each card is placed in the PREVIEW's content coordinates only:
   * `(rangeTop − scrollerTop) / uiZoom + scroller.scrollTop`, plus the
   * scroller box's offset from the lane box (`uiZoom` because a client rect
   * is in visual pixels, a CSS `top` in the zoomed ones). The lane's own
   * scrollTop never enters it. Take-over rule: a scroll of the preview
   * drives the lane's scrollTop, so a card stays level with its highlight;
   * a scroll of the lane by the person is left alone until the preview
   * scrolls again. Cards
   * are pushed down past the one above them, never overlapping; cards with
   * no highlight (missing, ambiguous, beyond the cap, a different revision)
   * follow in line order; the card being written sits at its selection. A
   * stack longer than the preview stays reachable: the lane scrolls on past
   * the preview's end.
   *
   * It runs on every change to the cards or the highlights: each paint
   * places (the list read, an add, a resolve, a delete, a new comment's
   * editor, a Reload, the preview re-rendering), a card changing height
   * places (an edit opening or growing: a ResizeObserver on each card), and
   * a scroll places.
   */
  function placeCards() {
    const lane = laneEl, inner = innerEl, sc = scrollerOf();
    if (!wide || !lane || !inner || !sc) return;
    const z = uiZoom();
    const scTop = sc.getBoundingClientRect().top;
    // Content geometry only (reviewer P1-C on 93c1b929): the scroller's box
    // offset from the lane's box, never either one's scroll state, so a
    // re-place after the person scrolled the lane moves nothing.
    const offset = (scTop - lane.getBoundingClientRect().top) / z;
    const gap = parseFloat(getComputedStyle(inner).rowGap) || 0;
    const want = (r: globalThis.Range | null | undefined) =>
      r && typeof r.getBoundingClientRect === 'function' ? (r.getBoundingClientRect().top - scTop) / z + sc.scrollTop + offset : null;
    const items = [...inner.children].map((node) => {
      const el = node as HTMLElement;
      const id = el.dataset.reviewId;
      // The comment being written sits at its selection, or at the top when its
      // text is not on screen (a new revision); focusing it brings it into view.
      const y = id ? want(ranges.get(id)) : el.classList.contains('rv-new') ? (want(newRange) ?? 0) : null;
      return { el, y };
    });
    const typing = inner.ownerDocument.activeElement?.closest?.('.rv-card') as HTMLElement | null | undefined;
    const typingWas = typing && inner.contains(typing) ? typing.style.top : null;
    const placed = items.filter((i) => i.y !== null).sort((a, b) => a.y! - b.y!);
    let floor = 0;
    for (const it of [...placed, ...items.filter((i) => i.y === null)]) {
      const y = Math.max(it.y ?? floor, floor);
      it.el.style.top = `${y}px`;
      floor = y + it.el.offsetHeight + gap;
    }
    inner.style.height = `${Math.max(floor, sc.scrollHeight + offset)}px`;
    // The card being typed in stays in view when a re-place MOVES it (a
    // Reload put a new comment whose text left the screen at the lane top),
    // through the same scrollIntoView a card's focus uses. A scroll moves no
    // card, so it never pulls the lane against the person's scrolling.
    if (typing && typingWas !== null && typing.style.top !== typingWas) typing.scrollIntoView?.({ block: 'nearest' });
  }
  let placeQueued = false;
  function queuePlace() {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => { placeQueued = false; placeCards(); });
  }
  // A card that changes height (an editor opening, a note growing) moves the
  // ones below it.
  $effect(() => {
    const inner = innerEl;
    void shown; void newAt; void notes;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(queuePlace);
    for (const c of inner.children) ro.observe(c);
    return () => ro.disconnect();
  });

  // ── Send as feedback (delta 2/3 P1-C) ────────────────────────────────────
  let feedbackNote = $state('');
  let sending = $state(false);
  async function sendFeedback() {
    const tg = target, p = project;
    if (!tg || !p || sending) return;
    // Bound to the preview's life (reviewer P1-B): hidden, Back, a server
    // switch, another file or this component gone, and it lands nothing and
    // navigates nowhere. The unsaved notes are not touched either way.
    const ok = capture();
    // Captured NOW: a recipient chosen while this is in flight is the person's.
    const intent = recipientIntent(memory, p.id);
    sending = true; feedbackNote = '';
    const mine = ++sendSeq;
    try {
      const r = await api.reviewFeedback(tg);
      if (!ok()) return;
      if (!r.count) { feedbackNote = t('reviewFeedbackEmpty'); return; }
      // The room is resolved from the stable id at landing: a rename is
      // followed, a removed project lands nothing.
      const now = (await api.projectList()).projects.map((row: { project: Project }) => row.project).find((x: Project) => x.id === p.id && !x.archived);
      if (!ok()) return;
      if (!now) { feedbackNote = t('reviewFeedbackStale'); return; }
      landFeedback(memory, scope.state.prefs, { projectId: p.id, session: now.session, block: r.text, intent });
      feedbackNote = t('reviewFeedbackSent');
      onfeedback(now.session);
    } catch (e) {
      if (ok()) feedbackNote = (e as Error)?.message ?? String(e);
    } finally { if (mine === sendSeq) sending = false; }
  }


  // Every exit bumps the generation and ends the pending state with it, so
  // the page it leads to is never stuck behind a dead request.
  $effect(() => {
    context()(); // reads Files' visible and operation context
    if (scope.eligible) scope.eligible();
    void targetId;
    untrack(() => {
      lifeGen++;
      saving = ''; saveSeq++;
      sending = false; sendSeq++;
    });
  });

  const cut = (s: string) => {
    const one = s.replace(/\s+/gu, ' ').trim();
    return [...one].length > QUOTE_MAX ? `${[...one].slice(0, QUOTE_MAX).join('')}…` : one;
  };
  function where(a: ReviewAnnotation): string {
    const at = a.at;
    if (!at || at.state === 'missing') return t('reviewMissing');
    if (at.state === 'ambiguous') return t('reviewAmbiguous');
    if (kind === 'code' && at.range.line > rowsShown) return t('reviewBeyond').replace('{n}', String(at.range.line));
    return t('reviewLine').replace('{n}', String(at.range.line));
  }
</script>

{#snippet card(a: ReviewAnnotation)}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <article class="rv-card" class:resolved={a.status === 'resolved'} class:hot={hotId === a.id} data-review-id={a.id} tabindex="-1"
    aria-label={`${t('reviewComment')}: ${cut(a.quote)}`}
    onmouseenter={() => { hotId = a.id; }} onmouseleave={() => { if (hotId === a.id) hotId = ''; }}
    onfocusin={() => { hotId = a.id; }}
    oncontextmenu={(e) => contextCard(e, a)} use:longpress={{ onlongpress: (at) => { menu = { at, id: a.id }; } }}>
    <div class="rv-head">
      <q class="rv-quote">{cut(a.quote)}</q>
      <CommandButton variant="icon" iconOnly icon="dots" label={`${t('reviewCardMenu')}: ${cut(a.quote)}`}
        hasPopup="menu" onclick={(e) => { menu = { at: { anchor: anchorOf(e.currentTarget as Element) }, id: a.id }; }} />
    </div>
    {#if notes[a.id] != null}
      <textarea class="rv-input" rows="3" aria-label={t('reviewNote')} value={notes[a.id]}
        oninput={(e) => writeNote(a.id, e.currentTarget.value)} onkeydown={(e) => saveKeys(e, () => saveEdit(a))}></textarea>
      <div class="rv-actions">
        <CommandButton label={t('cancel')} onclick={() => dropNote(a.id)} />
        <CommandButton variant="primary" label={t('reviewSave')} pending={saving === a.id} icon="check"
          disabled={!(notes[a.id] ?? '').trim()} onclick={() => saveEdit(a)} />
      </div>
    {:else}
      <p class="rv-note">{a.note}</p>
    {/if}
    <p class="rv-meta">
      <span class:rv-lost={a.at?.state !== 'located'}>{where(a)}</span>
      {#if a.status === 'resolved'}<span>· {t('reviewResolved')}</span>{/if}
      {#if a.by && a.by !== 'human'}<span>· {a.by}</span>{/if}
    </p>
  </article>
{/snippet}

{#snippet composer()}
  {#if newAt}
    <div class="rv-card rv-new">
      <q class="rv-quote">{cut(newAt.quote)}</q>
      <textarea class="rv-input" rows="3" aria-label={t('reviewNote')} placeholder={t('reviewNote')} value={notes[''] ?? ''}
        oninput={(e) => writeNote('', e.currentTarget.value)} onkeydown={(e) => saveKeys(e, saveNew)}></textarea>
      {#if stale}<p class="rv-warn" role="alert">{t('reviewStale')}</p>{/if}
      <div class="rv-actions">
        <CommandButton label={t('cancel')} onclick={() => dropNote('')} />
        <CommandButton variant="primary" label={t('reviewSave')} icon="check" pending={saving === 'new'}
          disabled={!(notes[''] ?? '').trim() || stale} onclick={saveNew} />
      </div>
    </div>
  {/if}
{/snippet}

{#snippet head()}
  <div class="rv-bar compact-tools">
    {#if wide}<span class="rv-title" title={`${t('reviewComments')} (${openCount})`}>{t('reviewComments')} ({openCount})</span>{/if}
    {#if resolvedCount}
      <CommandButton variant="icon" iconOnly icon="circle-check" label={t('reviewShowResolved')} pressed={showResolved}
        onclick={() => { showResolved = !showResolved; }} />
    {/if}
    {#if openCount && !wide}
      <CommandButton icon="send" label={t('reviewSendFeedback')} pending={sending} onclick={sendFeedback} />
    {/if}
  </div>
  <!-- In the column the title keeps its line; Send takes the row under it
       (validator on 5b2a004f: the count wrapped beside it at 1440). -->
  {#if openCount && wide}
    <div class="rv-send"><CommandButton icon="send" label={t('reviewSendFeedback')} pending={sending} onclick={sendFeedback} /></div>
  {/if}
  {#if resolved.candidates.length > 1 && !resolved.chosen}
    <div class="rv-project">
      <Select dense bind:value={picked} placeholder={t('reviewProjectPick')}
        options={resolved.candidates.map((p) => ({ value: p.id, label: p.name, hint: p.session }))} />
    </div>
  {/if}
  {#if projectsError}
    <p class="rv-warn" role="alert">{t('reviewProjectsFailed')}: {projectsError}</p>
    <CommandButton icon="refresh" label={t('reviewRetry')} onclick={() => { projectsRetry++; }} />
  {/if}
  {#if feedbackNote}<p class="rv-status" role="status">{feedbackNote}</p>{/if}
  {#if error}<p class="rv-warn" role="alert">{error}</p>{/if}
  {#if listing && !current}<p class="rv-status">{t('reviewReloadHint')}</p>{/if}
{/snippet}

<div class="rv-wrap" class:wide={on && wide} bind:this={wrapEl}>
  {@render children()}
  {#if on}
    {#if wide}
      <aside class="rv-column" aria-label={t('reviewComments')} style:--rv-card-w="{CARD_W}px">
        {@render head()}
        <div class="rv-lane" bind:this={laneEl}>
          <div class="rv-lane-inner" bind:this={innerEl}>
            {@render composer()}
            {#each shown as a (a.id)}{@render card(a)}{/each}
          </div>
        </div>
      </aside>
    {:else}
      <section class="rv-fold" aria-label={t('reviewComments')}>
        <div class="rv-fold-row">
          <CommandButton variant="icon" icon={folded ? 'chevron-up' : 'chevron-down'} label={`${t('reviewComments')} (${openCount})`}
            expanded={!folded} onclick={() => { folded = !folded; }} />
          {@render head()}
        </div>
        {#if !folded || newAt}
          <div class="rv-list">
            {@render composer()}
            {#if !folded}{#each shown as a (a.id)}{@render card(a)}{/each}{/if}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>

{#if pick && pickPos}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="rv-pick" bind:this={pickEl} bind:clientWidth={pickW} bind:clientHeight={pickH}
    style:left="{pickPos.x}px" style:top="{pickPos.y}px" style:visibility={pickW ? 'visible' : 'hidden'}
    onmousedown={(e) => e.preventDefault()} onpointerdown={() => { holding = true; }}>
    {#if 'range' in pick.mapped}
      <CommandButton variant="primary" icon="plus" label={t('reviewComment')} onclick={openComposer} />
    {:else}
      <span class="rv-refused" role="status">{t(pick.mapped.refused)}</span>
    {/if}
  </div>
{/if}

<ContextMenu at={menu?.at ?? null} items={menuItems} oncancel={() => { menu = null; }} />
<ConfirmDialog open={!!pendingDelete} {compact} busy={!!pendingDelete && saving === pendingDelete.id}
  title={t('reviewDeleteTitle')} note={t('reviewDeleteNote')} confirmLabel={t('delete')} confirmIcon="trash"
  cancelLabel={t('cancel')} onconfirm={confirmDelete} oncancel={() => { pendingDelete = null; }} />

<style>
  .rv-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .rv-wrap.wide { flex-direction: row; }
  .rv-wrap > :global(.preview-body) { min-width: 0; }
  .rv-column {
    flex: 0 0 var(--rv-card-w); min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--config-label-gap);
    padding: var(--config-label-gap); border-left: 1px solid var(--border);
  }
  /* The lane scrolls (reviewer P1-C): every card and its menu stay reachable
     however tall the stack is. Its content height and the cards' tops are
     set by placeCards. */
  .rv-lane { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .rv-lane-inner { position: relative; row-gap: var(--config-label-gap); }
  .rv-lane-inner > :global(.rv-card) { position: absolute; left: 0; right: 0; }
  .rv-fold { border-top: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; max-height: 45%; }
  .rv-fold-row { display: flex; align-items: center; gap: var(--config-label-gap); padding: var(--ui-gap) var(--config-label-gap); flex-wrap: wrap; }
  .rv-list {
    overflow: auto; -webkit-overflow-scrolling: touch; padding: 0 var(--config-label-gap) var(--config-label-gap);
    display: flex; flex-direction: column; gap: var(--config-label-gap);
  }
  .rv-bar { display: flex; align-items: center; gap: var(--ui-gap); min-width: 0; }
  .rv-title {
    flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-family: var(--font-display); font-size: var(--fs-ui); color: var(--text2);
  }
  .rv-send { display: flex; }
  .rv-card {
    display: flex; flex-direction: column; gap: var(--ui-gap); padding: var(--menu-item-padding-y) var(--menu-item-padding-x);
    border: 1px solid var(--border); border-radius: var(--ui-radius-row); background: var(--surface);
    transition: border-color var(--t-fast), background var(--t-fast);
  }
  .rv-card.hot, .rv-card:focus-visible { border-color: var(--accent-line); background: var(--accent-bg); outline: none; }
  .rv-card.resolved { opacity: 0.7; }
  .rv-head { display: flex; align-items: flex-start; gap: var(--ui-gap); }
  .rv-quote {
    flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text2);
    overflow-wrap: anywhere; quotes: '“' '”';
  }
  .rv-note { margin: 0; font-size: var(--fs-body); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
  .rv-meta { margin: 0; display: flex; gap: var(--ui-gap); flex-wrap: wrap; font-size: var(--fs-meta); color: var(--text3); }
  .rv-lost { color: var(--status-warn); }
  .rv-input {
    width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: var(--fs-body);
    color: var(--text); background: var(--bg); border: 1px solid var(--input-border); border-radius: var(--ui-radius-control);
    padding: var(--menu-item-padding-y) var(--config-label-gap);
  }
  .rv-actions { display: flex; justify-content: flex-end; gap: var(--ui-gap); }
  .rv-status, .rv-warn { margin: 0; font-size: var(--fs-sub); color: var(--text2); }
  .rv-warn { color: var(--status-warn); }
  .rv-project { display: flex; }
  .rv-pick { position: fixed; z-index: 30; }
  .rv-refused {
    display: block; max-width: var(--rv-card-w, 260px); padding: var(--menu-item-padding-y) var(--menu-item-padding-x);
    font-size: var(--fs-sub); color: var(--text2);
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--ui-radius-control);
  }
</style>

<script lang="ts">
  const listId = $props.id();
  import { activeModal } from './modal.ts';
  import { nextMenuIndex } from './menu-navigation.ts';
  // The app's ONE dropdown. A native <select> pops the OS menu — a different
  // font, a different palette, a different animation, and on desktop WKWebView
  // a separate window entirely — which is exactly the seam the owner asked to
  // remove ("现在我看好像用的系统的下拉菜单，尽量保证我们 ui 统一一致",
  // 2026-08-19). Team's roster picker had already hand-rolled one for the same
  // reason; this is that idea extracted so there is one implementation.
  //
  // It reuses the popover mechanics of the Hub's agent menu: a fixed layer
  // placed from the trigger's rect, because these fields live inside scrolling
  // panels and an absolutely-positioned menu would be clipped by them.
  import Icon from './Icon.svelte';
  import { anchorOf, menuPlacement, popOrigin, viewBox, type AnchorRect } from './placement.ts';

  /** `ink`: an agent's name ink (board #293) — the option wears the app's
   *  `.ava` tile in it, lettered with the label's first character. */
  interface Option { value: string; label?: string; hint?: string; icon?: string; ink?: string }

  let {
    value = $bindable(''),
    options = [] as (string | Option)[],
    disabled = false,
    /** Match the denser field dialect (Team's template editor) instead of the
     * default one (the agent editor's inputs). A dropdown that lines up with
     * neither is what "左右和上方没有对齐" looked like. */
    dense = false,
    /** COMBOBOX mode: the trigger is a real text input — the value stays free
     * text (a model id we cannot enumerate is still typeable), and the menu is
     * the suggestion list, filtered as you type. Built for the agent editor's
     * model field, which used a native <datalist> — the OS popup this
     * component exists to remove (owner, 2026-08-24: "模型选择下拉框明显不对"). */
    editable = false,
    /** FONT-PREVIEW mode (board #97: "最好选择的字体本身就有样式"): each
     * option renders IN the family it names, and the field wears the current
     * value's face — the choice demonstrates itself. A family the device
     * lacks falls through to the app stack, which is also the honest answer:
     * what you see is what picking it gets you. */
    fontPreview = false,
    /** With fontPreview: the face an EMPTY field wears, so the placeholder
     * naming a default that has no single family name (the terminal's
     * platform-keyword lead) still shows it (board 312). */
    emptyFace = '',
    placeholder = '',
    ariaLabel = '',
    onchange = (_v: string) => {},
  } = $props();

  const norm = $derived(
    options.map((o): Option => (typeof o === 'string' ? { value: o } : o)),
  );
  const current = $derived(norm.find((o) => o.value === value));
  const label = $derived(current?.label ?? current?.value ?? '');

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let inputEl: HTMLInputElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);
  let anchor = $state<AnchorRect | null>(null);
  let menuH = $state(0);
  /** Keyboard cursor while open; -1 until the user arrows. */
  let cursor = $state(-1);

  /** Editable mode filters as you type — substring, case-blind, the typed
   * value itself excluded from being "filtered away" logic-wise: an empty or
   * fully-typed value shows the whole list, which is how the field doubles as
   * a browser. */
  const shown = $derived(
    !editable ? norm : (() => {
      const q = value.trim().toLowerCase();
      if (!q) return norm;
      const hit = norm.filter((o) => (o.label ?? o.value).toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
      // The full value matching exactly one option means the user picked it
      // (or finished typing it): offer everything again rather than a
      // one-row menu that just repeats the field.
      return hit.length === 1 && hit[0]!.value === value ? norm : hit;
    })(),
  );
  const hasIcons = $derived(shown.some((option) => !!option.icon || !!option.ink));

  // EXACTLY as wide as the field: with the menu right-aligned to the trigger,
  // equal widths make both edges line up, which is what a field-shaped picker
  // has to do. A max-width clamp would break that on the wide side, so the only
  // clamp is menuPlacement's viewport one.
  const fieldW = $derived(anchor ? Math.round(anchor.right - anchor.left) : 0);

  // The menu is styled to the FIELD's width, so the placement math uses that
  // number directly. Measuring the box back (bind:clientWidth) fed
  // menuPlacement a width MINUS border and — on desktop, where scrollbars are
  // classic and take real space — minus ~17px of scrollbar whenever the list
  // was long enough to scroll: right-aligned as `anchor.right - w`, the menu
  // overshot the field's right edge by exactly that much (owner, 2026-08-25:
  // "桌面端…下拉框…左右位置偏了"). Overlay-scrollbar platforms never showed it.
  const pos = $derived(anchor ? menuPlacement(anchor, { w: fieldW, h: menuH }, viewBox(), 6) : { x: 0, y: 0 });

  function show() {
    if (disabled || !(triggerEl ?? inputEl)) return;
    focusTrigger();
    anchor = anchorOf((triggerEl ?? inputEl)!);
    menuH = 0;
    cursor = shown.findIndex((o) => o.value === value);
    open = true;
  }
  let composing = $state(false);
  const imeKey = (event: KeyboardEvent) => composing || event.isComposing || event.keyCode === 229;
  function focusTrigger() { if (!disabled) (editable ? inputEl : triggerEl)?.focus(); }
  function moveCursor(from: number, step: 1 | -1) {
    cursor = nextMenuIndex(from, step, shown.length);
    menuEl?.querySelectorAll('button')[cursor]?.scrollIntoView?.({ block: 'nearest' });
  }
  function hide(restoreFocus = false) {
    open = false;
    if (restoreFocus) focusTrigger();
  }
  function pick(v: string) {
    if (disabled || composing) return;
    open = false;
    if (v === value) { committed = v; focusTrigger(); return; }
    value = v;
    committed = v;
    onchange(v);
    focusTrigger();
  }
  /** Editable mode: free-typed text commits on Enter/blur (a pick commits via
   * pick()). `committed` remembers the last reported value so a blur after a
   * pick, or an untouched field, stays silent. */
  let committed = $state(value);
  function commitTyped() {
    if (disabled || composing || !editable || value === committed) return;
    committed = value;
    onchange(value);
  }
  $effect(() => { if (disabled) hide(); });

  // Dismissal, on everything that means "I moved on": a click elsewhere,
  // Escape, a scroll under the anchor, a resize. The scroll listener is a
  // CAPTURE listener on window, which receives every element's scroll — the
  // menu's own included — so the list scrolling is excluded explicitly: a
  // long list (the model catalogue) closed the moment it was scrolled
  // (review, 2026-09-03).
  $effect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      // THIS instance's boxes, not the class names: `.closest('.sel-trigger')`
      // matched ANY Select in the app, so with three side by side (the agent
      // editor) opening one and tapping another left the first hanging open
      // (owner, 2026-08-25: "在其他地方点击之后就应该回收了，不应该一直显示
      // 展开在那里"). Another instance is OUTSIDE like everything else.
      const t = e.target as Node | null;
      if (t && (menuEl?.contains(t) || triggerEl?.contains(t) || inputEl?.contains(t))) return;
      hide();
    };
    const onKey = (e: KeyboardEvent) => {
      if (disabled || imeKey(e)) return;
      const modal = activeModal(document);
      if (modal && !modal.contains(editable ? inputEl : triggerEl)) return;
      if (!(triggerEl ?? inputEl)?.contains(document.activeElement) && !menuEl?.contains(document.activeElement)) return;
      if (e.key === 'Escape') { hide(true); e.preventDefault(); e.stopPropagation(); return; }
      if (e.key === 'Tab') { hide(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        moveCursor(cursor, step);
        return;
      }
      if (!editable && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault(); moveCursor(-1, e.key === 'Home' ? 1 : -1); return;
      }
      // Space stays typeable in a text field; it only picks for the button.
      if (e.key === 'Enter' || (e.key === ' ' && !editable)) {
        if (cursor >= 0 && shown[cursor]) { e.preventDefault(); pick(shown[cursor]!.value); }
        else if (editable && e.key === 'Enter') { hide(); commitTyped(); }
      }
    };
    const onScroll = (e: Event) => {
      if (menuEl && e.target instanceof Node && menuEl.contains(e.target)) return;
      hide();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    const onResize = () => hide();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);   // capture: any ancestor
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  });
</script>

{#snippet tile(o: Option)}<span class="ava so-ava" style:background={o.ink}>{(o.label ?? o.value).slice(0, 1).toUpperCase()}</span>{/snippet}

{#if editable}
  <!-- COMBOBOX: the native input keeps its hit box and editable field paint.
       The inert chevron still says "there is a list here". -->
  <span class="sel-combo">
    <input class="sel-trigger control-field combo" class:open class:dense bind:this={inputEl}
      {disabled} {placeholder} bind:value
      style:font-family={fontPreview && value.trim() ? `'${value.trim().replace(/['"]/g, '')}'` : (fontPreview && emptyFace) || undefined}
      role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && cursor >= 0 ? `${listId}-${cursor}` : undefined}
      aria-label={ariaLabel || undefined}
      autocomplete="off" autocapitalize="off" spellcheck="false"
      oninput={() => { if (!open) show(); cursor = -1; }}
      onclick={() => { if (!open) show(); }}
      onblur={commitTyped}
      oncompositionstart={() => composing = true}
      oncompositionend={() => composing = false}
      onkeydown={(e) => {
        if (imeKey(e)) return;
        if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show(); }
        if (!open && e.key === 'Enter') commitTyped();
      }} />
    <span class="combo-chev"><span class="flip" class:on={open}><Icon name="chevron-down" size={11} /></span></span>
  </span>
{:else}
<button class="sel-trigger control-field" class:open class:dense bind:this={triggerEl} type="button" role="combobox"
  {disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={ariaLabel || undefined}
  aria-activedescendant={open && cursor >= 0 ? `${listId}-${cursor}` : undefined}
  onkeydown={(e) => {
    if (!imeKey(e) && !open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show(); }
  }}
  onclick={() => (open ? hide() : show())}>
  {#if current?.icon}<img class="so-ico" src={current.icon} alt="" />{/if}{#if current?.ink}{@render tile(current)}{/if}
  <span class="sel-value">{label || placeholder}</span>
  <span class="flip" class:on={open}><Icon name="chevron-down" size={11} /></span>
</button>
{/if}

{#if open && shown.length}
  <div class="sel-menu menu-surface menu-list pop-layer" class:ready={menuH > 0} role="listbox" tabindex="-1" id={listId}
    style:left="{pos.x}px" style:top="{pos.y}px" style:width="{fieldW}px"
    style:--pop-origin={anchor ? popOrigin(anchor, pos) : undefined}
    bind:this={menuEl} bind:offsetHeight={menuH}>
    {#each shown as o, i (o.value)}
      <button class="sel-opt menu-item" class:sel={o.value === value} class:cur={i === cursor}
        role="option" aria-selected={o.value === value} type="button" tabindex="-1" id={`${listId}-${i}`}
        onclick={() => pick(o.value)} onpointerenter={() => (cursor = i)}>
        {#if hasIcons}<span class="menu-icon" aria-hidden="true">{#if o.icon}<img class="so-ico" src={o.icon} alt="" />{:else if o.ink}{@render tile(o)}{/if}</span>{/if}
        <span class="so-label menu-label" style:font-family={fontPreview && o.value ? `'${o.value.replace(/['"]/g, '')}'` : undefined}>{o.label ?? o.value}</span>
        {#if o.hint}<span class="so-hint menu-hint">{o.hint}</span>{/if}
        {#if o.value === value}<span class="menu-check" aria-hidden="true"><Icon name="check" size={12} /></span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  /* The shared control-field owns inset paint without shrinking the native
     input/button or changing the popover's measured anchor. */
  .sel-trigger {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 0 12px; color: var(--text);
    /* The trigger shows a VALUE, so it keeps the content font — the input
       dialect, not the button/chrome one. */
    font-size: var(--fs-body); font-family: var(--font-ui);
    line-height: var(--control-line-height);
    cursor: pointer; text-align: left;
  }
  /* Dense remains a text-role option for existing non-form consumers, not
     another control height. Configuration forms use the normal value role. */
  .sel-trigger.dense { font-size: var(--fs-ui); }
  button.sel-trigger { --field-paint: transparent; padding-inline: 0; }
  .sel-trigger:disabled { opacity: var(--control-disabled-opacity); cursor: default; }
  .sel-value { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text2); }
  .sel-trigger :global(svg) { flex: none; color: var(--text2); }
  /* Combobox clothes: the input IS the trigger, the chevron rides inside its
     right padding so the box still promises a list. The chevron's 180° turn
     (.flip, motion.md) sits on an INNER wrapper in both modes: here because
     .combo-chev is centred by its own translateY, which must stay put. */
  .sel-combo { position: relative; display: block; width: 100%; }
  .sel-trigger.combo { display: block; padding-right: 26px; cursor: text; }
  .sel-trigger.combo::placeholder { color: var(--text2); }
  .combo-chev {
    position: absolute; right: 9px; top: 50%; transform: translateY(-50%);
    display: grid; place-items: center; pointer-events: none; color: var(--text2);
  }

  /* Same popover dialect as the Hub's menus: one menu language app-wide. */
  .sel-menu {
    position: fixed; z-index: 40; max-height: calc(46vh / var(--ui-zoom, 1)); overflow-y: auto;
    /* Visibility and the intro are the shared .pop-layer atom (app.css). */
  }
  .sel-opt.sel { color: var(--accent-ink); }
  /* An option's icon (a backend logo): sized to the text line, never stretched. */
  .so-ico { flex: none; width: 15px; height: 15px; border-radius: 3px; object-fit: contain; }
  /* An agent option's tile is the app's .ava atom as it is (board #293). */
  .so-ava { flex: none; }

  /* iOS (only) zooms a focused control below 16px. On Android this bump made
     a Select disagree with the fields beside it — and .dense (0,2,0) beat the
     old media rule anyway, so dense triggers never bumped while inputs did
     (owner, 2026-08-24: "字号还是偏大不一致"). Gate on the iOS family and
     include dense, so where the zoom exists everything bumps TOGETHER. */
  @supports (-webkit-touch-callout: none) {
    @media (any-pointer: coarse) {
      .sel-trigger, .sel-trigger.dense { font-size: var(--fs-input-touch); }
    }
  }
</style>

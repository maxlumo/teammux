<script lang="ts">
  // The app's ONE modal dialog shell (board #317, from #315's review).
  //
  // Four dialogs had copied it: ConfirmDialog owned the whole contract
  // (scrim, card, sheet, Escape, Tab trap, focus restore), AddServerDialog
  // re-typed it with a slightly different Tab selector, and
  // CreateProjectDialog and the Hub's team picker had re-typed only the
  // PAINT — so they drifted into three shapes (`--bg2` vs `--bg`, 440 vs
  // 420px, radius 18 vs `--control-dialog-radius`, z-index 30/31 vs 60/61,
  // no fade) and had NO Escape, no Tab trap and no focus restore at all.
  // That is the regression tenet 9 predicts: each copy looked reasonable
  // while it was written.
  //
  // What the shell owns: the scrim, the card and its one motion (desktop
  // fades on --t-fast — it is centred BY a transform, so a transform
  // keyframe would fight its own placement; phone rises on `sheet-up` under
  // the fading scrim), `aria-modal` with the caller's role and label, the
  // keyboard (Escape, Tab wrapping inside), and focus (in on open, back to
  // the opener on close).
  // What the caller owns: the WORDS, the content and the actions, as
  // children. The content classes (`h2`, `.dlg-note`, `.dlg-error`,
  // `.dlg-actions`) are global atoms in app.css, not scoped here: children
  // belong to the CALLER's component, so a scoped rule would never match
  // them.
  //
  // Back is NOT ours. The phone's Back is the HOST's layer order (App's
  // popstate chain, Hub's `backLayers`): a shell that consumed popstate
  // itself would race that chain and peel two layers for one gesture. Every
  // host registers its dialog there, and `oncancel` is what it calls.
  import type { Snippet } from 'svelte';
  import { activeModal } from './modal.ts';

  let {
    /** Callers mounted per opening may leave this at its default. */
    open = true,
    /** The dialog's accessible name (its visible title, as a string). */
    label,
    /** `alertdialog` for a confirmation — a decision the caller interrupted
     * the reader to get; `dialog` for a form. */
    role = 'dialog',
    /** Phone: a bottom sheet instead of a centred card. */
    compact = false,
    /** An operation is running: Escape and the scrim stop cancelling, and
     * assistive tech is told. */
    busy = false,
    /** Asked before Escape closes the dialog, because Escape is a CONSUMABLE
     * dismissal: the innermost open layer gets it first. A caller whose
     * content has its own steps (CreateProjectDialog's folder picker and its
     * new-folder field) returns true when one of them consumed the key, and
     * the dialog stays open with its draft (#317 review P1-b — the shell's
     * window-level listener used to cancel a folder name by closing the whole
     * project form). Only Escape routes through this: clicking the scrim is
     * unambiguous, and so is the × . */
    escapeGuard = () => false,
    /** Id of an element inside that describes the dialog (an error alert). */
    describedby = undefined,
    /** The card, for a caller that must move focus itself (ConfirmDialog's
     * busy transition). */
    element = $bindable(null),
    oncancel = () => {},
    children,
  }: {
    open?: boolean;
    label: string;
    role?: 'dialog' | 'alertdialog';
    compact?: boolean;
    busy?: boolean;
    escapeGuard?: () => boolean;
    describedby?: string | undefined;
    element?: HTMLDivElement | null;
    oncancel?: () => void;
    children: Snippet;
  } = $props();

  /** Everything inside that can take focus, in DOM order. */
  const FOCUSABLE = 'input:not(:disabled), button:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';
  const items = (): HTMLElement[] => [...(element?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];

  /** Focus the first thing the dialog offers. ConfirmDialog's Cancel is first
   * in DOM order on purpose: the dialog opens under the pointer of someone
   * who was just clicking things, so a stray Enter must not destroy anything. */
  export function focusDefault() {
    items()[0]?.focus({ preventScroll: true });
  }

  function cancel() {
    if (!busy) oncancel();
  }

  $effect(() => {
    const dialog = element;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement;
    // Unless the content already claimed focus (an `autofocus` field), park
    // it on the first control: the shell behind is not reachable while this
    // is up, so focus must start inside.
    if (!dialog.contains(document.activeElement)) focusDefault();
    const onKey = (e: KeyboardEvent) => {
      if (activeModal(document) !== dialog) return;   // only the top modal
      // An IME composition swallows Escape to cancel the candidate window —
      // closing the dialog on it would lose the draft with the candidates.
      if (e.key === 'Escape' && !e.isComposing) {
        // Handled either way — by the layer that consumed it or by us — so
        // nothing further acts on this key.
        e.stopPropagation(); e.preventDefault();
        if (!escapeGuard()) cancel();
      } else if (e.key === 'Tab') {
        const focusables = items();
        if (!focusables.length) { e.preventDefault(); dialog.focus(); return; }
        const index = focusables.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (index <= 0 ? focusables.length - 1 : index - 1) : (index + 1) % focusables.length;
        e.preventDefault(); focusables[next]!.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // Back to the opener — only if it is still there, and only if the
      // dialog still holds focus or nothing does. A dialog that opened over
      // ANOTHER modal returns focus to it, never past it.
      const owner = activeModal(document);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected
        && (!owner || owner === dialog || owner.contains(previousFocus))) previousFocus.focus({ preventScroll: true });
    };
  });
</script>

{#if open}
  <div class="dlg-backdrop" onclick={cancel} role="presentation"></div>
  <!-- The ROLE is the only dialog species there is: a confirmation is an
       `alertdialog`, and app.css keys its one paint difference
       (`corner-shape: round`, #161) off that attribute. No `class` prop —
       that is the door the four copies drifted through. -->
  <div class="dlg" class:sheet={compact}
    {role} aria-modal="true" aria-label={label}
    aria-describedby={describedby} aria-busy={busy || undefined}
    tabindex="-1" bind:this={element}>
    {@render children()}
  </div>
{/if}

<style>
  /* Motion (motion.md): the scrim fades in on --t-move beside the sheet; the
     desktop dialog only FADES (--t-fast) — it is centred BY a transform, so a
     transform keyframe on it would fight its own placement. */
  .dlg-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.45); animation: fade-in var(--t-move) ease-out; }
  .dlg {
    position: fixed; z-index: 61; left: 50%; top: 50%; transform: translate(-50%, -50%);
    animation: fade-in var(--t-fast) ease-out;
    /* Every vh/vw is divided by --ui-zoom: the web/Android interface scaling
       is CSS `zoom` on <html>, which scales rendered pixels but NOT viewport
       units — at zoom > 1 a raw 80vh dialog is TALLER than the screen, and
       the DirPicker's confirm button sat below the bottom edge, unreachable
       (owner 2026-08-25: "创建project选择路径，没看到确认按钮"). */
    width: min(420px, calc(100vw / var(--ui-zoom, 1) - 32px));
    max-height: calc(100vh / var(--ui-zoom, 1) - 48px); overflow-y: auto;
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--control-dialog-radius);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); padding: 18px;
    display: flex; flex-direction: column; gap: 12px;
  }
  /* Phone: a bottom sheet — reachable with a thumb, and it never fights the
     on-screen keyboard for the middle of the screen. It RISES from the bottom
     edge (sheet-up, app.css) because its resting transform is none; the
     standing `will-change: opacity` is the one sanctioned sheet hint
     (design-language §1): the Android System WebView drops the compositor
     layer when the rise ends and blinks a blank frame while it re-rasterizes,
     and opacity promotes a layer without becoming a containing block. */
  .dlg.sheet {
    left: 0; top: auto; bottom: 0; transform: none;
    width: 100%; max-width: none; border-radius: var(--control-dialog-radius) var(--control-dialog-radius) 0 0;
    border-left: none; border-right: none; border-bottom: none;
    padding: 16px 14px calc(16px + var(--sab, 0px)); /* var(--sab): env() is 0 in the APK */
    animation: sheet-up var(--t-move) ease-out;
    will-change: opacity;
  }
  @media (prefers-reduced-motion: reduce) { .dlg-backdrop, .dlg, .dlg.sheet { animation: none; } }
</style>

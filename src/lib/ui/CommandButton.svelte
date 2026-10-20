<script lang="ts">
  import Icon from './Icon.svelte';
  import { hoverInfo } from './hover.ts';

  type Props = {
    label: string;
    variant?: 'primary' | 'secondary' | 'icon' | 'danger';
    iconOnly?: boolean;
    pressed?: boolean;
    expanded?: boolean;
    /** The disclosure control STANDS INSIDE the region it discloses (the Hub
     * sidebar's collapse, board #174): the region being visible is the whole
     * signal, so the button keeps its rest look instead of the engaged wash a
     * disclosure of content elsewhere wears (the roster's). */
    inside?: boolean;
    /** No paint at all — rest, hover or press: the glyph IS the control. For
     * an icon command that stands on a surface already carrying the hover
     * (the roster card's Stop on its lit card, board #211): a wash there is a
     * second layer of the same hover. Hit box, focus ring, pending and
     * disabled are unchanged; meaningless with `primary`/solid paint. */
    bare?: boolean;
    /** The ONE circular command: the composer's Send (owner, 2026-09-20, board
     * #218: "除了 agent 自己的原型 logo，发送按钮以外，都要圆角矩形的按钮设计"). Every
     * other command — icon or text, quiet or solid — is a rounded rectangle on
     * `--ui-radius-control`. */
    round?: boolean;
    controls?: string;
    hasPopup?: 'menu' | 'dialog' | 'listbox';
    /** What the command IS, when its visible `label` is only a name or a shortened
     * form of it (the search button wearing an agent's name, board #432): the
     * accessible name and the hover card's title. The label stays the visible text. */
    title?: string;
    disabled?: boolean;
    destructiveConfirm?: boolean;
    onclick?: (event: MouseEvent) => void;
    element?: HTMLButtonElement | null;
  } & ({ pending?: false; icon?: string } | { pending: boolean; icon: string });
  let {
    label, icon = '', variant = 'secondary', iconOnly = false,
    pressed, expanded, inside = false, bare = false, round = false, controls, hasPopup, title,
    disabled = false, pending = false, destructiveConfirm = false,
    onclick = () => {}, element = $bindable(null),
  }: Props = $props();
  const compact = $derived(iconOnly || variant === 'icon');
  const solid = $derived(variant === 'primary' || (variant === 'danger' && destructiveConfirm));
  const engaged = $derived((variant === 'icon' || (variant === 'secondary' && iconOnly)) && (pressed === true || (expanded === true && !inside)));
  // A disclosure glyph turns instead of swapping (motion.md 4) — a chevron,
  // vertical for a roster, or the panel toggle of a side partition, whose
  // inner chevron alone turns (boards #174, #202; app.css .flip .turn).
  const disclosure = $derived(!pending && expanded !== undefined && (icon.startsWith('chevron-') || icon === 'panel-left'));
</script>

<button type="button" class="command-button"
  class:primary={solid} class:secondary={variant === 'secondary'}
  class:danger={variant === 'danger'} class:icon-only={compact} class:solid class:bare={bare && !solid} class:round class:pending class:engaged
  disabled={disabled || pending} aria-label={title ?? label} aria-busy={pending || undefined}
  aria-pressed={pressed} aria-expanded={expanded} aria-controls={controls} aria-haspopup={hasPopup}
  bind:this={element}
  use:hoverInfo={() => compact ? { title: title ?? label } : title ? { title } : null}
  onclick={(event) => { if (!disabled && !pending) onclick(event); }}>
  {#if icon}
    <span class="command-icon" class:spinning={pending} class:flip={disclosure} class:on={disclosure && expanded} aria-hidden="true">
      <Icon name={pending ? 'refresh' : icon} />
    </span>
  {/if}
  {#if !compact}<span class="command-label">{label}</span>{/if}
</button>

<style>
  .command-button {
    position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; gap: 8px;
    box-sizing: border-box; height: var(--control-height); min-width: var(--control-height);
    padding: 0 12px; border: 0; border-radius: var(--ui-radius-control);
    background: transparent; color: var(--text2); cursor: pointer; letter-spacing: 0;
    font: 500 var(--fs-ui)/var(--control-line-height) var(--font-display);
    transition: color var(--t-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .command-button::before {
    content: ''; position: absolute; inset: var(--control-paint-inset) 0;
    border-radius: var(--control-paint-radius); background: var(--command-paint, transparent); pointer-events: none;
    box-shadow: inset 0 0 0 100px var(--command-overlay, transparent);
    transition: background var(--t-fast), box-shadow var(--t-fast);
  }
  .secondary { --command-paint: var(--control-surface); }
  /* Buttons are rounded rectangles (board 218); the composer's Send alone stays a circle. */
  .round, .round::before { border-radius: var(--ui-radius-pill); }
  .icon-only { width: var(--control-height); padding: 0; }
  .icon-only::before { inset: var(--control-paint-inset); }
  .danger { color: var(--danger-ink); }
  .solid { --command-paint: var(--accent-fill); color: var(--accent-fill-ink); }
  .solid.danger { --command-paint: var(--danger-fill); }
  .command-button:hover:not(:disabled) { --command-paint: var(--control-hover); }
  /* Ink: quiet at rest, full on hover — the .icon-btn / rail grammar. A
     command's 2px strokes in full --text outweighed the text around them
     (owner, 2026-09-20, board 220: "这些按钮上显示的线条太黑了，甚至有点喧宾夺主…tab 上
     的文字，其实都没有那么黑"); tab --text3 < command --text2 < body --text.
     Solid, danger and engaged keep their own inks in every state. */
  .command-button:not(.solid):not(.danger):hover:not(:disabled) { color: var(--text); }
  .command-button.solid:hover:not(:disabled) {
    --command-paint: var(--accent-fill);
    --command-overlay: color-mix(in srgb, var(--control-overlay-light) 4%, transparent);
  }
  .command-button.solid.danger:hover:not(:disabled) { --command-paint: var(--danger-fill); }
  .command-button:active:not(:disabled) { --command-paint: var(--control-surface); }
  .command-button.solid:active:not(:disabled) {
    --command-paint: var(--accent-fill);
    --command-overlay: color-mix(in srgb, var(--control-overlay-dark) 6%, transparent);
  }
  .command-button.solid.danger:active:not(:disabled) { --command-paint: var(--danger-fill); }
  .command-button.bare,
  .command-button.bare:hover:not(:disabled),
  .command-button.bare:active:not(:disabled) { --command-paint: transparent; }
  .command-button.engaged,
  .command-button.engaged:hover:not(:disabled),
  .command-button.engaged:active:not(:disabled) {
    --command-paint: var(--control-surface); color: var(--accent-ink);
  }
  .command-button:disabled:not(.pending) { opacity: var(--control-disabled-opacity); cursor: default; }
  .command-button.pending { opacity: 1; cursor: progress; }
  .command-button:focus-visible { outline: none; }
  .command-button:focus-visible::before { outline: 2px solid var(--accent-ink); outline-offset: 2px; }
  .command-icon, .command-label { position: relative; z-index: 1; }
  .command-icon { display: inline-flex; width: var(--control-icon-size); height: var(--control-icon-size); flex: none; }
  .command-icon :global(svg) { width: 100%; height: 100%; }
  .command-label { white-space: nowrap; }
  .spinning { animation: spin 0.6s linear infinite; }
  @media (prefers-reduced-motion: reduce) {
    .command-button, .command-button::before { transition: none; }
    .spinning { animation: none; }
  }
</style>

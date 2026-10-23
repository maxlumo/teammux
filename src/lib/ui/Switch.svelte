<script lang="ts">
  let { checked = false, label, hideLabel = false, disabled = false, onchange }:
    { checked?: boolean; label: string; hideLabel?: boolean; disabled?: boolean; onchange: (checked: boolean) => void } = $props();
</script>

<button class="switch" class:on={checked} class:labelled={!hideLabel} type="button"
  role="switch" aria-checked={checked} aria-label={label} {disabled}
  onclick={() => { if (!disabled) onchange(!checked); }}>
  {#if !hideLabel}<span>{label}</span>{/if}
  <span class="switch-track" aria-hidden="true"></span>
</button>

<style>
  .switch {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    min-width: var(--control-height); min-height: var(--control-height); padding: 0 6px;
    background: none; border: 0; border-radius: var(--ui-radius-control);
    color: var(--text); font: 400 var(--fs-body)/var(--control-line-height) var(--font-ui);
    cursor: pointer;
  }
  .labelled { justify-content: space-between; padding-inline: 0; }
  .switch-track {
    position: relative; display: block; flex: none; width: 32px; height: 18px;
    box-sizing: border-box; border: 1px solid var(--control-border); border-radius: 9px;
    background: var(--input-bg); transition: background var(--t-fast), border-color var(--t-fast);
  }
  .switch-track::after {
    content: ''; position: absolute; top: 1px; left: 1px; width: 14px; height: 14px;
    border-radius: 50%; background: var(--text2); transition: transform var(--t-fast), background var(--t-fast);
  }
  .on .switch-track { background: var(--accent-fill); border-color: var(--accent-fill); }
  .on .switch-track::after { transform: translateX(14px); background: var(--accent-fill-ink); }
  .switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch:disabled { opacity: var(--control-disabled-opacity); cursor: default; }
  @media (prefers-reduced-motion: reduce) { .switch-track, .switch-track::after { transition: none; } }
</style>

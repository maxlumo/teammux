<!--
  Unified chip used for every "switchable thing" in the app:
  - MRU chips on the Sessions page
  - The split cell's session badge and the collapsed-state single chip in the
    Terminal top bar (the window STRIP is the shared tab strip since #365 —
    destinations are tabs; chips are toggles and switches)
  - The pane picker's chips

  One component, one visual language. All size / spacing / color are
  defined here, not in the consuming pages.

  Variants:
    variant="default" — the idle state (muted border, transparent bg)
    variant="active"  — currently selected (accent border + accent bg)
    variant="add"     — the `+ new window` ghost button (dashed border)

  Slots: takes either an agent entry (renders icon) or a `label` prop
  (renders monospace text). Agents take priority.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { Agent } from '../core/agents.ts';

  let {
    agent = null,         // Agent entry from agents.ts
    agents = [],          // Aggregated entries
    label = '',           // Monospace text fallback (command name, session name)
    variant = 'default',
    iconName = '',        // Lucide icon name, used by 'add' and collapsed chip
    chevron = '',         // Small indicator appended at end
    title = '',           // HTML title attribute; null = none (a hover card speaks instead)
    onclick = () => {},
  }: {
    agent?: Agent | null;
    agents?: { agent: Agent; count: number }[];
    label?: string;
    variant?: 'default' | 'active' | 'add';
    iconName?: string;
    chevron?: '' | 'up' | 'down';
    title?: string | null;
    onclick?: (e: MouseEvent) => void;
  } = $props();
</script>

<button
  class="chip chip-{variant}"
  title={title === null ? undefined : (title || (agents.length
    ? `${label ? `${label} · ` : ''}${agents.map(item => `${item.agent.tag}${item.count > 1 ? ` ×${item.count}` : ''}`).join(', ')}`
    : label || agent?.tag || ''))}
  onclick={(e) => onclick(e)}
>
  <span class="chip-content">
    {#if agents.length}
      <span class="chip-agents">
        {#each agents as item (item.agent.tag)}
          <img class="chip-icon" src={item.agent.icon} alt={item.agent.tag} />
        {/each}
      </span>
    {:else if agent}
      <img class="chip-icon" src={agent.icon} alt={agent.tag} />
    {:else if iconName}
      <Icon name={iconName} size={12} />
    {/if}
    {#if label}
      <span class="chip-label">{label}</span>
    {/if}
    {#if chevron}
      <!-- One glyph that turns (motion.md principle 4): down at rest, rotated
           to up — never two chevrons swapped. -->
      <span class="flip" class:on={chevron === 'up'}><Icon name="chevron-down" size={10} /></span>
    {/if}
  </span>
</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-gap);
    /* 24 px chip with line-height 1.3 leaves ~4 px slack for g/p/y
       descenders at 11 px font. Don't force line-height: 1 — glyphs clip. */
    padding: 3px 8px;
    height: var(--ui-control-height);
    border: 1px solid var(--border2);
    border-radius: var(--ui-radius-pill);
    background: var(--input-bg);
    color: var(--text2);
    font-size: var(--ui-font-control);
    font-weight: 500;
    line-height: 1.3;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    max-width: 140px;
    box-sizing: border-box;
    transition: border-color var(--t-fast), background var(--t-fast), color var(--t-fast);
    position: relative;
  }
  .chip:active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent);
  }

  .chip-active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent);
  }
  .chip-active .chip-icon { opacity: 1; }

  .chip-add {
    background: transparent;
    border-style: dashed;
    color: var(--text3);
    padding: 3px 9px;
  }
  .chip-add:active {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-bg);
  }

  .chip-content {
    display: inline-flex;
    align-items: center;
    gap: var(--ui-gap);
    min-width: 0;
    transform: translateY(1px);
  }

  .chip-icon {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    opacity: 0.85;
    transition: opacity var(--t-fast);
  }
  .chip-agents { display: inline-flex; align-items: center; gap: 3px; overflow: visible; }

  .chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--font-ui);
  }
</style>

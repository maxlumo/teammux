<script lang="ts">
  // The ONE list of saved servers (board 315): the rail/phone switcher popover
  // and Settings › Connection render this same component, so a row's state,
  // its actions and their keyboard/IME contract cannot drift between the two
  // (one mechanism per job). Popover vs page is the caller's layout only.
  //
  // It is a non-modal PICKER, not an action menu (#165): native Tab order, a
  // click on a row switches at once, rename is its own sibling command, and
  // removing a saved server goes through the shared ConfirmDialog.
  import { tick } from 'svelte';
  import Icon from '../ui/Icon.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import { activeModal } from '../ui/modal.ts';
  import { t } from '../core/i18n.svelte.ts';
  import type { ServerEntry } from './servers.ts';
  import type { MemberStatus } from './server-members.svelte.ts';
  import Switch from '../ui/Switch.svelte';
  import { stateDotColor } from '../hub/hub.ts';

  interface Props {
    servers: ServerEntry[];
    /** The CONFIRMED current server (authenticated). Only it wears aria-current. */
    currentId: string;
    /** Connection state, one input for both hosts (board 315): `connected`
     * says whether the current entry's socket is up; `target` is a switch in
     * progress (pending) or failed. aria-current never stands in for it. */
    link?: { connected: boolean; target?: { id: string; failed: boolean } | null };
    /** 'menu' inside the switcher popover; 'page' inside Settings › Connection. */
    variant?: 'menu' | 'page';
    onpick: (id: string) => void;
    onrename: (id: string, name: string) => void;
    onremove: (id: string) => void;
    onadd: () => void;
    /** A deferred close (asked while an IME composition was still open). */
    onclose?: () => void;
    /** The element focus returns to after a rename/remove (the popover or page). */
    container?: HTMLElement | null;
    /** Why the saved servers cannot be edited right now (board #335 ②b-4:
     * the boot migration is blocked and the registry frozen). Non-empty: it
     * is shown, and rename and remove are disabled — a refusal with its
     * reason, never a silent no-op. */
    frozen?: string;
    /** Aggregate (board #335 ③b-3): every row carries its include switch and
     * its member status; picking a name moves the focus. Null in Single. */
    members?: {
      included: (id: string) => boolean;
      status: (id: string) => MemberStatus | null;
      /** A refusal comes back as `notice`, with its reason. */
      ontoggle: (id: string, included: boolean) => void;
      /** Trees kept after their server's identity went (absorbed into
       * `into`, or reaching it): detached, drafts still in them. Dismiss asks
       * that tree, then lets it go. */
      orphans: { id: string; name: string; into: string }[];
      ondismiss: (id: string) => void;
    } | null;
    /** A refusal to show on the list (an include/exclude that failed). */
    notice?: string;
  }
  let {
    servers, currentId, link = { connected: true }, variant = 'menu',
    onpick, onrename, onremove, onadd, onclose = () => {}, container = null, frozen = '',
    members = null, notice = '',
  }: Props = $props();

  /** The one status-dot language (stateDotColor / .live-dot): the server
   * being reached breathes, a failed one is danger, the connected current is
   * accent, everything else rests achromatic. */
  type Dot = 'live' | 'pending' | 'failed' | 'rest';
  function dotOf(id: string): Dot {
    if (link.target?.id === id) return link.target.failed ? 'failed' : 'pending';
    if (id === currentId && link.connected && !link.target) return 'live';
    // A background member wears its own derived status (③b-3).
    const st = id !== currentId ? members?.status(id) : null;
    if (st?.kind === 'connected') return 'live';
    if (st?.kind === 'connecting' || st?.kind === 'reconnecting') return 'pending';
    if (st?.kind === 'failed' || st?.kind === 'orphan') return 'failed';
    return 'rest';
  }
  /** Why a member is failing, where the address line can say it. */
  function failure(id: string): string {
    const st = id !== currentId ? members?.status(id) : null;
    if (st?.kind !== 'failed') return '';
    if (st.reason === 'elsewhere') return t('memberElsewhere').replace('{name}', st.detail ?? '');
    return t(st.reason === 'storage' ? 'memberStorage' : 'memberUnreachable');
  }
  const DOT_COLOR: Record<Dot, string> = {
    live: 'var(--accent)', pending: stateDotColor('running'), failed: stateDotColor('failed'), rest: stateDotColor('idle'),
  };

  let renaming = $state('');   // entry id whose name is an input
  let draft = $state('');
  let composing: { id: string; input: HTMLInputElement } | null = null;
  let trigger: HTMLElement | null = null;
  let pending: { id: string; close: boolean } | null = null;

  async function restoreFocus(target: HTMLElement | null) {
    const root = container;
    await tick();
    if (!root?.isConnected || activeModal(document)) return;
    if (document.activeElement !== document.body && !root.contains(document.activeElement)) return;
    (target?.isConnected ? target : root).focus({ preventScroll: true });
  }

  /** Commit any open rename. Returns false when an IME composition is still
   * open: the final native value has not landed, so the caller's close waits
   * for compositionend (which calls onclose). */
  export function finish(close = false): boolean {
    if (composing) {
      pending = { id: renaming, close: pending?.close || close };
      return false;
    }
    commit();
    renaming = '';
    trigger = null;
    pending = null;
    return true;
  }
  /** Drop an open rename without saving (Escape). */
  export function cancelRename(): boolean {
    if (!renaming) return false;
    const back = trigger;
    renaming = '';
    composing = null;
    trigger = null;
    pending = null;
    void restoreFocus(back);
    return true;
  }
  export function isComposing() { return !!composing; }

  function start(s: ServerEntry, el: HTMLElement) {
    trigger = el;
    composing = null;
    pending = null;
    renaming = s.id;
    draft = s.name;
  }
  function commit() {
    if (composing) {
      pending ??= { id: renaming, close: false };
      return;
    }
    const id = renaming;
    const request = pending;
    if (id) onrename(id, draft);
    renaming = '';
    trigger = null;
    pending = null;
    if (request && request.id === id && request.close) onclose();
  }
  function key(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229 || composing) return;
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const back = trigger;
      commit();
      void restoreFocus(back);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }
  function compositionStart(e: CompositionEvent) {
    composing = { id: renaming, input: e.currentTarget as HTMLInputElement };
  }
  async function compositionEnd(e: CompositionEvent) {
    const composition = composing;
    if (!composition || composition.input !== e.currentTarget) return;
    await tick(); // Keep every commit entry gated until the final native input lands.
    if (composing !== composition || composition.id !== renaming || !composition.input.isConnected) return;
    draft = composition.input.value;
    composing = null;
    const request = pending;
    if (request && request.id === renaming) {
      if (request.close) { finish(); onclose(); }
      else commit();
    }
  }
  /** svelte action: focus + select the rename input the moment it mounts. */
  function focusOnMount(el: HTMLInputElement) {
    el.focus();
    el.select?.();
  }

  /** Removing is DESTRUCTIVE (config + parked state gone), so it asks. The
   * row's IDENTITY is captured at click time: a list that switched, refreshed
   * or closed underneath cannot retarget the delete. */
  let victim = $state<{ id: string; name: string } | null>(null);
  function confirmRemove() {
    const v = victim;
    victim = null;
    if (!v) return;
    onremove(v.id);
    void restoreFocus(null);
  }
</script>

<div class="server-list" class:page={variant === 'page'}>
  {#if frozen}<small class="config-error appear" role="alert">{frozen}</small>{/if}
  {#if notice && !frozen}<small class="config-error appear" role="alert">{notice}</small>{/if}
  {#each servers as s (s.id)}
    {@const cur = s.id === currentId}
    <div class="sm-row" class:cur>
      {#if renaming === s.id}
        <input class="sm-rename config-input" bind:value={draft} use:focusOnMount
          aria-label={`${t('serverRename')} ${s.name}`}
          onkeydown={key}
          oncompositionstart={compositionStart}
          oncompositionend={compositionEnd}
          onblur={commit} />
      {:else}
        <button class="sm-pick menu-item" type="button" title={s.address} aria-current={cur ? 'true' : undefined}
          aria-busy={dotOf(s.id) === 'pending' ? 'true' : undefined}
          onclick={() => onpick(s.id)}>
          <span class="sm-line">
            <span class="sm-dot" class:live-dot={dotOf(s.id) === 'pending'} style:background={DOT_COLOR[dotOf(s.id)]} aria-hidden="true"></span>
            <span class="sm-name">{s.name}</span>
          </span>
          <span class="sm-addr">{s.address}{#if failure(s.id)} · {failure(s.id)}{/if}</span>
        </button>
      {/if}
      {#if members}
        {@const on = members.included(s.id)}
        <Switch hideLabel checked={on} label={t('serverInclude').replace('{name}', s.name)}
          disabled={!!frozen}
          onchange={(next) => members?.ontoggle(s.id, next)} />
      {/if}
      <CommandButton variant="icon" icon="edit" label={`${t('serverRename')} ${s.name}`}
        disabled={renaming === s.id || !!frozen} onclick={(e: MouseEvent) => { e.stopPropagation(); start(s, e.currentTarget as HTMLElement); }} />
      {#if cur}
        <span class="sm-check" title={t('serverCurrent')}><Icon name="check" size={13} /></span>
      {:else}
        <CommandButton variant="danger" iconOnly icon="x" label={`${t('serverRemove')} ${s.name}`} disabled={!!frozen}
          onclick={(e: MouseEvent) => { e.stopPropagation(); victim = { id: s.id, name: s.name }; }} />
      {/if}
    </div>
  {/each}
  {#each members?.orphans ?? [] as o (o.id)}
    <!-- A tree whose server is gone (③b, P1-5): named, with where its
         identity went, and the one way on — Dismiss, which asks it first. -->
    <div class="sm-row orphan">
      <div class="sm-pick menu-item sm-static" aria-disabled="true">
        <span class="sm-line">
          <span class="sm-dot" style:background={DOT_COLOR.failed} aria-hidden="true"></span>
          <span class="sm-name">{o.name}</span>
        </span>
        <span class="sm-addr">{o.into ? t('memberElsewhere').replace('{name}', o.into) : t('memberAbsorbed')}</span>
      </div>
      <CommandButton variant="danger" iconOnly icon="x" label={`${t('memberDismiss')} ${o.name}`} disabled={!!frozen}
        onclick={(e: MouseEvent) => { e.stopPropagation(); members?.ondismiss(o.id); }} />
    </div>
  {/each}
  <button class="sm-add menu-item" type="button" onclick={onadd}><Icon name="plus" size={13} /><span>{t('serverAdd')}</span></button>
</div>

<!-- Forgetting a saved server (board #55): the shared confirmation, danger
     tone — the entry, its token and its parked view state are gone for good;
     the machine itself is untouched. -->
<ConfirmDialog open={!!victim}
  confirmIcon="trash"
  title={victim ? t('serverRemoveTitle').replace('{name}', victim.name) : ''}
  note={t('serverRemoveNote')}
  confirmLabel={t('serverRemove')}
  onconfirm={confirmRemove} oncancel={() => (victim = null)} />

<style>
  /* Two-line rows; shared atoms (menu-item, CommandButton, live-dot) own paint. */
  .server-list { display: flex; flex-direction: column; min-width: 0; }
  .sm-row {
    --menu-row-height: calc(2 * var(--control-line-height) + 2 * var(--menu-item-padding-y));
    display: flex; align-items: center; gap: var(--menu-gap); min-width: 0;
    min-height: var(--menu-row-height); flex: none;
  }
  .sm-pick {
    flex: 1; min-width: 0; flex-direction: column; align-items: flex-start; gap: 0;
  }
  .sm-line { display: flex; align-items: center; gap: var(--menu-gap); min-width: 0; max-width: 100%; }
  /* The address list's dot (Preferences .addr-dot): one size for one cue. */
  .sm-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; transition: background var(--t-fast); }
  .sm-name { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sm-addr { font-family: var(--font-mono); font-size: var(--fs-meta); line-height: var(--control-line-height); color: var(--text2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sm-row.cur .sm-name { color: var(--accent-ink); }
  .sm-check { color: var(--accent-ink); display: grid; place-items: center; width: var(--control-height); flex: none; }
  .sm-rename { flex: 1; min-width: 0; }
  .sm-static { cursor: default; }
  .sm-add { border-top: 1px solid var(--border); margin-top: var(--menu-gap); }
</style>

<script lang="ts">
  // The connection FIELDS (address with its suggestions, token, tmux socket),
  // shared by the disconnected connect page and the Add server dialog (board
  // 315), so the two ways to name a server cannot drift: one field set, one
  // list. The list is the saved servers' addresses, read off the registry
  // (board #400) — there is no list of its own to forget from: a server is
  // forgotten in Settings › Connection, and then it is gone from here. (The
  // `hist-` class names are from the list's earlier life.)
  import { untrack } from 'svelte';
  import Icon from '../ui/Icon.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { rememberedAddresses, type Suggestion } from './servers.ts';
  import { isBulkInsert, parseConnectionLink } from '../core/connection-link.ts';

  let {
    address = $bindable(''), token = $bindable(''), socket = $bindable(''),
    onpick,
    /** Focus the address field when mounted (the dialog). */
    autofocus = false,
    onenter = () => {},
  }: {
    address?: string; token?: string; socket?: string;
    /** A suggestion is about to be applied (the whole saved tuple is passed):
     * the parent clears what must not follow it, BEFORE the fields change.
     * The tuple's three values then replace the fields' — a socket included, so
     * the previous server's never rides along. The parent may return the one
     * thing that survives: `{ socket }`, the local gateway's own auto-filled
     * socket when the saved entry has none. */
    onpick?: (pick: Suggestion) => { socket: string } | void;
    autofocus?: boolean; onenter?: () => void;
  } = $props();

  let showToken = $state(false);
  let showHistory = $state(false);
  // Read when the form mounts and again each time the list opens, so a form
  // held across another page never offers what that page deleted.
  let remembered = $state(rememberedAddresses(localStorage));
  function toggleList() {
    if (!showHistory) remembered = rememberedAddresses(localStorage);
    showHistory = !showHistory;
  }

  function pick(row: Suggestion) {
    const keep = onpick?.(row);
    address = row.address;
    token = row.token;
    socket = keep?.socket ?? row.socket;
    showHistory = false;
    linkError = '';
    settled = row.address;          // the last ACCEPTED address moves with the tuple it belongs to
  }

  let field = $state<HTMLInputElement>();
  /** The last ACCEPTED address: where the field started, or the address of the
   * last pick or usable link, or the last plain edit that was committed. What a
   * link that cannot be used (and was typed, not pasted) is replaced with —
   * moved by every accepted tuple, so a rejection never restores an address
   * that belongs to an earlier server than the token and socket beside it. */
  let settled = untrack(() => address);
  /** Why the last link was refused. Credential-free by construction: it names
   * the problem, never the text. */
  let linkError = $state('');

  /** A text that is a connection LINK (lib/core/connection-link.ts, the new
   * form or the old front-end one) is the connection itself: it is split at
   * once into address, token and socket, exactly as a pick of a saved server
   * applies its tuple, and the field keeps only the address — the token never
   * stays in plain view. A recognised link that cannot be used (it names no
   * server, or its credentials are ambiguous) is never left in the field: the
   * field goes back to `fallback`, the other fields stay as they are, and
   * `linkError` says why. Anything else is just an address. Returns false for
   * "not a link", so the caller keeps the text. */
  function absorb(input: HTMLInputElement, fallback: string): boolean {
    const parsed = parseConnectionLink(input.value);
    if (parsed.kind === 'none') return false;
    if (parsed.kind === 'link') {
      pick({ address: parsed.link.address, token: parsed.link.token ?? '', socket: parsed.link.socket ?? '' });
      input.value = address;        // `address` may not have changed, and the DOM still holds the link
    } else {
      address = fallback;
      input.value = fallback;
      linkError = t(parsed.reason === 'no-address' ? 'linkNoAddress' : parsed.reason === 'ambiguous' ? 'linkAmbiguous' : parsed.reason === 'hidden' ? 'linkHidden' : 'linkAddressCredential');
    }
    return true;
  }

  /** The address field. Typing stays plain editable text; a link is split
   * only where a whole text arrives at once (a paste, a drop, a keyboard
   * committing a clipboard suggestion) or the field is committed. */
  function typed(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    linkError = '';
    if (isBulkInsert(e as InputEvent) && absorb(input, address)) return;
    address = input.value;
  }

  /** THE gate of every action that submits the form (Enter, the Connect button,
   * the Add server submit, an assistive or programmatic activation): the parents
   * call it before they read a field. A link typed out in full is split now
   * (or refused, and taken out of the field); and while a refusal is pending —
   * its message is showing and nothing was edited or picked since — nothing is
   * submitted, so a rejected input can never make the form act on the value it
   * was restored to. True when the form may go ahead. */
  export function commit(): boolean {
    if (!field) return true;
    if (linkError) return false;
    if (absorb(field, settled)) return !linkError;
    settled = address;
    return true;
  }

  function focusIf(el: HTMLInputElement) { if (autofocus) el.focus(); }
  function enter(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (commit()) onenter();
  }
</script>

<div class="fields">
  <label>
    <span class="label-text">{t('address')}</span>
    <div class="addr-wrap">
      <input type="text" bind:this={field} value={address} oninput={typed} onchange={() => { commit(); }} onfocus={() => { settled = address; }} placeholder="ws://host:port" autocapitalize="off" autocomplete="off" use:focusIf onkeydown={enter} />
      {#if remembered.length}
        <button class="hist-btn" class:open={showHistory} aria-expanded={showHistory}
          onclick={toggleList}><span class="flip" class:on={showHistory}><Icon name="arrow-down" size={13} /></span></button>
      {/if}
    </div>
    {#if linkError}<div class="config-error appear" role="alert">{linkError}</div>{/if}
    {#if showHistory && remembered.length}
      <div class="hist-list appear-rise">
        {#each remembered as h (h.address)}
          <div class="hist-row">
            <button class="hist-item" onclick={() => pick(h)}>{h.address}</button>
          </div>
        {/each}
      </div>
    {/if}
  </label>

  <label>
    <span class="label-text">{t('token')}</span>
    <div class="token-wrap">
      <span class="token-icon"><Icon name="key" size={13} /></span>
      <input type={showToken ? 'text' : 'password'} bind:value={token} placeholder="auth token" onkeydown={enter} />
      <button class="eye-btn" type="button" onclick={() => showToken = !showToken}>
        <Icon name={showToken ? 'eye-off' : 'eye'} size={14} />
      </button>
    </div>
  </label>

  <label>
    <span class="label-text">{t('tmuxSocket')} <span style="font-weight:400;text-transform:none;letter-spacing:0">{t('tmuxSocketHint')}</span></span>
    <input type="text" bind:value={socket} placeholder="/tmp/tmux-1000/default" autocapitalize="off" autocomplete="off" onkeydown={enter} />
  </label>
</div>

<style>
  .fields {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .addr-wrap { position: relative; }
  .addr-wrap input { padding-right: 36px; }
  /* Centred BY a transform, so the arrow's 180° turn lives on the inner .flip
     wrapper, never on the button (motion.md: a resting transform is not a
     thing to animate over). */
  .hist-btn {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--text3); cursor: pointer;
    padding: 4px; display: flex; -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast);
  }
  .hist-btn:active { color: var(--accent); }
  .hist-list {
    display: flex; flex-direction: column;
    border: 1px solid var(--input-border); border-radius: var(--ui-radius-control);
    overflow: hidden; margin-top: 2px;
  }
  .hist-row {
    display: flex; align-items: center;
    border-bottom: 1px solid var(--border2); min-width: 0;
  }
  .hist-row:last-child { border-bottom: none; }
  .hist-item {
    flex: 1; min-width: 0; padding: 9px 14px; border: none; background: none;
    color: var(--text); font-size: var(--fs-body); text-align: left; cursor: pointer;
    font-family: var(--font-mono);
    -webkit-tap-highlight-color: transparent;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    transition: background var(--t-fast), color var(--t-fast);
  }
  .hist-item:active { background: var(--accent-bg); color: var(--accent); }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .label-text {
    font-size: var(--fs-sub);
    font-weight: 500;
    color: var(--text3);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid var(--input-border);
    border-radius: var(--ui-radius-control);
    background: var(--input-bg);
    color: var(--text);
    /* The iOS no-auto-zoom threshold; see --fs-input-touch in app.css. */
    font-size: var(--fs-input-touch);
    outline: none;
    transition: border-color var(--t-fast) ease, background var(--t-fast) ease, box-shadow var(--t-fast) ease;
    -webkit-appearance: none;
    appearance: none;
  }
  input:focus {
    border-color: var(--accent);
    background: var(--accent-bg);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  input::placeholder { color: var(--text3); }

  .token-wrap {
    position: relative;
  }
  .token-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: var(--fs-body);
    pointer-events: none;
  }
  .token-wrap input { padding-left: 36px; padding-right: 36px; }
  .eye-btn {
    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
    background: none; border: none; color: var(--text3); cursor: pointer;
    padding: 4px; display: flex; -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast);
  }
  .eye-btn:active { color: var(--accent); }
  /* The press scale rides the inner svg: the button's own transform is its
     vertical centring and must not be animated over. */
  .eye-btn :global(svg) { transition: transform var(--t-fast); }
  .eye-btn:active :global(svg) { transform: scale(0.9); }
</style>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { connect, disconnect, getMachineId, setSocket } from '../core/ws.ts';
  import { defaultConnectionAddress, dropAutofilled, hostedByGateway, localAutofill, normalizeAddress as normalizeAddressFor, type Autofilled, type LocalConfig } from '../core/connection-address.ts';
  import { isAndroid, isTauriDesktop, tauriReady } from '../core/platform.ts';
  import { localServerLine, localServer } from './server-mode.svelte.ts';
  import { activateConnected } from './servers.ts';
  import Icon from '../ui/Icon.svelte';
  import ConnectFields from './ConnectFields.svelte';
  import { copyText } from '../core/clipboard.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { createFeedbackLifetime, type FeedbackValue } from '../ui/feedback-lifetime.ts';

  type HistoryEntry = { address: string; token: string };

  /** What a connect attempt established about the peer on the other end
   * (board #335 ②b-1): the host's handle may only resume on one of the two
   * conclusions that leave it still serving its own server. */
  type ConnectOutcome = 'same-server' | 'other-server' | 'no-peer' | 'unresolved';

  /** The host's handover for ONE attempt. `current()` is what makes a late
   * attempt harmless across instances — this form can be unmounted mid-dial
   * and a new one started, and the old dial must then write no identity, bring
   * nothing up and conclude nothing. */
  type ConnectHandover = { current(): boolean; settle(outcome: ConnectOutcome): void };

  let {
    onConnected,
    beforeConnect,
  }: {
    onConnected: (switched: boolean) => void;
    /**
     * Called once, before this form re-dials the shared socket (board #335
     * ②b-1, reviewer P1-b).
     *
     * This form can reach a DIFFERENT server than the one the app is on, and
     * through ②b every page is talking over the same connection object. So
     * the host gets to put the current server's handle aside FIRST: after the
     * socket points elsewhere, a call still in flight from the old tree — or
     * a callback that settles before the new tree mounts — would be the old
     * server's work sent to the new one.
     *
     * It may return a function that takes what this attempt CONCLUDED, and
     * the conclusion is the point: nobody knows until the peer authenticates
     * whether this address is the same server (the ordinary reconnect, where
     * the host keeps its handle and remounts nothing), another one, or a
     * stranger whose identity could not be established. "The function reached
     * its finally" is not a conclusion — reporting that would hand the old
     * server's pages to a peer nobody has identified.
     *
     * Optional, because Settings is a person-level surface that also renders
     * with no server at all.
     */
    beforeConnect?: (() => ConnectHandover | void) | undefined;
  } = $props();

  // The fields as the page opens: the state starts from them, and the
  // desktop autofill compares against them to tell a person's edit.
  const opened = {
    address: localStorage.getItem('tmux_address') || defaultConnectionAddress(location, import.meta.env.DEV, hostedByGateway(document)),
    token: localStorage.getItem('tmux_token') || '',
    socket: localStorage.getItem('tmux_socket') || '',
  };
  let address = $state(opened.address);
  let token = $state(opened.token);
  let socket = $state(opened.socket);
  let error = $state('');
  let connecting = $state(false);

  let history = $state<HistoryEntry[]>((() => {
    const raw = JSON.parse(localStorage.getItem('tmux_address_history') || '[]');
    // Migrate: old format was string[], new is {address, token}[]
    return raw.map((h: string | HistoryEntry) => typeof h === 'string' ? { address: h, token: '' } : h);
  })());

  // Migrate old host+port (one-time)
  const oldHost = localStorage.getItem('tmux_host');
  if (oldHost) {
    const oldPort = localStorage.getItem('tmux_port');
    address = `ws://${oldHost}:${oldPort || '9899'}`;
    localStorage.removeItem('tmux_host');
    localStorage.removeItem('tmux_port');
  }

  // Desktop app only: fill from THIS machine's config what nothing saved
  // and the person has not touched while the config was being read (board
  // #323). The address is the same `local_url` the gateway probe dials. A
  // migrated old host/port above counts as the person's choice, so it stays.
  if (!isAndroid && isTauriDesktop) {
    const saved = { address: localStorage.getItem('tmux_address'), token: localStorage.getItem('tmux_token'), socket: localStorage.getItem('tmux_socket') };
    tauriReady
      .then(() => window.__TAURI__?.core.invoke('get_local_config'))
      .then((cfg: LocalConfig | undefined) => {
        if (!cfg) return;
        const fill = localAutofill(saved, opened, { address, token, socket }, cfg);
        if (fill.address !== undefined) address = fill.address;
        if (fill.token !== undefined) token = fill.token;
        if (fill.socket !== undefined) socket = fill.socket;
        if ((fill.token !== undefined || fill.socket !== undefined) && cfg.url) autofilled = { address: cfg.url, token: fill.token, socket: fill.socket };
      })
      .catch(() => {});
  }

  // This computer's server, when the desktop app did not get one (board
  // #323): occupied or failed. Disconnected there is no rail, so the reason
  // has to be readable here.
  // Follows every transition: a `starting` that turns `failed` shows its
  // reason without reopening the page.
  if (!isAndroid && isTauriDesktop) localServer.start(tauriReady, () => window.__TAURI__ as never);
  const localTrouble = $derived(localServer.mode && (localServer.mode.mode === 'occupied' || localServer.mode.mode === 'failed') ? localServerLine(localServer.mode, t) : null);

  // Local credentials the autofill put in, and the local address they are
  // for: they never follow the address to another server.
  let autofilled = $state<Autofilled | null>(null);
  /** A history pick: drop the still-untouched auto values that would not
   * belong to the picked target (the socket included — history entries
   * carry none) and forget their record, then the entry's address and
   * token apply. Picking the local gateway keeps its socket, still tracked. */
  function pickHistory(next: string) {
    const { clear, keep } = dropAutofilled(autofilled, { address: next, token, socket });
    if (clear.socket !== undefined) socket = clear.socket;
    // Still the local gateway: the socket stays auto-filled (so it leaves if
    // the address later moves away); the entry's token is the person's.
    autofilled = keep ? { ...keep, token: undefined } : null;
  }
  $effect(() => {
    const { clear, keep } = dropAutofilled(autofilled, { address, token, socket });
    if (clear.token !== undefined) token = clear.token;
    if (clear.socket !== undefined) socket = clear.socket;
    if (keep !== autofilled) autofilled = keep;
  });

  const normalizeAddress = (addr: string) => normalizeAddressFor(addr, location.protocol);

  function saveHistory(addr: string, tok: string) {
    const entry = { address: addr.trim(), token: tok || '' };
    history = [entry, ...history.filter(h => h.address !== entry.address)].slice(0, 8);
    localStorage.setItem('tmux_address_history', JSON.stringify(history));
  }

  let cancelled = false;
  /** Attempts started by THIS instance. Only the latest may conclude: a
   * superseded one must not write the registry, call `onConnected` or report a
   * handover conclusion, exactly as a superseded dial must not record its
   * result (board #335 ②b-1, reviewer 2026-10-10). */
  let attempts = 0;
  /** And an attempt dies with the component. The host's ticket cannot cover
   * this one: a re-dial that does NOT go through a handover — the Connection
   * page's address rows, the periodic optimizer — leaves the host's handover
   * current, so a dial started by a form the reader has since left would
   * still look live and could disconnect or write identity over the socket
   * that re-dial now owns (orchestrator's ruling, 2026-10-10). */
  let mounted = true;
  onDestroy(() => { mounted = false; });

  async function doConnect() {
    error = '';
    connecting = true;
    cancelled = false;
    const attempt = ++attempts;
    // Mine AND still the app's: the instance counter orders this form's own
    // attempts, the host's handover says whether the app is still waiting on
    // this one at all.
    const live = () => mounted && attempt === attempts && !cancelled && (handover?.current() ?? true);
    // The handover of the shared socket: the host puts its current server's
    // handle aside before the dial, and this attempt reports what it
    // ESTABLISHED about the peer. Suspending rather than revoking is what
    // keeps an ordinary reconnect to the SAME server from remounting every
    // page; reporting a conclusion rather than completion is what keeps the
    // old server's pages off an unidentified peer.
    const handover = beforeConnect?.() as ConnectHandover | void;
    try {
      // FROZEN at the start of the attempt, and used for everything after:
      // the fields are live inputs a reader can keep typing into, and an
      // identity write that re-read them would record a server nobody dialled
      // (orchestrator's ruling, 2026-10-10).
      const url = normalizeAddress(address);
      const tok = token;
      const sock = socket.trim();
      localStorage.setItem('tmux_address', url);
      localStorage.setItem('tmux_token', tok);
      if (sock) localStorage.setItem('tmux_socket', sock);
      else localStorage.removeItem('tmux_socket');
      saveHistory(url, tok);
      await connect(url, tok);
      // A superseded, cancelled or unmounted attempt owns nothing from here
      // on: not the registry, not `onConnected`, and not the handover.
      if (!live()) return;
      if (sock) await setSocket(sock).catch(() => {});
      // Checked again here, after the awaits above and with NO await between
      // this and the first identity write: a newer handover may have taken
      // over while `connect` or `setSocket` resolved, and the transport is
      // imported statically precisely so nothing can resolve in between
      // (reviewer, 2026-10-10).
      if (!live()) return;
      // Save machine_id → address mapping
      try {
        const mid = getMachineId?.();
        if (mid) {
          const map = JSON.parse(localStorage.getItem('tmux_machines') || '{}');
          const addrs = map[mid] || [];
          if (!addrs.includes(url)) addrs.push(url);
          map[mid] = addrs.slice(-8);
          localStorage.setItem('tmux_machines', JSON.stringify(map));
          // The LIVE tmux_machine_id is deliberately NOT written here:
          // activateConnected owns that key. A pre-write would poison the
          // park on the different-server path — parkAndPoint would file the
          // NEW machine's id under the OLD server's parking slot (lead
          // blocker #2, board #55). The map above is safe: it is keyed by
          // machineId and never read through the live key.
        }
        // The multi-server registry (board #55): a successful connect RECORDS
        // by machine identity and then asks whether this was a different
        // server. Same machine (a LAN/Tailscale alternate) — nothing to
        // activate, the socket swap was the whole event. A DIFFERENT server —
        // the old one's live state is parked under its id and App brings the
        // app up on this one with the content tree remounted and every
        // per-server memory reset (board 315, no reload). The mirror keys
        // already point here — this form wrote them before dialing.
        const act = activateConnected(localStorage, {
          address: url, token: tok,
          ...(sock ? { socket: sock } : {}),
          ...(mid ? { machineId: mid } : {}),
        });
        if (!live()) return;
        if (act.reload) {
          // A different server authenticated: the old handle is terminal.
          handover?.settle('other-server');
          onConnected(true);
          return;
        }
      } catch {
        // A peer DID authenticate and we could not establish which server it
        // is (the registry write failed). Treating that as a same-server
        // success is what would resume the old server's handle onto it, so it
        // is an error and the handle keeps refusing.
        if (live()) {
          handover?.settle('unresolved');
          error = t('configIdentityFailed');
          disconnect();
        }
        return;
      }
      handover?.settle('same-server');
      onConnected(false);
    } catch (e) {
      if (!live()) return;
      // The dial never reached an authenticated peer, so there is no stranger
      // on the socket to be confused with this server.
      handover?.settle('no-peer');
      error = (e as Error).message;
    } finally {
      if (live()) connecting = false;
    }
  }

  function cancelConnect() {
    cancelled = true;
    connecting = false;
    disconnect();
  }

  // Build a deep link that pre-fills + auto-connects (consumed by App.svelte's
  // consumeConnectUrlParams). Includes the token so the link connects on its own.
  let shareFeedback = $state<FeedbackValue | null>(null);
  const shareLifetime = createFeedbackLifetime(value => { shareFeedback = value; });
  const shareContext = $derived({ address, token, socket });
  $effect(() => { void shareContext; shareLifetime.clear(); });
  onDestroy(() => shareLifetime.dispose());
  function buildShareUrl() {
    const url = normalizeAddress(address);
    const params = new URLSearchParams();
    params.set('addr', url);
    if (token) params.set('token', token);
    if (socket.trim()) params.set('socket', socket.trim());
    return `${location.origin}${location.pathname}?${params.toString()}`;
  }
  async function shareLink() {
    const attempt = shareLifetime.begin();
    const context = shareContext;
    const link = buildShareUrl();
    const copied = await copyText(link);
    if (!shareLifetime.current(attempt) || context !== shareContext) return;
    shareLifetime.update(attempt, copied
      ? { kind: 'success', message: t('linkCopied') }
      : { kind: 'error', message: t('copyFailed') });
  }
</script>

<div class="wrapper">
  <div class="card">
    <div class="card-header">
      <div class="icon"><img class="icon-dark" src="/assets/icon-dark.svg" alt="" width="72" height="72" /><img class="icon-light" src="/assets/icon-light.svg" alt="" width="72" height="72" /></div>
      <h2>tmux<span class="accent">mobile</span></h2>
      <p class="subtitle">{t('connectTitle')}</p>
    </div>

    <ConnectFields bind:address bind:token bind:socket bind:history onpick={pickHistory} onenter={() => { if (address && !connecting) doConnect(); }} />

    {#if error}
      <div class="error appear">{error}</div>
    {/if}
    {#if localTrouble}
      <div class="config-note" role="status">{localTrouble.label}: {localTrouble.value}</div>
    {/if}

    {#if connecting}
      <div class="connect-row">
        <button class="connect-btn connecting" disabled>
          <span class="spinner"></span> {t('connecting')}
        </button>
        <button class="cancel-btn" onclick={cancelConnect}>{t('cancel')}</button>
      </div>
    {:else}
      <button class="connect-btn" onclick={doConnect} disabled={!address}>
        {t('connect')}
      </button>
    {/if}

    {#if shareFeedback?.kind === 'error'}
      <div class="config-error" role="alert">{shareFeedback.message}</div>
    {/if}
    <button class="share-btn" onclick={shareLink} disabled={!address} title={t('shareLink')}>
      <Icon name="copy" size={13} /> {shareFeedback?.kind === 'success' ? shareFeedback.message : t('shareLink')}
    </button>

    <a class="about-link" href="https://github.com/vokako/tmux-mobile" target="_blank" rel="noopener">
      {t('about')}
    </a>
  </div>
</div>

<style>
  .wrapper {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }

  .card {
    width: 100%;
    max-width: 380px;
    /* A raised surface, never canvas-on-canvas (owner, 2026-09-05: "第一次
       启动的时候，选项的卡片后面没有阴影"): the card used to paint var(--bg)
       on the var(--bg) page, and dark mode's black drop shadow is invisible
       on the near-black canvas — elevation there comes from the surface
       lift every other card wears. The shadow stays for light, where it
       reads. */
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px 24px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
  }

  .card-header {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  .icon {
    font-size: var(--fs-hero);
    color: var(--accent);
    filter: drop-shadow(0 0 12px var(--accent-glow));
    margin-bottom: 4px;
  }
  .icon-light { display: none; }
  :global(html[data-theme="light"]) .icon-dark { display: none; }
  :global(html[data-theme="light"]) .icon-light { display: inline; }

  h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--fs-display);
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.5px;
  }
  .accent { color: var(--accent); }

  .subtitle {
    margin: 0;
    font-size: var(--fs-ui);
    color: var(--text3);
  }

  .connect-btn {
    width: 100%;
    padding: 13px;
    border: none;
    border-radius: var(--ui-radius-row);
    background: var(--accent-fill);
    color: var(--accent-fill-ink);
    font-size: var(--fs-title);
    font-weight: 600;
    cursor: pointer;
    transition: transform var(--t-fast) ease, filter var(--t-fast) ease, opacity var(--t-fast) ease;
    -webkit-tap-highlight-color: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    letter-spacing: -0.2px;
  }
  .connect-btn:active:not(:disabled) {
    transform: scale(0.98);
    filter: brightness(0.9);
  }
  .connect-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .connect-row { display: flex; gap: 8px; }
  .connect-row .connect-btn { flex: 1; }
  .share-btn {
    width: 100%; margin-top: 8px; padding: 10px;
    border: 1px solid var(--border); border-radius: var(--ui-radius-panel);
    background: none; color: var(--text2); font-size: var(--fs-ui); font-weight: 600;
    cursor: pointer; -webkit-tap-highlight-color: transparent;
    display: flex; align-items: center; justify-content: center; gap: 6px;
    transition: color var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
  }
  .share-btn:active:not(:disabled) { transform: scale(0.98); color: var(--accent); border-color: var(--accent); }
  .share-btn:disabled { opacity: 0.4; cursor: default; }
  .about-link {
    display: block; text-align: center; margin-top: 18px;
    color: var(--text3); font-size: var(--fs-ui); text-decoration: none;
    -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast);
  }
  .about-link:active { color: var(--accent); }
  .cancel-btn {
    padding: 13px 20px; border: 1px solid var(--border); border-radius: var(--ui-radius-panel);
    background: none; color: var(--text2); font-size: var(--fs-body); font-weight: 600;
    cursor: pointer; -webkit-tap-highlight-color: transparent;
  }

  .spinner {
    width: 16px; height: 16px;
    border: 2px solid rgba(0, 0, 0, 0.2);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

  .error {
    color: var(--danger);
    font-size: var(--fs-ui);
    padding: 10px 14px;
    background: var(--danger-bg);
    border: 1px solid color-mix(in srgb, var(--danger) 15%, transparent);
    border-radius: var(--ui-radius-row);
  }
</style>

<script lang="ts">
  import { onDestroy } from 'svelte';
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

  /** One connect attempt's own connection (board #335 ②b-4): App's
   * CANDIDATE, not the socket any server's pages are using. It reaches
   * whatever answers at the address, and nobody knows which server that is
   * until it authenticates — so it is kept apart from every bound runtime,
   * and closed once identity is recorded; the server's own runtime then
   * dials. `current()` is App's answer to "is the app still waiting on this
   * attempt?": false once a newer attempt, a switch or a leave took over. */
  /** The server's own bring-up after the candidate. `committed`, when given,
   * resolves once it can no longer be cancelled (its runtime is being
   * bound): from then on the form offers no Cancel. */
  type SecondHalf = { done: Promise<string | null>; cancel(): void; committed?: Promise<unknown> };
  type Candidate = {
    connect(url: string, token: string): Promise<unknown>;
    setSocket(socket: string): Promise<unknown>;
    machineId(): string;
    current(): boolean;
    close(): void;
  };

  let {
    onConnected,
    openCandidate,
    confirmLeave,
    notice = '',
    frozen = '',
    onRetry,
    onIdentityFailed,
  }: {
    /** Why this form may not connect right now — the boot migration is
     * blocked, and nothing may move CURRENT until it is recorded (board #335
     * ②b-4; orchestrator, 21:45). Non-empty: this is shown, and the form's
     * one button is Retry (`onRetry`) instead of Connect — Retry is the way
     * out, not a connect. */
    frozen?: string;
    onRetry?: () => void;
    /** The identity write after an authenticated connect failed: the host's
     * gate decides whether storage is blocked (board #335 ②b-4). */
    onIdentityFailed?: () => void;
    /** Why the app came back to this page, from outside the form — an
     * automatic reconnect that reached a peer nobody could identify (board
     * #335 ②b-2-2). Shown in the form's one error slot until it says
     * something of its own. */
    notice?: string;
    /** The attempt authenticated and its identity is recorded: the app
     * comes up on that server, `switched` when it is a different one than
     * the app was on. The candidate is already closed; App
     * dials the server's OWN connection, whose handshake is the identity of
     * record, and hands back that second half: `done` resolves null once the
     * server is up or the reason it is not, and `cancel` stops it (reviewer
     * P1-D on cc45d7d1: the form stays busy, reports and cancels through
     * BOTH handshakes). */
    onConnected: (switched: boolean) => SecondHalf | void;
    /** A fresh candidate for one attempt (see `Candidate`). Opening one makes
     * any earlier attempt stale. */
    openCandidate: () => Candidate;
    /**
     * Asked FIRST, before anything is dialled or written (board #335 ②b-2-3,
     * reviewer P1-c): may the server-bound tree be thrown away for this
     * address? A connect to another server destroys every page of the one
     * the app is on, and an unsaved editor there has to be asked in its own
     * dialog while it still exists. False stays: nothing is dialled. Asked
     * with the address this attempt froze, which is the one it will dial.
     */
    confirmLeave?: ((address: string) => Promise<boolean>) | undefined;
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
  /** The attempt passed its point of no return: still busy, no Cancel. */
  let committing = $state(false);

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
   * superseded one must not write the registry or call `onConnected`,
   * exactly as a superseded dial must not record its result (board #335
   * ②b-1, reviewer 2026-10-10). */
  let attempts = 0;
  /** And an attempt dies with the component: a dial started by a form the
   * reader has since left must not bring anything up. */
  let mounted = true;
  /** The candidate of the attempt in flight, closed by Cancel; and the
   * server's own dial after it, which Cancel stops too. */
  let candidate: Candidate | null = null;
  let secondHalf: SecondHalf | null = null;
  onDestroy(() => { mounted = false; candidate?.close(); secondHalf?.cancel(); });

  async function doConnect() {
    if (frozen) return;
    error = '';
    connecting = true;
    committing = false;
    cancelled = false;
    const attempt = ++attempts;
    // FROZEN at submit, before the first await, and used for everything
    // after — the question, the dial, every write: the fields are live inputs
    // a reader (or a late autofill) can change while the leave walk is open,
    // and the target that was approved has to be the one dialled (reviewer
    // P1-b on 48b40082; and an identity write that re-read them would record
    // a server nobody dialled, orchestrator's ruling, 2026-10-10).
    const url = normalizeAddress(address);
    const tok = token;
    const sock = socket.trim();
    // Before the dial and every write: a "stay" here must leave the app
    // exactly as it was. A walk that FAILS is a stay too, and this attempt
    // ends with it — never an unhandled rejection with the form left
    // connecting. The host holds this form mounted while the walk shows other
    // pages, so an accept comes back to the instance that asked.
    let leave = true;
    if (confirmLeave) {
      try { leave = await confirmLeave(url); } catch { leave = false; }
    }
    if (!leave) {
      if (attempt === attempts) connecting = false;
      return;
    }
    if (!mounted || attempt !== attempts || cancelled) return;
    // The attempt's OWN connection (board #335 ②b-4). Nothing bound to a
    // server is touched while it dials: the pages of the server the app is
    // on keep their socket, and whatever answers here is identified before
    // anything is brought up on it.
    const own = openCandidate();
    candidate = own;
    // TWO questions, kept apart (reviewer P1-D on cc45d7d1). `mine`: is this
    // still this form's attempt — what its busy state and its error belong
    // to. `live`: may it still conclude anything for the APP — the candidate
    // is also current only while the app waits on it, and goes stale the
    // moment it is closed, so it can never be what ends the busy state.
    const mine = () => mounted && attempt === attempts && !cancelled;
    const live = () => mine() && own.current();
    try {
      localStorage.setItem('tmux_address', url);
      localStorage.setItem('tmux_token', tok);
      if (sock) localStorage.setItem('tmux_socket', sock);
      else localStorage.removeItem('tmux_socket');
      saveHistory(url, tok);
      await own.connect(url, tok);
      // A superseded, cancelled or unmounted attempt owns nothing from here
      // on: not the registry, not `onConnected`.
      if (!live()) return;
      // The tmux socket is the SERVER's setting, so it is set through the
      // candidate and stays set for the server's own connection.
      if (sock) await own.setSocket(sock).catch(() => {});
      const mid = own.machineId();
      let switched = false;
      // Checked again here, after the awaits above and with NO await between
      // this and the first identity write: a newer attempt may have taken
      // over while `connect` or `setSocket` resolved (reviewer, 2026-10-10).
      if (!live()) return;
      // Save machine_id → address mapping
      try {
        if (mid) {
          const map = JSON.parse(localStorage.getItem('tmux_machines') || '{}');
          const addrs = map[mid] || [];
          if (!addrs.includes(url)) addrs.push(url);
          map[mid] = addrs.slice(-8);
          localStorage.setItem('tmux_machines', JSON.stringify(map));
          // The unprefixed tmux_machine_id is NOT written here, or anywhere:
          // since board #335 ②b-4 it is the frozen LEGACY mirror, the
          // evidence a server must match to claim pre-#335 inputs. The
          // machine is the entry's (activateConnected records it).
        }
        // The multi-server registry (board #55): a successful connect RECORDS
        // by machine identity and then asks whether this was a different
        // server. Same machine (a LAN/Tailscale alternate) — nothing to
        // activate. A DIFFERENT server — CURRENT moves to it and App brings
        // the app up on it with the content tree remounted (board 315, no
        // reload); each server's state is in its own slots already.
        const act = activateConnected(localStorage, {
          address: url, token: tok,
          ...(sock ? { socket: sock } : {}),
          ...(mid ? { machineId: mid } : {}),
        });
        switched = act.reload;
      } catch {
        // A peer DID authenticate and we could not establish which server it
        // is (the registry write failed): an error, and nothing comes up.
        if (live()) {
          error = t('configIdentityFailed');
          own.close();
          // Done before the host's gate, which may end this attempt.
          connecting = false;
          onIdentityFailed?.();
        }
        return;
      }
      if (!live()) return;
      // Identity is recorded: the candidate's work is done. The server's own
      // runtime dials from here (not adopt: one owner per connection), and
      // the form stays busy until THAT has answered.
      own.close();
      const second = onConnected(switched) || null;
      secondHalf = second;
      second?.committed?.then(() => { if (mine() && secondHalf === second) committing = true; });
      const failure = second ? await second.done : null;
      if (mine() && failure) error = failure;
    } catch (e) {
      if (mine()) error = (e as Error).message;
    } finally {
      // Every end of an attempt releases its candidate and its busy state,
      // whatever it concluded (reviewer P1-D on cc45d7d1).
      own.close();
      if (candidate === own) candidate = null;
      if (mine()) { connecting = false; committing = false; secondHalf = null; }
    }
  }

  function cancelConnect() {
    cancelled = true;
    connecting = false;
    candidate?.close();
    candidate = null;
    // The second handshake too: the server's own dial is cancelled, so a late
    // answer binds nothing.
    secondHalf?.cancel();
    secondHalf = null;
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

    {#if frozen || error || notice}
      <div class="error appear">{frozen || error || notice}</div>
    {/if}
    {#if localTrouble}
      <div class="config-note" role="status">{localTrouble.label}: {localTrouble.value}</div>
    {/if}

    {#if connecting}
      <div class="connect-row">
        <button class="connect-btn connecting" disabled>
          <span class="spinner"></span> {t('connecting')}
        </button>
        {#if !committing}
          <button class="cancel-btn" onclick={cancelConnect}>{t('cancel')}</button>
        {/if}
      </div>
    {:else if frozen}
      <button class="connect-btn" onclick={() => onRetry?.()}>
        {t('configRetry')}
      </button>
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
  </div>
</div>

<style>
  /* The page is its own scroller: its layer and every ancestor clip, so a card
     taller than the window (zoomed, short, keyboard up) was cut off with
     nothing to scroll (board #381). `min-height: 0` lets `overflow-y` act;
     the card centres with auto margins, which collapse to the top when there
     is no room, where `align-items: center` pushed its top out of reach.
     app-shell.md § "A page taller than the window scrolls itself". */
  .wrapper {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 24px 16px;
  }

  .card {
    margin: auto;
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

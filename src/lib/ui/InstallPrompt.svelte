<script lang="ts">
  // PWA install offer — browser-only banner inviting the user to install the
  // web UI as a standalone app.
  //
  // Two paths:
  //   • Chromium (Chrome/Edge/Android/Samsung): the browser fires
  //     `beforeinstallprompt`; we capture it, show our own banner, and call
  //     the saved event's prompt() when the user taps Install — triggering
  //     the native install dialog.
  //   • iOS Safari: there is NO programmatic install API, so we detect it and
  //     show short "Share → Add to Home Screen" instructions instead.
  //
  // Never shown inside the Tauri shell (already native) or once the app is
  // already running standalone (installed). Dismissals are remembered for a
  // cooldown window so we don't nag.
  import { t } from '../core/i18n.svelte.ts';
  import { isTauri } from '../core/platform.ts';

  // Chromium-only event; not in TS DOM libs.
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<unknown>;
  }

  const DISMISS_KEY = 'tmux_pwa_dismissed';
  const DISMISS_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days


  function isStandalone() {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  }

  function isIos() {
    const ua = navigator.userAgent || '';
    // iPadOS 13+ masquerades as macOS; distinguish by touch support.
    return (
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  function isIosSafari() {
    if (!isIos()) return false;
    const ua = navigator.userAgent || '';
    // On iOS, "Add to Home Screen" only exists in Safari — exclude in-app
    // browsers and other engines (CriOS/Chrome, FxiOS/Firefox, EdgiOS, etc.).
    return /safari/i.test(ua) && !/crios|fxios|edgios|opt\//i.test(ua);
  }

  function dismissedRecently() {
    try {
      const ts = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
      return ts > 0 && Date.now() - ts < DISMISS_COOLDOWN_MS;
    } catch {
      return false;
    }
  }

  let visible = $state(false);
  let mode = $state<'' | 'prompt' | 'ios'>('');
  let deferredPrompt: BeforeInstallPromptEvent | null = null;

  $effect(() => {
    if (isTauri || isStandalone() || dismissedRecently()) return;

    function onBeforeInstall(e: Event) {
      // Prevent the mini-infobar; we drive the offer ourselves.
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      mode = 'prompt';
      visible = true;
    }

    function onInstalled() {
      visible = false;
      deferredPrompt = null;
      try {
        localStorage.removeItem(DISMISS_KEY);
      } catch {}
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    // iOS never fires beforeinstallprompt — offer manual instructions.
    let iosTimer: ReturnType<typeof setTimeout> | null = null;
    if (isIosSafari()) {
      // Small delay so the banner doesn't fight the first paint / connect UI.
      iosTimer = setTimeout(() => {
        mode = 'ios';
        visible = true;
      }, 2500);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
      if (iosTimer) clearTimeout(iosTimer);
    };
  });

  async function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch {}
    deferredPrompt = null;
    visible = false;
  }

  function dismiss() {
    visible = false;
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {}
  }

  // The space the banner takes at the bottom of the window, published while
  // it shows as `--install-reserve` on the root (board #387): the page
  // scrollers that hold a primary action at their end (the connect page)
  // stop above it, so the banner never sits on Connect / Share at any
  // interface scale. Its own height plus its distance from the bottom edge,
  // read as LAYOUT values (offsetHeight and the computed `bottom`, both in
  // the root zoom's units, like the page that reserves them), re-read when
  // the banner reflows. Removed with the banner.
  let banner = $state<HTMLElement | null>(null);
  $effect(() => {
    const el = banner;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      const below = parseFloat(getComputedStyle(el).bottom) || 0;
      root.style.setProperty('--install-reserve', `${el.offsetHeight + below}px`);
    };
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--install-reserve');
    };
  });
</script>

{#if visible}
  <div class="install-banner" role="dialog" aria-label={t('installTitle')} bind:this={banner}>
    <img class="install-icon" src="/pwa-192.png" alt="" width="40" height="40" />
    <div class="install-body">
      <div class="install-title">{t('installTitle')}</div>
      <div class="install-desc">
        {#if mode === 'ios'}
          {t('installIosHint')}
        {:else}
          {t('installDesc')}
        {/if}
      </div>
    </div>
    <div class="install-actions">
      {#if mode === 'prompt'}
        <button class="install-btn" onclick={install}>{t('installBtn')}</button>
      {/if}
      <button class="install-dismiss" onclick={dismiss} aria-label={t('installLater')}>
        {t('installLater')}
      </button>
    </div>
  </div>
{/if}

<style>
  .install-banner {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: calc(12px + var(--sab, 0px)); /* var(--sab): env() is 0 in the APK */
    z-index: 200;
    width: min(440px, calc(100vw / var(--ui-zoom, 1) - 24px));
    box-sizing: border-box;
    /* Its content WRAPS inside that width (board #387): the actions were a
       fixed column beside the text, so a narrow banner (a phone at interface
       scale 150%+, browser zoom 200%) squeezed the text to one word per line
       and pushed Install / Not now past the window's edge. Now the text keeps
       a readable measure and the actions move to their own line, at the end. */
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 16px;
    background: var(--nav-bg);
    border: 1px solid var(--border);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    /* Its own keyframe rather than .appear-rise: the banner is centred BY a
       translateX, so the rise has to carry that transform along. Tempo and
       curve are the vocabulary's (motion.md: arrive decelerating on --t-move). */
    animation: install-rise var(--t-move) ease-out;
  }
  @keyframes install-rise {
    from { opacity: 0; transform: translateX(-50%) translateY(16px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .install-banner { animation: none; }
    .install-btn, .install-dismiss { transition: none; }
  }
  .install-icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    flex-shrink: 0;
  }
  /* Basis 0 with a readable minimum: the text stays beside the icon and
     takes the room left on the line, and the actions are what wrap to the
     next line when that room would fall under 9em (board #387). */
  .install-body {
    flex: 1 1 0;
    min-width: 9em;
    overflow-wrap: anywhere;
  }
  .install-title {
    font-size: var(--fs-body);
    font-weight: 600;
    color: var(--text);
  }
  .install-desc {
    font-size: var(--fs-sub);
    color: var(--text2);
    margin-top: 2px;
    line-height: 1.35;
  }
  .install-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .install-btn {
    padding: 7px 14px;
    border: none;
    border-radius: var(--ui-radius-control);
    background: var(--accent-fill);
    color: var(--accent-fill-ink);
    font-size: var(--fs-ui);
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: transform var(--t-fast);
  }
  .install-btn:active { transform: scale(0.94); }
  .install-dismiss {
    padding: 7px 10px;
    border: none;
    border-radius: var(--ui-radius-control);
    background: transparent;
    color: var(--text3);
    font-size: var(--fs-ui);
    cursor: pointer;
    font-family: inherit;
    white-space: nowrap;
    transition: color var(--t-fast);
  }
  .install-dismiss:active { color: var(--text2); }
</style>

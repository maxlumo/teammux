<script lang="ts">
  // Board #107: ONE ask component (ticket 2b's dashboard reuses it). It draws an ask from
  // its ROW (structure and state, board #106), never from the composed body. Open: the
  // question, the options in focus order with the recommended one marked, an Answer box,
  // Dismiss and Discuss in chat. Closed: the outcome and no live controls. The delivery
  // state sits BESIDE the decision, never merged into it (hub-feed.md § An ask is a bubble).
  import CommandButton from '../ui/CommandButton.svelte';
  import { renderMarkdown } from '../core/markdown.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { NO_LABELS } from './names.ts';
  import { deliveryWord, noDeliveryYet, type AskerState, type AskDraft } from './asks.svelte.ts';
  import type { AskRow } from '../core/ws-api.ts';

  let {
    ask, names = NO_LABELS, asker = 'live' as AskerState, refused = '', error = '', stale = false, busy = false, draft, ondraft,
    onanswer = async (_option?: string, _text?: string) => false, ondismiss = () => {}, ondiscuss = () => {},
  }: {
    ask: AskRow; names?: { shown: (n: string) => string }; asker?: AskerState; refused?: string; error?: string; stale?: boolean; busy?: boolean;
    /** The store's draft for this ask (round 5): read once when the card mounts, written back
     * on every change, so a card that unmounts mid-call comes back with it. */
    draft?: AskDraft; ondraft?: (draft: AskDraft) => void;
    /** Resolves true once the server answered; the Answer box is cleared only then. */
    onanswer?: (option?: string, text?: string) => Promise<boolean> | void; ondismiss?: () => void; ondiscuss?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let text = $state(draft?.text ?? '');
  const open = $derived(ask.state === 'open');
  const who = $derived(names.shown(ask.asker));
  const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const delivery = $derived(deliveryWord(ask.delivery));
  // The server's words beside the decision; with none recorded yet on an answered or dismissed
  // ask, the client's OWN wording says so, never one of the server's (leader note 59).
  const deliveryText = $derived(
    delivery === 'sent' ? t('askSent').replace('{name}', who)
      : delivery === 'stopped' ? t('askNotDeliveredStopped').replace('{name}', who)
        : delivery === 'gone' ? t('askGone').replace('{name}', who)
          : delivery === 'unconfirmed' ? t('askUnconfirmed')
            : noDeliveryYet(ask) ? t('askNoDeliveryYet') : '',
  );
  /** `said` is the closing act in its own words: `B · beta — text`, `dismissed: …`,
   * `withdrawn: why — citing …` (asks.md). The card shows it as it is. */
  const said = $derived((ask.said ?? '').replace(/^withdrawn:\s*/u, ''));

  /** The option this card last tried to send; it stays marked until a send lands (F2). */
  // svelte-ignore state_referenced_locally
  let tried = $state<string | undefined>(draft?.tried);
  $effect(() => { if (open) ondraft?.({ text, tried }); });
  /** The control that started the close in flight: it alone wears the atom's pending state
   * (contrast kept, its icon slot, aria-busy); the others are only unavailable. */
  let acting = $state<string>('');
  const mine = (id: string) => busy && acting === id;
  /** One send for an option tap and the Answer box: an option carries the comment already
   * typed (board-dashboard.md § 3, "an option, with or without a comment"); the words and
   * the option stay until the server answered. */
  async function send(option?: string) {
    const words = text.trim();
    if (busy || (!option && !words)) return;
    tried = option;
    acting = option ? `opt:${option}` : 'answer';
    if ((await onanswer(option, words || undefined)) === true) { text = ''; tried = undefined; }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="ask-card" class:closed={!open} onclick={(e) => e.stopPropagation()} data-ask-seq={ask.seq}>
  <div class="ask-q">{@html renderMarkdown(ask.question)}</div>
  {#if open}
    {#if ask.options.length}
      <div class="ask-opts" role="group" aria-label={ask.question}>
        {#each ask.options as o (o.key)}
          <div class="ask-opt">
            <CommandButton label={`${o.key} · ${o.label}`} variant={o.key === ask.recommend ? 'primary' : 'secondary'} wrap reserve pending={mine(`opt:${o.key}`)} pressed={tried === o.key ? true : undefined} disabled={busy} onclick={() => send(o.key)} />
            {#if o.key === ask.recommend}<span class="ask-rec">{t('askRecommended')}</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
    <div class="ask-answer">
      <textarea class="config-input ask-text" rows="2" placeholder={t('askAnswerPh')} bind:value={text} disabled={busy}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }}></textarea>
      <CommandButton label={t('askAnswer')} variant="primary" icon="send" pending={mine('answer')} disabled={busy || !text.trim()} onclick={() => send()} />
    </div>
    <div class="ask-acts">
      <CommandButton label={t('askDismiss')} icon="x" pending={mine('dismiss')} disabled={busy} onclick={() => { if (busy) return; acting = 'dismiss'; ondismiss(); }} />
      <CommandButton label={t('askDiscuss')} disabled={busy} onclick={ondiscuss} />
    </div>
    {#if asker !== 'live'}
      <p class="ask-note" role="status">{t(asker === 'stopped' ? 'askAskerStopped' : 'askAskerGone').replace('{name}', who)}</p>
    {/if}
    {#if refused}<p class="ask-note" role="alert">{refused}</p>{/if}
    {#if error}<p class="ask-note" role="alert">{t('askNotSent').replace('{why}', error)}</p>{/if}
  {:else}
    <p class="ask-out">
      <span class="ask-state">{ask.state === 'answered' ? t('askAnswered') : ask.state === 'dismissed' ? t('askDismissed') : t('askWithdrawn').replace('{name}', who)}</span>
      {#if ask.state !== 'dismissed' && said}<span class="ask-said">{said}</span>{/if}
      <span class="ask-when">{ask.state === 'withdrawn' ? who : names.shown('human')} · {when(ask.closed_at)}</span>
    </p>
    {#if refused}<p class="ask-note" role="alert">{refused}</p>{/if}
  {/if}
  {#if deliveryText}<p class="ask-delivery">{deliveryText}</p>{/if}
  <!-- Every loaded row, open or closed, whose refresh failed (leader ruling 14 / 40). -->
  {#if stale}<p class="ask-note ask-stale" role="status">{t('askStale')}</p>{/if}
</div>

<style>
  .ask-card { display: flex; flex-direction: column; gap: var(--ui-gap); min-width: 0; }
  .ask-q { min-width: 0; overflow-wrap: anywhere; }
  .ask-opts { display: flex; flex-direction: column; gap: var(--ui-gap); }
  .ask-opt { display: flex; align-items: center; gap: var(--ui-gap); min-width: 0; flex-wrap: wrap; }
  .ask-rec, .ask-when, .ask-delivery { font-size: var(--fs-meta); color: var(--text3); }
  .ask-answer { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: flex-end; gap: var(--ui-gap); }
  .ask-text { flex: 1 1 12em; min-height: 0; resize: none; }
  .ask-acts { display: flex; flex-wrap: wrap; gap: var(--ui-gap); }
  .ask-note { font-size: var(--fs-meta); color: var(--text2); margin: 0; }
  .ask-out { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--ui-gap); margin: 0; }
  .ask-state { font-weight: 600; }
  .ask-said { min-width: 0; overflow-wrap: anywhere; }
  .ask-delivery { margin: 0; }
</style>

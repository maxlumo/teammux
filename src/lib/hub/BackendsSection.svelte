<script>
  // The Agents page's Backends section (board #492 phase 2): for each agent
  // CLI, is it installed on THIS server, is it set up, does it answer — read
  // through the one `backends_check` RPC. The server decides every fact; this
  // only shows them (backends-view.ts) and runs the two actions:
  //
  // - Refresh: exactly ONE per actual entry into the section (`active`
  //   rising), never on the page's mount or in the background; the button
  //   runs another on demand.
  // - Test: only on a click, on a row the server says only a Test decides.
  //
  // One action at a time. Each carries a TICKET { runtime handle, visit,
  // action }; only the request whose ticket is still the current one may
  // touch anything, its busy state included ("still mine"). Whether its
  // answer may be APPLIED, or a request SENT, is a separate check
  // (`permitted`: cap present and section shown). A reconnect (cap unknown)
  // or leaving the section voids the ticket at once, so a dropped link never
  // leaves a button spinning; the results and the reading position stay.
  // Contract: board #492, reviewer design CLEAR 07:29 (agents-overview.md §
  // "Backend readiness").
  import { t } from '../core/i18n.svelte.ts';
  import { stateDotColor, stateIsLive } from './hub.ts';
  import CommandButton from '../ui/CommandButton.svelte';
  import ServerTag from '../ui/ServerTag.svelte';
  import { untrack } from 'svelte';
  import { clock, factDot, hintKey, mergeFact, mergeRow, reasonKey, readRefresh, readTest, refreshFailed, rowHints, testFailed, testable } from './backends-view.ts';

  let { runtime, active = false, cap = 'unknown', head = true, tag = null, icon = () => '', onBack = null, onReport = null } = $props();

  let report = $state.raw(null);   // { backends, baseline, at }: the last Refresh answer
  let tested = $state.raw(null);   // { name, set_up, answers, at }: a Test since that Refresh
  let running = $state('');        // 'refresh' | 'test' | '': the action that shows pending
  let runningName = $state('');    // the row a running Test is for
  let failure = $state.raw(null);  // { action, name, reason, code }: the last action that could not run
  let needsUpdate = $state(false); // the cap was announced but the method is not there

  // Ownership (plain: it orders answers and is never shown).
  let current = null;
  let visit = 0;
  let actionGen = 0;
  let inVisit = false;
  let visitRuntime = null;
  let entrySent = false;
  let alive = true;

  const permitted = () => alive && active && cap === 'present';
  const mine = (ticket) => alive && ticket === current && ticket.runtime === runtime && ticket.visit === visit;
  function release() { current = null; running = ''; runningName = ''; }

  function startVisit(r) {
    release();
    visit++;
    inVisit = true;
    entrySent = false;
    failure = null;
    needsUpdate = false;
    // Another runtime's rows are not this one's.
    if (r !== visitRuntime) { report = null; tested = null; }
    visitRuntime = r;
    entryRefresh();
  }
  function endVisit() {
    inVisit = false;
    visit++;
    release();
  }
  /** The visit's ONE Refresh: at entry, or — for a visit that began before
   * the server's login answered — when the cap is first known present. */
  function entryRefresh() {
    if (inVisit && !entrySent && permitted()) void run('refresh');
  }

  $effect(() => {
    const on = active;
    const r = runtime;
    untrack(() => {
      if (on && (!inVisit || r !== visitRuntime)) startVisit(r);
      else if (!on && inVisit) endVisit();
    });
  });
  $effect(() => {
    const c = cap;
    untrack(() => {
      if (c !== 'present') release();
      else entryRefresh();
    });
  });
  $effect(() => () => { alive = false; current = null; });

  async function run(action, name = '') {
    if (running || !permitted()) return;
    const ticket = { runtime, visit, action: ++actionGen };
    current = ticket;
    running = action;
    runningName = name;
    if (action === 'refresh') entrySent = true;
    failure = null;
    needsUpdate = false;
    try {
      const answer = action === 'test' ? await runtime.api.backendsCheck(name) : await runtime.api.backendsCheck();
      if (!mine(ticket) || !permitted()) return;
      // A reply is not a result (reviewer P1-A on d7c6ab54): the server
      // answers a check that could not run inside a normal reply, so each
      // answer is read for what it FOUND. One that found nothing is this
      // action's failure and leaves every fact on screen, with its time.
      const failed = action === 'test' ? testFailed(answer, name) : refreshFailed(answer);
      if (failed) { failure = { action, name, reason: reason(failed), code: failed }; return; }
      if (action === 'refresh') {
        const read = readRefresh(answer);
        if (!read) { failure = { action, name, reason: t('backendsBadAnswer'), code: '' }; return; }
        // A fact this check could not decide keeps the definite one before it.
        const before = new Map((report?.backends ?? []).map((b) => [b.name, b]));
        const prevAt = report?.at ?? 0;
        report = { backends: read.backends.map((b) => mergeRow(before.get(b.name), b, prevAt)), baseline: read.baseline, at: Date.now() };
        // The agent editor marks a backend whose CLI this Refresh found
        // missing (board #511 P3): the same rows, never a second probe.
        onReport?.(report);
        // A Test's facts stay while the new row still leaves them to a Test.
        if (tested && !report.backends.some((b) => b.name === tested.name && testable(b))) tested = null;
      } else {
        const read = readTest(answer, name);
        if (!read) { failure = { action, name, reason: t('backendsBadAnswer'), code: '' }; return; }
        const shown = rows.find((b) => b.name === name);
        const prevAt = tested?.name === name ? tested.at : (report?.at ?? 0);
        tested = { name, set_up: mergeFact(shown?.set_up, read.set_up, prevAt), answers: mergeFact(shown?.answers, read.answers, prevAt), at: Date.now() };
      }
    } catch (e) {
      if (!mine(ticket) || !permitted()) return;
      if (e?.code === -32601) needsUpdate = true;
      else failure = { action, name, reason: String(e?.message ?? e), code: '' };
    } finally {
      if (mine(ticket)) release();
    }
  }

  /** The rows shown: the last Refresh, with a later Test's facts on its row. */
  const rows = $derived((report?.backends ?? []).map((b) => (tested && b.name === tested.name
    ? { ...b, set_up: tested.set_up, answers: tested.answers } : b)));
  const refreshDidFail = $derived(failure?.action === 'refresh');
  const failureHint = $derived(failure?.code ? hintKey(failure.code) : null);
  const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), t(key));
  const reason = (code) => t(reasonKey(code));

  function installedText(b) {
    const i = b.installed ?? {};
    if (i.state === 'present') return i.version ? i.version : t('backendsVersionUnknown');
    if (i.state === 'missing') return fill('backendsNotFound', { program: b.program ?? b.name });
    // unknown, or a field this answer lacks: never said to be absent
    return t('backendsInstallUnknown');
  }
  function setUpText(u = {}) {
    if (u.state === 'present') return u.basis === 'cli' ? fill('backendsSignedIn', { via: u.via ?? '' }) : fill('backendsSetUpPresent', { via: u.via ?? '' });
    if (u.state === 'missing') return u.missing?.length ? fill('backendsSetUpMissing', { names: u.missing.join(t('backendsOr')) }) : t('backendsSetUpMissingBare');
    return t('backendsSetUpUnknown');
  }
  function answersText(a = {}) {
    if (a.state === 'yes') return fill('backendsAnswersYes', { n: a.count ?? 0 });
    if (a.state === 'no') return t('backendsAnswersNo');
    if (a.reason === 'test_only') return t('backendsNotTested');
    if (a.reason === 'first_run') return t('backendsReasonFirstRun');
    return t('backendsSetUpUnknown');
  }
  /** A fact's reason line, when its words add to the value; for a fact a
   * later check could not renew, when it is from and why. */
  function why(fact, value) {
    if (fact?.kept) return fill('backendsKept', { time: clock(fact.kept.at), reason: reason(fact.kept.reason) });
    if (!fact?.reason || fact.state === 'yes') return '';
    const text = reason(fact.reason);
    return text === value ? '' : text;
  }
  const status = $derived(
    cap === 'unknown' ? t('backendsWaitingConnection')
    : needsUpdate ? t('backendsNeedsUpdate')
    : running === 'refresh' ? t('backendsChecking')
    : refreshDidFail ? fill('backendsCouldNotCheck', { reason: failure.reason })
    : report ? fill('backendsCheckedAt', { time: clock(report.at) }) : '');
</script>

{#snippet fact(label, state, value, detail, path = '')}
  <div class="preference-row fact">
    <div class="pref-label"><span class="config-field-label">{label}</span></div>
    <div class="pref-control fact-value">
      <span class="fact-line"><span class="fact-dot" class:live-dot={stateIsLive(factDot(state))} style:background={stateDotColor(factDot(state))} aria-hidden="true"></span><span class="fact-text">{value}</span></span>
      {#if path}<span class="fact-path">{path}</span>{/if}
      {#if detail}<span class="config-note">{detail}</span>{/if}
    </div>
  </div>
{/snippet}

{#if head}
  <div class="page-head config-page-head">
    <div class="config-head-inner">
      {#if onBack}<CommandButton variant="icon" icon="chevron-left" label={t('back')} onclick={onBack} />{/if}
      <h1>{t('backendsTitle')}<ServerTag name={tag} /></h1>
    </div>
  </div>
{/if}
<div class="backends subtle-scroll">
  <div class="config-form">
    <p class="config-note">{t('backendsScope')}</p>
    <div class="b-bar">
      <p class="config-note b-status" class:config-error={refreshDidFail || needsUpdate} role="status">
        {status}{#if report && (cap === 'unknown' || refreshDidFail)}{' '}{fill('backendsShowingFrom', { time: clock(report.at) })}{/if}
      </p>
      <CommandButton icon="refresh" label={t('backendsRefresh')} pending={running === 'refresh'}
        disabled={cap !== 'present' || !active || (!!running && running !== 'refresh')} onclick={() => run('refresh')} />
    </div>
    {#if refreshDidFail && failureHint}<p class="config-note">{t(failureHint)}</p>{/if}
    {#if report?.baseline}<p class="config-note">{fill('backendsBaseline', { reason: reason(report.baseline) })}</p>{/if}
    {#each rows as b (b.name)}
      {@const hints = rowHints(b)}
      <section class="config-section backend" aria-label={b.name}>
        <div class="b-head">
          {#if icon(b.name)}<img class="ava" src={icon(b.name)} alt="" />{/if}
          <strong class="b-name">{b.name}</strong>
          {#if testable(b) || tested?.name === b.name}
            <span class="b-test"><CommandButton icon="zap" label={t('backendsTest')} pending={running === 'test' && runningName === b.name}
              disabled={cap !== 'present' || !active || (!!running && !(running === 'test' && runningName === b.name))} onclick={() => run('test', b.name)} /></span>
          {/if}
        </div>
        {@render fact(t('backendsInstalled'), b.installed?.state, installedText(b), why(b.installed, installedText(b)), b.installed?.path ?? '')}
        {@render fact(t('backendsSetUp'), b.set_up?.state, setUpText(b.set_up), why(b.set_up, setUpText(b.set_up)))}
        {@render fact(t('backendsAnswers'), b.answers?.state, answersText(b.answers), why(b.answers, answersText(b.answers)))}
        {#each hints as h (h.key)}<p class="config-note b-hint">{fill(h.key, { program: h.program, name: h.names.join(t('backendsOr')) })}</p>{/each}
        {#if testable(b) || tested?.name === b.name}<p class="config-note">{fill('backendsTestNote', { program: b.program ?? b.name })}</p>{/if}
        {#if tested?.name === b.name}<p class="config-note">{fill('backendsTestedAt', { time: clock(tested.at) })}</p>{/if}
        {#if failure?.action === 'test' && failure.name === b.name}
          <p class="config-error" role="alert">{fill('backendsTestFailed', { reason: failure.reason })}</p>
          {#if failureHint}<p class="config-note">{t(failureHint)}</p>{/if}
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .backends { flex: 1; min-height: 0; overflow-y: auto; --config-pref-value: var(--config-editor-width); }
  .b-bar { display: flex; align-items: center; gap: var(--config-field-gap); flex-wrap: wrap; }
  .b-status { flex: 1 1 200px; min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .backends p { margin: 0; }
  .backend { display: flex; flex-direction: column; min-width: 0; }
  .b-head { display: flex; align-items: center; gap: 8px; min-height: var(--control-height); }
  .b-name { flex: 1; min-width: 0; overflow-wrap: anywhere; font: 600 var(--fs-body)/1.3 var(--font-display); color: var(--text); }
  .b-test { margin-left: auto; flex: none; }
  .fact-value { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  /* Compact: a long fact wraps beside its label instead of dropping under it
     (the shared row wraps at max-content, which suits a control, not text). */
  @media (max-width: 760px) { .preference-row > .fact-value { flex: 1 1 0; } }
  .fact-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .fact-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; transition: background var(--t-fast); }
  .fact-text { min-width: 0; overflow-wrap: anywhere; color: var(--text); font-size: var(--fs-ui); }
  /* The program the check found, as text a person can select and copy on
     every layout (reviewer (c)): never hover-only, never cut off. */
  .fact-path {
    min-width: 0; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text;
    font: var(--fs-sub)/1.4 var(--font-mono); color: var(--text2);
  }
</style>

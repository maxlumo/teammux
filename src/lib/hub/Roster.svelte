<script>
  import CommandButton from '../ui/CommandButton.svelte';
  import Icon from '../ui/Icon.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { untrack } from 'svelte';
  import { ALL_TARGET, targetMembers, targetTeam, teamTarget } from './hub-composer.ts';
  import { useServerScope } from '../app/server-context.ts';
  import { backendColor as colorOf, stateDotColor, stateIsLive, chipExtras, ctxColor, fmtElapsed, wakeLine, modelLabel, runtimeLabel, agentHue, namedGroup, rosterGroups, rosterMarker, sortAgentsForRoster, stoppedGroups } from './hub.ts';
  import { hoverInfo } from '../ui/hover.ts';
  import { longpress } from '../ui/longpress.ts';
  import { anchorOf } from '../ui/placement.ts';
  import { flip } from 'svelte/animate';
  import { moveMs } from '../ui/motion.ts';
  import { scrollEdges } from '../ui/scroll-edges.ts';
  import { slideIndicator } from '../ui/indicator.ts';
  import { tabShape } from '../ui/tab-shape.ts';
  import { createPressDrag } from '../ui/press-drag.ts';
  import { groupDropAt } from '../app/nav-order.ts';

  let {
    selected = '', compact = false, managedAgents = [], stopped = [], stoppedTeams = {}, selectedRow = null,
    recipient = '', filterAgent = '', unread = new Set(), acting = false, tick = Date.now(),
    roomReady = false, justLoaded = false, rosterBase = null,
    composerText = '', managedNames = [], busyNames = [], interrupting = [],
    stateLabel = (state) => state, detailLabel = (detail) => detail, stateTone = () => undefined,
    onselect: setRecipient = () => {}, oninterrupt: interrupt = () => {}, onfilter = () => {},
    /** Hub's one target predicate (#482: the reading-filter lock). A control
     * that would pick a target it refuses is disabled — the dimming made true. */
    targetable = (_target) => true,
    expanded: expandPref = false, onexpand = () => {}, onadd = () => {}, oncontext = () => {},
    allMenuOpen = false, onall = (_event) => {},
    onallcontext = (_at) => {}, onteamcontext = (_at, _team) => {},
    /** Board #384: drag a live card onto a team to move it there at runtime,
     * or onto the standalone area to leave its team. `moveScope` is the
     * context a drag belongs to (Hub's: its project and `ok` = it may move
     * here now); null or not ok = no drag. `onmove(name, team, scope)` with
     * team '' = leave, and the scope the drag was pressed in. */
    moveScope = null, onmove = (_name, _team, _scope) => {},
  } = $props();
  // This server's backend catalog (board #335 ②b-3): the avatars are its
  // answer. From the Hub's scope, read once at init.
  const catalog = useServerScope().state.backends;
  const backendIcon = catalog.icon;
  const backendColor = (backend) => colorOf(backend, catalog);

  const cardsId = $props.id();
  /* Expanding is only meaningful when the single row OVERFLOWS (#266, ruling
     2026-09-28): a room whose cards all fit has nothing to expand, so it gets
     no chevron and keeps the strip's lit tab with its feet, whatever the
     remembered preference says. The preference is kept and applies again once
     the row overflows. Measured by `scrollEdges` in the single-row form;
     until the first measurement the preference stands. The chevron's grid
     column stays reserved when it is not offered: the row's width must not
     depend on the answer, or a room in between would stay whichever way it
     arrived. */
  let overflowing = $state(true);
  const expanded = $derived(expandPref && overflowing);
  let cardsEl = $state(null);
  let hovering = $state(false);
  let focused = $state(false);
  let pressing = $state(false);
  let heldOrder = $state.raw({ session: '', names: [] });
  const holdOrder = $derived(hovering || focused || pressing);
  const ranked = $derived(sortAgentsForRoster(managedAgents));
  function clearPress() { pressing = false; }
  function beginPress() { pressing = true; }
  // Stop stands ON the state dot of the one card the pointer (or focus) is on,
  // fine pointers only (owner, 2026-09-20: "默认不显示，只有鼠标移到上边，把状态的小圆点变
  // 为终止按钮。手机端就不要了…让用户用选项卡终止就好"; board #205). A pending interrupt
  // keeps its Stop so the keyboard path has feedback (#173). Touch never renders
  // one: the long-press menu's Interrupt is the touch path.
  const coarse = typeof window !== 'undefined' && window.matchMedia('(any-pointer: coarse)').matches;
  let armed = $state('');
  function arm(name, pointerType = 'mouse') { if (!coarse && pointerType !== 'touch') armed = name; }
  function disarm(name) { if (armed === name) armed = ''; }
  /** Pointer or focus on the Everyone tab previews the All choice: the STRIP
   * lights as one enclosure, exactly as clicking would (board #236). Touch
   * never previews — a finger has no hover. */
  let allPreview = $state(false);
  /** All is the destination, actually or in preview: then the strip is the
   * lit tab and no card paints its own (one enclosure, no internal lines). */
  const allLit = $derived(recipient === ALL_TARGET || allPreview);
  const addressedMembers = $derived(new Set(targetMembers(recipient, managedAgents)));
  const showStop = (name) => !coarse && busyNames.includes(name) && (armed === name || interrupting.includes(name));
  /** Places the Stop's centre on the dot's centre — offsets are the card's own
   * coordinate space (the select button is positioned; the card is too). */
  function overDot(node) {
    const card = node.closest('.acard');
    const place = () => {
      const dot = card?.querySelector('.ac-top');
      if (!dot) return;
      const host = dot.offsetParent;
      const dx = host && host !== card ? host.offsetLeft : 0, dy = host && host !== card ? host.offsetTop : 0;
      node.style.setProperty('--dot-x', `${dx + dot.offsetLeft + dot.offsetWidth / 2}px`);
      node.style.setProperty('--dot-y', `${dy + dot.offsetTop + dot.offsetHeight / 2}px`);
    };
    place();
    const observer = typeof ResizeObserver !== 'undefined' && card ? new ResizeObserver(place) : null;
    observer?.observe(card);
    return { destroy: () => observer?.disconnect() };
  }
  $effect(() => {
    void managedAgents; void busyNames; void selected;
    focused = !!cardsEl?.contains(document.activeElement);
  });
  // Freeze identity order, not the live agent objects or their action state.
  $effect(() => {
    const names = ranked.map((a) => a.name);
    const previous = untrack(() => heldOrder);
    let next = names;
    if (holdOrder && previous.session === selected) {
      const present = new Set(names);
      const known = new Set(previous.names);
      next = [...previous.names.filter((name) => present.has(name)), ...names.filter((name) => !known.has(name))];
    }
    if (previous.session !== selected || next.length !== previous.names.length
        || next.some((name, index) => name !== previous.names[index])) {
      heldOrder = { session: selected, names: next };
    }
  });
  const orderedAgents = $derived.by(() => {
    if (!holdOrder || heldOrder.session !== selected) return ranked;
    const current = new Map(ranked.map((a) => [a.name, a]));
    const held = new Set(heldOrder.names);
    return [...heldOrder.names.map((name) => current.get(name)).filter(Boolean), ...ranked.filter((a) => !held.has(a.name))];
  });
  const groups = $derived(rosterGroups(orderedAgents));
  /* A team every member of which is stopped still has a place and a menu
     (board #287): its stopped cards sit under its name, like a live team's. */
  const offTeams = $derived(stoppedGroups(stopped, stoppedTeams, managedAgents));
  const offLoose = $derived(stopped.filter((name) => !offTeams.some((g) => g.members.includes(name))));
  /* The ONE marker's destination (motion principle 14): the whole group under
     All (and while All previews), the lit team, or the lit card. Empty when
     nothing in the strip is the recipient (the room itself). */
  const litTeam = $derived(targetTeam(recipient));
  const litInGroup = $derived(!allLit && !litTeam && groups.some((g) => namedGroup(g) && g.members.some((m) => m.name === recipient)));
  /* A lit team down to one live member is drawn as that member's card, so
     the marker lands on the card like any single recipient (#241). */
  const markerTarget = $derived(rosterMarker({ all: allLit, team: litTeam, groups, addressed: managedAgents.some((a) => addressedMembers.has(a.name)) }));
  const markerKey = $derived([recipient, allLit, expanded, orderedAgents.map((a) => a.name).join(',')].join('|'));
  $effect(() => {
    void selected; void expanded;
    if (cardsEl) { cardsEl.scrollLeft = 0; cardsEl.scrollTop = 0; }
  });
  const extras = $derived(chipExtras(composerText, recipient, managedNames));
  const slotBackend = (name) => (selectedRow?.slots ?? []).find((s) => s.window_name === name)?.command;

  function selectTarget(name) {
    setRecipient(name);
  }
  const isAddressed = (name) => addressedMembers.has(name);
  const coarsePointer = () => window.matchMedia('(any-pointer: coarse)').matches;
  /* A menu opened FROM a card sits at the card — left-aligned, the card kept
     visible — like the All button's (#168) and a stopped card's. */
  const cardAnchor = (trigger) => ({ anchor: anchorOf(trigger), align: 'left', trigger, keepTriggerClear: true });
  /* Touch has no hover, so a touch-opened menu CARRIES the hover card's facts
     (board #223: "手机上因为没有悬停窗口 所以选项卡里给我展示一下agent信息").
     A pointer menu stays verbs-only — the hover card already answered. */
  const touchInfo = (get) => (coarsePointer() ? get() : null);
  // ── Drag a card onto a team (board #384) ─────────────────────────────
  // The ONE press-drag (ui/press-drag.ts): a mouse or pen press on a live
  // card that travels the threshold, in any direction, carries the card; the
  // drop targets are the live NAMED team groups other than its own (a team
  // root) and, for a card in a team, the standalone area: a standalone card's
  // group, or (when there is none) a temporary "Standalone" slot shown only
  // while such a card is carried. Their boxes are snapshotted at drag start
  // (the carried card moves by transform), the point decides the target
  // (`groupDropAt`), and a release on one asks Hub to move it. A team
  // scrolled out of the single-row strip is not a target: the expand toggle
  // and the card menu's Move items reach it.
  let cardDrag = $state(null);
  /* The context the carried card was pressed in, compared by IDENTITY with
     Hub's current `moveScope`: kept out of `cardDrag`, whose $state would
     hand back a proxy that is never === the original. */
  let dragScope = null;
  /* Every target's box CLIPPED to the strip's visible box (reviewer P2-2): a
     group scrolled out of the single-row strip, or past a narrow split
     pane's edge, is not a target anywhere on the page, and one half out
     catches only its visible half. */
  const cardTargets = (from) => {
    const view = cardsEl?.getBoundingClientRect();
    if (!view) return [];
    return [...cardsEl.querySelectorAll('.roster-cluster[data-drop]')]
      .map((el) => ({ key: el.dataset.drop === '-' ? '' : el.dataset.drop, r: el.getBoundingClientRect() }))
      .filter(({ key }) => key !== from)
      .map(({ key, r }) => ({
        key, left: Math.max(r.left, view.left), top: Math.max(r.top, view.top),
        right: Math.min(r.right, view.right), bottom: Math.min(r.bottom, view.bottom),
      }))
      .filter((r) => r.right > r.left && r.bottom > r.top);
  };
  const cardDrags = createPressDrag({
    axis: 'xy',
    get: () => cardDrag,
    set: (drag) => { cardDrag = drag; },
    begin: (press) => {
      // A drag only where it may move now. Its context is the one the PRESS
      // was made in (reviewer P1-A): a press that outlived a project switch
      // is cancelled by the effect below before the next pointer event, and
      // whatever it carries the commit refuses, since it compares the
      // PRESS's scope with the current one (never one read here).
      if (!moveScope?.ok) return null;
      const a = managedAgents.find((x) => x.name === press.name);
      if (!a) return null;
      const from = rosterTeam(a);
      dragScope = press.scope;
      // The temporary slot renders after this; it is measured on the next move.
      return { name: a.name, from, dx: 0, dy: 0, rects: null, target: null };
    },
    track: (drag, e, { dx, dy }) => {
      cardDrag.dx = dx;
      cardDrag.dy = dy;
      // Measured once the targets have rendered (they appear with the drag),
      // and again until the temporary slot is in, for a card in a team.
      if (!drag.rects?.length || (drag.from && !drag.rects.some((r) => r.key === ''))) cardDrag.rects = cardTargets(drag.from);
      cardDrag.target = groupDropAt(cardDrag.rects, e.clientX, e.clientY);
    },
    // Re-checked in the step that commits: only a drag of the context that
    // is still current asks for a move, and it hands that context over.
    commit: (drag) => { if (drag.target !== null && dragScope === moveScope && moveScope?.ok) onmove(drag.name, drag.target, dragScope); },
  });
  // A new context (project switch, page hidden, cap lost) ends a press or a
  // drag at once: its targets belong to the old one.
  $effect(() => {
    void moveScope;
    return () => cardDrags.cancel();
  });
  /** The team a card is in, by root; '' standalone. */
  const rosterTeam = (a) => (a.team ? a.team.split('/')[0] : '');
  /** Where a carried team card may go standalone: a standalone card's group
   * when one is shown, else the temporary slot. By the group's TEAM, not by
   * how it is drawn: a team down to one live member is drawn as a plain card
   * (`namedGroup`), and it is still that team's drop target. */
  const looseShown = $derived(groups.some((g) => !g.team));
  $effect(() => {
    if (!cardDrag) return;
    // The strip resized under a carried card (expanded, a split pane's width,
    // the window): every box moved, the drag ends (reviewer P2). The first
    // report is the size it started at.
    const strip = cardsEl;
    let start = null;
    const resized = typeof ResizeObserver !== 'undefined' && strip ? new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (!r) return;
      if (!start) { start = { w: r.width, h: r.height }; return; }
      if (r.width !== start.w || r.height !== start.h) cardDrags.cancel();
    }) : null;
    resized?.observe(strip);
    const off = cardDrags.listen();
    return () => { off(); resized?.disconnect(); };
  });
  // The strip scrolling under a carried card (`.cards` onscroll) moves every
  // target and the card's own origin: the geometry is stale, the drag ends.
  // So does a roster change (an agent arrives, stops, changes team): its
  // target and boxes go together, so a release that follows with no further
  // pointer move cannot drop on a group that is no longer there (reviewer
  // P2). Keyed by names and teams, not the array: a poll replaces the array
  // every few seconds with the same roster.
  const rosterKey = $derived(managedAgents.map((a) => `${a.name}:${a.team ?? ''}`).join(','));
  $effect(() => {
    void rosterKey;
    return () => cardDrags.cancel();
  });

  function clickAgent(event, name) {
    if (cardDrags.consumeClick()) return;
    if (!coarsePointer() && event.detail > 1) return;
    // The recipient's own card: a second click opens its menu (Record only
    // leads), it does not deselect (owner, 2026-09-13: "agent选中卡片时，再次点击
    // 不是取消选中，而且展开选项卡"; board #196). Under All, a click narrows to the card.
    if (recipient === name) {
      const a = managedAgents.find((x) => x.name === name);
      oncontext(cardAnchor(event.currentTarget), name, touchInfo(() => (a ? cardInfo(a) : offCardInfo(name))));
      return;
    }
    selectTarget(name);
  }
  function focusAgent(event, name, stopped = false) {
    if (coarsePointer() || event.detail < 2) return;
    event.preventDefault();
    // On a card the reading filter has made unavailable as a target, this is
    // still the explicit "show only this one" (#483): the filter moves first
    // and selects it. Only the target half is refused by Hub's writer.
    if (!stopped && recipient !== name) setRecipient(name);
    onfilter(name);
  }
  function stoppedMenu(event, name) {
    if (!coarsePointer() && event.detail > 1) return;
    oncontext(cardAnchor(event.currentTarget), name, touchInfo(() => offCardInfo(name)));
  }

  function destinationNote(name) {
    if (!isAddressed(name)) return '';
    const team = targetTeam(recipient);
    const destination = recipient === ALL_TARGET ? t('hubToAllLong')
      : team ? t('hubToTeamLong').replace('{name}', team)
      : t('hubToDmLong').replace('{name}', `@${name}`);
    const also = extras.length ? t('hubToAlsoHint').replace('{names}', extras.map((n) => `@${n}`).join(', ')) : '';
    return [destination, also].filter(Boolean).join('\n');
  }

  function vitalsLine(v) {
    if (!v) return '';
    const parts = [];
    if (v.model) parts.push(modelLabel(v.model));
    if (v.context_pct != null) parts.push(`${v.context_pct}% ctx`);
    if (v.effort) parts.push(v.effort);
    if (v.branch) parts.push(v.branch);
    return parts.join(' · ');
  }

  function cardInfo(a) {
    const lines = [{ label: t('hubHoverState'), value: [stateLabel(a.state), detailLabel(a.detail)].filter(Boolean).join(' · '), tone: stateTone(a.state, a.detail) }];
    const model = runtimeLabel(a);
    if (model) lines.push({ label: t('hubHoverModel'), value: model });
    if (a.vitals?.context_pct != null) lines.push({ label: t('hubHoverCtx'), value: `${a.vitals.context_pct}%` });
    if (a.input_mode) lines.push({ label: t('hubHoverMode'), value: a.input_mode === 'steer' ? 'Steer' : 'Queue' });
    if (a.wake) lines.push({ label: t('hubHoverWake'), value: wakeLine(a.wake) });
    if (a.since) lines.push({ label: t('hubHoverSince'), value: fmtElapsed(a.since, tick) });
    if (a.team) lines.push({ label: t('teamsTitle'), value: a.team });
    lines.push({ label: t('hubHoverTarget'), value: `${selected}:${a.window}` });
    if (selectedRow?.project.path) lines.push({ label: t('hubHoverPath'), value: selectedRow.project.path });
    const text = [a.vitals?.effort, a.vitals?.branch].filter(Boolean).join(' · ');
    return { title: a.name, lines, text, note: [destinationNote(a.name), filterNote(a.name)].filter(Boolean).join('\n') };
  }

  function offCardInfo(name) {
    const slot = (selectedRow?.slots ?? []).find((x) => x.window_name === name);
    const lines = [{ label: t('hubHoverState'), value: t('hubStopped') }];
    if (slot?.command) lines.push({ label: t('hubHoverModel'), value: slot.command });
    if (selectedRow?.project.path) lines.push({ label: t('hubHoverPath'), value: selectedRow.project.path });
    return { title: name, lines, note: filterNote(name) };
  }
  /** The mode names itself and its way out where the pointer already is. */
  function filterNote(name) {
    return filterAgent === name ? t('hubFilterOnNote') : '';
  }

  // Native keyboard clicks have no pointer point; keep their context menu at the card.
  function pointOf(e) {
    const trigger = e.currentTarget;
    if (!e.clientX && !e.clientY) {
      const rect = trigger.getBoundingClientRect();
      return { x: rect.left, y: rect.bottom, trigger };
    }
    return { x: e.clientX, y: e.clientY, trigger };
  }
</script>

{#if selected}
  <div class="roster tab-strip" class:compact>
    <div class="cards edge-fade" class:expanded class:filtering={!!filterAgent} class:reveal={justLoaded} class:reordering={!!cardDrag} id={cardsId} bind:this={cardsEl} use:scrollEdges={{ active: !expanded, wrapped: 'expanded', onoverflow: (over) => { overflowing = over; }, key: markerKey }}
      role="group" aria-label={t('agentsTitle')}
      onpointerenter={(e) => { hovering = e.pointerType !== 'touch'; }}
      onpointerleave={() => { hovering = false; clearPress(); }}
      onpointerdown={beginPress} onpointerup={clearPress} onlostpointercapture={clearPress}
      onpointermove={(e) => cardDrags.move(e)}
      onscroll={() => { if (cardDrag) cardDrags.cancel(); }}
      onpointercancel={clearPress} onclickcapture={clearPress}
      onfocusin={() => { focused = true; }}
      onfocusout={(e) => { focused = !!e.relatedTarget && e.currentTarget.contains(e.relatedTarget); if (!focused) clearPress(); }}>
      <!-- Only while there is nothing to show: with cards already rendered the
           three shimmering placeholders sat in front of them (owner, 2026-09-23:
           "Agent 卡片都已经渲染出来了，前面还有 3 个空的过渡动画"). -->
      {#if !roomReady && !managedAgents.length && !stopped.length}
        <div class="skel-wrap sk-cards" aria-hidden="true">
          <span class="skel sk-card"></span><span class="skel sk-card"></span><span class="skel sk-card"></span>
        </div>
      {/if}

      <!-- The DESTINATIONS: the All tab and the live agents, the group the
           multi-select enclosure belongs to. It is a group, not the row: the
           +, a stopped identity and the empty space after them are not
           destinations, and framing them was what made the All enclosure "有点
           过分大了" (owner, 2026-09-22). -->
      <div class="tabs tab-group" class:all-lit={allLit} use:slideIndicator={{ key: markerKey, active: markerTarget, hidden: expanded || !markerTarget }}>
      <!-- Everyone: the PINNED tab at the strip's head (board #236, owner,
           2026-09-22: "不用隐藏，我不展开就看不到吧…都显示全了"). Chrome pins a
           tab as an icon-only tab at the far left; this is that — always in
           view, avatar-sized glyph, and a destination like the cards so it
           wears the same tab paint (lit when All IS the recipient). Hovering
           or focusing it PREVIEWS the choice: every live card lights as it
           would after the click (owner: "鼠标悬停…看到的就是所有的 Agent 被选中或
           者激活"). The glyph is `bots` — a small CROWD of the same bot mark a
           single agent wears, so "all the agents" needs no new species (owner,
           2026-09-22: "画成 Agent 类似的 Logo"; 2026-09-23: "可以多画几个机器人";
           the group-of-people and collab's orbiting dots both failed the glance
           test). `bare`: the tab is the paint, the command adds none (#180:
           never a card — no data-agent, no Stop, no meter). -->
      <span class="all-choice acard strip-tab" class:sel={recipient === ALL_TARGET} role="presentation"
        onpointerenter={(e) => { if (e.pointerType !== 'touch') allPreview = true; }} onpointerleave={() => { allPreview = false; }}
        onfocusin={() => { allPreview = true; }} onfocusout={() => { allPreview = false; }}
        oncontextmenu={(e) => { e.preventDefault(); if (selected && roomReady) onallcontext(cardAnchor(e.currentTarget)); }}
        use:longpress={{ onlongpress: (at) => { if (selected && roomReady) onallcontext(at); } }}>
        <CommandButton variant="icon" icon="bots" label={t('hubEveryone')} pressed={recipient === ALL_TARGET} bare
          hasPopup={recipient === ALL_TARGET ? 'menu' : undefined}
          expanded={recipient === ALL_TARGET ? allMenuOpen : undefined}
          disabled={!selected || !roomReady} ariaDisabled={!targetable(ALL_TARGET)} onclick={onall} />
      </span>
      {#each groups as group (group.key)}
      {@const named = namedGroup(group)}
      <div class="roster-cluster" class:team={named} class:team-lit={named && recipient === teamTarget(group.team)} data-team={named ? group.team : undefined}
        data-drop={cardDrag ? (group.team ?? '-') : undefined} class:drop-target={!!cardDrag && cardDrag.target === (group.team ?? '')}
        role={named ? 'group' : undefined} aria-label={named ? `${t('teamsTitle')} ${group.team}` : undefined}
        animate:flip={{ duration: moveMs() }}>
        {#if named}
          <button type="button" class="team-label"
            aria-pressed={recipient === teamTarget(group.team)}
            aria-disabled={targetable(teamTarget(group.team)) ? undefined : 'true'}
            aria-label={t('hubToTeamLong').replace('{name}', group.team)}
            aria-haspopup="menu"
            use:hoverInfo={() => ({ title: group.team })}
            onclick={() => setRecipient(teamTarget(group.team))}
            oncontextmenu={(e) => { e.preventDefault(); onteamcontext(pointOf(e), group.team); }}
            use:longpress={{ onlongpress: (at) => onteamcontext(at, group.team) }}>
            <span class="team-name">{group.team}</span>
          </button>
        {/if}
      {#each group.members as a (a.name)}
        {@const mentioned = extras.includes(a.name) || extras.includes(ALL_TARGET)}
        {@const pending = interrupting.includes(a.name)}
        <!-- Selection and interruption are sibling native targets, never nested buttons. -->
        <div class="acard strip-tab" role="group" data-agent={a.name} class:sel={isAddressed(a.name)} class:filtered={filterAgent === a.name} class:stop-shown={showStop(a.name)}
          class:lifted={cardDrag?.name === a.name} style:transform={cardDrag?.name === a.name ? `translate(${cardDrag.dx}px, ${cardDrag.dy}px)` : null}
          class:appear-pop={!!rosterBase && !rosterBase.has(a.name)} animate:flip={{ duration: moveMs() }}
          onpointerenter={(e) => arm(a.name, e.pointerType)} onpointerleave={() => disarm(a.name)}
          onfocusin={() => arm(a.name)} onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) disarm(a.name); }}>
          <button type="button" class="agent-select"
            aria-pressed={isAddressed(a.name)}
            aria-disabled={targetable(a.name) ? undefined : 'true'}
            aria-label={[`${a.name} · ${stateLabel(a.state)}`, a.team, detailLabel(a.detail), vitalsLine(a.vitals), unread.has(a.name) ? t('hubUnread') : '', mentioned ? t('hubToAlsoHint').replace('{names}', `@${a.name}`) : '', filterAgent === a.name ? t('hubFilterItem') : ''].filter(Boolean).join(' · ')}
            use:hoverInfo={() => cardInfo(a)}
            onclick={(e) => clickAgent(e, a.name)} ondblclick={(e) => focusAgent(e, a.name)}
            onpointerdown={(e) => cardDrags.down(e, { name: a.name, scope: moveScope })}
            onpointerup={() => cardDrags.up()} onpointercancel={() => cardDrags.cancel()}
            oncontextmenu={(e) => { e.preventDefault(); oncontext(pointOf(e), a.name, touchInfo(() => cardInfo(a))); }}
            use:longpress={{ onlongpress: (at) => oncontext(at, a.name, touchInfo(() => cardInfo(a))) }}>
            <span class="avatar-slot">
              {#if backendIcon(a.agent)}<img class="ava" src={backendIcon(a.agent)} alt={a.agent} />{:else}<span class="ava" style:background={backendColor(a.agent)}>{a.name.slice(0, 1).toUpperCase()}</span>{/if}
              {#if a.vitals?.context_pct != null}
                {@const pct = Math.max(0, Math.min(100, a.vitals.context_pct))}
                <span class="ctx-ring" role="meter" aria-label={t('hubCtxUsed')}
                  aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct} aria-valuetext={`${a.vitals.context_pct}%`}
                  style:--ctx-amount={`${pct}%`} style:--ctx-color={ctxColor(a.vitals.context_pct)}></span>
              {/if}
            </span>
            <span class="a-name strip-label" style:--who-ink={agentHue(a.name)}>{a.name}<span class="ac-top"><span class="st" class:live-dot={stateIsLive(a.state)} style:background={stateDotColor(a.state, a.detail)}></span></span></span>
            <span class="agent-marks" class:unmarked={!mentioned && !unread.has(a.name)}>
              {#if mentioned}<span class="agent-mention" aria-hidden="true">@</span>{/if}
              {#if unread.has(a.name)}<span class="unread-dot appear-pop" aria-hidden="true"></span>{/if}
            </span>
            {#if expanded && a.vitals?.context_pct != null}<span class="ctx-value">{a.vitals.context_pct}%</span>{/if}
          </button>
          {#if showStop(a.name)}
            <!-- The dot BECOMES the Stop: the danger icon command (a dense 28px
                 slot, compact-tools) centred where the dot was, taking no width —
                 the card never changes size (owner, 2026-09-20: "终止按钮应该是红色的
                 吧，更符合语义"; board #205; replaces #195's resident quiet Stop).
                 bare: no wash — the card under it already carries the hover;
                 the red glyph is the whole control (owner, 2026-09-20: "停止按钮就
                 不用加背景了，就红色方块我直接点就行"; board #211). -->
            <span class="agent-stop compact-tools" class:pending use:overDot>
              <CommandButton label={`${t('hubInterrupt')} ${a.name}`} icon="stop" variant="danger" iconOnly bare
                {pending} disabled={pending}
                onclick={(e) => { e.stopPropagation(); interrupt(a.name); }} />
            </span>
          {/if}
        </div>
      {/each}
      </div>
      {/each}
      <!-- ONE HIGHLIGHT THAT TRAVELS (motion principle 14): the lit
           enclosure — fill, edge, both feet, the join into the band — is
           this one marker, placed by slideIndicator, gliding from the old
           destination to the new one. A card, a team and All are the same
           marker at a different width. Last in the group so the All tab
           stays its first child; it paints beneath the cards by z-index. -->
      {#if !expanded && markerTarget}
        <span class="slide-pill tab" class:raised={litInGroup} aria-hidden="true">
          <span class="tab-shape" use:tabShape><svg><path class="tab-fill" /><path class="tab-edge" /></svg></span>
        </span>
      {/if}
      <!-- The measurement box for All: the group's own extent. -->
      <span class="tabs-extent" aria-hidden="true"></span>
      </div>
      {#if cardDrag?.from && !looseShown}
        <!-- The standalone drop target when no standalone card is shown
             (board #384): only while a card in a team is carried, outside
             the destinations group (it is a place to drop, not a tab). -->
        <div class="roster-cluster standalone-slot appear" data-drop="-" class:drop-target={cardDrag.target === ''}>
          <span class="team-label">{t('hubMoveStandalone')}</span>
        </div>
      {/if}
      {#each offTeams as group (group.team)}
        <!-- A stopped team (board #287): its name opens the team menu, whose
             Start brings the team back from its current definition. Not a
             destination — nobody is running to talk to. -->
        <div class="roster-cluster team off" data-team={group.team} role="group" aria-label={`${t('teamsTitle')} ${group.team} · ${t('hubStopped')}`}
          animate:flip={{ duration: moveMs() }}>
          <button type="button" class="team-label" aria-haspopup="menu" disabled={acting}
            aria-label={`${group.team} · ${t('hubStopped')}`}
            use:hoverInfo={() => ({ title: group.team, lines: [{ label: t('hubHoverState'), value: t('hubStopped') }] })}
            onclick={(e) => onteamcontext(cardAnchor(e.currentTarget), group.team)}
            oncontextmenu={(e) => { e.preventDefault(); onteamcontext(pointOf(e), group.team); }}
            use:longpress={{ onlongpress: (at) => onteamcontext(at, group.team) }}>
            <span class="team-name">{group.team}</span>
          </button>
          {#each group.members as name (name)}
            <div class="acard strip-tab off" data-agent={name} class:filtered={filterAgent === name} class:appear-pop={!!rosterBase && !rosterBase.has(name)} animate:flip={{ duration: moveMs() }}>{@render offSelect(name)}</div>
          {/each}
        </div>
      {/each}
      {#each offLoose as name (name)}
        <div class="acard strip-tab off" data-agent={name} class:filtered={filterAgent === name} class:appear-pop={!!rosterBase && !rosterBase.has(name)} animate:flip={{ duration: moveMs() }}>{@render offSelect(name)}</div>
      {/each}
      <!-- A stopped identity offers context actions, never a card-wide restart.
           Owner, 2026-09-05: "头像应该使用我们正常设定的 Agent 头像，并且变成灰色".
           One card body for a loose stopped identity and a stopped team's
           member (#287); `animate:` must stay on the each's own child. -->
      {#snippet offSelect(name)}
        {@const backend = slotBackend(name)}
          <button type="button" class="agent-select" disabled={acting}
            aria-label={[name, t('hubStopped'), filterAgent === name ? t('hubFilterItem') : ''].filter(Boolean).join(' · ')} aria-haspopup="menu"
            use:hoverInfo={() => offCardInfo(name)}
            onclick={(e) => stoppedMenu(e, name)} ondblclick={(e) => focusAgent(e, name, true)}
            oncontextmenu={(e) => { e.preventDefault(); oncontext(pointOf(e), name, touchInfo(() => offCardInfo(name))); }}
            use:longpress={{ onlongpress: (at) => oncontext(at, name, touchInfo(() => offCardInfo(name))) }}>
            <span class="avatar-slot">
              {#if backendIcon(backend)}<img class="ava dim" src={backendIcon(backend)} alt={backend} />{:else}<span class="ava dim">{name.slice(0, 1).toUpperCase()}</span>{/if}
            </span>
            <span class="a-name strip-label">{name}</span>
          </button>
      {/snippet}
      <!-- Spawning opens a closed project too; keep its entry even in an empty room. -->
      <div class="roster-add">
        <CommandButton icon="plus" variant="icon" label={t('hubSpawn')} onclick={onadd} />
      </div>
    </div>
    {#if overflowing}
    <div class="roster-toggle">
      <CommandButton icon="chevron-up" variant="icon" label={expanded ? t('hubRosterCollapse') : t('hubRosterExpand')}
        {expanded} controls={cardsId} disabled={!roomReady} onclick={onexpand} />
    </div>
    {/if}
  </div>
{/if}

<style>
  .roster {
    --roster-avatar-size: 18px;
    --roster-ring-size: 24px;
    --roster-all-icon-size: 20px;
    --roster-ring-stroke: 2px;
    --roster-card-inset: 4px;
    /* Room after the dot for the Stop that replaces it (#205): the 28px
       compact-tools slot (its hit box, and the outer edge of its focus ring;
       the paint is 20px inside it) centred on the 6px dot reaches 14px past
       the dot's centre; 28/2 − 6/2 + the card's 1px inset border = 12px ends
       the slot at the inner edge of the border. Constant, not hover-only, so
       revealing the Stop never reflows the row (owner, 2026-09-20: "状态小点右侧
       好像没有留边距…停止按钮都超出 agent 卡片框了"; board #211). */
    --roster-dot-reserve: 12px;
    --roster-gap: 2px;
    --roster-control-gap: 2px;
    --roster-expanded-max: min(240px, calc(32dvh / var(--ui-zoom, 1)));
    position: relative;
    display: grid; grid-template-columns: minmax(0, 1fr) var(--control-height);
    gap: 0; flex: 0 1 auto; min-width: 0; min-height: 0;
    padding: 0 var(--composer-inset) 0 0;
    /* The frame and its floor line are the shared strip's (`.tab-strip`,
       app.css, #365). The band's TOP EDGE is the strip's floor pixel: the
       faint bubble line runs the full width and meets the band's own side
       edges, and every lit enclosure breaks it with its fill and turns into
       it through its feet — Chrome's toolbar line (owner, 2026-09-23: "圆弧
       连接的整个 Agent 框上面的输入区，应该有一条横着的淡淡的白线延伸"). Over
       the frame alone the translucent line came out a third dimmer than the
       tab edge it continues (measured lum 46 vs 65, dark) and read thinner
       ("粗细好像也不一样", owner, 2026-09-23), hence its row of band fill. */
    container: roster / inline-size;
  }
  /* The strip starts at its scrollport inset; the field keeps its normal inset.
     The tab strip sits on the tab FRAME; the composer below is the BAND
     (owner's Chrome screenshot, 2026-09-22: the active tab and the toolbar
     are ONE FILL, the omnibox its own field inside — "从颜色上把它们变成一体…
     底下的框是一个单独的一个输入框"). The join is colour, never a hairline —
     the first round said "attached" with lines and left a gap under every lit
     tab ("一堆缺口，看起来好奇怪").
     Round 5 sets the two ends of the step: the band/tab fill is the AGENT
     BUBBLE's own brightness (--bubble-in) with the bubble's own faint edge
     (--bubble-line) — "和 Agent 返回给我的消息框的亮度色彩差不多就可以…整体加
     一个稍微淡白色的边" — and the contrast comes from the FRAME going darker
     beneath, not the tab going brighter ("会不会有点过亮了？…把其他地方变得更
     暗"). */
  .cards {
    display: flex; align-items: center; gap: var(--roster-gap); overflow-x: auto; scrollbar-width: none;
    min-width: 0; min-height: 0; padding: 0 2px 0 var(--tab-foot);
  }
  /* The destinations group: sized to its content, so the multi-select
     enclosure ends after the last tab instead of framing the + and the empty
     space behind it (owner, 2026-09-22: "不要把加号后面的这些区域也都框出来").
     `flex: none` is load-bearing in the single-row strip: as a shrinkable item
     of the scrolling `.cards`, the group absorbed all the negative space once
     the tabs overflowed while its own `flex: none` cards did not — the cards
     spilled out of the group and the stopped cards and the + drew ON TOP of
     them (review, 2026-09-22, measured in Chromium at 300px with four 90px
     tabs: group right 198 vs. last tab right 368, stopped card left 200).
     The wrapped list is the opposite case: there the group SHOULD shrink to
     the container and wrap inside itself. */
  .tabs { display: flex; align-items: center; gap: var(--roster-gap); flex: none; position: relative; z-index: 0; }
  .cards.expanded .tabs { flex: 0 1 auto; min-width: 0; flex-wrap: wrap; align-content: start; }
  /* The tab chain spans the strip's full height: a tab is attached to the
     FLOOR, so its box must reach it. Centred at its 34px minimum, it floated
     whenever any sibling made the strip taller — the owner's macOS build
     showed the floor line running under both feet and the arcs landing about
     a pixel above it (2026-09-23, 15:07). The + and the disclosure stay
     centred. */
  .cards:not(.expanded) .tabs, .cards:not(.expanded) .roster-cluster, .cards:not(.expanded) .acard { align-self: stretch; }
  /* The group is one flex item in the scrolling strip; solos use the same
     wrapper without group chrome. Its baseline sits BEHIND a lit tab, whose
     fill covers the line and whose raised edge opens into the composer. */
  .roster-cluster { display: flex; align-items: center; gap: var(--roster-gap); flex: none; position: relative; }
  .roster-cluster.team { margin-inline: var(--roster-gap); padding-inline: var(--roster-gap); }
  .cards:not(.expanded) .roster-cluster.team::before {
    content: ''; position: absolute; inset: auto var(--roster-gap) 0;
    height: calc(var(--roster-gap) / 2); background: var(--text2); pointer-events: none; z-index: -1;
  }
  /* The group's name is a WORD, not a block: the pill grew with the name and
     read as a big square beside the small tabs (owner, 2026-09-24: "小组名有一
     个方块，这个方块有时候太大…直接显示名字就好"). Still a native button with
     the full target; it speaks through ink alone — the inactive tabs' --text2,
     the lit tabs' --text on hover and when the team is the recipient. */
  .team-label {
    display: inline-flex; align-items: center; min-height: var(--control-height);
    padding-inline: var(--ui-gap); border-radius: var(--ui-radius-row);
    border: 0; white-space: nowrap; color: var(--text2); background: none; cursor: pointer;
    font: 600 var(--fs-meta)/1 var(--font-display);
    transition: color var(--t-move) ease;
    /* No native tap flash: the platform's grey block on touch was the "方块"
       the owner saw at the instant of tapping the name (2026-09-25). */
  }
  .team-label:hover, .team-label[aria-pressed="true"] { color: var(--text); }
  .team-label:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 1px; }
  .roster.compact .team-label { min-width: var(--control-height); min-height: var(--control-height); max-width: calc(2 * var(--control-height)); }
  .team-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .roster-cluster.team.off .team-label { color: var(--text3); }
  /* The wrapped (expanded) list is a list: there a lit team is a closed
     rounded box of its own, and its member cards draw no border inside it. In
     the single-row strip the marker below carries the enclosure. */
  .cards.expanded .roster-cluster.team-lit { background: var(--bubble-in); border-radius: var(--ui-radius-panel); }
  .cards.expanded .roster-cluster.team-lit::after {
    content: ''; position: absolute; inset: 0; border: 1px solid var(--bubble-line);
    border-radius: inherit; pointer-events: none;
  }
  /* Dragging a card onto a team (board #384), in the rail's drag grammar:
     the carried card is LIFTED and follows the pointer by transform; the
     group under it is enclosed in the accent line; nothing else hovers while
     carrying. The lift is the strip's own tab paint (`::before`): the lit
     tab's OPAQUE fill, the accent line, the menu shadow. The address row's
     translucent accent wash let the card it passed over read through it
     (live proof, 2026-10-15: "o[ps1] solo"), and the select button has no
     border to colour. */
  .cards.reordering { cursor: grabbing; user-select: none; }
  .cards.reordering .acard:not(.lifted) .agent-select { pointer-events: none; }
  .acard.lifted { position: relative; z-index: 2; --card-paint: var(--tab-fill); --card-line: var(--accent-line); }
  /* The tab group is its own stacking context (z-index 0, so the marker stays
     beneath the cards); while carrying it rises above its siblings, or the
     Standalone slot and the stopped teams after it would paint over the
     carried card (live proof, 2026-10-15). */
  .cards.reordering .tabs { z-index: 1; }
  .acard.lifted::before { box-shadow: var(--menu-shadow); }
  .roster-cluster.drop-target::after {
    content: ''; position: absolute; inset: 0; border: 1px solid var(--accent);
    border-radius: var(--ui-radius-panel); pointer-events: none;
  }
  .cards:not(.expanded) .roster-cluster.team.drop-target::before { background: var(--accent); }
  .standalone-slot .team-label { cursor: inherit; }
  .cards.expanded .roster-cluster.team-lit .acard::before { background: transparent; border-color: transparent; }
  .tabs.all-lit .roster-cluster.team::before { display: none; }
  .cards.expanded .roster-cluster.team { flex: 0 1 100%; min-width: 0; flex-wrap: wrap; }
  /* MULTI-SELECT IS ONE ENCLOSURE (owner, 2026-09-22: "如果是选择多个 Agent，
     就用一个大的包边。注意 Agent 和 Agent 之间的卡片不要有很多线拐来拐去，就是
     一个大的包边"): under All — and while the All tab previews it — the
     DESTINATIONS GROUP is the lit tab, one fill and one edge around it, and
     the per-card paint switches off. Every internal line is gone by
     construction, not by patching borders between siblings. In the strip
     the marker grows to the group's extent; the wrapped list closes it as a
     box of its own. */
  .cards.expanded .tabs.all-lit::before {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: var(--bubble-in); border: 1px solid var(--bubble-line); border-radius: var(--ui-radius-panel);
  }
  .cards.expanded .tabs.all-lit .acard::before { background: transparent; border-color: transparent; }
  .tabs-extent { position: absolute; inset: 0; pointer-events: none; }
  /* ONE HIGHLIGHT THAT TRAVELS (motion principle 14; owner, 2026-09-23:
     "切换的动画不是很丝滑…先标了一个框，然后又闪过去了"): the lit enclosure —
     fill, edge, both feet and the join into the band — is ONE marker, the
     shared `.slide-pill` placed by `slideIndicator`, that glides from the old
     destination to the new one on --t-move (transform and width, the atom's
     own allowance). Before, each card lit in place: its fill crossfaded
     while its feet and floor popped, which read as a frame appearing and
     then flashing away. The marker sits under the cards and over the group
     baseline: both are z -1 in the group's stacking context, and the marker
     comes later in the DOM, so the baseline shows exactly where the marker
     is not. */
  /* THE SILHOUETTE IS ONE PATH (owner, 2026-09-27: "这个拐角还是不够连续 感觉
     线错位了…能不能用最标准的方式"): Chrome's own construction — outward foot,
     side, rounded top, side, foot — filled once and stroked once
     (`ui/tab-shape.ts`). It replaces a bordered box, two radial-gradient
     feet, their bordered rings and a join layer, four rasterisations that had
     to meet: the side border snapped to device pixels while the ring's arc
     and the gradient's hard stop did not, so at a fractional scale the arc
     landed beside the side stroke and the gradient edge was jagged. The
     drawing box is the paint box (below the card's paint inset, down to the
     floor row) widened by one foot on each side — the feet reach into the
     neighbours' empty bottom corners — and one pixel into the band, where the
     fill overlaps the junction. The radii stay tokens: the card tier (also
     the 24px context ring's curvature — the panel radius read as a half
     circle on a 32px tab, owner 2026-09-23) and the 8px foot (a 4px arc at a
     1px stroke was a staircase). Only the stroke colour crossfades; the
     geometry moves with the marker. */
  /* A lit member inside a group wears the raised neutral contour (#238). */
  .slide-pill.tab.raised { --card-line: var(--text2); }
  .cards:not(.expanded)::-webkit-scrollbar { display: none; }
  .cards.expanded {
    flex-wrap: wrap; align-content: start;
    max-height: var(--roster-expanded-max); overflow-x: hidden; overflow-y: auto; scrollbar-width: thin;
  }
  .sk-cards { display: flex; gap: var(--roster-gap); flex: none; grid-column: 1 / -1; }
  .sk-card {
    width: calc(3 * var(--control-height)); height: var(--tab-paint-height);
    margin-block: var(--control-paint-inset); border-radius: var(--ui-radius-row);
  }
  /* A card is a TAB (board #236, owner: "做成类似 Chrome tab 栏的样式？选中哪一个，
     哪一个就是亮的，其他在旁边"). At rest: nothing — a name on the frame.
     Hover: the quiet wash. Selected: the bubble fill and the bubble edge,
     top corners rounded, reaching the strip's floor where the band begins —
     one enclosure from tab into band. */
  /* Chrome dims an inactive tab's LABEL as well as its fill — two signals for
     one state, which is what makes the lit tab read at a glance (owner,
     2026-09-22: "选中和没有选中的…差异更明显一点"). The avatar, status dot and
     context ring keep their colours: they are live facts, not chrome. */
  /* A live card's name wears its agent ink (agentHue, board #292); an unlit
     tab keeps the dimming above by mixing that ink toward the same --text2. */
  .acard:not(.off) .a-name { color: var(--who-ink, inherit); }
  .tabs:not(.all-lit) .acard:not(.sel):not(.off) .a-name { color: color-mix(in srgb, var(--who-ink) 55%, var(--text2)); }
  /* In the single-row strip the lit card paints NOTHING of its own — the
     marker carries the enclosure — and the hover wash stays on the unlit
     cards, as in Chrome. The wrapped (expanded) list is a list, so there a
     lit card stays a closed rounded box of its own. */
  .cards.expanded .acard.sel { --card-paint: var(--bubble-in); --card-line: var(--bubble-line); }
  /* The one-agent reading filter is shown IN the strip: the filtered card
     keeps its light and every other destination dims — no banner above the
     feed and no ✕ to find (owner, 2026-09-23: "把当前的卡片直接亮起，其他全部
     变暗"). Double-clicking the card again, or its menu's Show everything,
     leaves the mode. The tab paint is untouched: dimming says "not in view",
     the paint still says who you are talking to. */
  .agent-select, .team-label, .all-choice { transition: opacity var(--t-move) ease; }
  .cards.filtering .acard:not(.filtered) .agent-select,
  .cards.filtering .team-label,
  .cards.filtering .all-choice { opacity: var(--control-disabled-opacity); }
  .ctx-ring {
    position: absolute; left: 0; top: 0;
    width: var(--roster-ring-size); height: var(--roster-ring-size); border-radius: 50%;
    background: conic-gradient(var(--ctx-color) var(--ctx-amount), var(--border) 0);
    mask: radial-gradient(farthest-side, transparent calc(100% - var(--roster-ring-stroke)), var(--control-overlay-dark) 0);
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) { .acard::before, .agent-select, .team-label, .all-choice { transition: none; } }
  .cards.expanded .acard { max-width: 100%; }
  .agent-select {
    position: relative;
    display: flex; align-items: center; gap: var(--roster-control-gap);
    min-height: var(--control-height); min-width: var(--control-height);
    border: 0; border-radius: var(--ui-radius-row); background: transparent; color: inherit;
    padding: 0 var(--roster-card-inset); text-align: left; cursor: pointer; font-size: var(--fs-ui);
  }
  .agent-select:focus-visible { outline-color: var(--accent-ink); outline-offset: 0; }
  /* Only a live card carries a dot, so only it reserves the Stop's room. */
  .acard:not(.off) .agent-select { padding-inline-end: var(--roster-dot-reserve); }
  .cards.expanded .a-name {
    min-width: 0; white-space: normal; overflow-wrap: anywhere;
    padding-block: var(--control-paint-inset);
  }
  /* The dot lives INSIDE the name's line, 5px after its last glyph, with
     vertical-align: middle — by definition the box's midpoint on the baseline
     plus half the x-height, i.e. centred on the lowercase letters whatever
     the font's ascent/descent. As a flex sibling it was centred on the LINE
     box, ~1px off and font-dependent, 1–2px from the name (owner, 2026-09-13:
     "状态小点稍微有点挨得近了，而且上下不居中"; board #195). */
  .ac-top { display: inline-flex; vertical-align: middle; margin-inline-start: 5px; }
  .agent-marks { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; min-width: 1em; flex: none; }
  .agent-marks.unmarked { display: none; }
  /* The filter's mark: the funnel its menu row wears, in the marks' accent
     ink — with the other cards dimmed, it says WHICH agent the feed is
     narrowed to, not only that something changed (owner, 2026-09-23: "只是颜色
     变暗了，没有任何提示…这个 Filter 和正常状态的差异太小了"; then "放大镜好像不
     太好…用平常我们那种沙漏过滤的样式"). Its own flex child, not a row of the
     marks column: three stacked marks would exceed the strip and grow it. */
  .agent-mention { color: var(--accent-ink); font-family: var(--font-mono); font-size: var(--fs-meta); font-weight: 600; }
  /* Stop stands on the dot: absolutely placed by overDot, so it never widens
     the card (#180's concern) and the dot yields to it while shown. */
  .agent-stop { position: absolute; z-index: 1; left: var(--dot-x, 50%); top: var(--dot-y, 50%); transform: translate(-50%, -50%); display: flex; align-items: center; }
  .acard.stop-shown .ac-top { visibility: hidden; }
  /* Coarse geometry (32px paint, 36px targets, 2px inset) is the shared
     strip's (`.tab-strip`, app.css): the owner's 2026-09-23/24 rulings for
     this row now hold for every tab strip. */
  .avatar-slot { position: relative; width: var(--roster-ring-size); height: var(--roster-ring-size); display: grid; place-items: center; flex: none; }
  .ava { width: var(--roster-avatar-size); height: var(--roster-avatar-size); flex: none; border-radius: 50%; object-fit: contain; display: grid; place-items: center; }
  .ctx-value { width: 4ch; flex: none; text-align: right; font: var(--fs-meta)/1 var(--font-mono); color: var(--text2); white-space: nowrap; }
  /* The overflow probe reads the single row with the list's figures still in
     the DOM: they belong to the wrapped list only (#266). */
  .cards:not(.expanded) .ctx-value { display: none; }
  .off { color: var(--text2); }
  .ava.dim { background: var(--surface2); color: var(--text3); }
  img.ava.dim { background: none !important; filter: grayscale(1); opacity: 0.55; }
  .roster-add { display: flex; align-items: center; flex: none; min-height: var(--control-height); }
  /* Three faces need their own readable icon size, independent of tab spacing. */
  .all-choice { --control-icon-size: var(--roster-all-icon-size); }
  .all-choice :global(.command-icon svg) { width: 100%; height: 100%; }
  /* Tight on fine pointers; the coarse branch keeps a full finger target. */
  .all-choice :global(.command-button.icon-only) { width: auto; min-width: 0; padding-inline: 2px; }
  /* Touch restores the square: there the box IS the target, not the paint.
     Declared after the tight rule — same specificity, later wins. */
  @media (any-pointer: coarse) {
    .all-choice :global(.command-button.icon-only) { width: var(--control-height); min-width: var(--control-height); padding-inline: 0; }
  }
  /* The TAB carries the selected paint; the command inside stays washless
     (engaged would put a colour block back inside the tab) — its accent ink
     is the pressed signal that remains. The override has to name the
     engaged HOVER and ACTIVE states too: CommandButton's own rules for them
     outrank a bare `.engaged` override, so the wash came back on hover and,
     on a phone, stuck after every tap (owner, 2026-09-25: "选中状态下按钮好像有
     一个背景色"). */
  .all-choice :global(.command-button.engaged),
  .all-choice :global(.command-button.engaged:hover:not(:disabled)),
  .all-choice :global(.command-button.engaged:active:not(:disabled)) { --command-paint: transparent; }
  /* No spare row above the tabs: the disclosure is exactly the card's hit-box
     height, so the coarse strip stops at its 44px touch floor. */
  .roster-toggle { display: flex; align-self: end; align-items: center; height: calc(var(--tab-paint-height) + 2 * var(--control-paint-inset)); }
</style>

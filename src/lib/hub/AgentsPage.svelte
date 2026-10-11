<script>
  import { untrack } from 'svelte';
  import { registerLeaveGuard } from '../app/leave-guards.ts';
  import { useServerScope } from '../app/server-context.ts';
  // AgentsPage — the agent configuration page, in the Hub page format
  // (ui-unification.md "Page skeleton"): a real sidebar (bg2, .side-h,
  // .side-row entries) + a main column with a .page-head. Definitions
  // (backend, model, persona, skills, MCP servers, hire permission) are
  // edited HERE and only here; the Hub consumes them.
  import Icon from '../ui/Icon.svelte';
  import SideHandle from '../ui/SideHandle.svelte';
  import { scrollFade } from '../core/scrollFade.ts';
  import { t } from '../core/i18n.svelte.ts';
  import { renderMarkdown } from '../core/markdown.ts';
  import { backendColor as colorOf } from '../hub/hub.ts';
  import { moveMs, revealMs } from '../ui/motion.ts';
  import { hoverInfo } from '../ui/hover.ts';
  import Select from '../ui/Select.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import Switch from '../ui/Switch.svelte';
  import CheckboxGroup from '../ui/CheckboxGroup.svelte';
  import { activeModal } from '../ui/modal.ts';
  import { configFingerprint, configPayload, configValid } from './config-draft.ts';

  // The backends a registry agent can run on and the effort levels each
  // accepts come from the SERVER (`backends_list`, board #130) — the client
  // kept hand mirrors of both and the effort one had drifted (omp was
  // missing). Read on each reload so a list that arrived after the page
  // painted still lands; core/agents.ts holds the older-server fallback.
  //
  // The server is this subtree's (board #335 ②b-3), read once at init: its
  // runtime for the leave guard and the RPCs, its state for that server's
  // backend catalog. On the rail that is the page's subtree; inside
  // Preferences it is the guest scope App gives the embedded editor.
  const scope = useServerScope();
  if (!scope) throw new Error('AgentsPage needs a server scope');
  const guardOwner = scope.runtime;
  const { registryList, registrySave, registryDelete, modelsList, skillsList, skillsSave, skillsDelete, skillsRefresh, skillsImport, skillsFiles, skillsFile, mcpList, mcpSave, mcpDelete, teamsList, teamsSave, teamsDelete, globalPromptGet, globalPromptSet } = guardOwner.api;
  const catalog = scope.state.backends;
  const { icon: backendIcon, spawnable: spawnableBackends, defaultBackend, efforts: backendEfforts, switchesInputMode: backendSwitchesInputMode, onChange: onServedBackends, known: servedBackendsKnown } = catalog;
  const backendColor = (backend) => colorOf(backend, catalog);
  let backends = $state(spawnableBackends());
  // `section` narrows the page to ONE kind — 'agents' | 'teams' | 'skills' |
  // 'mcp' — for the phone's Settings, where each is its own second-level page
  // (owner, 2026-09-02: "把 team agent mcp skill 分开几个二级设置页面吧，在手机
  // 上"). null = the desktop page: the sidebar lists the CATEGORIES (global
  // instructions, agents, teams, skills, MCP) and the main column shows the
  // chosen one's rows, then its editor (owner, 2026-09-04: "左边侧边栏先写配置
  // 条目 右边展示详细内容 不要全堆在一起了").
  let { visible = false, onGoBack = null, editRequest = null, onDrilled = null,
    onGuardExit = null, guardPage = '', section: requestedSection = null } = $props();
  let section = $state(untrack(() => requestedSection));
  const SECTION_META = {
    agents: ['agentsTitle', 'agentsHint'],
    teams: ['teamsTitle', 'teamsHint'],
    skills: ['skillsTitle', 'skillsHint'],
    mcp: ['mcpTitle', 'mcpHint'],
  };
  // The desktop's categories (the sidebar's rows). `count` feeds the row's
  // trailing figure; `start` is the "+" in the category page's head.
  const CAT_KEY = 'tmux_agents_cat';
  const CAT_META = {
    global: { label: 'agentsGlobal', hint: 'settingsGlobalHint', add: 'edit', start: () => startGlobal() },
    agents: { label: 'agentsTitle', hint: 'settingsAgentsHint', add: 'agentsNew', start: (x) => startEdit(x) },
    teams: { label: 'teamsTitle', hint: 'settingsTeamsHint', add: 'teamsNew', start: (x) => startTeam(x) },
    skills: { label: 'skillsTitle', hint: 'settingsSkillsHint', add: 'skillsNew', start: (x) => startSkill(x) },
    mcp: { label: 'mcpTitle', hint: 'settingsMcpHint', add: 'mcpNew', start: (x) => startMcp(x) },
  };
  const CATS = $derived([
    { id: 'global', label: 'agentsGlobal', hint: 'settingsGlobalHint', count: null },
    { id: 'agents', label: 'agentsTitle', hint: 'settingsAgentsHint', count: () => String(defs.length) },
    { id: 'teams', label: 'teamsTitle', hint: 'settingsTeamsHint', count: () => String(teams.length) },
    { id: 'skills', label: 'skillsTitle', hint: 'settingsSkillsHint', count: () => String(skills.length) },
    { id: 'mcp', label: 'mcpTitle', hint: 'settingsMcpHint', count: () => String(mcps.length) },
  ]);
  const storedCat = typeof localStorage !== 'undefined' ? localStorage.getItem(CAT_KEY) : null;
  let cat = $state(storedCat && storedCat in CAT_META ? storedCat : 'agents');
  let categoryOpen = $state(false);
  function pickCat(id) {
    if (cat === id) { categoryOpen = true; return; }
    requestLeave(() => {
      closeAll();
      categoryOpen = true;
      cat = id;
      try { localStorage.setItem(CAT_KEY, id); } catch {}
      if (id === 'global') startGlobal();
    });
  }
  // section is the host's committed navigation result, after onGuardExit.
  // Guarding it again would ask twice after the user has already discarded.
  let lastSection = untrack(() => requestedSection);
  $effect(() => {
    const next = requestedSection;
    if (next === lastSection) return;
    lastSection = next;
    untrack(() => { closeAll(); section = next; });
  });

  let defs = $state([]);
  let teams = $state([]);       // agent teams (board #74): RegTeam[]
  let skills = $state([]);      // central skill assets
  let mcps = $state([]);        // central MCP server defs
  let editing = $state(null);   // agent working copy or null
  let isNew = $state(false);
  // One editor at a time across the three kinds.
  let editingSkill = $state(null);
  let skillIsNew = $state(false);
  let editingMcp = $state(null);
  // A TEAM working copy (board #74): { name, description, members: TeamMember[] }.
  let editingTeam = $state(null);
  // The app-wide instructions (`<config>/AGENTS.md`, tmm-cli.md § The app-wide
  // instructions): ONE text every managed agent's prompt starts with. It is
  // edited HERE — the Agents page is where an agent's words are configured —
  // as the first row of the list, above the agents it applies to.
  let editingGlobal = $state(null); // { text, path, max_bytes, loading } working copy or null
  let teamIsNew = $state(false);
  const drilled = $derived(!!editing || !!editingSkill || !!editingMcp || !!editingTeam || !!editingGlobal);
  let drillAnim = $state('');
  let wasDrilled = false;
  let mcpIsNew = $state(false);
  let error = $state('');
  let info = $state(''); // a good-news line (e.g. what a plugin import installed)
  let rootEl = $state(null);
  let paneMode = $state('wide');
  let compactViewport = $state(typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  $effect(() => {
    const node = rootEl;
    if (!node) return;
    const measure = () => {
      if (!node.clientWidth) return;
      compactViewport = window.matchMedia('(max-width: 760px)').matches;
      const style = getComputedStyle(node);
      const sidebar = parseFloat(style.getPropertyValue('--sidebar-w')) || 240;
      const rows = parseFloat(style.getPropertyValue('--agents-rows-w')) || 240;
      const editor = parseFloat(style.getPropertyValue('--config-editor-width')) || 480;
      paneMode = node.clientWidth < sidebar + editor ? 'stacked'
        : !section && node.clientWidth < sidebar + rows + editor ? 'reduced' : 'wide';
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const aside of node.querySelectorAll(':scope > aside')) observer.observe(aside);
    measure();
    return () => observer.disconnect();
  });
  let original = $state('');
  let pendingOperation = $state('');
  const saving = $derived(!!pendingOperation);
  let epoch = 0;
  let exitIntent = $state(null);
  const pendingExit = $derived(exitIntent?.confirm ? exitIntent.action : null);
  const draft = $derived(editing ? { kind: 'agent', value: editing }
    : editingTeam ? { kind: 'team', value: editingTeam }
    : editingSkill ? { kind: 'skill', value: editingSkill }
    : editingMcp ? { kind: 'mcp', value: editingMcp }
    : editingGlobal ? { kind: 'global', value: editingGlobal } : null);
  const creating = $derived(draft?.kind === 'agent' ? isNew : draft?.kind === 'team' ? teamIsNew
    : draft?.kind === 'skill' ? skillIsNew : draft?.kind === 'mcp' ? mcpIsNew : false);
  const editorTitle = $derived(draft?.kind === 'global' ? t('agentsGlobal')
    : creating ? t(({ agent: 'agentsNew', team: 'teamsNew', skill: 'skillsNew', mcp: 'mcpNew' })[draft?.kind])
    : draft?.value.name ?? '');
  const dirty = $derived(!!draft && configFingerprint(draft) !== original);
  const savable = $derived(!saving && !removing && !pendingExit && !pending
    && configValid(draft, creating) && (creating || dirty));
  const rememberDraft = () => { original = configFingerprint(draft); };
  /** `cancel` runs when the person answers "keep editing" (#335 ③a): a host
   * that revealed this editor to ask can put its view back. */
  function requestLeave(action, cancel = null) {
    if (pending || pendingExit) { cancel?.(); return; }
    if (saving || removing) { exitIntent = { action, confirm: false, cancel }; return; }
    if (dirty) exitIntent = { action, confirm: true, cancel };
    else action();
  }
  $effect(() => {
    if (!exitIntent || exitIntent.confirm || saving || removing) return;
    untrack(() => {
      const { action, cancel } = exitIntent;
      exitIntent = null;
      requestLeave(action, cancel);
    });
  });
  $effect(() => onGuardExit?.(requestLeave));
  // A server switch destroys this editor (board 315): it asks through the
  // same leave confirmation, and waits for a save/remove in flight first.
  let leaveCancel = null;
  $effect(() => registerLeaveGuard({
    runtime: guardOwner,
    page: guardPage,
    dirty: () => untrack(() => dirty || saving || removing),
    ask: () => new Promise((resolve) => {
      // A dialog of its own is already open: the user is answering that one.
      if (untrack(() => pending || pendingExit)) { resolve(false); return; }
      leaveCancel = () => resolve(false);
      requestLeave(() => { leaveCancel = null; resolve(true); });
    }),
  }));
  $effect(() => () => { epoch++; });
  function editorKey(event) {
    if (!visible || !rootEl?.contains(event.target) || activeModal(document)) return;
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      requestLeave(closeAll);
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveCurrent();
    }
  }
  async function saveCurrent() {
    if (!savable) return;
    const generation = epoch;
    const kind = draft.kind, payload = configPayload(draft);
    const importSource = kind === 'skill' && creating && !payload.name;
    pendingOperation = 'save'; error = ''; info = '';
    let imported;
    try {
      if (kind === 'agent') await registrySave(payload);
      else if (kind === 'team') await teamsSave(payload);
      else if (kind === 'mcp') await mcpSave(payload);
      else if (kind === 'global') await globalPromptSet(payload.text);
      else if (importSource) imported = await skillsImport(payload.source);
      else await skillsSave(payload);
    } catch (e) {
      if (generation === epoch) error = String(e?.message ?? e);
      return;
    } finally {
      if (generation === epoch) pendingOperation = '';
    }
    if (generation !== epoch) return;
    closeAll(false);
    if (imported) {
      const skipped = imported.skipped?.length ? ` · ${t('skillsSkipped')}: ${imported.skipped.join(', ')}` : '';
      info = `${t('skillsImported')}: ${(imported.imported ?? []).join(', ') || '—'}${skipped}`;
    }
    await reload();
  }

  /** The pending destructive action: `{ kind, name }`. Deleting an agent
   * definition, a skill or an MCP server used to be immediate — one stray tap
   * on a phone and a definition was gone (owner asked for the audit,
   * 2026-08-19). The words per kind live here so the dialog stays generic. */
  let pending = $state(null);
  let removing = $state(false);
  let removeError = $state('');

  /** Grow long prompts to their CSS max-height, then scroll within the field.
   * The expanded member card should reveal writing, not another keyhole-sized
   * control. CSS owns the responsive min/max; the action only follows it. */
  function autoGrow(node) {
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.style.height = 'auto';
        const max = Number.parseFloat(getComputedStyle(node).maxHeight);
        const height = Number.isFinite(max) ? Math.min(node.scrollHeight, max) : node.scrollHeight;
        node.style.height = `${height}px`;
        node.style.overflowY = node.scrollHeight > height + 1 ? 'auto' : 'hidden';
      });
    };
    node.addEventListener('input', fit);
    window.addEventListener('resize', fit);
    fit();
    return {
      destroy() {
        cancelAnimationFrame(frame);
        node.removeEventListener('input', fit);
        window.removeEventListener('resize', fit);
      },
    };
  }

  // The phone's back gesture peels this page's layers like Files does its
  // views (owner, 2026-08-24): dialog first, then an open editor (compact:
  // "the list is the page; editing takes the screen"), then the floor.
  $effect(() => {
    // Drill motion (design-language.md §1 navigation grammar): the editor
    // enters from the right, the list re-enters from the left — derived from
    // the one compound flag so every open/close path animates alike.
    if (drilled !== wasDrilled) { drillAnim = drilled ? 'fwd' : 'back'; wasDrilled = drilled; }
    // An EMBEDDING host needs the same flag: mounted as a Settings category on
    // a phone, this page's editor brings its own `.page-head`, so Settings has
    // to drop its own or the screen wears two stacked title bars.
    onDrilled?.(drilled);
    if (!onGoBack) return;
    onGoBack(() => {
      if (saving || removing) return true;
      if (pendingExit) { exitIntent = null; return true; }
      if (pending) { pending = null; return true; }
      if (drilled) { requestLeave(closeAll); return true; }
      if (!section && categoryOpen && paneMode === 'stacked') { categoryOpen = false; return true; }
      return false;
    });
  });
  const COPY = {
    agent: { title: 'confirmDeleteAgentDefTitle', note: 'confirmDeleteAgentDefNote' },
    skill: { title: 'confirmDeleteSkillTitle',    note: 'confirmDeleteSkillNote' },
    mcp:   { title: 'confirmDeleteMcpTitle',      note: 'confirmDeleteMcpNote' },
    team:  { title: 'confirmDeleteTeamTitle',     note: 'confirmDeleteTeamNote' },
  };
  const ask = (kind, name) => {
    if (saving || removing || pending) return;
    removeError = '';
    pending = { kind, name };
  };
  async function runPending() {
    if (!pending || removing) return;
    const act = pending;
    const { kind, name } = act;
    const generation = epoch;
    removing = true;
    removeError = '';
    try {
      if (kind === 'agent') await registryDelete(name);
      else if (kind === 'team') await teamsDelete(name);
      else if (kind === 'skill') await skillsDelete(name);
      else await mcpDelete(name);
    } catch (e) {
      if (generation === epoch && pending === act) removeError = String(e?.message ?? e);
      return;
    } finally {
      if (generation === epoch && pending === act) removing = false;
    }
    if (generation !== epoch || pending !== act) return;
    pending = null;
    closeAll();
    await reload();
  }

  // The model ids the selected backend accepts, asked of the backend's own CLI
  // (per backend, cached server-side). This is a suggestion list, not a
  // restriction: an id we cannot enumerate is still typeable, and `registry_save`
  // is the authority that rejects one the backend would silently ignore — a
  // dashed `claude-sonnet-4-5` ran happily on the DEFAULT model instead
  // (owner report, 2026-08-19).
  // The served backend list can land after this page rendered (it is
  // fetched on connect): re-read it then, so an open editor gains the
  // input-mode field instead of waiting for the next visit (board #245).
  let servedTick = $state(0);
  $effect(() => onServedBackends(() => { servedTick++; backends = spawnableBackends(); }));
  const switchesInputMode = (backend) => { void servedTick; return backendSwitchesInputMode(backend); };
  /** An explicit backend pick in the editor: a steer draft moving to a backend
   * the server says cannot switch becomes queue. With no list yet nothing is
   * judged — the field stays visible and registry_save decides. */
  function pickBackend(draft, backend) {
    if (draft?.input_mode === 'steer' && servedBackendsKnown() && !backendSwitchesInputMode(backend)) draft.input_mode = 'queue';
  }
  let models = $state([]);
  $effect(() => {
    const backend = editing?.backend;
    if (!backend) { models = []; return; }
    let live = true;
    modelsList(backend)
      .then((r) => { if (live) models = r.models ?? []; })
      .catch(() => { if (live) models = []; });
    return () => { live = false; };
  });

  /** The list unfolds on its FIRST paint only (motion.md principle 15,
   * `.reveal` on the sidebar list): a revisit or a save's reload is a cut.
   * Cleared by a timer (one --t-move + the atom's 210ms stagger + margin) so
   * a row added later does not rise as if it were part of the first fill. */
  let justLoaded = $state(false);
  let painted = false;
  async function reload() {
    // "I could not ask" is not "there is nothing": keep the last known lists
    // on a failed RPC (same rule as the Hub roster). Wiping them meant one
    // timed-out call emptied the whole page until the next visit.
    backends = spawnableBackends();
    try { defs = (await registryList()).agents ?? []; } catch { /* keep last */ }
    try { teams = (await teamsList()).teams ?? []; } catch { /* keep last */ }
    try { skills = (await skillsList()).skills ?? []; } catch { /* keep last */ }
    try { mcps = (await mcpList()).mcp ?? []; } catch { /* keep last */ }
    if (!painted) {
      painted = true;
      justLoaded = true;
      setTimeout(() => { justLoaded = false; }, revealMs());
    }
  }
  $effect(() => { if (visible) reload(); });

  // The rows column's width survives reload the same way App restores
  // --sidebar-w and Hub its --hub-drawer-w: SideHandle is the only other
  // writer (board #94).
  $effect(() => {
    const saved = parseInt(localStorage.getItem('tmux_agents_rows_w') || '', 10);
    if (saved >= 180 && saved <= 420) {
      document.documentElement.style.setProperty('--agents-rows-w', saved + 'px');
    }
  });

  // The Hub's agent menu can ask for one agent's editor ("configure agent" —
  // the model's home is here, not quoted in the menu; owner, 2026-08-25), and
  // a team name's menu for that team's editor (`kind: 'team'`, board #258).
  // Depends on `defs`/`teams` too: the request usually arrives WITH the tab
  // switch, before reload() has answered, so it waits for the list and fires once.
  let editReqDone = 0;
  $effect(() => {
    const req = editRequest;
    if (!visible || saving || removing || pendingExit || pending || !req || req.n === editReqDone) return;
    if (req.kind === 'team') {
      const team = teams.find((x) => x.name === req.name);
      if (!team) return;
      editReqDone = req.n;
      untrack(() => startTeam(team));
      return;
    }
    const def = defs.find((d) => d.name === req.name);
    if (!def) return;
    editReqDone = req.n;
    untrack(() => startEdit(def));
  });

  function closeAll(clearExit = true) {
    epoch++;
    pending = null; removing = false; removeError = ''; pendingOperation = '';
    editing = null; editingSkill = null; editingMcp = null; editingTeam = null; editingGlobal = null;
    original = ''; if (clearExit) exitIntent = null; error = ''; info = '';
  }

  // ── The app-wide instructions ─────────────────────────────────────────
  function startGlobal() {
    requestLeave(async () => {
      closeAll();
      const generation = epoch;
      editingGlobal = { text: '', path: '', max_bytes: 24 * 1024, loading: true };
      rememberDraft();
      try {
        const r = await globalPromptGet();
        if (generation !== epoch) return;
        editingGlobal = { text: r.text ?? '', path: r.path ?? '', max_bytes: r.max_bytes ?? 24 * 1024, loading: false };
        rememberDraft();
      } catch (e) {
        if (generation !== epoch) return;
        error = String(e?.message ?? e);
        editingGlobal.loading = false; editingGlobal.failed = true;
      }
    });
  }
  const globalBytes = $derived(editingGlobal ? new TextEncoder().encode(editingGlobal.text.trim()).length : 0);

  // ── Agent teams (board #74) ───────────────────────────────────────────
  // A member has exactly one source: a BARE coding backend configured here, a
  // registry agent inherited whole, or a sub-team inherited whole. Only the
  // bare source owns prompt / Skills / MCP in this editor.
  const TEAM_MAX = 8; // mirrors the server's spawn cap (validated there too, on the EXPANSION)
  const blankMember = () => ({ name: '', base: defs[0]?.name ?? '', team: '', role: '', model: '', effort: '', input_mode: '', agent: null, expanded: true });
  function bareEditor(agent = {}) {
    const skillEntries = parseRefs(agent.skills);
    const mcpEntries = parseRefs(agent.mcp);
    return {
      name: agent.name ?? '',
      backend: agent.backend ?? defaultBackend(),
      model: agent.model ?? '',
      effort: agent.effort ?? '',
      input_mode: agent.input_mode ?? 'queue',
      system: agent.system ?? '',
      skillSel: skillEntries.filter((x) => typeof x === 'string'),
      mcpSel: mcpEntries.filter((x) => typeof x === 'string'),
      mcpExtra: mcpEntries.filter((x) => typeof x !== 'string'),
    };
  }
  function startTeam(team) {
    if (team && editingTeam?.name === team.name && !teamIsNew) return;
    requestLeave(() => {
      closeAll();
      if (!section) { cat = 'teams'; categoryOpen = true; try { localStorage.setItem(CAT_KEY, 'teams'); } catch {} }
      teamIsNew = !team;
      let members = [];
      if (team) { try { members = JSON.parse(team.members) ?? []; } catch { members = []; } }
      editingTeam = team
        ? { name: team.name, description: team.description ?? '', members: members.map((m, i) => ({ name: m.name ?? '', base: m.base ?? '', team: m.team ?? '', role: m.role ?? '', model: m.model ?? '', effort: m.effort ?? '', input_mode: m.input_mode ?? '', agent: m.agent ? bareEditor(m.agent) : null, expanded: i === 0 })) }
        : { name: '', description: '', members: [blankMember()] };
      rememberDraft();
    });
  }
  function addMember() {
    if (saving || !editingTeam || editingTeam.members.length >= TEAM_MAX) return;
    editingTeam.members = [
      ...editingTeam.members.map((member) => ({ ...member, expanded: false })),
      blankMember(),
    ];
  }
  function removeMember(i) {
    if (saving || !editingTeam) return;
    const removedWasOpen = editingTeam.members[i]?.expanded;
    const members = editingTeam.members.filter((_, k) => k !== i);
    if (removedWasOpen && members.length && !members.some((member) => member.expanded)) {
      members[Math.min(i, members.length - 1)].expanded = true;
    }
    editingTeam.members = members;
  }
  function toggleMember(i) {
    if (!editingTeam) return;
    const opening = !editingTeam.members[i]?.expanded;
    editingTeam.members = editingTeam.members.map((member, k) => ({
      ...member,
      expanded: opening && k === i,
    }));
  }
  /** The source Select's value: '' for a bare backend, a registry agent name,
   * or `team:<name>` for a nested team. Switching source drops fields owned by
   * the previous source so prompt / Skills / MCP cannot leak onto an inherited
   * agent or team. */
  const kindOf = (m) => (m.team ? `team:${m.team}` : m.base);
  function setBase(i, v) {
    if (saving) return;
    const m = editingTeam.members[i];
    if (v.startsWith('team:')) { m.team = v.slice(5); m.base = ''; m.agent = null; m.expanded = true; return; }
    m.team = '';
    m.base = v;
    m.agent = v ? null : (m.agent ?? bareEditor());
    // A steer override cannot follow the member to a base the list says
    // cannot switch (#254) — same rule as a backend pick (pickBackend).
    if (m.input_mode === 'steer' && servedBackendsKnown() && !backendSwitchesInputMode(baseBackend(m))) m.input_mode = '';
    m.expanded = true;
  }
  /** Teams offerable as a member: every OTHER team (the server also refuses
   * cycles through longer chains). */
  const subTeams = $derived(teams.filter((x) => x.name !== editingTeam?.name));
  // Model suggestions per backend for CUSTOM members (the same models_list the
  // agent editor asks); fetched once per backend.
  let modelsByBackend = $state({});
  function ensureModels(backend) {
    if (!backend || backend in modelsByBackend) return;
    modelsByBackend[backend] = [];
    modelsList(backend).then((r) => { modelsByBackend[backend] = r.models ?? []; }).catch(() => {});
  }
  const baseBackend = (m) => defs.find((d) => d.name === m.base)?.backend ?? '';
  /** The base's own input mode, which an empty member override inherits (#254). */
  const baseInputMode = (m) => defs.find((d) => d.name === m.base)?.input_mode ?? 'queue';
  const memberBackend = (m) => m.team ? '' : (m.base ? baseBackend(m) : (m.agent?.backend ?? ''));
  const memberName = (m) => m.team || m.name.trim() || t('teamsUnnamedMember');
  const memberSource = (m) => m.team
    ? `${t('teamsSubTeam')} · ${m.team}`
    : m.base
      ? `${t('teamsCustomAgent')} · ${m.base}`
      : `${t('teamsBare')} · ${m.agent?.backend ?? defaultBackend()}`;
  $effect(() => {
    for (const m of editingTeam?.members ?? []) {
      if (!m.base && m.agent) ensureModels(m.agent.backend);
      else if (m.base) ensureModels(baseBackend(m));
    }
  });
  /** One-line summary for the sidebar row: member names, base in parentheses. */
  function teamSummary(team) {
    try { return (JSON.parse(team.members) ?? []).map((m) => (m.team ? `+${m.team}` : m.name)).filter(Boolean).join(' · '); } catch { return ''; }
  }

  // The skill's managed files: a chip per file, one previewed at a time.
  // SKILL.md leads; .md renders, anything else shows as monospace text
  // (owner, 2026-08-28: "配置页面可以预览skillmd以及其他资源文件").
  let skFiles = $state([]);
  let skSel = $state('SKILL.md');
  let skText = $state('');
  let skillListRequest = 0, skillFileRequest = 0;
  // The YAML frontmatter duplicates the form fields (name/description) —
  // the preview shows the skill's BODY.
  function stripFrontmatter(md) {
    const m = /^---\n[\s\S]*?\n---\n?/.exec(md);
    return m ? md.slice(m[0].length) : md;
  }
  function loadSkillFiles(name) {
    const generation = epoch;
    const request = ++skillListRequest;
    skFiles = [];
    skSel = 'SKILL.md';
    skText = '';
    skillsFiles(name)
      .then((r) => { if (generation === epoch && request === skillListRequest) skFiles = r.files ?? []; })
      .catch(() => { if (generation === epoch && request === skillListRequest) skFiles = []; });
    loadSkillFile(name, 'SKILL.md');
  }
  function loadSkillFile(name, path) {
    const generation = epoch;
    const request = ++skillFileRequest;
    skSel = path;
    skText = '';
    skillsFile(name, path)
      .then((r) => { if (generation === epoch && request === skillFileRequest) skText = r.content; })
      .catch((e) => { if (generation === epoch && request === skillFileRequest) skText = String(e?.message ?? e); });
  }
  // The description is READING by default — skill descriptions run to
  // paragraphs (they teach the model when to fire) and a one-line input
  // showed a keyhole's worth. Click to edit, blur to fold back
  // (owner, 2026-08-29: "description 应该是多行的 默认是让我浏览 点击才能编辑").
  let descEditing = $state(false);
  function startSkill(sk) {
    if (sk && editingSkill?.name === sk.name && !skillIsNew) return;
    requestLeave(() => {
      closeAll();
      skillIsNew = !sk;
      editingSkill = sk ? { ...sk } : { name: '', source: '', description: '' };
      descEditing = false;
      if (sk) loadSkillFiles(sk.name); else { skFiles = []; skText = ''; }
      rememberDraft();
    });
  }
  function refreshSkill() {
    requestLeave(async () => {
      if (!editingSkill) return;
      const generation = epoch, name = editingSkill.name;
      pendingOperation = 'refresh'; error = '';
      try {
        await skillsRefresh(name);
        const result = await skillsList();
        if (generation !== epoch) return;
        skills = result.skills ?? skills;
        const refreshed = skills.find(x => x.name === name);
        if (refreshed) { editingSkill = { ...refreshed }; rememberDraft(); loadSkillFiles(name); }
      } catch (e) {
        if (generation === epoch) error = String(e?.message ?? e);
      } finally { if (generation === epoch) pendingOperation = ''; }
    });
  }

  function startMcp(m) {
    if (m && editingMcp?.name === m.name && !mcpIsNew) return;
    requestLeave(() => {
      closeAll();
      mcpIsNew = !m;
      editingMcp = m ? { ...m, defText: pretty(m.def) } : { name: '', defText: '{\n  "command": "",\n  "args": []\n}' };
      rememberDraft();
    });
  }

  function startEdit(def) {
    if (def && editing?.name === def.name && !isNew) return;
    requestLeave(() => {
      closeAll();
      if (!section) { cat = 'agents'; categoryOpen = true; try { localStorage.setItem(CAT_KEY, 'agents'); } catch {} }
      isNew = !def;
      // Preserve unknown references and inline MCP objects while editing the
      // choices currently present in the shared catalogs.
      const skillSel = def ? parseRefs(def.skills) : [];
      const mcpEntries = def ? parseRefs(def.mcp) : [];
      editing = def
        ? {
            ...def,
            effort: def.effort ?? '',
            input_mode: def.input_mode ?? 'queue',
            skillSel: skillSel.filter((x) => typeof x === 'string'),
            mcpSel: mcpEntries.filter((x) => typeof x === 'string'),
            mcpExtra: mcpEntries.filter((x) => typeof x !== 'string'),
          }
        : { name: '', backend: defaultBackend(), model: '', effort: '', input_mode: 'queue', system: '', skillSel: [], mcpSel: [], mcpExtra: [] };
      rememberDraft();
    });
  }

  function parseRefs(json) {
    try { return JSON.parse(json) ?? []; } catch { return []; }
  }
  function pretty(json) {
    try { return JSON.stringify(JSON.parse(json), null, 2); } catch { return json || '[]'; }
  }

</script>

<svelte:window onkeydown={editorKey} />
{#snippet inputModeField(draft, backend = draft.backend, inherited = null)}
  <!-- Board #245: one field for every agent definition — the registry editor,
       a team's bare member and (#254) a member derived from a registry agent.
       Shown only where the switch was measured (the server's backends_list
       says which); elsewhere the CLI decides and the field would promise a
       behaviour no config carries. A saved steer is always shown, so it is
       never hidden while the list is missing and can always be changed back.
       A derived member passes its base's backend and mode: '' = inherit, the
       same contract as its model/effort overrides. -->
  {#if switchesInputMode(backend) || draft.input_mode === 'steer'}
    <label class="config-field"><span class="config-field-label">{t('agentsInputMode')}</span>
      <Select bind:value={draft.input_mode} disabled={saving || removing}
        options={[
          ...(inherited ? [{ value: '', label: `${t('teamsInherit')} (${t(inherited === 'steer' ? 'agentsInputSteer' : 'agentsInputQueue')})` }] : []),
          { value: 'queue', label: t('agentsInputQueue') }, { value: 'steer', label: t('agentsInputSteer') },
        ]}
        ariaLabel={t('agentsInputMode')} />
    </label>
  {/if}
{/snippet}
{#snippet inputModeHint(draft, inherited = null)}
  {#if (draft.input_mode || inherited) === 'steer'}<p class="hint">{t('agentsInputSteerHint')}</p>{/if}
{/snippet}
{#snippet rows(kind)}
  <!-- One kind's definitions as rows — the phone's sidebar list (narrowed by
       `section`) and the desktop's main list (the chosen category) render the
       SAME markup, so the two cannot drift apart. -->
      {#if kind === 'agents'}
      <!-- The house rules row: what EVERY agent below is told first. On the
           desktop it is a CATEGORY of its own (the sidebar's first row). -->
      {#if section}
      <button class="side-row" class:open={!!editingGlobal} onclick={startGlobal}>
        <span class="ava global"><Icon name="file" size={13} /></span>
        <span class="r-name">{t('agentsGlobal')}</span>
        <span class="r-backend">AGENTS.md</span>
      </button>
      {/if}
      {#each defs as d (d.name)}
        <button class="side-row" class:open={editing?.name === d.name && !isNew} onclick={() => startEdit(d)}>
          {#if backendIcon(d.backend)}<img class="ava" src={backendIcon(d.backend)} alt={d.backend} />{:else}<span class="ava" style:background={backendColor(d.backend)}>{d.name.slice(0, 1).toUpperCase()}</span>{/if}
          <span class="r-name">{d.name}</span>
          <span class="r-backend">{d.backend}</span>
        </button>
      {/each}
      <button class="side-row add" onclick={() => startEdit(null)}>
        <Icon name="plus" size={13} />{t('agentsNew')}
      </button>
      {/if}

      <!-- Agent TEAMS (board #74): a named set of the agents above, each with
           a role. Same row dialect; the second line names the members. -->
      {#if kind === 'teams'}
      {#each teams as tm (tm.name)}
        <button class="side-row team-row" class:open={editingTeam?.name === tm.name && !teamIsNew} onclick={() => startTeam(tm)}>
          <Icon name="bots" size={13} />
          <span class="r-col"><span class="r-name">{tm.name}</span><span class="r-sub">{teamSummary(tm)}</span></span>
        </button>
      {/each}
      <button class="side-row add" onclick={() => startTeam(null)}>
        <Icon name="plus" size={13} />{t('teamsNew')}
      </button>
      {/if}

      {#if kind === 'skills'}
      {#each skills as sk (sk.name)}
        <button class="side-row" class:open={editingSkill?.name === sk.name && !skillIsNew} onclick={() => startSkill(sk)}>
          <Icon name="zap" size={13} />
          <span class="r-name">{sk.name}</span>
        </button>
      {/each}
      <button class="side-row add" onclick={() => startSkill(null)}>
        <Icon name="plus" size={13} />{t('skillsNew')}
      </button>
      {/if}

      {#if kind === 'mcp'}
      {#each mcps as m (m.name)}
        <button class="side-row" class:open={editingMcp?.name === m.name && !mcpIsNew} onclick={() => startMcp(m)}>
          <Icon name="link" size={13} />
          <span class="r-name">{m.name}</span>
        </button>
      {/each}
      <button class="side-row add" onclick={() => startMcp(null)}>
        <Icon name="plus" size={13} />{t('mcpNew')}
      </button>
      {/if}
{/snippet}

<div class="agents-root config-compact config-entity" bind:this={rootEl} class:editing={drilled} class:with-rows={!section}
  class:reduced={paneMode === 'reduced'} class:stacked={paneMode === 'stacked'} class:category-open={categoryOpen}
  class:drill-fwd={drillAnim === 'fwd'} class:drill-back={drillAnim === 'back'}>
  <aside class="sidebar config-navigation">
    <SideHandle />
    <div class="side-scroll subtle-scroll" class:reveal={justLoaded} use:scrollFade>
      {#if section}
        {@render rows(section)}
      {:else}
        <!-- Desktop (owner, 2026-09-04: "左边侧边栏先写配置条目 右边展示详细
             内容 不要全堆在一起了"): the sidebar lists the CATEGORIES, like
             Settings' — no icons, the words carry it (owner, 2026-08-25).
             The category's rows are the SECOND column (board #94), and the
             main column holds the editor. -->
        {#each CATS as c (c.id)}
          <button class="side-row" class:open={cat === c.id} onclick={() => pickCat(c.id)}
            use:hoverInfo={() => ({ title: t(c.label), text: t(c.hint) })}>
            <span class="r-name">{t(c.label)}</span>
            {#if c.count}<span class="r-backend">{c.count()}</span>{/if}
          </button>
        {/each}
      {/if}
    </div>
  </aside>

  {#if !section}
    <!-- The desktop's SECOND level (board #94: "右侧拆分成两级"): the chosen
         category's rows are their own column, so an open editor no longer
         REPLACES them — the list stays beside what it selected, the same
         master-detail every other desktop page speaks. The global
         instructions have no roster, only the one document, so their level
         is that single row. Compact keeps the drill — this column is
         desktop-only. -->
    <aside class="cat-rows config-navigation">
      {#if paneMode === 'stacked'}
        <div class="page-head config-page-head">
          <div class="config-head-inner">
            <CommandButton variant="icon" icon="chevron-left" label={t('back')} onclick={() => categoryOpen = false} />
            <h1>{t(CAT_META[cat].label)}</h1>
          </div>
        </div>
      {/if}
      <SideHandle varName="--agents-rows-w" storeKey="tmux_agents_rows_w" min={180} max={420} def={240} label={t(CAT_META[cat].label)} />
      <div class="rows-scroll subtle-scroll" class:reveal={justLoaded} use:scrollFade>
        {#if cat === 'global'}
          <button class="side-row" class:open={!!editingGlobal} onclick={startGlobal}>
            <span class="r-name">AGENTS.md</span>
          </button>
        {:else}
          {@render rows(cat)}
        {/if}
      </div>
    </aside>
  {/if}

  <main class="mid">
    {#if drilled}
      <div class="page-head config-page-head">
        <div class="config-head-inner">
          {#if paneMode !== 'wide'}
            <CommandButton variant="icon" icon="chevron-left" label={t('back')} disabled={saving || removing}
              onclick={() => requestLeave(closeAll)} />
          {/if}
          <h1>{editorTitle}</h1>
          <div class="config-actions">
            {#if !creating && draft.kind !== 'global' && editingSkill?.source !== 'builtin'}
              <CommandButton variant="danger" iconOnly icon="trash" label={t('delete')}
                disabled={saving || removing} onclick={() => ask(draft.kind, draft.value.name)} />
            {/if}
            {#if editingSkill && !skillIsNew}
              <CommandButton variant="icon" icon="refresh" label={t('skillsRefresh')}
                disabled={saving || removing} pending={pendingOperation === 'refresh'} onclick={refreshSkill} />
            {/if}
            {#if editingGlobal?.failed}
              <CommandButton variant="icon" icon="refresh" label={t('configRetry')} onclick={startGlobal} />
            {/if}
            {#if paneMode === 'wide'}
              <CommandButton variant="icon" icon="x" label={t('cancel')} disabled={saving || removing}
                onclick={() => requestLeave(closeAll)} />
            {/if}
            <CommandButton variant="primary" iconOnly icon={editingSkill && skillIsNew ? 'download' : 'check'}
              label={editingSkill && skillIsNew ? t('skillsImport') : t('save')}
              disabled={!savable} pending={pendingOperation === 'save'} onclick={saveCurrent} />
          </div>
        </div>
      </div>
    {/if}
    {#if editingGlobal}
      <div class="editor config-form"><fieldset class="config-fields" disabled={saving || removing || editingGlobal.loading || editingGlobal.failed} aria-busy={saving}>
        {#if error}<div class="err config-error appear" role="alert">{error}</div>{/if}
        <p class="hint wide">{t('agentsGlobalHint').replace('{path}', editingGlobal.path || '<config>/AGENTS.md')}</p>
        <textarea class="config-input mono" rows="16" bind:value={editingGlobal.text} spellcheck="false"
          aria-label={t('agentsGlobal')} placeholder={t('agentsGlobalPh')}></textarea>
        <p class="hint" class:over={globalBytes > editingGlobal.max_bytes}>{t('agentsGlobalBytes').replace('{n}', String(globalBytes)).replace('{max}', String(editingGlobal.max_bytes))}</p>
      </fieldset></div>
    {:else if editingSkill}
      <div class="editor config-form"><fieldset class="config-fields" disabled={saving || removing} aria-busy={saving}>
        {#if error}<div class="err config-error appear" role="alert">{error}</div>{/if}
        {#if info}<p class="hint appear">{info}</p>{/if}
        <label class="config-field"><span class="config-field-label">{t('agentsName')}</span>
          <input class="config-input" bind:value={editingSkill.name} readonly={!skillIsNew} placeholder="git-review" />
        </label>
        {#if skillIsNew}
          <p class="hint">{t('skillsImportHint')}</p>
        {/if}
        <label class="config-field"><span class="config-field-label">{t('skillsSource')}</span>
          <input class="config-input" bind:value={editingSkill.source} readonly={editingSkill.source === 'builtin'} placeholder="https://github.com/org/repo/tree/main/skills/git-review" />
        </label>
        {#if editingSkill.source === 'builtin'}
          <p class="hint">{t('skillsBuiltin')}</p>
        {/if}
        <div class="config-field"><span class="config-field-label">{t('skillsDesc')}</span>
          {#if editingSkill.source === 'builtin'}
            <p class="desc-readonly">{editingSkill.description || '—'}</p>
          {:else if skillIsNew || descEditing}
            <!-- svelte-ignore a11y_autofocus — the user just clicked "edit
                 this text"; focusing anywhere else would drop the intent. -->
            <textarea class="config-input" rows="4" bind:value={editingSkill.description} autofocus={descEditing}
              aria-label={t('skillsDesc')}
              onblur={() => descEditing = false}></textarea>
          {:else}
            <button class="desc-view" type="button" title={t('edit')} onclick={() => descEditing = true}
              >{editingSkill.description || '—'}</button>
          {/if}
        </div>
        {#if editingSkill.synced_at}
          <p class="hint">{t('skillsSynced')} {new Date(editingSkill.synced_at * 1000).toLocaleString()}</p>
        {/if}
        {#if !skillIsNew && skFiles.length}
          <div class="md-preview">
            <div class="side-h">{t('skillsFilesTitle')}</div>
            <!-- A quiet list, not a chip cloud: file paths are reading
                 material (owner, 2026-08-28: "可以是小的列表组件展示").
                 A single SKILL.md still shows its one row — hiding the list
                 read as "file 没有写" (owner, 2026-08-29). -->
              <div class="file-list" role="listbox" aria-label={t('skillsFilesTitle')}>
                {#each skFiles as f (f.path)}
                  <button class="file-row" class:sel={skSel === f.path} type="button" role="option" aria-selected={skSel === f.path}
                    onclick={() => loadSkillFile(editingSkill.name, f.path)}>
                    <span class="f-path">{f.path}</span>
                    <span class="f-size">{f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</span>
                  </button>
                {/each}
              </div>
            {#if skSel.endsWith('.md')}
              <div class="md md-doc">{@html renderMarkdown(skSel === 'SKILL.md' ? stripFrontmatter(skText) : skText)}</div>
            {:else}
              <pre class="file-pre">{skText}</pre>
            {/if}
          </div>
        {/if}
      </fieldset></div>
    {:else if editingMcp}
      <div class="editor config-form"><fieldset class="config-fields" disabled={saving || removing} aria-busy={saving}>
        {#if error}<div class="err config-error appear" role="alert">{error}</div>{/if}
        <label class="config-field"><span class="config-field-label">{t('agentsName')}</span>
          <input class="config-input" bind:value={editingMcp.name} readonly={!mcpIsNew} placeholder="files" />
        </label>
        <label class="config-field"><span class="config-field-label">{t('mcpDef')}</span>
          <textarea class="config-input mono" rows="10" bind:value={editingMcp.defText} spellcheck="false"></textarea>
        </label>
        {#if dirty && !configValid(draft, creating)}<p class="config-error">{t('agentsMcpInvalid')}</p>{/if}
      </fieldset></div>
    {:else if editingTeam}
      <div class="editor config-form"><fieldset class="config-fields" disabled={saving || removing} aria-busy={saving}>
        {#if error}<div class="err config-error appear" role="alert">{error}</div>{/if}
        <div class="config-fields">
          <label class="config-field"><span class="config-field-label">{t('teamsName')}</span>
            <input class="config-input" bind:value={editingTeam.name} readonly={!teamIsNew} placeholder="dev-squad" />
          </label>
          <label class="config-field"><span class="config-field-label">{t('teamsDesc')}</span>
            <textarea class="config-input" rows="6" bind:value={editingTeam.description}
              placeholder={t('teamsDescPh')} use:autoGrow></textarea>
          </label>
        </div>
          <div class="config-fields">
          <div class="members-head">
            <span class="config-field-label">{t('teamsMembers')}</span>
            <span class="members-count">{editingTeam.members.length}/{TEAM_MAX}</span>
          </div>
          {#each editingTeam.members as m, i (i)}
            <div class="member" class:open={m.expanded}>
              <div class="member-head">
                <button class="member-summary" type="button" aria-expanded={m.expanded}
                  aria-label={`${memberName(m)} · ${memberSource(m)} · ${t(m.expanded ? 'teamsCollapseMember' : 'teamsExpandMember')}`}
                  title={t(m.expanded ? 'teamsCollapseMember' : 'teamsExpandMember')}
                  onclick={() => toggleMember(i)}>
                  {#if m.team}
                    <span class="member-ava team"><Icon name="bots" size={15} /></span>
                  {:else if backendIcon(memberBackend(m))}
                    <img class="member-ava" src={backendIcon(memberBackend(m))} alt={memberBackend(m)} />
                  {:else}
                    <span class="member-ava fallback" style:background={backendColor(memberBackend(m) || defaultBackend())}
                      >{memberName(m).slice(0, 1).toUpperCase()}</span>
                  {/if}
                  <span class="member-copy">
                    <span class="member-title">{memberName(m)}</span>
                    <span class="member-source">{memberSource(m)}</span>
                    {#if m.role.trim()}<span class="member-role">{m.role.trim()}</span>{/if}
                  </span>
                  <span class="flip member-chevron" class:on={m.expanded}>
                    <Icon name="chevron-down" size={13} />
                  </span>
                </button>
                <div class="member-actions">
                  <CommandButton variant="danger" iconOnly icon="x" label={t('teamsRemoveMember')}
                    disabled={saving || removing || editingTeam.members.length <= 1} onclick={() => removeMember(i)} />
                </div>
              </div>
              {#if m.expanded}
                <div class="member-body appear">
                  <section class="member-section identity-section">
                    <div class="member-section-title">{t('teamsMemberSetup')}</div>
                    <div class="config-row">
                      {#if !m.team}
                        <label class="config-field"><span class="config-field-label">{t('teamsMemberName')}</span>
                          <input class="config-input" bind:value={m.name} placeholder="dev" />
                        </label>
                      {/if}
                      <label class="config-field"><span class="config-field-label">{t('teamsBase')}</span>
                        <Select value={kindOf(m)} disabled={saving || removing} ariaLabel={t('teamsBase')}
                          options={[
                            { value: '', label: t('teamsBare') },
                            ...defs.map((d) => ({ value: d.name, label: `${t('teamsCustomAgent')}: ${d.name}`, icon: backendIcon(d.backend) ?? undefined })),
                            ...subTeams.map((x) => ({ value: `team:${x.name}`, label: `${t('teamsSubTeam')}: ${x.name}` })),
                          ]}
                          onchange={(v) => setBase(i, v)} />
                      </label>
                    </div>
                  </section>
                  <section class="member-section role-section">
                    <label class="config-field"><span class="config-field-label">{m.team ? t('teamsSubBrief') : t('teamsRole')}</span>
                      <textarea class="config-input" rows="6" bind:value={m.role}
                        placeholder={m.team ? t('teamsSubBriefPh') : t('teamsRolePh')} use:autoGrow></textarea>
                    </label>
                  </section>
                  {#if m.base && !m.team}
                    <!-- A custom agent inherits its definition. Only explicit
                         runtime overrides and the team role live here. -->
                    <section class="member-section">
                      <div class="member-section-title">{t('teamsOverrides')}</div>
                      <div class="config-row">
                        <label class="config-field"><span class="config-field-label">{t('agentsModel')}</span>
                          <Select bind:value={m.model} editable disabled={saving || removing} options={modelsByBackend[baseBackend(m)] ?? []}
                            placeholder={t('teamsInherit')} ariaLabel={t('agentsModel')} />
                        </label>
                        <label class="config-field"><span class="config-field-label">{t('agentsEffort')}</span>
                          <Select bind:value={m.effort} disabled={saving || removing}
                            options={[{ value: '', label: t('teamsInherit') }, ...backendEfforts(baseBackend(m))]}
                            ariaLabel={t('agentsEffort')} />
                        </label>
                        {@render inputModeField(m, baseBackend(m), baseInputMode(m))}
                      </div>
                      {@render inputModeHint(m, baseInputMode(m))}
                    </section>
                  {/if}
                  {#if !m.base && !m.team && m.agent}
                    <!-- Bare coding agent: this team owns its complete definition.
                         Registry agents and sub-teams inherit theirs and never
                         expose prompt / Skills / MCP here. -->
                    <section class="member-section">
                      <div class="member-section-title">{t('teamsBareConfig')}</div>
                      <div class="config-row">
                        <label class="config-field"><span class="config-field-label">{t('agentsBackend')}</span>
                          <Select bind:value={m.agent.backend} disabled={saving || removing} ariaLabel={t('agentsBackend')}
                            onchange={(b) => pickBackend(m.agent, b)}
                            options={backends.map((b) => ({ value: b, icon: backendIcon(b) ?? undefined }))} />
                        </label>
                        <label class="config-field"><span class="config-field-label">{t('agentsModel')}</span>
                          <Select bind:value={m.agent.model} editable disabled={saving || removing} options={modelsByBackend[m.agent.backend] ?? []}
                            placeholder={t('agentsModelDefault')} ariaLabel={t('agentsModel')} />
                        </label>
                        <label class="config-field"><span class="config-field-label">{t('agentsEffort')}</span>
                          <Select bind:value={m.agent.effort} disabled={saving || removing}
                            options={[{ value: '', label: t('agentsModelDefault') }, ...backendEfforts(m.agent.backend)]}
                            ariaLabel={t('agentsEffort')} />
                        </label>
                        {@render inputModeField(m.agent)}
                      </div>
                      {@render inputModeHint(m.agent)}
                      <label class="config-field"><span class="config-field-label">{t('agentsSystem')}</span>
                        <textarea class="config-input" rows="12" bind:value={m.agent.system}
                          placeholder={t('agentsSystemPh')} use:autoGrow></textarea>
                      </label>
                      <div class="config-row">
                        <div class="config-field">
                          {#if skills.length}
                            <CheckboxGroup label={t('agentsSkills')} value={m.agent.skillSel} disabled={saving || removing}
                              options={skills.map(sk => ({ value: sk.name, label: sk.name }))}
                              onchange={next => m.agent.skillSel = next} />
                          {:else}
                            <span class="config-field-label">{t('agentsSkills')}</span>
                            <p class="hint">{t('agentsNoSkills')}</p>
                          {/if}
                        </div>
                        <div class="config-field">
                          {#if mcps.length}
                            <CheckboxGroup label={t('agentsMcp')} value={m.agent.mcpSel} disabled={saving || removing}
                              options={mcps.map(server => ({ value: server.name, label: server.name }))}
                              onchange={next => m.agent.mcpSel = next} />
                          {:else}
                            <span class="config-field-label">{t('agentsMcp')}</span>
                            <p class="hint">{t('agentsNoMcp')}</p>
                          {/if}
                          {#if m.agent.mcpExtra.length}
                            <p class="hint">{t('agentsMcpExtra').replace('{n}', String(m.agent.mcpExtra.length))}</p>
                          {/if}
                        </div>
                      </div>
                    </section>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
          {#if editingTeam.members.length < TEAM_MAX}
            <div><CommandButton icon="plus" label={t('teamsAddMember')} disabled={saving || removing} onclick={addMember} /></div>
          {:else}
            <p class="hint">{t('teamsMax').replace('{n}', String(TEAM_MAX))}</p>
          {/if}
        </div>
      </fieldset></div>
    {:else if editing}
      <div class="editor config-form"><fieldset class="config-fields" disabled={saving || removing} aria-busy={saving}>
        {#if error}<div class="err config-error appear" role="alert">{error}</div>{/if}

        <label class="config-field"><span class="config-field-label">{t('agentsName')}</span>
          <input class="config-input" bind:value={editing.name} readonly={!isNew} placeholder="reviewer" />
        </label>
        <div class="config-row">
          <label class="config-field"><span class="config-field-label">{t('agentsBackend')}</span>
            <Select bind:value={editing.backend} disabled={saving || removing} ariaLabel={t('agentsBackend')}
              onchange={(b) => pickBackend(editing, b)}
              options={backends.map((b) => ({ value: b, icon: backendIcon(b) ?? undefined }))} />
          </label>
          <label class="config-field"><span class="config-field-label">{t('agentsModel')}</span>
            <!-- Editable Select, not a native <datalist>: the OS suggestion
                 popup is the seam the shared dropdown exists to remove (owner,
                 2026-08-24: "模型选择下拉框明显不对"). The value stays free
                 text — an id we cannot enumerate is still typeable, and
                 registry_save remains the authority that rejects a bad one. -->
            <Select bind:value={editing.model} editable disabled={saving || removing} options={models}
              placeholder={t('agentsModelDefault')} ariaLabel={t('agentsModel')} />
          </label>
          <label class="config-field"><span class="config-field-label">{t('agentsEffort')}</span>
            <!-- A fixed enum per backend (the CLI's own levels), so a Select,
                 not free text: a typo'd effort is a warning above the splash
                 and a silent fallback to the default. '' = backend default,
                 same contract as the model. -->
            <Select bind:value={editing.effort} disabled={saving || removing}
              options={[{ value: '', label: t('agentsModelDefault') }, ...backendEfforts(editing.backend)]}
              ariaLabel={t('agentsEffort')} />
          </label>
          {@render inputModeField(editing)}
        </div>
        {@render inputModeHint(editing)}
        <label class="config-field"><span class="config-field-label">{t('agentsSystem')}</span>
          <textarea class="config-input" rows="6" bind:value={editing.system} placeholder={t('agentsSystemPh')}></textarea>
        </label>
        <div class="config-field">
          {#if skills.length}
            <CheckboxGroup label={t('agentsSkills')} value={editing.skillSel} disabled={saving || removing}
              options={skills.map(sk => ({ value: sk.name, label: sk.name }))}
              onchange={next => editing.skillSel = next} />
          {:else}
            <span class="config-field-label">{t('agentsSkills')}</span>
            <p class="hint">{t('agentsNoSkills')}</p>
          {/if}
        </div>
        <div class="config-field">
          {#if mcps.length}
            <CheckboxGroup label={t('agentsMcp')} value={editing.mcpSel} disabled={saving || removing}
              options={mcps.map(server => ({ value: server.name, label: server.name }))}
              onchange={next => editing.mcpSel = next} />
          {:else}
            <span class="config-field-label">{t('agentsMcp')}</span>
            <p class="hint">{t('agentsNoMcp')}</p>
          {/if}
          {#if editing.mcpExtra.length}
            <p class="hint">{t('agentsMcpExtra').replace('{n}', String(editing.mcpExtra.length))}</p>
          {/if}
        </div>
      </fieldset></div>
    {:else if !section}
      <!-- Desktop, nothing being edited: the rows live in their own column
           now (board #94), so the main column is the category's front page —
           its name, the "+", and the hint that used to sit above the rows. -->
      <div class="page-head config-page-head">
        <div class="config-head-inner">
          <h1>{t(CAT_META[cat].label)}</h1>
          <div class="config-actions">
          {#if cat === 'global'}
            <CommandButton variant="icon" icon="edit" label={t('edit')} onclick={startGlobal} />
          {:else}
            <CommandButton variant="icon" icon="plus" label={t(CAT_META[cat].add)} onclick={() => CAT_META[cat].start(null)} />
          {/if}
          </div>
        </div>
      </div>
      <div class="placeholder">
        {#if info}<p class="hint appear">{info}</p>{/if}
        <p class="hint">{t(CAT_META[cat].hint)}</p>
      </div>
    {:else}
      <div class="page-head"><h1>{t(SECTION_META[section]?.[0] ?? 'agentsTitle')}</h1></div>
      <div class="placeholder">
        <p class="hint">{t(SECTION_META[section]?.[1] ?? 'agentsHint')}</p>
      </div>
    {/if}
  </main>
</div>

<ConfirmDialog open={!!pending} busy={removing} compact={compactViewport}
  title={pending ? t(COPY[pending.kind].title).replace('{name}', pending.name) : ''}
  note={pending ? t(COPY[pending.kind].note) : ''}
  confirmLabel={t('delete')} confirmIcon="trash" error={removeError}
  onconfirm={runPending} oncancel={() => { if (!removing) pending = null; }} />
<ConfirmDialog open={!!pendingExit} danger={false} compact={compactViewport}
  title={t('discardChanges')} note={t('configDiscardNote')}
  confirmLabel={t('configDiscard')} confirmIcon="check" cancelLabel={t('configKeepEditing')}
  onconfirm={() => { const action = pendingExit; exitIntent = null; action?.(); }}
  oncancel={() => { const cancel = exitIntent?.cancel; exitIntent = null; leaveCancel?.(); leaveCancel = null; cancel?.(); }} />

<style>
  .agents-root { height: 100%; display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 0; background: var(--bg); }
  /* The desktop's three levels (board #94): categories | the category's rows |
     the editor. The rows column has its own remembered width, same SideHandle
     dialect as every other divider. */
  .agents-root.with-rows { grid-template-columns: var(--sidebar-w) var(--agents-rows-w, 240px) minmax(0, 1fr); }
  .agents-root.reduced.with-rows { grid-template-columns: var(--sidebar-w) minmax(0, 1fr); }
  .reduced.editing .cat-rows, .reduced:not(.editing) .mid { display: none; }
  .agents-root.stacked, .agents-root.stacked.with-rows { grid-template-columns: minmax(0, 1fr); }
  .stacked .sidebar { border-right: none; }
  .stacked.editing .sidebar, .stacked.editing .cat-rows, .stacked:not(.editing) .mid { display: none; }
  .stacked.with-rows:not(.category-open) .cat-rows { display: none; }
  .stacked.with-rows.category-open:not(.editing) .sidebar { display: none; }
  .stacked.with-rows.category-open:not(.editing) .cat-rows { display: flex; }
  .cat-rows { position: relative; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .rows-scroll { flex: 1; overflow-y: auto; padding: 8px; }
  @media (max-width: 760px) {
    .agents-root, .agents-root.with-rows { grid-template-columns: minmax(0, 1fr); }
    /* Compact keeps the two-level drill: the rows column is desktop-only. */
    .cat-rows { display: none; }
    /* Compact: the list is the page; editing takes the screen. A full-width
       list has no column beside it, so its divider would sit at the screen's
       right edge as a stray line (owner, 2026-08-27). */
    .sidebar { border-right: none; }
    .agents-root.editing .sidebar { display: none; }
    .agents-root:not(.editing) .mid { display: none; }
    /* Drill motion: same 120ms grammar as the app-level page slide. */
    .agents-root.drill-fwd .mid { animation: drill-in-right 0.12s linear; }
    .agents-root.drill-back .sidebar { animation: drill-in-left 0.12s linear; }
  }
  @media (prefers-reduced-motion: reduce) {
    .agents-root.drill-fwd .mid, .agents-root.drill-back .sidebar { animation: none; }
  }

  .sidebar { position: relative; background: var(--bg2); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
  .side-scroll { flex: 1; overflow-y: auto; padding: 8px; }
  .r-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 550; }
  .r-backend { font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text3); flex: none; }
  /* A wash, not a drawn frame: borders on inner micro atoms read as chrome
     (owner, 2026-08-24 audit; same rule as the sys-line atoms). */

  .mid { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  /* Skill files as a quiet list — rows in the wash hover family, the
     selected one in the accent wash (same states the sidebar rows speak). */
  .file-list {
    display: flex; flex-direction: column; overflow: hidden auto; max-height: 200px;
    border: 1px solid var(--border2); border-radius: var(--ui-radius-control);
  }
  .file-row {
    display: flex; align-items: center; gap: 8px; padding: 4px 10px;
    background: none; border: none; cursor: pointer; text-align: left;
    font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text);
    transition: background var(--t-fast), color var(--t-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .file-row:hover { background: var(--surface2); }
  .file-row.sel { background: var(--accent-bg); color: var(--accent); }
  .f-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .f-size { margin-left: auto; flex: none; color: var(--text3); font-size: var(--fs-micro); }
  .placeholder { flex: 1; display: grid; place-items: center; }
  .hint { color: var(--text2); font-size: var(--fs-sub); margin: 0; line-height: 1.5; max-width: 100%; }
  .hint.wide { max-width: 640px; }
  .hint.over { color: var(--danger-ink); }
  /* The house-rules row's glyph: a document, not a backend — quiet grey. */
  .ava.global { display: grid; place-items: center; background: var(--surface2); color: var(--text2); }
  /* Description at rest: the text itself, whole and wrapped; the wash on
     hover says "tap to edit" without drawing an input around reading. */
  .desc-view {
    background: none; border: 1px solid transparent; border-radius: var(--ui-radius-control);
    padding: 6px 8px; margin: 0; text-align: left; cursor: text;
    font: inherit; font-size: var(--fs-body); color: var(--text); line-height: 1.55;
    min-height: var(--control-height);
    white-space: pre-wrap; overflow-wrap: anywhere;
    transition: background var(--t-fast), border-color var(--t-fast);
    -webkit-tap-highlight-color: transparent;
  }
  .desc-view:hover { background: var(--surface2); }
  .desc-readonly {
    margin: 0; color: var(--text); font: var(--fs-body)/1.55 var(--font-ui);
    white-space: pre-wrap; overflow-wrap: anywhere;
  }

  .editor { flex: 1; min-height: 0; overflow-y: auto; }
  .members-head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
  .members-count { margin-left: auto; color: var(--text3); font: 500 var(--fs-micro)/1 var(--font-mono); }
  /* Each member is a readable summary first. Clicking the broad summary
     opens one full-width editor and closes the previous member, so a long
     prompt never competes with a stack of open forms. */
  .member {
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid var(--border); border-radius: var(--ui-radius-row); background: var(--surface);
    box-shadow: 0 4px 14px color-mix(in srgb, var(--text) 5%, transparent);
    transition: border-color var(--t-fast), background var(--t-fast), box-shadow var(--t-fast);
  }
  .member.open { border-color: var(--accent-line); box-shadow: 0 7px 22px color-mix(in srgb, var(--text) 8%, transparent); }
  /* The hover wash is the ROW's, remove command included: on the summary
     alone it stopped short of the ✕ and left the row's end unlit (owner,
     2026-09-23: "高亮没有覆盖全，把关闭按钮右边那一块儿给漏掉了"). */
  .member-head {
    display: flex; align-items: stretch; min-height: 64px;
    transition: background var(--t-fast);
  }
  .member-head:hover { background: var(--surface2); }
  .member-summary {
    min-width: 0; flex: 1; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto;
    align-items: center; gap: 10px; padding: 9px 10px;
    border: 0; background: none; color: var(--text); text-align: left; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .member-ava {
    width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex: none;
  }
  .member-ava.team, .member-ava.fallback {
    display: grid; place-items: center; color: var(--text);
    font: 700 var(--fs-sub)/1 var(--font-display);
  }
  .member-ava.team { background: var(--surface2); color: var(--accent); }
  .member-copy { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); gap: 2px 9px; min-width: 0; align-items: baseline; }
  .member-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 var(--fs-body)/1.3 var(--font-display); }
  .member-source { min-width: 0; overflow-wrap: anywhere; color: var(--text2); font: 500 var(--fs-sub)/1.3 var(--font-mono); }
  .member-role {
    grid-column: 1 / -1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--text2); font-size: var(--fs-sub); line-height: 1.4;
  }
  .member-chevron { display: inline-flex; color: var(--text3); }
  .member-actions { display: flex; align-items: center; padding: 0 7px 0 2px; }
  .member-body { display: flex; flex-direction: column; border-top: 1px solid var(--border2); }
  .member-section { display: flex; flex-direction: column; gap: var(--config-field-gap); padding: var(--config-field-gap); }
  .member-section + .member-section { border-top: 1px solid var(--border2); }
  .member-section-title { color: var(--text2); font-size: var(--fs-meta); font-weight: 600; }
  .team-row { align-items: flex-start; }
  .r-col { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
  .r-sub { font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text2); overflow-wrap: anywhere; }
  @media (max-width: 760px) {
    .member-head { min-height: 72px; }
    .member-summary { grid-template-columns: 34px minmax(0, 1fr) auto; min-height: 72px; padding: 10px 8px 10px 10px; }
    .member-ava { width: 34px; height: 34px; }
    .member-copy { grid-template-columns: minmax(0, 1fr); gap: 1px; }
    .member-role { grid-column: 1; }
    .member-actions { padding-right: 4px; }
  }
  .md-preview { border-top: 1px solid var(--border2); margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
  .file-pre {
    margin: 0; padding: 8px 10px; overflow: auto; max-height: 60vh;
    font-family: var(--font-mono); font-size: var(--fs-sub);
    color: var(--text); background: var(--code-bg, var(--surface));
    border-radius: var(--ui-radius-control); white-space: pre;
  }
  .md-doc {
    background: var(--surface); border: 1px solid var(--border2); border-radius: var(--ui-radius-panel);
    padding: 12px 14px; font-size: var(--fs-body); color: var(--text); line-height: 1.55;
    overflow-wrap: anywhere;
  }
</style>

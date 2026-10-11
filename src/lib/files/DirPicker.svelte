<script lang="ts">
  // THE directory picker (rule 6: one mechanism per UI job) — over the SAME
  // `fs_list` RPC the file browser uses. Typing an absolute path from memory
  // was the only way to start a project (owner: "路径选择复用下文件选择器");
  // the Team workspace field wanted the same browse. Until 2026-09-03 there
  // were two of these (files/ and team/), with different props and behaviour:
  // one had the race guard, the other the new-folder affordance. This one has
  // both. Deliberately directories-only: a chooser, not a second file manager,
  // so it does not grow preview/edit/upload. Callers get an absolute path.
  import Icon from '../ui/Icon.svelte';
  import { revealMs } from '../ui/motion.ts';
  import { useServerApi } from '../app/server-context.ts';
  import { t } from '../core/i18n.svelte.ts';

  type DirEntry = { name: string; type: string; path: string };

  let {
    start = '~',
    onpick,
    oncancel,
    onnavigate,
  }: {
    /** Directory to open at; `~` and relative paths are resolved by the server. */
    start?: string;
    /** The confirmed directory (the Use button). */
    onpick?: (path: string) => void;
    oncancel?: () => void;
    /** Every browse step, so a caller's field can track the picker before confirm. */
    onnavigate?: (path: string) => void;
  } = $props();
  // This server's RPCs, read once at init (board #335 ②b).
  const { fsList, fsMkdir } = useServerApi();

  let cwd = $state('');
  let dirs = $state<DirEntry[]>([]);
  let ready = $state(false); // first answer arrived — before it there is nothing to keep
  let reveal = $state(false); // wears .reveal for that first answer only, dropped after revealMs()
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  let busy = $state(false);
  let error = $state('');
  let listEl = $state<HTMLElement | null>(null);
  let seq = 0;

  // New-folder inline input.
  let creating = $state(false);
  let newName = $state('');
  let createErr = $state('');

  /** Cancel the innermost layer this picker owns, if it has one open — the
   * new-folder field. `true` when it consumed the dismissal.
   *
   * A host asks this BEFORE treating Escape (or a phone Back) as "close the
   * whole thing": the picker lives inside dialogs whose shell owns Escape at
   * the window level, and without being asked, cancelling a folder name threw
   * away the entire project form (#317 review P1-b). Same dialect as
   * `ServerList.cancelRename` — the component with the state exposes the
   * cancel; the host decides the order. */
  export function cancelLocal(): boolean {
    if (!creating) return false;
    creating = false;
    newName = '';
    createErr = '';
    return true;
  }

  // Navigation KEEPS the current list on screen and swaps it atomically when
  // the answer arrives — clearing first made every tap blank-then-repaint
  // (owner, 2026-08-28: "每次点击一个路径…先清空再重新刷新…要交互更流畅").
  // The rows stay tappable mid-load; `seq` makes the newest tap win, so a
  // slow earlier answer can never overwrite a later one.
  async function open(path: string) {
    const my = ++seq;
    busy = true;
    error = '';
    try {
      const r = await fsList(path, false);
      if (my !== seq) return;
      cwd = r.path ?? path;
      dirs = ((r.entries ?? []) as DirEntry[])
        .filter((e) => e.type === 'dir')
        .sort((a, b) => a.name.localeCompare(b.name));
      // The unfold is for the FIRST answer only, and the class is dropped
      // once the stagger has played (motion.md; board #93): the rows are
      // keyed by path, so a navigation remounts them all — remounting under
      // a lingering `.reveal` blanked every row behind rise-in's backwards
      // fill and flashed the list on every hop. Navigation keeps rows and
      // swaps them atomically; that is this picker's own rule.
      if (!ready) {
        reveal = true;
        revealTimer = setTimeout(() => { reveal = false; }, revealMs());
      }
      ready = true;
      if (listEl) listEl.scrollTop = 0; // a NEW directory starts at its top
      onnavigate?.(cwd);
    } catch (e) {
      if (my !== seq) return;
      error = (e as Error)?.message ?? String(e); // the old list stays — the error line says why
    }
    busy = false;
  }

  async function createFolder() {
    const name = newName.trim();
    if (!name || !cwd) return;
    const dir = `${cwd.replace(/\/$/, '')}/${name}`;
    try {
      await fsMkdir(dir);
      creating = false;
      newName = '';
      createErr = '';
      await open(dir); // navigate into the new folder → it becomes the selection
    } catch (e) {
      createErr = (e as Error)?.message || 'failed';
    }
  }

  // The parent of an absolute path; '/' is its own parent (no climb past root).
  function parentOf(path: string) {
    const trimmed = path.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/');
    if (cut <= 0) return '/';
    return trimmed.slice(0, cut);
  }

  $effect(() => { open(start || '~'); });
</script>

<div class="picker">
  <div class="pk-head">
    <button class="icon-btn" title={t('dirPickerUp')} disabled={cwd === '/'} onclick={() => open(parentOf(cwd))}>
      <Icon name="chevron-up" size={13} />
    </button>
    <span class="pk-path" title={cwd}>{cwd || '…'}</span>
    <button class="icon-btn" title={t('dirPickerHome')} onclick={() => open('~')}><Icon name="home" size={13} /></button>
    <button class="icon-btn" class:on={creating} title={t('newFolder')} aria-label={t('newFolder')} disabled={!cwd}
      onclick={() => { creating = !creating; createErr = ''; }}><Icon name="folder-plus" size={13} /></button>
  </div>

  {#if creating}
    <div class="pk-new appear-rise">
      <Icon name="folder-plus" size={13} />
      <input class="pk-new-input" bind:value={newName} placeholder={t('newFolderName')}
        autocapitalize="off" autocomplete="off"
        onkeydown={(e) => { if (e.key === 'Enter') createFolder(); else if (e.key === 'Escape' && !e.isComposing) cancelLocal(); }} />
      <button class="chip-btn primary" onclick={createFolder} disabled={!newName.trim()}>{t('create')}</button>
    </div>
    {#if createErr}<div class="pk-err appear">{createErr}</div>{/if}
  {/if}

  {#if error}
    <div class="pk-err appear">{error}</div>
  {/if}

  <!-- Rows are keyed by path, so a new directory remounts them all and they
       unfold under the dim (motion.md principle 15). -->
  <div class="pk-list subtle-scroll" class:busy class:reveal bind:this={listEl}>
    {#if !ready}
      <div class="pk-empty">…</div>
    {:else if !dirs.length}
      <div class="pk-empty">{t('dirPickerEmpty')}</div>
    {:else}
      {#each dirs as d (d.path)}
        <button class="pk-row" onclick={() => open(d.path)}>
          <Icon name="folder" size={13} />
          <span class="pk-name">{d.name}</span>
          <Icon name="chevron-right" size={12} />
        </button>
      {/each}
    {/if}
  </div>

  <div class="pk-foot">
    <button class="chip-btn" onclick={() => oncancel?.()}>{t('cancel')}</button>
    <button class="chip-btn primary" disabled={!cwd} onclick={() => onpick?.(cwd)}>{t('dirPickerUse')}</button>
  </div>
</div>

<style>
  .picker { display: flex; flex-direction: column; min-height: 0; gap: 8px; }
  .pk-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .pk-head .icon-btn.on { color: var(--accent); background: var(--accent-bg); }
  .pk-path {
    flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sub);
    color: var(--text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    direction: rtl; text-align: left;   /* keep the TAIL of a long path visible */
  }
  .pk-err { color: var(--danger); font-size: var(--fs-meta); }
  .pk-new { display: flex; align-items: center; gap: 6px; color: var(--text3); }
  .pk-new-input {
    flex: 1; min-width: 0; padding: 5px 8px;
    border: 1px solid var(--input-border); border-radius: var(--ui-radius-control);
    background: var(--input-bg); color: var(--text); font-size: var(--fs-ui);
    font-family: var(--font-mono); outline: none;
  }
  .pk-new-input:focus { border-color: var(--accent); }
  .pk-list {
    flex: 1; min-height: 140px; max-height: calc(42vh / var(--ui-zoom, 1)); overflow-y: auto;
    border: 1px solid var(--border); border-radius: var(--ui-radius-control); background: var(--input-bg);
    transition: opacity var(--t-fast) ease;
  }
  /* In-flight cue that never flashes: the dim only starts after 150ms, so a
     fast local listing (the normal case) navigates with no visible blink. */
  .pk-list.busy { opacity: 0.55; transition-delay: 0.15s; }
  .pk-row {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    /* 40px rows: this is a phone-first list of tap targets. */
    min-height: 40px; padding: 6px 10px; border: none; border-bottom: 1px solid var(--border2);
    background: none; color: var(--text2); font-size: var(--fs-ui); cursor: pointer;
    font-family: var(--font-ui); /* rows carry directory names — data, not chrome */
    -webkit-tap-highlight-color: transparent;
    transition: color var(--t-fast);
  }
  .pk-row:last-child { border-bottom: none; }
  .pk-row:hover { color: var(--accent); }
  .pk-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pk-empty { padding: 16px; text-align: center; color: var(--text3); font-size: var(--fs-ui); }
  .pk-foot { display: flex; justify-content: flex-end; gap: 6px; }
</style>

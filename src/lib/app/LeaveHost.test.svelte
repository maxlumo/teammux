<script>
  // Two real guarded editors in App's page structure (board 315 review P1):
  // Files in an always-mounted, hidden-when-not-current layer, and the Agents
  // editor inside a layer that mounts only on `prefs` — or while the leave
  // walk HOLDS pages, exactly App's `{#if page === 'prefs' || holdPages}`
  // (App.source.test pins that expression). The walk is the real one.
  import { tick } from 'svelte';
  import Files from '../files/Files.svelte';
  import AgentsPage from '../hub/AgentsPage.svelte';
  import { confirmLeave } from './leave-guards.ts';
  import { useServerRuntime } from './server-context.ts';
  // The handle this host's subtree is bound to: a leave destroys THAT one
  // (board #335 ②b-2-3), so its guards are the ones asked.
  const leaving = useServerRuntime();
  let { expose = () => {} } = $props();
  let page = $state('files');
  let holdPages = $state(false);
  async function revealPage(next) { if (page !== next) { page = next; await tick(); } }
  $effect(() => expose({
    go: (next) => { page = next; },
    page: () => page,
    leave: () => confirmLeave({ leaving, current: page, reveal: revealPage, hold: (on) => { holdPages = on; } }),
  }));
</script>

<div class="layer-files" hidden={page !== 'files'}>
  <Files session="fixture" guardPage="files" visible={page === 'files'} />
</div>
{#if page === 'prefs' || holdPages}
  <div class="layer-prefs" hidden={page !== 'prefs'}>
    <AgentsPage section="agents" guardPage="prefs" visible={page === 'prefs'} />
  </div>
{/if}

<script>
  // Host for the status corner's mount test (board #335 ③c-5, P1-C2): the
  // sampler is handed a `load` whose answers the test releases by hand, an
  // `owner` the test swaps, and a `mounted` switch to destroy it.
  import SystemStatus from './SystemStatus.svelte';
  let owner = $state({ id: 'a' });
  let mounted = $state(true);
  let tag = $state('alpha');
  const pending = [];
  globalThis.__sys = {
    set owner(o) { owner = o; }, set tag(v) { tag = v; }, set mounted(v) { mounted = v; },
    release(all = true) { const fn = all ? pending.splice(0) : pending.splice(0, 1); for (const r of fn) r(); },
    get pending() { return pending.length; },
  };
  const load = () => new Promise((r) => { const mine = owner; pending.push(() => r({ cpu_pct: mine.id === 'a' ? 10 : 90, mem_used: 1, mem_total: 10, disk_used: 1, disk_total: 10 })); });
</script>

{#if mounted}
  <SystemStatus {load} {owner} {tag} />
{/if}

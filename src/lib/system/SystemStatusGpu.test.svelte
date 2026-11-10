<script>
  // Host for the GPU part of the status corner (board #102): the reading is
  // set by the test (`__gpu.reading`), and the ONE hover card is mounted so
  // its lines can be read.
  import SystemStatus from './SystemStatus.svelte';
  import HoverCard from '../ui/HoverCard.svelte';
  let reading = $state(null);
  let tag = $state(null);
  let rows = $state(1);
  globalThis.__gpu = { set reading(r) { reading = r; }, set tag(v) { tag = v; }, get rows() { return rows; } };
  const load = () => Promise.resolve(reading);
</script>

<SystemStatus {load} {tag} bind:rows />
<HoverCard />

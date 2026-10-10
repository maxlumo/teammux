<script>
  // Host for the scratch panel mount test (board #324): the frame state lives
  // here like App's, and `epoch` stands in for App's server key (the runtime
  // handle since board #335 ②b-1; what this fixture needs is only that the
  // key CHANGES on a switch).
  import ScratchPanel from './ScratchPanel.svelte';
  let open = $state(false);
  let live = $state(true);
  let edge = $state('bottom');
  let epoch = $state(0);
  globalThis.__scratch = {
    set open(v) { open = v; }, get open() { return open; },
    set live(v) { live = v; }, bump() { epoch++; },
    get edge() { return edge; },
  };
</script>

<button class="opener">opener</button>
{#key epoch}
  <ScratchPanel {open} {live} {edge} onclose={() => (open = false)} onedge={(e) => (edge = e)} />
{/key}

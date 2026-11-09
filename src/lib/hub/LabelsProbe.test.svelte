<script>
  // Test-only host for watchLabels (board #91): renders what one agent is shown as.
  import { watchLabels } from './session-labels.svelte.ts';
  let { runtime, session = 'app', agent = 'kiro-2', other = 'other' } = $props();
  // The probe is bound to one runtime for life, as a page is.
  // svelte-ignore state_referenced_locally
  const labels = watchLabels(runtime);
</script>
<span id="shown">{labels.names(session).shown(agent)}</span>
<span id="other">{labels.names(other).shown(agent)}</span>
<span id="peer">{labels.names(session).shown('omp-2')}</span>
<button id="refresh" onclick={() => labels.refresh()}>refresh</button>

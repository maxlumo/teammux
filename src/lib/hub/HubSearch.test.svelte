<script lang="ts">
  // Host for HubSearch's mount tests (board #432): the real lifecycle object, a
  // scripted `ask`, a composer-like draft to prove the box leaves it alone, and
  // an outside control for the focus rule.
  import { untrack } from 'svelte';
  import HubSearch from './HubSearch.svelte';
  import { createHubSearch } from './hub-search.svelte.ts';
  let { ask, askFiles = undefined, onjump = () => {}, onopenfile = () => {}, delay = 0 }: { ask: (req: any) => Promise<any>; askFiles?: (req: any) => Promise<any>; onjump?: (hit: any) => void; onopenfile?: (file: any) => void; delay?: number } = $props();
  let cleared = $state(0);
  (globalThis as unknown as { __cleared: () => number }).__cleared = () => cleared;
  const search = createHubSearch({ ask: (req) => ask(req), ...(untrack(() => askFiles) ? { askFiles: (req) => askFiles!(req) } : {}), delay: untrack(() => delay) });
  (globalThis as unknown as { __search: typeof search }).__search = search;
</script>

<div class="chat-head" style="position: relative; height: 40px">
  <button class="opener" type="button" onclick={() => search.show()}>search</button>
  <HubSearch {search} projectName={(room) => `P:${room}`} agentName={(n) => (n === 'human' ? 'you' : n)} {onjump} {onopenfile} onclearagent={() => { cleared += 1; search.setAgent(''); }} />
</div>
<textarea class="draft"></textarea>
<button class="outside" type="button">outside</button>

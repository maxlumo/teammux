<script lang="ts">
  import { untrack } from 'svelte';
  import AgentsPage from './AgentsPage.svelte';
  import type { BackendInfo } from '../core/agents.ts';
  import { useServerScope } from '../app/server-context.ts';
  // The catalog of the scope this page is bound to (board #335 ②b-3).
  const catalog = useServerScope()!.state.backends;
  let { ready, backends = null }: { backends?: BackendInfo[] | null; ready: (controls: {
    show: (value: boolean) => void;
    edit: (name: string) => void;
    section: (value: string) => void;
    serve: (list: BackendInfo[] | null) => void;
  }) => void } = $props();
  // What App.svelte does on connect: the server's backends_list, before the
  // page reads it (board #245 — the input-mode switch is server truth). Read
  // once, like App's connect handler; `untrack` says so.
  untrack(() => catalog.set(backends));
  let visible = $state(true);
  let section = $state('agents');
  let editRequest = $state<{ name: string; n: number } | null>(null);
  let sequence = 0;
  $effect(() => ready({
    show: value => visible = value,
    edit: name => editRequest = { name, n: ++sequence },
    section: value => section = value,
    serve: list => catalog.set(list),
  }));
</script>

<div hidden={!visible}>
  <AgentsPage {visible} {editRequest} {section} />
</div>

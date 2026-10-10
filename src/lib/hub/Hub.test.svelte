<script lang="ts">
  import { untrack } from 'svelte';
  import Hub from './Hub.svelte';
  import { setServedBackends, type BackendInfo } from '../core/agents.ts';
  import { useServerScope } from '../app/server-context.ts';
  // The notification centre is App-owned UI; a test drives its jump requests
  // here (#322) — through the centre of the scope this Hub is bound to.
  const centre = useServerScope()!.state.centre;
  (globalThis as unknown as { __centre: typeof centre }).__centre = centre;
  // What App.svelte does on connect: the server's backends_list, before the
  // Hub reads it (board #271 — the live queue/steer switch is server truth).
  let { backends = null, visible: shown = false, ...rest }: { backends?: BackendInfo[] | null; visible?: boolean; [key: string]: unknown } = $props();
  untrack(() => setServedBackends(backends));
  // A test leaves and returns to the Hub page the way App does: by `visible`.
  let visible = $state(untrack(() => shown));
  (globalThis as unknown as { __setVisible: (v: boolean) => void }).__setVisible = (v) => { visible = v; };
</script>

<Hub {...rest} {visible} />

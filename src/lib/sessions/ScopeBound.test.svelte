<script>
  // Host for scope-binding.mount.test.ts (board #335 ②b-3): binds ONE page of
  // the terminal/sessions area to a scope whose transport is NOT the facade's,
  // so a call that still went through `core/ws.ts` shows up on the wrong side.
  import { setServerScope } from '../app/server-context.ts';
  import Sessions from './Sessions.svelte';
  import PanePicker from './PanePicker.svelte';
  import ScratchPanel from '../app/ScratchPanel.svelte';

  let { which, ...rest } = $props();
  const transport = globalThis.__scopeTransport;
  // svelte-ignore state_referenced_locally
  setServerScope({ runtime: { id: 'b', api: transport, connection: transport }, state: undefined });
</script>

{#if which === 'sessions'}
  <Sessions visible {...rest} />
{:else if which === 'picker'}
  <button class="trigger">open</button>
  <PanePicker {...rest} />
{:else if which === 'scratch'}
  <ScratchPanel open {...rest} />
{/if}

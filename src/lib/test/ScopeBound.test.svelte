<script>
  // Host for scope-binding.mount.test.ts (board #335 ②b-3): binds ONE bound
  // page to a scope whose transport is NOT the facade's,
  // so a call that still went through `core/ws.ts` shows up on the wrong side.
  import { setServerScope } from '../app/server-context.ts';
  import { createServerState } from '../app/server-state.ts';
  import Files from '../files/Files.svelte';
  import Hub from '../hub/Hub.svelte';
  import Board from '../hub/Board.svelte';
  import ChatImage from '../hub/ChatImage.svelte';
  import Projects from '../projects/Projects.svelte';
  import CreateProjectDialog from '../projects/CreateProjectDialog.svelte';
  import AgentsPage from '../hub/AgentsPage.svelte';
  import Sessions from '../sessions/Sessions.svelte';
  import PanePicker from '../sessions/PanePicker.svelte';
  import ScratchPanel from '../app/ScratchPanel.svelte';
  import GitPanel from '../files/GitPanel.svelte';
  import DirPicker from '../files/DirPicker.svelte';

  let { which, ...rest } = $props();
  const transport = globalThis.__scopeTransport;
  // svelte-ignore state_referenced_locally
  setServerScope({ runtime: { id: 'b', api: transport, connection: transport }, state: createServerState(localStorage) });
</script>

{#if which === 'sessions'}
  <Sessions visible {...rest} />
{:else if which === 'picker'}
  <button class="trigger">open</button>
  <PanePicker {...rest} />
{:else if which === 'scratch'}
  <ScratchPanel open {...rest} />
{:else if which === 'git'}
  <GitPanel {...rest} />
{:else if which === 'dir'}
  <DirPicker {...rest} />
{:else if which === 'files'}
  <Files visible {...rest} />
{:else if which === 'hub'}
  <Hub visible {...rest} />
{:else if which === 'board'}
  <Board visible {...rest} />
{:else if which === 'image'}
  <ChatImage {...rest} />
{:else if which === 'projects'}
  <Projects {...rest} />
{:else if which === 'create'}
  <CreateProjectDialog {...rest} />
{:else if which === 'agents'}
  <AgentsPage visible {...rest} />
{/if}

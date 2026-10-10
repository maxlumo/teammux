<script>
  // Files plus the switch's leave-guard walk, so a mount test can drive the
  // real guard of a real editor (board 315).
  import Files from './Files.svelte';
  import { confirmLeave } from '../app/leave-guards.ts';
  import { useServerRuntime } from '../app/server-context.ts';
  // The handle this host's subtree is bound to: a leave destroys THAT one
  // (board #335 ②b-2-3), so its guards are the ones asked.
  const leaving = useServerRuntime();
  let { expose = () => {}, ...initial } = $props();
  $effect(() => expose({ confirmLeave: () => confirmLeave({ leaving, current: 'files', reveal: async () => {}, hold: () => {} }) }));
</script>

<Files {...initial} />

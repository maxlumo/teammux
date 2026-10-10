<script>
  // The owner of one server-bound subtree (board #335 ②b-1): it binds the
  // subtree to one runtime at init and renders the pages inside it.
  //
  // Its host keys it on the handle, so a replacement runtime is a new
  // INSTANCE of this component rather than a new value in a live one — which
  // is what makes "read the context once at init" safe for every page below.
  import { setServerRuntime } from './server-context.ts';

  let { runtime, children } = $props();

  // svelte-ignore state_referenced_locally
  // One runtime for this instance's whole life. A null one provides nothing,
  // and that is a real case rather than a gap: before the first connect there
  // is no saved entry to name, and `useServerApi()` then falls back to the
  // facade — the path every page takes today. b3-4 removes the fallback and
  // this case together.
  if (runtime) setServerRuntime(runtime);
</script>

{@render children?.()}

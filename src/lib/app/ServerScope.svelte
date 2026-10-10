<script>
  // The owner of one server-bound subtree (board #335 ②b-1): it binds the
  // subtree to one runtime at init and renders the server-bound pages inside
  // it.
  //
  // Its host keys it on the handle, so a replacement runtime is a new
  // INSTANCE of this component rather than a new value in a live one — which
  // is what makes "read the context once at init" safe for every page below.
  //
  // WITH NO RUNTIME IT RENDERS NOTHING (reviewer P1-b, 2026-10-10). Rendering
  // the children anyway — merely without a context — looked harmless and was
  // the opposite: during the gap in a swap it built a whole provider-less
  // Files/Terminal/Hub tree that fell back to the facade, and `{#key}` mounts
  // the new branch BEFORE destroying the old, so that unbound tree came up
  // while the old server's tree was still alive. Nothing server-bound exists
  // without a server to bind it to.
  //
  // What a person can do before there is a server — the Connection surface,
  // the preferences that belong to them and not to a machine — is rendered by
  // the host OUTSIDE this subtree, so suppressing the children here cannot
  // strand a fresh client on an empty screen.
  import { setServerRuntime } from './server-context.ts';

  let { runtime, children } = $props();

  // svelte-ignore state_referenced_locally
  // One runtime for this instance's whole life.
  if (runtime) setServerRuntime(runtime);
</script>

{#if runtime}{@render children?.()}{/if}

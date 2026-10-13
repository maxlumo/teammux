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
  //
  // It binds the runtime AND that server's state (②b-2-1), as one scope: the
  // host built the state for this runtime, and the two arrive together so no
  // page can see one server's runtime with another server's memory.
  import { setServerScope } from './server-context.ts';

  let { runtime, state, tag = null, eligible = null, children } = $props();

  // svelte-ignore state_referenced_locally
  // One runtime, and its state, for this instance's whole life. The tag is
  // read LIVE through the getter (③c-1): it follows the included set.
  if (runtime) setServerScope({ runtime, state, get tag() { return tag; }, get eligible() { return eligible; } });
</script>

{#if runtime}{@render children?.()}{/if}

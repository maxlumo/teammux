<script>
  // Host for the server-context mount test (board #335 ②a-3). It stands in
  // for what ②b's App will do: one provider per server-bound subtree, keyed
  // by the runtime HANDLE, plus one subtree with no provider at all, which
  // since ②b-4 FAILS: there is no fallback api (the boundary shows why).
  import ServerContextProvider from './ServerContext.test.provider.svelte';
  import ServerContextConsumer from './ServerContext.test.consumer.svelte';

  let runtimes = $state([]);
  let bare = $state(false);
  globalThis.__ctx = {
    set runtimes(v) { runtimes = v; },
    get runtimes() { return runtimes; },
    set bare(v) { bare = v; },
  };
</script>

{#each runtimes as runtime (runtime.id)}
  <!-- Keyed by the HANDLE, not by the id: a replacement runtime for the same
       server swaps the owner, while an ordinary reconnect (the same object)
       remounts nothing. The key gives the swap and not its ORDER — Svelte
       creates the new branch first, which the mount test measures. -->
  {#key runtime}
    <ServerContextProvider {runtime}>
      <ServerContextConsumer label={runtime.id} />
    </ServerContextProvider>
  {/key}
{/each}

{#if bare}
  <svelte:boundary>
    <ServerContextConsumer label="no-provider" />
    {#snippet failed(error)}<p class="no-scope">{String(error?.message ?? error)}</p>{/snippet}
  </svelte:boundary>
{/if}

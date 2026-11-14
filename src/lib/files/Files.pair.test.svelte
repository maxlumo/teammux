<script>
  // Board #126: the Files PAGE and the Hub's drawer Files, two instances in one server's
  // Files record, each behind its own mount gate (the drawer's is the Hub's compact width).
  // `drawerFirst` mounts the drawer before the page, the order the app has (reviewer, note
  // 22: which instance's effect runs last must not decide whose text is kept).
  import Files from './Files.svelte';
  let { page = true, drawer = true, pageRequest = null, drawerRequest = null, session = 'fixture', drawerFirst = false } = $props();
</script>

{#snippet pageHost()}<section class="page-host">{#if page}<Files visible={true} {session} singlePane={true} navRequest={pageRequest} />{/if}</section>{/snippet}
{#snippet drawerHost()}<section class="drawer-host">{#if drawer}<Files visible={true} {session} singlePane={true} navRequest={drawerRequest} />{/if}</section>{/snippet}
{#if drawerFirst}{@render drawerHost()}{@render pageHost()}{:else}{@render pageHost()}{@render drawerHost()}{/if}

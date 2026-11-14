<script lang="ts">
  // Host for #124's live-switch case (validator note 28): the Agents editor's TWO hosts on one server, as
  // App mounts them. The desktop page is conditional on the layout (App: `!agentsLivesInSettings(layout.phone)`);
  // Settings' guest, once opened on the phone, stays mounted and hidden (Preferences' `opened`).
  import AgentsPage from './AgentsPage.svelte';
  let host = $state<'page' | 'settings'>('page');
  let guestOpened = $state(false);
  let section = $state('agents');
  (globalThis as unknown as { __hosts: unknown }).__hosts = {
    set host(v: 'page' | 'settings') { host = v; if (v === 'settings') guestOpened = true; },
    set section(v: string) { section = v; },
  };
</script>

{#if host === 'page'}
  <div class="host-page"><AgentsPage visible={true} /></div>
{/if}
{#if guestOpened}
  <div class="host-settings" hidden={host !== 'settings'}><AgentsPage visible={host === 'settings'} {section} /></div>
{/if}

<script>
  // Board #423 review P2-B: Settings and the notification centre on one
  // screen, over the one switch — an unmute from the centre must refresh the
  // Settings caption that reads the platform permission.
  import Host from './Preferences.test.svelte';
  import NotifyCentre from '../hub/NotifyCentre.svelte';
  let props = $props();
  const centre = { items: [], sources: [], clearable: false, clear() {} };
</script>

<Host {...props} />
<div class="centre-host"><NotifyCentre {centre} /></div>

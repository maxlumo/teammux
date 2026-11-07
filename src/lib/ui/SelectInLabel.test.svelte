<script>
  import Select from './Select.svelte';
  let value = $state('kiro'), escapes = $state(0);
</script>
<svelte:window onkeydown={e => { if (e.key === 'Escape' && !e.defaultPrevented) escapes++; }} />
<label><span>Backend</span>
  <Select bind:value options={['kiro', 'codex']} ariaLabel="Backend" />
</label>
<label><span>Name</span><input name="name" /></label>
<output>{value}/{escapes}</output>

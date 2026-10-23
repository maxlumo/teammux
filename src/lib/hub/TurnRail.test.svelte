<script>
  // The Feed with the buttons a HOST would press (board #461). Test-only.
  // Each button does its whole change in ONE synchronous handler, so a fixture
  // can hold a pointer down, press one, and release after: a flush then sees
  // only the final state, which is exactly what a round trip inside one flush
  // looks like to an effect and why retirement is CALLED at the change.
  import Feed from './Feed.svelte';

  let { a = [], b = [], ...rest } = $props();
  let feed = $state(null);
  // The first blocks are the starting point only; the buttons below replace them.
  // svelte-ignore state_referenced_locally
  let blocks = $state(a);
  let selected = $state('A');
  let visible = $state(true);

  function room(to) {
    selected = to;
    blocks = to === 'A' ? a : b;
    feed.resetForRoom();          // what Hub's select path does, cached or not
  }
</script>

<button class="t-aba" onclick={() => { room('B'); room('A'); }}>A to B to A</button>
<button class="t-hide-show" onclick={() => { visible = false; visible = true; }}>hide then show</button>
<button class="t-hide" onclick={() => { visible = false; }}>hide</button>
<button class="t-show" onclick={() => { visible = true; }}>show</button>
<button class="t-filter" onclick={() => { feed.retireTurnRail(); blocks = b; feed.retireTurnRail(); blocks = a; }}>filter on, off</button>
<button class="t-set-b" onclick={() => { blocks = b; }}>blocks B</button>
<button class="t-set-a" onclick={() => { blocks = a; }}>blocks A</button>
<button class="t-close" onclick={() => { window.__closed = feed.closeTurnRail(); }}>back</button>

<Feed bind:this={feed} {blocks} {selected} {visible} {...rest} />

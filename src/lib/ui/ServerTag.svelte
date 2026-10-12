<script lang="ts">
  // The ONE server tag (board #335 ③c-1): where several servers can show in
  // one place — a union row, a page head, the Hub head, a notification —
  // this names the row's SOURCE. A micro tag in the design language's
  // existing vocabulary (design-language.md §Radius: tags are the capsule
  // allowlist; §Colour: a server is identity, not a state, so it wears the
  // achromatic text ink and a surface wash, never a status colour).
  //
  // WHEN it shows is not decided here: the caller passes `name` only when
  // the ②a ruling says so (more than one server included, whatever their
  // health — `app/server-tag.ts`), and null renders nothing. Single mode is
  // therefore tag-free by construction.
  let { name = null, title = undefined }: { name?: string | null; title?: string } = $props();
</script>

{#if name}
  <span class="server-tag" title={title ?? name}>{name}</span>
{/if}

<style>
  .server-tag {
    display: inline-block; flex: none; max-width: 10em;
    padding: 0 6px; border-radius: var(--ui-radius-pill);
    background: var(--surface2); color: var(--text2);
    font: 500 var(--fs-micro)/1.6 var(--font-ui);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle;
  }
</style>

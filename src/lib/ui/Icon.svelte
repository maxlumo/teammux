<script lang="ts">
  let { name, size = 16 }: { name: string; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  {#if name === 'bot'}
    <rect x="4" y="8" width="16" height="12" rx="3"/><circle cx="9.5" cy="14" r="1.5" fill="currentColor" stroke="none"/><circle cx="14.5" cy="14" r="1.5" fill="currentColor" stroke="none"/><line x1="12" y1="3" x2="12" y2="8"/><circle cx="12" cy="2.5" r="1.5" fill="currentColor" stroke="none"/><line x1="2" y1="13" x2="4" y2="13"/><line x1="20" y1="13" x2="22" y2="13"/>
  {:else if name === 'user'}
    <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 0 0-16 0"/>
  {:else if name === 'sessions'}
    <rect x="2" y="3" width="20" height="18" rx="2"/><path d="M8 21V7"/><path d="M2 7h20"/>
  {:else if name === 'terminal'}
    <!-- The page glyphs carry `glyph-*` PARTS that move only inside a chosen
         `.tab-glyph` (board #240, app.css): the prompt steps forward and the
         cursor shortens; the chat bubble starts typing; the gear turns; the
         page gains its title line; a card drops into the board's left column;
         the crew rises behind the front bot. Upright end poses that differ
         from rest (#262: a tilted page read as crooked, and a mirrored board
         is the same board).
         Outside the atom every part rests, so the drawing reads as before. -->
    <polyline class="glyph-step" points="4 17 10 11 4 5"/><line class="glyph-cursor" x1="12" y1="19" x2="20" y2="19"/>
  {:else if name === 'chat'}
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    <circle class="glyph-talk" cx="8" cy="10" r="1.25" fill="currentColor" stroke="none"/><circle class="glyph-talk" cx="12" cy="10" r="1.25" fill="currentColor" stroke="none"/><circle class="glyph-talk" cx="16" cy="10" r="1.25" fill="currentColor" stroke="none"/>
  {:else if name === 'gear'}
    <g class="glyph-spin"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></g>
  {:else if name === 'palette'}
    <path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h3a6 6 0 0 0 0-12z"/><circle cx="7.5" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="9.5" cy="6.5" r="1" fill="currentColor" stroke="none"/><circle cx="14" cy="6" r="1" fill="currentColor" stroke="none"/>
  {:else if name === 'link'}
    <path d="M10 13a5 5 0 0 0 7.07.07l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"/><path d="M14 11a5 5 0 0 0-7.07-.07l-2 2A5 5 0 0 0 12 20l1.15-1.15"/>
  {:else if name === 'x'}
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  {:else if name === 'search'}
    <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  {:else if name === 'filter'}
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  {:else if name === 'key'}
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
  {:else if name === 'send'}
    <path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4Z"/>
  {:else if name === 'send-up'}
    <line x1="12" y1="19" x2="12" y2="5.5" stroke-width="2.6"/><polyline points="5.5 11.5 12 5 18.5 11.5" stroke-width="2.6"/>
  {:else if name === 'stop'}
    <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>
  {:else if name === 'arrow-down'}
    <polyline points="6 9 12 15 18 9"/>
  {:else if name === 'delete'}
    <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/>
  {:else if name === 'arrow-up'}
    <polyline points="18 15 12 9 6 15"/>
  {:else if name === 'arrow-left'}
    <polyline points="15 18 9 12 15 6"/>
  {:else if name === 'arrow-right'}
    <polyline points="9 18 15 12 9 6"/>
  {:else if name === 'code'}
    <!-- Source — the feed's "raw" (board #218, owner 2026-09-20: "raw 的图标我理解
         不了，可以用类似源码的图标"): two angle brackets and a slash, the ⌘ it replaces
         read as a key, not as "show the source". -->
    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/>
  {:else if name === 'chevron-right'}
    <polyline points="9 18 15 12 9 6"/>
  {:else if name === 'panel-left'}
    <!-- The primary-sidebar toggle (board #202): a window with its left pane,
         and a chevron in the content area that alone turns 180° (.turn) —
         pointing at the pane while it is open (collapse), away when closed.
         The BASE drawing is the closed reading (points right, "expand");
         `.flip.on` (expanded) turns it to point left at the pane. #215 fixed
         the base, which pointed left and so read backwards in both states. -->
    <rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>
    <polyline class="turn" points="14 9.5 16.5 12 14 14.5"/>
  {:else if name === 'panel-bottom' || name === 'panel-right'}
    <!-- The scratch panel's two docks (board #326), same family as
         `panel-left`: a window with the panel's own edge drawn as the divider
         — across the bottom, or down the right side. No chevron: unlike the
         sidebar toggle these are a CHOICE, and the Segmented pill shows which
         one is live. -->
    <rect x="3" y="4" width="18" height="16" rx="2"/>
    {#if name === 'panel-bottom'}<line x1="3" y1="14" x2="21" y2="14"/>{:else}<line x1="15" y1="4" x2="15" y2="20"/>{/if}
  {:else if name === 'chevron-down'}
    <polyline points="6 9 12 15 18 9"/>
  {:else if name === 'chevron-up'}
    <polyline points="18 15 12 9 6 15"/>
  {:else if name === 'skip-left'}
    <line x1="7" y1="5" x2="7" y2="19"/><polyline points="17 5 11 12 17 19"/>
  {:else if name === 'skip-right'}
    <line x1="17" y1="5" x2="17" y2="19"/><polyline points="7 19 13 12 7 5"/>
  {:else if name === 'copy'}
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  {:else if name === 'folder'}
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  {:else if name === 'folder-plus'}
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
  {:else if name === 'folder-star'}
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polygon points="12 11 13.2 13.4 16 13.8 14 15.7 14.5 18.5 12 17.2 9.5 18.5 10 15.7 8 13.8 10.8 13.4" fill="currentColor" stroke="none"/>
  {:else if name === 'image'}
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
  {:else if name === 'file'}
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
  {:else if name === 'folder-up'}
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><polyline points="12 17 12 11"/><polyline points="9 14 12 11 15 14"/>
  {:else if name === 'home'}
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
  {:else if name === 'upload'}
    <polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
  {:else if name === 'downloading'}
    <!-- A download in progress (board #307): a dashed ring around an arrow
         into a tray. Only the ring turns (.dl-ring, OperationFeedback); the
         arrow and tray hold still. -->
    <circle class="dl-ring" cx="12" cy="12" r="10" stroke-dasharray="3.2 2.8"/><polyline points="8.5 10.5 12 14 15.5 10.5"/><line x1="12" y1="6.5" x2="12" y2="14"/><line x1="7.5" y1="17.5" x2="16.5" y2="17.5"/>
  {:else if name === 'download'}
    <polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/>
  {:else if name === 'plus'}
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  {:else if name === 'minus'}
    <line x1="5" y1="12" x2="19" y2="12"/>
  {:else if name === 'trash'}
    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  {:else if name === 'edit'}
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  {:else if name === 'save'}
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
  {:else if name === 'undo'}
    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
  {:else if name === 'wrap-text'}
    <line x1="3" x2="21" y1="6" y2="6"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><line x1="3" x2="10" y1="18" y2="18"/>
  {:else if name === 'no-wrap'}
    <line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/>
  {:else if name === 'redo'}
    <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/>
  {:else if name === 'arc-right'}
    <path d="M7 18 V12 A5 5 0 0 1 12 7 H16"/><polyline points="13 4 17 7 13 10"/>
  {:else if name === 'arc-left'}
    <path d="M17 18 V12 A5 5 0 0 0 12 7 H8"/><polyline points="11 4 7 7 11 10"/>
  {:else if name === 'swap-h'}
    <path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>
  {:else if name === 'bots'}
    <!-- Three offset heads share the single bot's rounded face. Rear contours
         stop where the front head begins, so no hidden strokes cross its face
         at the 20px roster size. -->
    <g class="glyph-crew" stroke-width="1.6" opacity="0.65">
      <path d="M12 5.8a2.4 2.4 0 0 1 2.4-2.4h5.2A2.4 2.4 0 0 1 22 5.8v3.1"/>
      <path d="M17 3.4V1.8"/>
      <circle cx="15.4" cy="7" r="0.95" fill="currentColor" stroke="none"/>
      <circle cx="19.1" cy="7" r="0.95" fill="currentColor" stroke="none"/>
    </g>
    <g class="glyph-crew" stroke-width="1.7" opacity="0.8">
      <path d="M12.6 6.7H5a2.5 2.5 0 0 0-2.5 2.5v5.6A2.2 2.2 0 0 0 4.7 17h3"/>
      <path d="M7.4 4.7v2"/>
      <circle cx="5.3" cy="12" r="1.05" fill="currentColor" stroke="none"/>
    </g>
    <rect x="8" y="9" width="13.5" height="12" rx="3" stroke-width="1.8"/>
    <path d="M13 7.7V9" stroke-width="1.8"/>
    <circle cx="12.2" cy="15.1" r="1.25" fill="currentColor" stroke="none"/>
    <circle cx="17.3" cy="15.1" r="1.25" fill="currentColor" stroke="none"/>
  {:else if name === 'play'}
    <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/>
  {:else if name === 'pause'}
    <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
  {:else if name === 'volume'}
    <path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>
  {:else if name === 'volume-off'}
    <path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>
  {:else if name === 'pip'}
    <rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1"/>
  {:else if name === 'maximize'}
    <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
  {:else if name === 'minimize'}
    <path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>
  {:else if name === 'info'}
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
  {:else if name === 'files'}
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line class="glyph-write" x1="8" y1="9" x2="12" y2="9"/>
  {:else if name === 'eye'}
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  {:else if name === 'eye-off'}
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
  {:else if name === 'bell'}
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>
  {:else if name === 'bell-off'}
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="1" y1="1" x2="23" y2="23"/>
  {:else if name === 'chevron-left'}
    <polyline points="15 18 9 12 15 6"/>
  {:else if name === 'refresh'}
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>
  {:else if name === 'star'}
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  {:else if name === 'star-filled'}
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/>
  {:else if name === 'circle'}
    <circle cx="12" cy="12" r="9"/>
  {:else if name === 'circle-check'}
    <circle cx="12" cy="12" r="9"/><polyline points="8.5 12.5 11 15 15.5 9.5"/>
  {:else if name === 'check'}
    <polyline points="20 6 9 17 4 12"/>
  {:else if name === 'check-filled'}
    <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><polyline points="17 8 10 15 7 12" stroke="var(--bg)" stroke-width="2.5" fill="none"/>
  {:else if name === 'zap'}
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  {:else if name === 'corner-down-left'}
    <!-- Enter (↩), the terminal bar's key while the soft keyboard is down (#296). -->
    <polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>
  {:else if name === 'keyboard'}
    <rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="10" y1="12" x2="10" y2="12"/><line x1="14" y1="12" x2="14" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/>
  {:else if name === 'git-branch'}
    <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
  {:else if name === 'clock'}
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  {:else if name === 'dots'}
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>
  {:else if name === 'grip'}
    <circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>
  {:else if name === 'menu'}
    <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
  {:else if name === 'layout'}
    <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><rect class="glyph-card" x="5.5" y="6" width="4" height="4" rx="1" fill="currentColor" stroke="none"/>
  {/if}
</svg>

<style>
  svg { display: inline-block; vertical-align: middle; }
</style>

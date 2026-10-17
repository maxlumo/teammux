# File Browser Page

## Purpose
Browse, preview, edit, and manage files on the remote server's filesystem. The
File Browser is always available (it does not require an open terminal pane).
The starting directory follows the active terminal/team session's working
directory, or the server's home directory when no session is open yet.

## Components
- Server door (board #358, owner 2026-10-13: "在 File 页面，其实也可以让我有一个
  地方，能很快速、方便地切换不同的 server 连接"): when more than one server is
  included (the ③c-1 tag rule), a small pill naming this tree's server opens
  App's ONE server popover. Where it sits (#366, owner 2026-10-14: "你切换的
  按钮单独占了一整行。你看能不能把它放到路径的最左侧，用一个非常小的 button 来
  做切换，保留机器的前几个字母就好"): not a row of its own, but the FIRST item
  of the line that says where you are — the path row in the list (before
  Back/Forward and the crumbs), the header right after Back in preview, edit,
  info, git and downloads whenever the list column is not on screen (one
  pane, or forced Desktop below 900px where the list hides beside a view —
  reviewer P1 on #366); when the list column IS on screen its path row keeps
  the one door. The label is the server's SHORT name (`shortServerTag`: first
  word, at most 8 letters — "devbox", "macmini" stay whole, a long host name
  shows its first word; if two included servers would share a short name both
  show in full); the full name is the tooltip and the accessible name. The
  pill is the one `ServerTag` at `--fs-micro`; its box is the row's control
  height and never shrinks, so a long path scrolls in its own strip and never
  pushes the door. Reading mode hides it. The popover is the one the rail and
  Settings open; there is no second
  switcher. Picking a connected server is the ordinary focus move (D2): no
  dial, no teardown; the other server's Files tree comes to the front with its
  own parked position (its `ServerState` keeps it). Nothing is merged: Files
  is the focused server's tree by design (D3). Single mode, or one included
  server, has no door. Same control on the phone and the desktop.
- Unified toolbar: named shared icon controls, 28px pointer / 44px coarse
  native targets with compact inset paint. Keep one row; measured overflow
  exposes trailing actions through the shared More menu, without shrinking
  touch targets or removing actions.
  Its first control
  (terminal glyph, "Session directory") returns to the active session's
  working directory; it is NOT a home button — the house icon means the
  user's home (`~`) wherever it appears (the directory picker)
- Breadcrumb path row (separate from toolbar): headed by the browser pair, Back and Forward (arrow glyphs, 28/44 targets) — Back retraces the user's directory steps, Forward undoes a Back, each disabled at its end, a fresh navigation clears Forward; the crumb strip scrolls to its tail; the root reads as the first separator; a segment's text is selectable, and right-click / long-press offers Copy name / Copy path of that segment (rows offer the same pair); file names in the list are selectable too, and a tap that ends a selection does not open or navigate
- File/directory list with icons, size, modified date
- The desktop list uses the available width until a preview is open. Beside a
  preview its independent, resizable width defaults to 400px (320-520px), not
  the global navigation sidebar width. File sizes sit to the right of complete
  names, on the same row; ordinary file and folder rows share a height.
- Bookmark panel (star current dir, scrollable saved paths)
- Recent files panel (last 20 opened files, scrollable, capped to 40vh)
- File preview: Markdown (rendered through the shared safe renderer, `core/markdown.ts`, + mermaid + KaTeX), CSV (table), code (syntax highlighted; the lined view shows the first 3000 lines with a "Show all N lines" button), HTML (sandboxed iframe), PDF (pdf.js), images (tap → the fullscreen Lightbox with pinch/wheel zoom; a trackpad pinch on the inline image opens it instead of zooming the page), video (the browser's own `<video>` player streaming ranges from the signed `/dl` URL — mp4/m4v/webm/mov/mkv/ogv, any size), audio (the browser's own `<audio controls>` player on the same stream — mp3 (`audio/mpeg`), m4a (`audio/mp4`), aac (`audio/aac`), ogg/oga/opus (`audio/ogg`), wav, flac, weba (`audio/webm`), any size; no waveform, playlist, background playback or cover art; hiding the page — a tab or server switch — pauses video and audio, and showing it again never plays). pdf.js, mermaid and highlight.js load on first use, not at startup.
- Text editor with syntax highlighting, undo stack, save button
- File operations: create file/folder, rename, delete, upload (with per-file progress feedback: reading %, a sending beat, then `Uploaded …` or a line naming every failed file; single file ≤ 60 MB), download
- File info panel: path (tap to copy), type, size, modified, permissions
- Git integration: status view, per-file stage/unstage, diff viewer, commit log, add all/commit/push

## Interactions
- Tap the server door → App's server popover (rail / Settings dialect); pick a server → focus moves there, Files shows that server's tree
- Tap directory → navigate into it
- Tap file → preview (or info page if not previewable, or if file size > 5 MB and the kind is not streamed — video and audio stream at any size)
- On the phone, a text preview (markdown, code, csv, html, pdf, converted
  documents) offers **Reading mode** (maximize in the header): the preview
  header and the app's tab bar hide, the content takes the whole screen, and
  one floating control (minimize, bottom-right, above the safe area) or the
  Back gesture returns to the normal preview. Not offered for images (the
  Lightbox), video or audio (their players), nor on the desktop layout. Leaving the
  preview or the page ends it.
- Tap a path reference in chat, Markdown, converted content, or an HTML
  preview → open it in Files, with the target's parent listing and a Back
  route to the source preview/list. Relative paths resolve against the
  project (chat) or source document's directory (previews), never the web origin.
- Explicit HTTP(S) and protocol-relative web links open in the system browser
  (a separate tab in browser mode); never navigate the app WebView.
- Desktop left-click, Cmd/Ctrl-click and middle-click share this destination
  policy: paths stay inside Files; real web URLs open externally.
- Background/resume and WebSocket reconnect refresh directory data without closing the active preview or editor
- From info page → tap preview (eye) button to load preview on demand
- Long file names wrap, preserving whitespace, rather than hiding behind a
  horizontal scroller. Preview titles also wrap without displacing Back/tools.
- Tap edit → open text editor
- Leaving an editor with unsaved changes asks "Discard unsaved changes?" on
  EVERY exit — the back button/gesture, a session or pane switch, the
  follow-the-cwd move, and the Hub drawer's "look here" jump. Cancel keeps the
  editor; a cancelled programmatic move (cwd follow) is skipped for that
  event, not replayed later
- Desktop right-click / long-press on a row → shared actions for that entry.
  Blank-directory context and toolbar More reuse toolbar actions; a menu
  cannot act on a different entry after navigation. Info remains available
  through the preview's existing info action.
- Menu Open and row Open both protect an unsaved editor. Menu Delete still
  requires confirmation; Back closes the menu before leaving the current view.
- Star button → bookmark current directory
- Hidden-file and bookmark tools expose pressed state; bookmark/recent panels
  expose expanded state and an associated panel ID. An opened empty panel
  distinguishes loading, read failure/retry and a confirmed empty collection.
- New item opens a name field and the shared File/Folder segmented choice.
- Refresh button in the toolbar → re-list current directory
- Swipe right from left edge → go back
- The back gesture retraces the user's own directory path first (a history,
  not a parent walk); below it a tab visit climbs parent directories to `/`
  and then stays (board #47 — the terminal is not below Files). Only a visit
  jumped from the chat returns to the conversation instead.
- Upload button → file picker (Tauri on desktop/Android, `<input>` in browser)
- Download button → save file locally

## API Calls
- `fs_cwd(session)` — get session working directory
- `fs_list(path, show_hidden)` — list directory
- `fs_stat(path)` — file metadata
- `fs_read(path)` — read text file (≤512KB)
- `fs_write(path, content)` — save text file
- `fs_mkdir(path)` — create directory
- `fs_delete(path)` — delete file/directory
- `fs_rename(from, to)` — rename/move
- `fs_download(path)` — download as base64 (≤50MB)
- `fs_upload(path, data)` — upload as base64 (one atomic message per file; the client refuses files over 60 MB, the server's 80 MB message cap ÷ base64 growth)
- `fs_convert(path, format?)` — convert file to HTML for preview (currently pptx only; extracted natively by the server, no external tooling required)
- `git(subcmd, args, cwd)` — git operations
- `get_bookmarks()` / `save_bookmarks(bookmarks)` — bookmark persistence

## State Management
- Current path, directory listing
- Preview content and mode (markdown/csv/code/html/pdf/image)
- Editor content, unsaved changes flag, undo stack
- Bookmarks array (server-side persistence)
- Show hidden files toggle
- Git status, diff, log data

### Bookmarks / recent-files write discipline
Both lists persist whole-array last-writer-wins (`save_bookmarks`,
`set_pref('recentFiles')`) and RPCs are concurrent, so the client guards
against clobbering (`src/lib/files/Files.svelte`):
1. Never persist before the first successful load (a write of the default
   `[]` would erase the server list); if the lazy load fails, skip
   persisting rather than wipe.
2. Every local mutation bumps a generation counter; fetch continuations
   only assign if their generation is still current — an in-flight read
   must not overwrite a newer local mutation.
3. The lazy first load is single-flighted (one shared promise).
These are client-side guards only; two *different* clients can still race
(server-side merge semantics would be the deeper fix — see todo.md §F).

Both rules are implemented once in `src/lib/files/persisted-list.ts`
(unit-tested); bookmarks and recents are two configurations of it.

## Edge Cases
- Base64 upload uses chunked encoding (8192 bytes/chunk) to avoid stack overflow
- Files > 5 MB (or not previewable by mime/name) open the info page instead of auto-loading preview; user confirms via preview button to avoid heavy transfers on mobile
- Markdown preview resolves relative image paths, infers MIME from image extension (not parent file)
- Markdown preview escapes raw HTML in the file (a README's `<img onerror>` is text, not script); inline HTML badges/logos therefore show as source
- A text file over 3000 lines previews its head; "Show all N lines" renders the rest (one DOM row per line — the cap keeps a 512 KB log from freezing a phone)
- Code highlighting arrives after the first-use load of highlight.js; the lines are readable (escaped, unhighlighted) in the meantime
- HTML preview iframe: `allow-same-origin` only, NO `allow-scripts` (sandbox escape prevention)
- HTML preview installs parent-owned path and external handlers in the sandbox
  document, since iframe click events cannot reach App
- Android downloads go to `/storage/emulated/0/Download/TmuxMobile/`, opened via FileProvider + Intent
- Android's downloaded-files list is sorted by filesystem modification time descending (newest first)
- The Files toolbar's Downloads (every platform, board #308) lists downloads in four groups: In progress (the running card with percent, speed and Cancel, which deletes its part), Resumable (parts on disk with their size; Download again resumes, Delete removes the part; a part from another server can only be deleted), Failed (Retry), and Finished (Android: the Download/TmuxMobile folder, tap opens, Delete asks first; desktop and browser: what this session saved). A browser shows only this session, and says so.
- Several downloads at once each keep their own card in the Files feedback stack, newest first, with percent, speed and Cancel (board #420): the same card the Downloads view's In progress group shows, read from the same store, so a newer download never hides an older one and the page and the Hub drawer show the same running downloads. The Downloads view itself lists them instead of the stack. No count badge, no cap.
- Download feedback uses the shared presentation; a measured transfer reports
  an integer byte percentage, while unknown totals and writing are indeterminate
  (#167, 2026-09-12). No synthetic percentage or delayed completion flash.
- A native saved-file result keeps Open/Close until acted on or its context
  exits; a browser download request uses the ordinary short completion notice
  without claiming the file was saved.
- Android file opening uses the `AndroidFileOpener` JS interface injected before initial page load by `onWebViewCreate`, NOT `tauri-plugin-opener`
- Android reattaches and health-checks the file opener after app resume; a failed download-complete Open remains retryable
- Filenames sanitized server-side (`sanitize_filename()`) to prevent path traversal
- Failed transfers leave pending state and expose their error; a stale
  completion cannot replace the feedback for a newer operation or context.
- Git arguments are passed directly as argv, not through a shell; log format separators such as `|` are valid argument data
- Git outcomes share the local feedback contract under the panel header.
  Failures keep stderr (or the exit code when stderr is empty) visible until
  retry/dismiss/context exit; ordinary completion uses the common 1500ms
  scheduler, not the retired 3-second error flash (#167, 2026-09-12).

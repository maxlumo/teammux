# File Handling & Security

## Context
File browser handles uploads, downloads, and previews across platforms with varying security constraints.

## Decision
Base64 encoding for small file transfer (previews), streaming HTTP for large-file downloads (user-initiated), chunked processing, sandboxed previews, platform-specific download/open paths.

## Key Decisions

### Copy and download feedback belongs to its attempt (#167 batch 2, 2026-09-12)

The old Files copy completion had no context or attempt identity. A late
success could replace a newer failure or appear after Files reopened.
Downloads shared mutable progress/result fields: A's completion or expiry
could clear B, and an awaited Open used the live output path. Two absolute
toast boxes occupied the same space.

Files now owns two `createFeedbackLifetime` slots in ONE unframed, in-flow
vertical stack of `OperationFeedback`. Copy cannot displace a download's
Open action. Only `success` expires, using the shared
`COMPLETION_FEEDBACK_MS` (1500ms); copy still checks the clipboard helper's
boolean. Pending/error states persist. A saved native file is `result`, not
an expiring success: Open/Close or context exit consumes it. Failed Open
retains that exact output path and remains retryable.

Review correction: `Copied`, ordinary browser download success and progress
have no Close action or empty action slot. Hiding progress without cancelling
its transfer would misrepresent an operation that is still running.
Copy errors offer Close; download errors/results offer Close, and only an
actual saved output supplies Open. Open's per-output `opening` state is
reactive and drives the shared command's pending/disabled affordance.
An older Open's completion, error or `finally` cannot dismiss a newer result
or clear that output's pending state. Byte transfer reads `Downloading`;
once bytes are ready, the indeterminate picker/write phase reads `Saving`.
The browser's `a.click()` only requests a download, so its expiring success
notice reads `Download requested`, never `Saved`. Only a confirmed native
write earns `Saved` and the persistent Open/Close result.

Each attempt captures session, declared root, directory, view, file path
and navigation request. Context exit clears both slots; hidden/reopened
contexts cannot revive an old attempt. Progress, completion, expiry and
Open callbacks may update only their current slot. The path passed at the
download gesture and the output passed at the Open gesture remain fixed
through awaits. A new feedback owner does NOT cancel any requested download:
all byte transfer and save operations still finish independently. (History:
#301 then told the outcome of a download that lost its slot; since #420 a
running download is never displaced at all and the context rule covers only
the OUTCOME slot. The current rule: § Running downloads and their outcomes.)
How the bytes travel and resume: § One download core (board #305). The attempt around them is `files/save-file.ts` (§ The viewer saves the file it shows, #447).

Numeric progress means actual received bytes divided by known total bytes.
Unknown Content-Length and the write/picker phase are indeterminate, with
no synthetic ramp, 95/96% allocation, 300ms visual wait or 10s/2s expiry.
The existing stall/retry/signature refresh, Range handling, HTTP fallback,
base64 decoding and native byte-write paths are unchanged. Android still
uses `save_to_downloads` and `AndroidFileOpener`, never the desktop opener.
The old private toast, progress ring and `toast-fade` keyframe are removed.

Verification: seven new strict mount cases reproduce copy ordering, full
1500ms expiry, hidden-context success/failure and dismissal/action-slot
policy; the existing false-copy case checks the live shared success surface.
Chromium 152.0.7977.64 passes 21 controlled scenarios in each of 1280x800 pointer and 390x844
touch, light/dark (the light touch run also uses reduced motion). These
cover stale download progress/failure/completion, cancelled old save,
result persistence, unknown/measured/write progress, stale Open success
and failure, context exit, both copy races, nonoverlapping slots, real phase
labels, action-slot policy, visible Open pending/retry and old Open
success/failure settling while the newer output is itself pending.
Desktop write and Android save/Open are transport mocks with byte/path
assertions, not native device or system-clipboard acceptance. Replacing
the captured copy token with a new token at completion makes the
old-success/new-failure mount case fail; restoring only `$state.raw` for
the output makes the Open-pending browser case fail. The transport
functions remain byte-for-byte equal to `bb565308`.

### Confirmation owns the operation, not the refresh (#167 batch 1, 2026-09-12)

Files' deletion helpers caught RPC/IPC errors and resolved normally, so the
confirmation executor closed the dialog after a rejected `fsDelete` or
`delete_download`. The executor now owns the mutation catch, a synchronous
per-action busy guard and the persistent error passed to ConfirmDialog.
Failure retains the same target and an enabled retry; Cancel, Escape,
backdrop and Back consume pending exits without dismissing the confirmation.
Once idle, dismissal drops the action and its error.

Each confirmation captures its target and originating session, root,
directory/request generation, view and file identity (and the downloaded
listing for local copies). Replacing or hiding that context invalidates the
confirmation; a late completion cannot refresh another directory, remove a
new downloaded row or close a newer dialog. Local wording identifies the
downloaded copy and says the server original survives. Discard is neutral,
with Keep editing as the return action; both callers supply explicit icons.

A successful remote mutation removes the known-deleted row and closes
confirmation before a separate listing refresh. Refresh failure is a listing
error, never an invitation to repeat the delete. Refresh preserves an unrelated
preview or dirty editor; only a deleted current file, or a current file under
the deleted directory, closes.
The #164 menus, #187 navigation/selection and existing clipboard false-result
check are unchanged. Feedback surfaces/timers remain outside this batch.

`Files.mount.test.ts` executes remote rejection/retry, same-tick repeats,
busy exits, refresh failure and stale completion with the existing strict
compileMount harness. `Files.browser.test-fixture.ts` mounts real Files for
Chromium's local IPC and dirty-editor cases with only transport mocks;
highlighting is real and no jsdom import/network guard is relaxed.
Measured on Chromium 153.0.8010.12 at 1280x800 pointer and 390x844 touch,
both themes: six scenarios pass in each variant. These are controlled
browser mounts, not native Android IPC/device acceptance.

### The path row scrolls; a segment never squashes (board #185, 2026-09-12)

Owner: "当文件预览路径超过预览框宽度的时候显示有问题，文字有上下重叠了". `.bc-path-row`
is a flex row with `overflow-x: auto` that scrolls to its tail after every
navigation — the design is a horizontal strip whose end is the current
directory. The defect was a CSS fact, not a layout choice: an explicit
`min-width` on a flex item REPLACES its automatic min-content floor, so with
`min-width: var(--control-height)` every `.bc-seg` shrank to the control size
(measured in Chromium at 390 px and 520 px: 14 segments each 28 px wide while
their text measured 34–87 px) and the nowrap glyphs of neighbours painted over
each other. `.bc-seg { flex-shrink: 0 }`: a segment keeps its width and the
row does the moving (after: 0 squashed segments, `scrollLeft` 489 of 878 at
390 px). `Files.source.test.ts` pins both halves.

The root reads as the FIRST SEPARATOR, not as a wide first crumb (board #187,
owner: "首个 / 斜线后边的文件夹间距比较大，整体看的不是很和谐"): the segment
min-width put the root glyph 15 px from "local" where every other glyph sits
5 px from its neighbours (measured in Chromium); `.bc-seg.bc-root` drops the
min-width and right padding and wears the separator's colour and size, so the
row reads `/ local / home / …` at one rhythm (after: 5/5/5). It keeps the
row's touch height; its width is the glyph's — the root is one tap away by
the row's own scroll and rarely the destination.

Back/Forward sit on the toolbar's `--tool-gap` (2px), not a private 4px
(board #195, owner 2026-09-13: "后退前进按钮为啥这么大，要紧凑一点" — their size is
the `compact-tools` metric, #192/#193; the pair's spacing is the tool group's).

A crumb HUGS ITS TEXT (board #191, owner 2026-09-12: "文件路径显示可以紧凑一点"):
the control min-width that #185 left on `.bc-seg` made every short name a
44 px box on the phone — measured at 390 coarse, `src`/`lib`/`files` sat in
44/44/44 px boxes for 23–30 px glyphs and the strip was 646 px wide; without
it every box is glyph + 8 px and the strip is 594 px, the same as on a
pointer. The touch HEIGHT stays the row's (`min-height: var(--control-height)`);
a crumb's width is its name's. `Files.source.test.ts` pins both.

A crumb is a THING WITH A PATH, so it gets the one context-menu mechanism
(board #187, owner: "这个路径最好可以复制，包括文件夹文件的名字我也可以选中复制"):
right-click / long-press a segment (root included) → `ContextMenu` with Copy
name and Copy path of THAT segment, through the same `openFileMenu`/`copyPath`
a row uses (`kind: 'path'`). Both offers come from ONE definition,
`copyActions` in `file-tools.ts`, shared by rows and crumbs (board #191, owner
2026-09-12: "复制文件路径最好是可以…我可以复制文件名或者整个完整的路径" — a
"Copy path" that only knew the full path left the name to be retyped). Crumb and file-name text are `user-select: text`; a tap
that ends a text selection is a copy gesture, not a navigation — the crumb
and row `onclick` skip when the selection is not collapsed, Feed's guard.
Measured with a real Chromium mouse drag: the file name selects and no
preview opens; the crumb `home` selects and no listing loads.

### Compact rows and contextual actions (#164, 2026-09-11)

Owner, 03:00, verbatim:
> 文件管理浏览上边那一行的按钮太大了，还有文件每一行里文件大小单独起了一行，和上边的文件夹行高不一致，不和谐，文件大小应该放到右边就行。

The size-below rule from #157 is superseded: size is a nonshrinking column
to the right of the complete name, on the same row. Ordinary files and folders
share a 32px pointer / 44px coarse minimum before the divider. Long names may
still wrap rather than being truncated to enforce an artificial fixed height.
The independent listing width and linked-preview Back history are unchanged.

The preview header is one list row high (#435, owner 2026-10-20: "文件预览页的上边
标题栏有点过高了，和本身文件那个栏里的一行的高度一致吧，不然太占空间"). It takes the
row's own metric, `--files-row-height`, as its minimum and no block padding;
its controls (28px on a pointer, 30px on touch inside `.compact-tools`) sit
inside it. Measured in headless Chromium with the app's CSS: before, the
header was 44px against a 32px row on a pointer and 46px against 44px on
touch; after, 32/32 and 44/44.

On a 390px phone it was still about 1.6 rows (validator, real browser: 69px,
two lines) because the name's 160px flex-basis plus back and six 30px tools
did not fit, so the tools wrapped even for a short name. The header's name now
shrinks first (`flex: 1 1 0; min-width: 0`) and is ONE line cut with an
ellipsis (`white-space: pre`), and its full text is the span's `title`; the
tools keep their count and hit boxes (orchestrator ruling). Measured in the
same harness at 390px with a coarse pointer, back + six tools: 68px (short
name) and 78px (a 75-character name) before, 44px against the 44px row for
both after, the long name cut; desktop 1280 stays 32/32. The header's name and
a list row's name follow different rules on purpose: in the list the name is
the content and wraps rather than being truncated (#164); in the header it
labels the open file, the bar is chrome, and the name can be read whole in the
list and the title. The editor's unsaved `*` is its own `flex: none` sibling
after the name (`.preview-dirty`), never part of the cut text, so a long name
cannot hide it (validator P1 on 07f4c8f5; measured at 390 coarse with the
75-character name: the mark 7px wide, after the name and inside the 44px bar).

Toolbar packing follows measured content width, the native target size and
the gap, not a device-specific item count. If all actions fit, all remain
visible. Otherwise reserve one target for More and put only trailing actions
in the shared ContextMenu. Nine 44px targets alone exceed 390px; forcing two
toolbar rows is not the solution. More is a real overflow control, not a
speculative menu. (#192, owner 2026-09-13, reversed the "never shrink touch
reach" half of this: on the phone every Files tool group — toolbar, path row,
row tools, preview header — sits on a 30px pitch (#193, "最上边一行能显示全，
不要...折叠了"; #309 moved it from 32 to 30, because the owner's 347px viewport
left 335px for ten tools that needed 338: now they need 318 and fit from 330).
The fit measures the toolbar's real content box and the rendered pitch
(`--control-height` is the button's width; both are 30 on the phone), and the
row does not spread its buttons. More stays measured, not scheduled. The metric and its measurements live in
design-language.md.) `file-tools.ts` owns the tested
packing decision and the captured row-action definitions. The first tool,
"Session directory", wears the HOUSE glyph (board #194, owner 2026-09-13:
"第一个按钮有歧义，应该变成小房子"): the terminal glyph it used to wear means
"open a terminal" everywhere else in the app. The toolbar and its
overflow/directory menu share the same action list; row tools and the row menu
share their own captured entry actions. Native targets are 28px on a pointer and 30px on touch inside `compact-tools`
(#192/#193), while the shared paint is 20/28px. No second button implementation.

Owner, same message, verbatim:
> 另外文件管理里的桌边操作的右键菜单帮我也加上吧。对了右键的菜单风格都检查统一。

Desktop contextmenu and the existing longpress action open row or directory
actions through the same ContextMenu. Preview prose is outside these gesture
surfaces and retains native selection. The directory action rejects row
targets through longpress's start predicate, so parent and child cannot both
arm and consume the same release; touch events still reach the existing Back
gesture. Menus capture the entry, session,
directory, listing and view; a replaced/closed context cannot run a queued
action. Back closes the menu before navigating. Menus close on context change
and toolbar-overflow resize, without adding a global history handler.
Open from a row or menu goes through `leaveEditor`, so an unsaved editor is
not overwritten by the new entry point. Delete still uses ConfirmDialog.
Copy path checks the shared clipboard helper's boolean and never starts a
success toast for a failed copy; broader operation-feedback ownership is #167.

ContextMenu prerequisites are fixed at that shared layer: full border-box
measurement, a viewport height cap with internal scrolling, 44px coarse
rows, checked-state semantics and disabled activation guards. The menu takes
keyboard focus and yields to an active modal; dismissal restores connected
focus without stealing it from a newer control. Before invoking an action,
the menu returns focus to its live origin so a newly opened confirmation
captures that origin, not the menu that is about to disappear. This matters
in the Hub: its earlier Escape listener yields to semantic menu territory
as well as `.files-body`, so a focused project menu cannot close a Files drawer
underneath it. Merely adding a later menu listener cannot undo that close.
The existing listeners and placement helper remain the only mechanisms.

Chromium 152.0.7977.64 measures the 390px toolbar at 49px instead of 105px
and ordinary rows at 45px including the divider, instead of 45px folders
and 53px files. At desktop the toolbar is 33px instead of 48px and ordinary
rows are 33px instead of 37/53px. Native-platform acceptance remains separate.

### File tools and name space (#157, 2026-09-10)

Historical rollout measurements follow. The 32px pointer/full-height tool
paint was revised by #161, and toolbar wrapping plus size-below by #164 above.

The #154 audit measured a 24x24px touch toolbar with three unnamed actions,
and an AGENTS.md name squeezed to 47.53px inside a 240px list while an unused
preview held 1154px. The fault was in the private tool dialect and layout,
not file routing or the preview renderer.

That rollout adopted `CommandButton` for tools, actions and Back: localized names and
shared hover information, 32px pointer / 44px touch boxes, proper pressed or
expanded state for icon tools, and wrapping toolbar/header groups. File/folder
creation uses the existing Segmented control. Breadcrumbs and path rows keep
their textual navigation form and meet the same hit-height floor.

Before a preview is open the desktop listing fills the available width.
Beside a preview it uses the existing SideHandle with `--files-list-w` and
`tmux_files_list_w`, default 400px and bounds 320-520px. This is a content-list
preference, independent of `tmux_sidebar_w`; do not migrate the unrelated
navigation width into it or restore the retired fraction/splitter. Forced
desktop on a narrow viewport shows the active view without squeezing both
columns. Existing single-pane embeds and Back history remain unchanged.
Both flex containers have `min-width: 0`: Chromium 152 measured a long code
preview expanding the outer Files item to 1126.6px inside an 854px allocation
without it. Content scrolls inside its preview, never by pushing tools offscreen.

File names preserve their whitespace and wrap in full. Size metadata occupied
the next line in #157; #164 deliberately replaces that choice. This retired the
hidden horizontal-name scroller and the shared-navigation-width prescription
for this listing. The path breadcrumb and saved full-path rows may still scroll
horizontally; they are paths, not shortened file names.

Expanded bookmark/recent panels distinguish loading, failure with retry and
confirmed emptiness. They retain `persisted-list.ts` as the sole read/mutation
owner; no new persistence or navigation mechanism is introduced. Routing,
transfer, editor and Back function bodies are unchanged by this UI adoption.
Verification uses real Files mounts and Chromium 152.0.7977.64 on pointer,
390px touch, wide touch, forced narrow desktop and a single-pane embed, in
both themes with reduced-motion/Chinese spots. In the controlled fixture,
AGENTS.md's name budget grows from 54.45px to 238px in a 400px listing beside
the preview; the initial listing uses all 1394px available. Every touch toolbar
button measures 44px, not the former 24px. Native pickers/downloads and a full
App/browser-history workflow remain owner/device acceptance, not fixture claims.

### An image preview opens the one Lightbox (board #188, 2026-09-12)

Owner: "预览图片的时候，要能够点击图片全屏放大，最好图片这种增加在图片上的触摸板两指放大
手势，不是把整个页面放大". The app already owned ONE fullscreen viewer,
`ui/Lightbox` (pinch, drag-pan, double-tap, wheel zoom, swipe-to-dismiss,
Escape / ✕ / back) — chat images open it (`ChatImage .ci-link`); the Files
preview showed a bare `<img>` you could only look at, and a trackpad pinch
over it zoomed the PAGE (browsers deliver a pinch as ctrl+wheel). Now the
picture is a button (`.image-open`, named by the file) that asks the host to
view it; `Files` holds `imageView`, renders the same `Lightbox`, and closes it
FIRST in its Back chain (the viewer is the topmost layer, above menus). A
ctrl+wheel on the inline image is consumed by a non-passive listener
(Svelte's own `onwheel` is passive, so it could not preventDefault) and
answered with the viewer, where pinch and wheel zoom the image. Guards:
`FilePreview.render.ts` pins the button; `Files.mount.test.ts` opens the
viewer by click, closes it through the Back chain, and checks a ctrl+wheel is
defaultPrevented and opens the viewer.

**A tap closes by its gesture, not by the scale its click finds (board #449, 2026-10-22).** The click arrives AFTER pointerup, so a double-tap that has just zoomed back out used to look, at click time, like a clean tap on an unzoomed backdrop and closed the viewer (measured in Chromium at main 7842c7ae; the image has `pointer-events: none`, so a tap on the picture lands on the stage and counts as the backdrop). The close is now decided from a per-gesture record, `tapCloses` in `Lightbox.svelte`: a first finger on an unzoomed picture sets it at pointerdown, and anything that changes the zoom during the gesture clears it (a second finger, a double-tap in or out, a wheel step with the button held; they all pass through `zoomAt` or the double-tap zoom-out), as does `pointercancel`, which is also not half of a double-tap. `onBackdrop` no longer reads `scale`. The next single-finger press takes its own qualification afresh, so old state can never leave the viewer unclosable. No timer or second gesture mechanism was added. NOT fixed here, filed as #450: because the first tap of an unzoomed double-tap closes the viewer at its click, double-tap-to-zoom-IN from scale 1 is unreachable (only pinch and wheel zoom in); making it reachable means delaying the close by the 300 ms double-tap window, which is the owner's call. Pinned by `Lightbox.mount.test.ts` (full pointerdown/up/click sequences on a test-owned clock: unzoomed tap closes; zoomed double-tap does not and the next tap does; zoomed tap and pan do not; a tap whose own gesture zooms in does not; a wheel step while held does not; two fingers and a cancel are not taps) and `Lightbox.source.test.ts` (the click handler does not read the scale).

### The viewer saves the file it shows (board #447, 2026-10-22)

Owner: "我在图片消息里，点开预览放大图片的时候，应该有可以直接下载的按钮". `ui/Lightbox` has one more control beside ✕ when its host can save the picture's FILE (`ondownload`); without a handler it is exactly what it was. Three hosts open it (Hub for chat images, Board, Files); all go through the same two modules.

- **ONE attempt** (`files/save-file.ts`, `saveServerFile(deps, path, owner, say)`): the protocol that lived as `handleDownload` inside Files.svelte until #447 and moved out unchanged — the download-record row, the writer claim and abort handle (`files-memory.ts`, what a runtime release suspends), the signed `/dl` URL and its re-sign, the whole-file RPC fallback, the desktop save dialog after the bytes, the browser's blob link. The caller supplies WHO it is (`owner`, the writer-claim identity) and where the outcome is SAID (`say`): Files tells its feedback slot, a viewer tells its own. What the closure leaned on from Files being loaded travels with it: the dialog import is behind `tauriReady`, and `realmReady()` (the once-per-process `download_release_all`) is memoised and awaited by every attempt, after the claim so the synchronous guard prefix is unchanged. Files still begins it at load. This is the ONE new await the move introduced: the transfer and storage rules are unchanged, but an attempt is now tracked before it, so a Cancel or a runtime's suspend that arrives while it is held ends the attempt right after it (`throwIfCancelled`), before any signature, RPC or fetch. The wait for a removal is therefore not extended by an RPC that should not have been sent.
- **ONE open = ONE record** `{ src, ref, label }` (`viewerOpen`, frozen), taken at the tap. A chat image's viewer URL is signed after the tap, so `ChatImage.view()` takes `ref = src` before the await and hands `onview(url, claim, ref)`; a later `src` change cannot change what that tap carries. The claim is `hub/view-claim.ts` (Board's #329 rule, now shared; the Hub had none): only the answer to the LATEST tap, in its epoch, opens. A direct URL (http, data, blob) and every composer or attachment thumbnail (a local blob) carry `ref: null` and are not offered a download: there is no signature to mint and no sink to write, `<a download>` is ignored on a cross-origin URL, and a Tauri fetch of an arbitrary URL would be a second fetch path. The Files viewer's record is taken in the `onview` handler with the open file's path and name: if the preview moves on to another file under an open viewer, it still shows and still saves the first.
- **The signature is minted at the download tap**, for the record's `ref`, never reused from the viewer or the thumbnail. `ChatImage`'s #175 signatures are unchanged (one near the viewport, one on error, one at the tap that opens the large picture); the download adds exactly one more, at its own tap.
- **Two lifetimes** (`files/viewer-download.svelte.ts`, `createViewerDownload(scope)` per host). The TRANSFER is the runtime's (`scope.state.files`: row, claim, abort handle) and ends only by its own completion or the runtime's seal → suspend → await; after a suspend `download.ts` refuses to re-sign, so no RPC reaches the next server. Closing the viewer, hiding the host or destroying it does not stop it. The FEEDBACK belongs to ONE open: `start` takes a token from `createFeedbackLifetime`, the attempt reports through it, and `retire()` (close, another image, room change, host not active) kills it, so a late progress, failure or Saved cannot land on another image's open (A → close → B, A → close → A). Progress is read by the attempt's own row id (`say.began(rowId)`), never by "the newest row for that path". A second activation of the same open while its attempt is prepared or running returns before it takes a token, so the first attempt's feedback keeps arriving; the control is hidden meanwhile. The writer claim's owner is the OPEN record: on Tauri a second download of the same file from Files, or from the same image after close + reopen, says "Already downloading" in the new viewer. A plain browser has no part id and so no cross-instance guard; there the hidden control is the whole protection, and the docs claim no more.
- **Retirement keys on the host's own gate, not on destruction, and the entries guard themselves.** App keeps every server's Hub, Board and Files mounted and only toggles them, so each host retires its open on the FALSE edge of the gate it already uses (Hub `searchActive`, Board `eligible()`, Files `visible && scope.eligible()`), in the same tick: claim retired, feedback cleared, record dropped, viewer closed. Coming back is a fresh tap; nothing revives (a held signature that returns after a hide/show or an eligible false → true round trip is dropped). Hiding does not seal the runtime or cancel a requested transfer. The doors check the same facts rather than relying on the effect that removes the button: a signed answer opens only while the host is active and for the latest claim, EVERY open (a signed chat image or a local attachment thumbnail, `showShot`) retires the earlier claim and feedback, and `start(record)` asks the host whether that record is its CURRENT open (by identity, with the gate) before it takes a token, so a handler kept from a closed or replaced viewer starts nothing.
- **Where the result goes after the viewer closes.** The outcome is not announced anywhere (Files' outcome slot is its own `tell()`, not a subscription to finished rows). What remains is the runtime's in-memory download record for the CURRENT session, which Files › Downloads lists until the page reloads; on Tauri the saved file (or its `.part`) is what survives a restart, by the existing mechanism. Nothing here extends storage.
- **Gestures and layout.** The Lightbox's pointer handlers moved from the root to a child `.lb-stage` that holds only the image. The bar (download, ✕) and the status are siblings of the stage, so the stage's `setPointerCapture` never sees them: a press and release on a control stays on it, does not zoom, pan or close, and the picture keeps pinch, pan, double-tap, wheel, swipe and backdrop tap. Each control is a real 44px touch box with the 34px paint inside it (the ✕ it always had), abutting with `--ui-gap`; the bar sits at `8px + --sat` so it is never under the status strip. The status is the one `OperationFeedback`, above `--sab`, inside the viewer (the Lightbox is z 300, so a host's own slot would sit under it).
- Pinned by `save-file.test.ts` (sealed record, failed signature, cancel), `viewer-download.test.ts` (one signature for three activations; A held, close, B; A → close → A; host disposed; runtime suspend; retire keeps the transfer), `view-claim.test.ts`, `Lightbox.mount.test.ts` / `Lightbox.source.test.ts` (control only with a handler; stage owns gestures; one control family), `ChatImage.mount.test.ts` (reference taken at the tap), and one fixture per host (`Hub.mount`, `Board.images.mount`, `Files.mount`: the control saves the opened file with a signature at its tap; hide/show and eligible round trips cannot reopen or leak). `viewer-download.tauri.test.ts` runs the helper in a faked Android shell (the writer claim exists there): Files + viewer on the same file, and close + reopen of the same image, say "Already downloading" and start no second transfer. Not exercised in jsdom: real pointer capture (checked once in Chromium, see the board note) and the Android save path (§ the validator's phone and desktop rig).

### Reading mode: the preview takes the phone's whole screen (board #226, 2026-09-20)

Owner: "在手机文件预览md等文件的时候，可以有一个放大按钮全屏显示，上下向上和向下隐藏起来，
悬浮一个按钮，在回到普通模式". On the touch layout a preview is content between
two strips of chrome — Files' `.preview-header` above (back, name, wrap /
edit / download / refresh / info) and App's `.tabbar` below. Reading mode
removes both. **One state, one signal**: `reading` in Files; the header hides
with `.files.reading .preview-header { display: none }` — a cut, the same
treatment the tab bar already gets under `html.keyboard-open` (motion
principle 5: intros are classes, exits are cuts) — and Files reports
`onimmersive(reading)` to App, which mirrors it into `main.immersive` while
Files is the page on screen (`.immersive .tabbar { display: none }`, beside
the keyboard rule; no second writer of the `<html>` class). The body then
measures 0→844 on a 390×844 phone (Chromium, this build). **The way back**
is a gesture or one control: Back exits reading mode first (the chain slot
under the Lightbox, above the file menu — entering pushed an entry like
`info` does), and a fixed `.reading-exit` node at the bottom-right,
`calc(16px + var(--sab))` above the safe area, holds one 44px
`CommandButton variant="secondary" iconOnly icon="minimize"`, `.appear` on
mount, lifted with `--menu-shadow` (measured: without a shadow the quiet
secondary paint vanished into a white page). **Where it is offered**: the
touch layout only (the desktop keeps rail + wide screen; a follow-up if
wanted), never for an image (its fullscreen is the one Lightbox, #188) or
a video or a sound (their players). **Where it ends**: any view change, and the page
going hidden — `$effect: if (!readingEligible || !visible) reading = false`
— so the tab bar is back before a list or another page shows. Pins:
`Files.mount` (enter → class + control + `onimmersive(true)`; Back and the
control each return; leaving the preview resets; no offer for an image or
on desktop), `Files.source` (the cut, the fixed node, the eligibility and
reset effects, the Back order), `App.source` (the prop, the page gate, the
rule beside the keyboard one).

### Review comments are the project's, not the preview's (board #434)

A text preview inside a project carries review comments: stored in
`<project root>/.tmm/reviews/`, anchored to the source in the LINE model,
written only through the server's verified root handle, and handed to the
Hub as a feedback block. `fs_read` returns the `revision` (sha256 of the
bytes it decoded) that a comment is made against. The whole design, its
rules and its limits are in [files-review.md](../pages/files-review.md).

### Two Download Paths
| Path | Used for | Size limit | Transport |
|------|----------|-----------|-----------|
| `fs_download` (WS RPC) | Inline PDF/image preview, Markdown-embedded images | 50 MB (`MAX_READ_SIZE`) | JSON-RPC over WebSocket, base64 |
| `/dl?path=…&exp=…&sig=…[&stream=1]` | User-initiated file download; video and audio preview (`<video src>`, board #182; `<audio src>`, board #416) | None — streams chunks; Range | Plain HTTP on same port |

Frontend `fsDownloadHttp` always uses the streaming HTTP path now (both `ws://` and `wss://`). The server peeks the first bytes of every accepted connection (plain TCP via `TcpStream::peek`; TLS via `BufStream::fill_buf` after the TLS handshake) and branches HTTP vs WebSocket-upgrade. This is what keeps a 56 MB .pptx download working over `wss://` — before, `wss://` fell back to the WS RPC path and tripped `MAX_READ_SIZE`.

`fs_download` stays — it's still the right choice for inline preview (the browser wants the bytes as `data:` URL anyway, so the base64 it gets from the server is already the final shape).

### One download core, resumable across sessions (board #305, 2026-10-04)

Owner, 2026-10-04: an 89 MB mp4 failed on the phone with "invalid array length"; then: "应该所有的下载都走一样的逻辑，并且支持下载断点续传之类的，如果服务端的文件没有更新，可以续传，如果更新了就重新下载".

Root cause of the error: Tauri 2 on Android never uses its binary IPC (`ipc-protocol.js`: `canUseCustomProtocol = osName !== 'android'`). The old `invoke('save_to_downloads', { data: bytes })` was JSON-encoded with one number per byte (`Array.from` in `process-ipc-message-fn.js`): 89 million array elements and about 318 million JSON characters through the Java bridge. A comment in Files.svelte claimed the binary channel; it was wrong on Android and is gone with the command.

Every download now runs through `src/lib/files/download.ts`. The bytes stream from the signed `/dl` URL into a sink as they arrive; the shells differ only in the sink:

| Shell | Sink | Unfinished part | Saved to | Resume | Peak memory |
|---|---|---|---|---|---|
| Android | `nativeSink`: ≤4 MiB base64 pieces to `download_chunk` | `Download/TmuxMobile/.tmm-<id>.part` + `.tmm-<id>.json` (ETag) | `Download/TmuxMobile/<name>` (a same-name file is replaced) | across sessions | one piece (3 MiB raw) |
| macOS / desktop | the same `nativeSink` | `<app cache>/downloads/.tmm-<id>.part` + `.json` | the path the save dialog returns after the bytes arrive | across sessions; a cancelled dialog keeps the part and says so | one piece |
| Browser | `memorySink`: chunks in memory, one Blob for `<a download>` | none | the browser's download manager | only within one attempt (network retries) | about the file size |

- **Resume rule.** `sink.open()` reports what an earlier attempt left. The request carries `Range: bytes=<received>-` and `If-Range: <etag>`. A 206 continues the part. A 200 means the file changed (or a proxy dropped Range): the part is reset for the new ETag and the download starts at byte 0. When that throws away a part from an EARLIER attempt, the progress line reads "File changed on the server, downloading again" for the rest of the attempt (told once, no second notice). A 416 for a part that already holds every byte (the save dialog was cancelled) completes without refetching. The server side is in websocket-rpc.md § `fs_download_url`.
- **Part id** = fnv1a64(server machine id + "\n" + remote path), 16 hex digits. The machine id rather than the URL, so the same server reached over LAN or Tailscale finds the same part. Since board #308 the sidecar beside each part records the server path and machine id (see Downloads view below for where that file lives); `list_downloads` hides `.tmm-` files and returns names only, so the plain Downloads list never shows them. Rust accepts only `[0-9a-f]{16}` ids, so an id cannot name a path outside the part folder.
- **What a failure leaves.** `download.ts` decides and marks the error (`keepPart`). A failure of the link (fetch error, stall, connection closed early, and HTTP 5xx/408/429, which is how a public proxy cuts a long transfer) flushes what arrived and KEEPS the part for the next download of that file. A status about the file (403, 404) or a sink failure (a write, a save) calls `download_abort`, so no half-file is left. Parts that nobody downloads again stay until removed by hand; there is no expiry in this version.
- **Within one attempt** the earlier rules hold: up to 4 retries that refill on progress, 1.5 s apart, a fresh 60 s signature each time, a 20 s stall watchdog, and the WS `fs_download` fallback when plain HTTP is unreachable (`DownloadUnreachable`).
- **The progress glyph** (board #307, owner 2026-10-04: "downloading 状态左边的圆圈都不动了"): with real byte progress the percent is known from the first piece, and the refresh glyph, which turns only while indeterminate, stopped at once. Files' download progress passes `glyph: 'download'`, so OperationFeedback shows a dashed ring that keeps turning until the download ends, around a still arrow into a tray; the saving phase keeps it. Other progress users keep refresh. Measured at 3x (390) and 2x (1280): the ring's centre is the same point at 0/90/180/270° and the arrow does not move.
- **A server switch suspends, it does not cancel** (board 315). Switching servers in place aborts every running attempt with the `SUSPEND` reason and waits for each to settle before the socket moves. A suspend keeps the part (`DownloadCancelled.keepPart`), Cancel in the Downloads view deletes it: the bytes are the leaving server's file and resume when the user is back on it, from its Resumable row. The row itself goes with the rest of that server's memory. The abort is also re-checked after the retry sleep, before `freshUrl`, so an attempt never asks the NEXT server to sign the old one's path.
- **Downloads view: one store** (board #308, owner 2026-10-04: "我要的下载状态查看在哪…应该有一个页面能看下载进度之类的"). `files/downloads.svelte.ts` is the module-level record of this session's downloads: every attempt registers a row (`begin`, reused by id, so a resume or a retry stays one row) and moves it `downloading → saving → done`, or `paused` (its part kept: a network failure or a cancelled save dialog) or `failed`; Cancel and a refused claim `forget` it. The feedback slot SHOWS the row (`feedbackOf`), it keeps no progress of its own. The Files toolbar's existing Downloads entry, now on every platform, opens four groups from that store plus the shell's disk: In progress (the same OperationFeedback card the feedback stack shows, with percent, speed and Cancel while downloading), Resumable (`download_list_parts` merged with paused rows, one row per id), Failed (Retry) and Finished (Android `list_downloads`; desktop and browser this session's rows). Group labels are the shared `.side-h` atom; rows are the file list's. No count badge: the toolbar has no badge atom, and a new one would be a new species. For Resumable a part's sidecar now records `name`, server `path` and machine id `server`: Download again needs the path, and a part resumes only against the server that sent it (another server's part shows "from another server" and can only be deleted). Where the sidecar lives decides who else can read it. On the desktop it is in the app cache (`<app cache>/downloads`). On Android the part folder IS the public `Download/TmuxMobile`, so `.tmm-<id>.json` is hidden only by its dot prefix: another app with storage access, or a file manager showing hidden files, can read the server path and machine id in it. That is the cost of resuming from this view, and it is accepted here; not storing the path on Android would make Resumable delete-only there. `list_downloads` still returns names only. Speed counts what the current attempt moved since its first progress report, so a resume does not count the part it started from.
- **Closing the preview loses nothing.** A remote file's preview is read into memory (`fs_read` / `fs_download`) and never written to disk; a download is a separate write to the place above.
- **Downloads run in parallel**, each with its own sink; each keeps its own card in the feedback stack (§ Running downloads and their outcomes). **One file, one writer** (validator #305 P1): the part id is stable per server + file, so two concurrent attempts on it would append to the same part (measured: 7340032 bytes for a 4 MiB file, reported Saved). The table of native downloads in flight is the runtime's `FilesMemory` (it was MODULE-level in Files.svelte before #335), so it spans both Files instances and, since #447, every viewer the app mounts (the Files page and the Hub drawer; validator #305 found the first, per-instance table let them write one part twice: 8388608 bytes for 4 MiB). A second Download of a file already downloading starts nothing: in the Files that started it, it does nothing more (its card is already in the stack, #420); in the other Files it shows "Already downloading", since the outcome is told where the download began. The entry is released when the attempt ends. Second line, in Rust: `download_open` claims the id for this process and refuses a second claim ("this file is already downloading") until `download_finish`, `download_abort` or `download_release` (a kept part: network failure, cancelled save dialog) lets go. A refused claim marks the error `partBusy`, and Files then neither aborts nor releases (and shows the same "Already downloading" notice as the JS guard, localized, never Rust's English text), so the guard never deletes the other writer's part (validator #305 P2, board #306: it did, and the first writer's next append failed). Claims live in the process, the JS table in the page: a webview reload would leave dead claims that refuse every resume of those files until the app restarts, so `realmReady()` (`save-file.ts`; the Files module begins it at load, and every attempt awaits it) calls `download_release_all` once when a page starts. Without a machine id (not expected after auth) the id is a one-off, so two servers never share a part; that download simply cannot resume later.
- **The desktop saves only where the user chose.** `download_finish` accepts a destination only if the fs scope allows it, and the save dialog grants exactly the file it returned. The webview, which talks to a possibly remote server, cannot pick a local file to overwrite.

Tests: `download.test.ts` (fresh, resume across sessions with Range + If-Range, a changed file restarts and is told once, a 200 inside one attempt overwrites, a complete part finishes from 416, a sink failure is not retried, the unreachable marker, piece sizes, the id); `downloads.rs` (open/reset/append/finish/abort on a real temp dir, a part without its sidecar is not resumed, id/name/destination escapes); `download.rs` (ETag, If-Range, OPTIONS); `Files.mount.test.ts` (Android: open, reset, three pieces, finish; no buffer crosses; fails if the old whole-buffer call returns. A second Download mid-transfer: one `download_open`, one fetch, the part holds the file exactly once, the slot shows the running progress, and the id is released after; fails without the in-flight guard). `Files.two.mount.test.ts` (validator's probe) mounts two Files in one realm: page then drawer on the same file gives one transfer, one `download_open`, an intact file and "Already downloading" in the drawer; it fails with a per-instance table. `downloads.rs` pins the writer claim. `Files.mount.test.ts` pins the Files side of a refused claim: `download_open` throws, and neither `download_abort` nor `download_release` is called (fails if the `partBusy` branch is disabled). `download.test.ts` also pins what each failure leaves. There is no device here: the APK is built, and the owner's smoke test (a file over 80 MB, the network cut midway, then Download again) is the device acceptance.

### Running downloads and their outcomes (board #420, 2026-10-18; history #167, #301)

**The feedback stack belongs to every download in progress** (board #420, owner 2026-10-18: "如果点了多个下载，应该有一个下载文件列表，而不是之前的显示看不到了"). Until then the slot belonged to the newest attempt (#167): a second download took it, and the first one's progress vanished from Files (it lived on only in the Downloads view, #308), which is what the owner saw as "the previous one is gone". Now the stack draws one card per running row of the downloads store, newest first (`stackedRows`, read from `store.rows`, which `begin` fills newest first). It is the SAME card the Downloads view's In progress group draws (the `activeDownload` snippet: `rowFeedback(row)` with percent, speed and Cancel), so nothing new is drawn. The slot keeps no progress of its own: progress writes the store and nothing else, so the stack and the Downloads view cannot disagree, and because the store is per runtime the Files page and the Hub drawer show the same running downloads. In the Downloads view the stack shows none, because the view lists the same rows. There is no cap and no count badge: the toolbar has no badge atom, and a "+N more" would be a new species. **The stack is a bounded scroll region of its own** (review P1-A): `.files-feedback` takes at most `calc(40vh / var(--ui-zoom, 1))`, the bookmarks panel's fraction, and scrolls (`overflow-y: auto`, touch momentum, `overscroll-behavior: contain`), so every card and its Cancel stays reachable while the list or preview and the toolbar keep their space. Its cards are `flex: none` inside it (review round 2: a card in a bounded column flex would otherwise be squeezed below its content and scroll inside itself), so the STACK scrolls and every card keeps its natural height; the rule is scoped to the stack, and the shared card is unchanged elsewhere. Measuring it on a 390px phone, a short desktop window and the Hub drawer with six or more downloads is the validator's (a mount test cannot measure geometry). **Cancel is offered only while it is honored** (review P2-C): a card has Cancel while its row is `downloading`. `download()` checks the signal on the streamed path, and one `throwIfCancelled` right before `saving` covers the whole-file fallback and a URL ask that a Cancel overtook, so a cancelled download hands nothing to the browser and saves nothing. While `saving` (a save dialog, Android's finish) the card offers no action, because a Cancel there would not happen.

**An outcome has ONE door, `tell`**: while this Files is seen, it takes the outcome slot (`downloadFeedback`): a saved file with its Open action (`result`), `Download requested` or a kept part as an expiring success, a failure as a closable error. Latest wins, and the slot is still cleared by a context exit like copy and upload. When a row leaves `downloading`/`saving`, its card leaves the stack and its outcome appears there. A cancelled download says nothing more; its card simply goes. **What #301's earlier notice still covers**: a download that ends while this Files is HIDDEN (the drawer closed, another tab) tells its outcome ONCE in the earlier notice (`earlierLifetime`) when Files is seen again, with no Open action (Open belongs to the live result). While hidden the outcome is HELD (`heldOutcome`, latest wins) and its 1500 ms life starts only when Files is seen (review P1-B: it used to start at the end, so a return after two seconds found nothing); a later return does not replay it. It is exempt from the context-exit clear and ends with Files (`alive`). A newer download no longer pushes an older one's outcome there: both are on screen. Pinned by `Files.mount.test.ts` ("several downloads show one card each…": two cards with their own percent, a cancel that leaves the other, a finish whose outcome appears while the other runs; "a download that ends while Files is hidden…"), `Files.two.mount.test.ts` (the page and the drawer each show both), and `Files.source.test.ts` (the stack reads the store, progress writes only the store, one card for the view and the stack). Also pinned: "…hidden is told once on return, however late" (5 s hidden, told on return, expires, no replay, the other card stays), "a Cancel through the whole-file fallback is honored" and "a saving download offers no Cancel". Negative controls: a stack that shows only the newest, an outcome that never reaches the earlier notice, a card without Cancel, an outcome whose life starts while hidden, no cancel check before saving, a Cancel offered while saving, and an unbounded stack (source contract) each fail them. **History**: #167 gave the one slot to the newest attempt and #301 told the outcome of an attempt that lost it; #420 retired both rules and the `adopt` hand-back that went with them.

**The spinner turns about its own centre.** `.feedback-icon` is `--control-icon-size` (17px on the phone) while `Icon` draws 16px, and the glyph sat in the box's top-left corner, so the arc's centre orbited the rotation origin by 0.5px (measured centre at 0/90/180/270°: (25,765.5)→(26,765.5)→(26,766.5)→(25,766.5) at 390; fixed (71,769) at 1280, where both are 16px). The glyph now fills its box (`.feedback-icon :global(svg) { width: 100%; height: 100% }`, the CommandButton rule), no new token. Pinned by `OperationFeedback.source.test.ts`.

### Resumable downloads (Range + retry)
Public-internet paths (reverse proxy in front of the server) routinely kill long-lived large responses: proxy idle/total timeouts, connection resets, silent stalls. Three pieces make `/dl` survive that:

- **Server: `Range` support.** `/dl` answers `206 Partial Content` + `Content-Range` for the single-range forms `bytes=N-` (what our resume client sends) and `bytes=N-M` (what a media element sends — board #182: WebKit probes with `bytes=0-1` and refuses to play unless the answer is a 206 of exactly two bytes; seeks are bounded windows), clamps `M` to the last byte, answers `416` + `Content-Range: bytes */size` when the start is past the end, and advertises `Accept-Ranges: bytes`. Suffix (`-N`) and multi-range forms fall back to a full 200, which is legal per RFC 7233. Measured live 2026-09-12 against the debug server with curl: 200 / 206 (2 bytes, 1000 bytes, exact slice equality) / 416 / 403.
- **Server: robust request parsing.** The request is read until `\r\n\r\n` (a proxy may split the request line across TCP segments — a single `read()` used to truncate the query mid-signature and 403 valid requests). `/dl?` is located anywhere in the request line so an unstripped proxy path prefix (`GET /tmux/dl?...`) still routes. Same prefix tolerance in the HTTP-vs-WS dispatch (`looks_like_dl_request`, request line only — header echoes don't match).
- **Client: `download()` in `download.ts` (was `fetchWithResume` in Files.svelte until board #305).** Streams the body with a 20 s stall watchdog (AbortController); on any mid-transfer failure it retries with `Range: bytes=<received>-`, so finished bytes are never re-fetched. Each retry re-signs the URL via `fs_download_url` (a download signature expires after 60 s — a retry minutes into a transfer would otherwise 403). The retry budget (4) refills whenever an attempt makes progress, so a flaky-but-moving link survives many small interruptions; only consecutive zero-progress failures abort. If a resume gets 200 instead of 206 (proxy stripped the Range, or since #305 the file changed), the client resets its sink and restarts from byte 0 rather than corrupting the file.

### Video previews stream through `/dl` (board #182, 2026-09-12)

Owner: "文件的预览里边，应该加入视频的流式播放的预览能力". Root cause of "not
previewable": every inline preview arrived as BYTES over the RPC
(`fs_download` base64, `MAX_READ_SIZE` 50 MB, the 5 MB info-page gate), and
a film is neither small nor something to buffer whole. The layer is the
browser's own player: a `<video controls playsinline preload="metadata">`
pointed at a signed `/dl` URL fetches its own ranges (`FilePreview.svelte`
`'video'` branch; `mimeCategory` `video/*`; `streamsInline` bypasses the size
gate because a streamed kind sends no bytes through the RPC). Three server
facts had to hold for that, each pinned by a unit test in `download.rs` and
measured live with curl; what neither can prove is the players themselves —
Android WebView and WKWebView both open with a `bytes=0-1` probe and decide
from that 206 whether to play at all — so device acceptance stays with the
owner:

1. **The signature lives as long as the viewing — and only for a viewing.**
   A media element keeps coming back to the same URL — Chromium suspends
   loading once its buffer is full and re-issues a Range request from the
   next offset; every seek is a fresh request — so a 60 s signature 403s a
   minute into the film. The lifetime is carried IN the signature as an
   absolute expiry (`exp`, bound into the HMAC so a client cannot extend
   it), and so is the MODE: a stream signature is `HMAC(dl:stream:<path>:
   <exp>)`, a download `HMAC(dl:<path>:<exp>)`, so the same tuple signed
   one way never verifies the other way (`&stream=1` on the URL only says
   which rule to apply). `fs_download_url` with `stream: true` mints
   `now + DL_STREAM_TTL_SECS`, a plain download `now + 60 s`, and each mode
   has its own ceiling at verification. `DL_STREAM_TTL_SECS` is **4 h**: a
   leaked stream URL replays for at most one film; downloads keep their
   minute. A stream signature is refused — at mint and at `/dl` — unless the
   path's extension is one `<video>` plays (`streams()`), so the long life
   can never be minted for a `.env` or an `index.html`. Files does NOT
   re-sign a stream on tab return: swapping a `<video>`'s `src` restarts it
   at 0. Live 2026-09-12 (debug server, curl): stream-signed `.env`, a
   stream signature relabelled as a download, a download signature with a
   4 h expiry (labelled either way), and a stream past the ceiling all 403;
   the video's own URL serves 200 / 206 / 416.
2. **Bounded ranges are honoured** (see Resumable downloads above).
3. **Video declares its real type.** `media_content_type` (the table that
   already spoke for images) adds `mp4/m4v/webm/mov/mkv/ogv`, the same rows
   `fs::mime_hint` uses — what Files calls a video, `/dl` serves as one.
   Media execute nothing; `Content-Disposition: attachment` stays, so a
   top-level navigation still downloads. Documents keep octet-stream.

Guards: `Files.mount.test.ts` opens a 2 GB `demo.mp4` — one
`fsDownloadHttp(path, { stream: true })`, no `fs_download`/`fs_read`, a
`<video>` with that URL; `FilePreview.render.ts` pins `playsinline`,
`preload="metadata"` (and, since #453, NO native `controls`); `file-preview.test.ts` pins the
category and the gate bypass. Not verified here: actual playback on the
owner's devices (the WebView's probe-and-decide, and codec support, are the
browser's).

### Audio rides the same stream (board #416, 2026-10-17)

Owner: "文件预览除了视频播放外，还应该加上音频播放". Nothing new is built: audio
is the second kind the browser's own player streams from `/dl`, under the
rules above. `FilePreview.svelte` has an `'audio'` branch,
`<audio controls preload="metadata" src={mediaUrl}>` in the video branch's
wrapper (`.image-preview`, `width: 100%`; no new visual species);
`mimeCategory` maps `audio/*` to `'audio'`; `streamsInline` includes it (no
size gate, no bytes over the RPC); `Files.svelte` signs it once with
`fsDownloadHttp(path, { stream: true })` and does not re-sign on tab return,
and reading mode is not offered for it. The server has ONE lookup for
the streamed kinds, `fs::streamed_media_type`, read by both `fs::mime_hint` and
`download::media_content_type` (video's rows moved into it, so the two cannot
drift; images and the rest of `mime_hint` stay where they were, and `/dl` still
answers octet-stream for everything else): mp3 → `audio/mpeg`, m4a →
`audio/mp4` (AAC in an MP4 container), aac → `audio/aac` (a bare .aac is ADTS,
its own type), ogg/oga/opus → `audio/ogg`, wav → `audio/wav`, flac →
`audio/flac`, weba → `audio/webm`; `streams()` is
true for `video/*` and `audio/*` and nothing else, so a stream signature is
still refused at mint and at `/dl` for every other extension, and the 403
matrix of point 1 is unchanged. Guards: the `download.rs` and `fs.rs` unit
rows (one per extension, and a test that both callers agree with the lookup), `file-preview.test.ts` (category, gate bypass),
`FilePreview.render.ts` (`preload="metadata"`, no native `controls` since #453), and
`Files.mount.test.ts` (a 300 MB `demo.mp3`: one stream-signed call, no
`fs_download`/`fs_read`; hiding the page pauses it, showing it never plays). **Hiding the page pauses the media** (video and audio share it): Files stays
mounted and hidden on a tab or server switch, so without it a track would go
on with no controls in sight. `FilePreview` takes the page's `visible`; when it
turns false the element is paused, nothing else changes (same element, same
signed URL, same position), and showing the page again never plays. Leaving
the preview removes the element, which pauses it. Not in scope: waveform, playlist, background
playback, metadata or cover art. Device playback stays with the owner.

### The preview plays through our own controls (board #453, 2026-10-22)

Owner, 2026-10-22 21:18: "视频和音频的预览，你看能不能不要用最原始的这种播放器？看看有没有轻量、好用一点的加载播放器，能有比较好的拖动控制（尤其是在平板或手机上），缓存buffer，就是更现代一些的播放器".
The engine stays the browser's `<video>`/`<audio>` — it decodes, buffers and
fetches its own Range windows from the signed `/dl` stream above, which is
byte-identical (minted once at open, never at play or seek). What changed is
the controls layer: `files/MediaPlayer.svelte` over the element (no native
`controls`), its rules in `files/media-player.ts`, the position bar the
`ui/MediaRange` atom (design-language.md § atoms). Packaged players were
measured and refused (gzip of the JS, 2026-10-22): Plyr 3.8.5 33.0 KB plus
5 KB CSS and a CDN sprite by default; media-chrome 4.19.3 33.5 KB, styled
through `::part`; Vidstack 1.15.7 124.9 KB — each a second visual species.
An hls/dash engine is out of scope (the files are files, not manifests).

- **Seeking.** Seekable span = the duration or `seekable`, never `buffered`
  (a seek past the buffer is legal; the element fetches it); a time in a hole
  between seekable ranges lands on the nearest seekable point (a tie goes
  forward). A drag previews the time and commits ONE seek on release;
  keyboard/AT commit on change. Each input is one transaction with an id,
  bound to the player's gesture epoch (review round 4 P1-A): a cancel, a lost
  pointer, a hide, a new source or focus leaving bumps it, and from then on
  that finger's moves, change and release do nothing — not even on the next
  file — until it is lifted. The PRESS is tracked apart from the transaction
  (review round 5): a `pointercancel` or `lostpointercapture` ends the
  transaction, not the press — the finger may still be down and Chromium
  keeps dragging its native slider — so its inputs are never re-read as an
  AT adjust. Evidence limit: the rig could not make Chrome 152 lose capture
  by itself, so it DISPATCHED a synthetic `lostpointercapture` with the real
  pointerId mid mouse drag; the 16 real native `input`s after it were all
  dropped, the thumb went back to the host value and nothing was sought. Only that pointer's own release
  (on the range, or on the window wherever it lands; a touch's last
  `touchend`/`touchcancel`) or a new pointerdown ends the press; another
  finger's pointerup does not. A range destroyed mid-input (the player
  moves it between its narrow and wide rows) retires its own live
  transaction, so the player drops that preview and its auto-hide hold; it
  runs in the swap's own flush, before the new range can take input; a released pointer's owed `change` is swallowed
  only while no newer input came (so an AT adjust after a still press
  commits: validator V1). One commit per gesture, not one Range
  request per seek: how many requests a seek costs is the element's.
- **Buffer.** The track paints `el.buffered` and the played part; no buffer
  of our own. While `waiting` during playback, the played part dims.
- **One value, one geometry** (board #462; owner 2026-10-24 "播放进度条圆点和下边高亮线不同步，圆点慢半拍"). The dot and the played line are both painted by `MediaRange` from one `--p` (value / max, unsnapped) over the track inset by the dot's radius; the browser's thumb stays only as the invisible, same-size hit/mapping element. It used to be the dot: snapped to `step` (whole seconds) and travelling one radius inside each end, it trailed or led the line by up to 13 px (mean 4.4 px) on a 30 s clip at 360 px. Measured as geometry per value, not as frames of real playback: each value from 0 to 30 s every 0.25 s rendered statically in headless Chromium 153 and the dot's centre and the line's edge read from pixels, they now coincide at every value but t = 0, where the line has no width and the reading falls back to 0 against the track start at 7 px (mean 0.06 px). With `step="any"` the native mapping of a pointer at x gives the value whose dot centre, by the same formula, is x; in production (`step` 1) a drag moves in whole seconds, the dot and the line together.
- **Gestures.** A tap on the picture shows or hides the bar (never plays); a
  double tap in the left/right third seeks −10/+10 s within 250 ms. Nothing
  in the bar reaches the picture or Files' edge swipe, and the bar takes no
  horizontal pan (`touch-action: pan-y`): on the rig a sideways drag from
  its Play button was Chrome's overscroll history back, which no handler
  can stop. A single tap toggles from the bar's state at pointerdown, before
  the tap's own focus move into the player shows it.
- **Auto-hide** (video only): 3 s into playback; held while paused, waiting,
  failed, dragging, a menu is open, the pointer is on the bar, or keyboard
  focus (`:focus-visible`) is in the player. Hidden, the bar is `inert`.
  A press on the bar restarts the 3 s. Hiding never drops focus to the page:
  a bar control that holds (mouse) focus hands it to the player first, else
  `inert` blurs it and the focusout re-showed the bar, hiding at ~6 s
  instead (validator V2). Tab from the player into a hidden bar shows it
  synchronously (`flushSync`) and lands on its first control; showing makes
  `visibility` instant (only the fade plays), because a visibility
  transition from hidden starts at hidden and Tab skipped the bar on the
  rig (validator V3).
- **Keys** act only when the player container itself has focus, never with
  Ctrl/Meta/Alt or while composing: Space/k, ←/→ 5 s, m, f.
- **Lifetime.** The player's gate is Files' own `imageActive` (the page is
  seen AND its server scope is eligible — the gate the image viewer retires
  on), handed down as `FilePreview`'s `visible` (review round 4 P1-B). Every
  forward entry — play, seek (range, keys, double tap), mute, the modes, the
  More menu and its choices, the picture's taps — asks it first, and the
  seek paths share the range's limits (no window, or unplayable: nothing).
  Every async request (play, fullscreen, PiP, retry) carries a per-kind
  ticket (`Intents`); closing the gate, a new source or destroy ends the
  life, which also closes the menu, drops the picture's pointerdown and the
  range's transaction, and clears the timers. A late result re-asserts the
  CURRENT intent — it never starts anything and never undoes a newer
  request — and only modes THIS player holds are exited. Pause-on-hide stays
  `FilePreview`'s one rule (above), on the same gate.
- **Errors.** A media error is never shown as playing, whatever the
  element's `paused` still reads (review round 4 P1-C): the one action is
  Play. Codes 3/4 (decode, unsupported) disable it; a blocked autoplay, a
  network error or an abort keep it, and for a network error that one click
  is the retry, which re-opens the file through Files' own path (a fresh
  stream signature) as one intent. `emptied` (a new load) forgets the old
  source's error; a paused player never shows `waiting`.
- **v1 scope.** Mute only, no volume range (the device has one). Speed in
  "More". Fullscreen where the host gives it: NOT in the Android app (wry's
  `onShowCustomView` cancels at once) or the macOS app (wry's `fullscreen`
  feature is off) — board #454 for the owner; PiP wherever the API exists.
  Under 520 px the range takes its own row and PiP/fullscreen fold into
  "More"; when even that row has no room (347 px at uiZoom 1.2 on the rig
  pushed More 30 px out of the bar), the time keeps its position and drops
  "/ duration" (one line that wraps the second part away), never a control.
- **Cost.** Whole-build delta against main 7b4705f0 (every JS/CSS asset,
  gzip -9): +7.63 KB with the post-merge P2, +7.57 KB after review round 5 (+7.43 KB at round 4, +6.91 KB at hand-off one, which
  the orchestrator accepted over the 6 KB yardstick, no lazy chunk); per
  module compiled alone: MediaPlayer 4.64 KB, MediaRange 1.52 KB, the rules
  0.83 KB, strings and icons 0.72 KB.

Guards: `MediaPlayer.mount.test.ts` (the protocols above, including the
R1-pending → hide → show → R2 interleaving), `MediaRange.mount.test.ts`,
`media-player.test.ts`, `FilePreview.render.ts`, and the round-shape
allowlist in `tokens.source.test.ts`.

### An HTML preview loads its relative resources through a signed directory cap (board #433, 2026-10-20)

Owner: "文件预览的时候，比如我打开了一个 html，这里的 html 引用了目标服务器上的资源，这时应该正确解析，避免无法加载的情况". Root cause: the preview is a `srcdoc` iframe, whose
base URL is the APP's (`about:srcdoc` inherits the parent's), so `style.css`
resolved against the Tauri/Vite origin, never the server holding the file.
The layer is the base URL. The HTML stays a `srcdoc` (the app keeps
`contentDocument` and its link handlers; `/dl` never serves a document) and is
given a `<base href>` on the file's server: a PATH-style signed URL, because a
relative reference drops a base's query, so `/dl?path=…` cannot be one.

**The door.** `/dl/s/{exp}/{dev}.{ino}/{sig}/{b64url(root)}/{dir…}/{target}`
(`download.rs` scope mode; `dispatch.rs` routes it as a download).
`fs_preview_base(path)` mints the base for the HTML's directory; the client
sends only the HTML path.

- **The root is the server's.** `rpc::preview_scope` canonicalizes the HTML
  and takes the longest declared project path that contains it (archived
  included), else the HTML's own directory. `/` and the canonical `$HOME` are
  never a root: a project there falls back to the directory, and a directory
  that is one of them gets no cap (the mint fails). Only a regular
  `.html`/`.htm` file gets one.
- **The signature is its own.** `HMAC(K, "v1"\0exp\0dev\0ino\0root)` with
  `K = HMAC(token, "tmm-dl-scope-v1")`. The derived key is the domain
  separation: a download/stream tag is an HMAC under the token itself, so no
  path or root makes one verify as the other (a legacy path may itself begin
  with `scope:`, which ruled out a text prefix). `exp` is `now + 4 h`
  (`DL_STREAM_TTL_SECS`, the stream ceiling), checked at verify.
- **The root is pinned by identity.** `(dev, ino)` of the root directory is
  signed. Serving opens the root `O_DIRECTORY|O_NOFOLLOW`, `fstat`s it against
  the signed pair, then walks each decoded segment with `openat(…,
  O_NOFOLLOW)` and serves the final regular file from that fd. A renamed or
  swapped root, any symlink inside the scope, `..`, `.`, an empty or
  NUL/slash-bearing segment all 403/404; the path is never re-resolved by
  name.
- **Only subresources leave.** css, png/jpg/gif/webp/bmp/svg/ico/avif,
  woff2/woff/ttf/otf and the streamed media types, decided on the last
  segment's extension. html, js, json and everything else 403.
- **A document made from the cap is inert.** Every scope answer carries
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: sandbox; default-src 'none'; style-src
  'unsafe-inline'` and `Content-Disposition: attachment`, so an SVG opened at
  top level, in an `<iframe>` or an `<object>` runs no script on the gateway
  origin (an `<img>`/`<link>` subresource ignores the header).
- **No name enters a header** (review P1-B, orchestrator ruling). The scope's
  disposition is the FIXED `attachment`, with no filename: a decoded segment
  may hold `"`, CR or LF (legal POSIX names), and spliced into the header it
  would end the block before the security headers. The legacy `/dl` keeps its
  name, through `download::attachment`: a printable-ASCII `filename=` (any
  other character, `"` and `\` become `_`) plus the exact name as RFC 8187
  `filename*=UTF-8''…`, so no control byte reaches the header block; a file
  with such a name still downloads. `names_with_quotes_and_line_breaks_cannot_move_the_header_block`
  serves real files named with `"`, CR, LF and CRLFCRLF through the one HTTP
  entry, scope and legacy, 200 and 206.

**The client.** `ws-api.fsPreviewBase` prepends this connection's
`httpOriginForWs` (scheme, host and any reverse-proxy prefix) to the minted
path, and returns that same string plus `/dl/s/` as the door's PREFIX; the
URL must begin with it. Nothing searches the URL for `/dl/s/`, so a proxy
prefix that itself holds that segment neither widens the policy nor loses
the door (review P2); the server likewise routes the first `/dl/s/` whose tail has the signed shape, and a request with none is an ordinary `/dl` one, so such a prefix in front of a download still downloads (validator P2). `file-preview.basedPreviewDoc` parses the HTML with `DOMParser` (an inert
document: no script, no fetch), removes every author `<base>`, `<meta
http-equiv=refresh>` and referrer policy (a `<meta name=referrer>` or a
`referrerpolicy` attribute: a referrer policy does not intersect like a CSP,
so either would override ours), and puts three elements first in `<head>`:

1. `<meta http-equiv="Content-Security-Policy">` — `default-src 'none';
   img-src P data:; style-src P 'unsafe-inline'; font-src P data:;
   media-src P; form-action 'none'; base-uri P`, where `P` is that prefix
   (so the proxy prefix stays; `;` and `,` are percent-encoded so the URL
   cannot split the policy);
2. `<meta name="referrer" content="no-referrer">`;
3. `<base href={scope URL}>`.

The output is SERIALIZED, never reassembled (orchestrator ruling
2026-10-20): a fixed `<!DOCTYPE html>` and then the prepared `<html>`
element's `outerHTML`. This is a structural guarantee, not the fix for a
demonstrated injection. The first version quoted the author doctype's
public/system identifiers back by hand; the review suspected that a quoted
identifier could close the doctype and open an element before the policy, but
measured on parse5 (the vectors are in `file-preview.test.ts`) the tokenizer
ends a doctype at any `>`, even inside quotes, and a rebuilt `""<img…"` falls
into its bogus-doctype state, so nothing ever preceded the policy (the review
withdrew the claim). The rule stands anyway: nothing parsed is re-quoted by
hand, and the identifiers mean nothing in a sandboxed preview. A quirks-mode
page therefore renders in standards mode. The output is parsed once more and
refused (no frame, the error line) unless the policy is `<head>`'s first
element with nothing before it.

`FilePreview.svelte` mints on every showing (open, Back, an editor round-trip,
the Refresh button — `renew`, a counter, so it mints even when the text is
unchanged) and never keeps the base on `currentFile` or a `FileLocation`, so a
4 h cap is renewed by Refresh. A tab return re-reads the text but keeps the
frame and its base. The frame mounts only when the mint answered
for THIS file and THIS content; an answer for a file no longer shown is
dropped (the effect's cleanup). A refused or failed mint (no project and a
directory of `$HOME` or `/`, an offline server) reports through the page's
error bar and still shows the page, through `basedPreviewDoc(content, null)`:
no `<base>` (the author's removed too) and a no-resource CSP, `default-src
'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri
'none'; form-action 'none'`, so it reads but fetches nothing — never an
unbased document fetching from the app's origin (orchestrator ruling,
2026-10-20 10:30). Links in the frame:
a bare `#fragment` scrolls in the document (decoded once, by `id`, then
`name`; `#` alone to the top; a middle or modified click on it is prevented
and does nothing) — under the base the browser would navigate the frame to
the cap; a relative path opens in Files; an HTTP(S) URL leaves through
the external handler; every other link activation (`mailto:`, `<area>`, …) is
prevented.

**Limits (v1).** An absolute-path reference (`/assets/x.png`) is not
rewritten and resolves against the gateway origin, outside the door, so it
does not load. A remote host (a CDN stylesheet or web font) is blocked by the
meta CSP. A symlink inside the scope is refused. An HTML file that is itself a symlink gets no cap (review P2): its resources would come from the target's directory while Files opens its links from the link's, so it renders under the no-resource policy with the error line. A directory symlink on the way is fine, since both resolve to the same physical directory; only a clicked link's `..` (resolved lexically by Files) can then differ from a resource's (resolved physically, and refused above the root). A lazy load more than 4 h
after the mint fails; Refresh mints a new cap. Scripts never run (the sandbox
has no `allow-scripts`). Guards: `download.rs` scope tests (signature fields,
domain separation, the derived key by a known answer computed outside the code, segment decoding, the type list and a nested path typed by its last segment, `open_in_scope` under a
pinned root, the headers and ranges over a duplex), `rpc.rs`
`a_preview_scope_is_the_longest_declared_project_else_the_files_directory`,
`file-preview.test.ts` (head order, the quoted-identifier doctype vectors and the reparse refusal, base/refresh removal with inert template
and comment text, the proxy prefix, the inert parse with a fetch control,
fragments, link routing, the no-scope CSP), `FilePreview.mount.test.ts` (no frame before the
base, a late answer dropped in either order, a failed mint rendering under the no-resource CSP, a fresh mint per showing)
and `Files.mount.test.ts` (a refused mint reads with the "resources not loaded"
line, a tab return does not mint, Refresh mints again and clears the line).
The zero-request claim for the no-resource state and the loads under the
scope are measured in a real browser against a real gateway (board #433
notes), since jsdom enforces no CSP.

### Upload feedback is the third slot of the same stack, and it never invents a percentage (board #214, 2026-09-20)

Owner: "文件上传要有个进度或者提示，让我知道传上去了没有". A successful upload was a
silent listing refresh; only a failure spoke, through the page's error bar.
Now `uploadLifetime` is a third `createFeedbackLifetime` slot in the same
`.files-feedback` stack (`{#if copyFeedback || downloadFeedback ||
uploadFeedback}` — the guard was the bug the mount test caught first), with
the same rules: errors offer Close, progress has no cancel, success expires
by itself, and a context exit (directory, session, view) stops the line.

What can honestly be shown. One file is ONE atomic `fs_upload` RPC — the
whole base64 body in a single WebSocket message — and nothing observes the
send, so a moving byte bar there would be fiction (`WebSocket.bufferedAmount`
polling was considered and rejected: it bypasses ws.ts and, once the
payload is E2E-encrypted, no longer maps to file bytes). The line therefore
reads `Uploading name (i/n)` with two phases: **Reading** carries the real
FileReader percentage (a native-path read is whole, so it shows none);
**Sending** is a discrete beat with the indeterminate spinner. A file is
counted *uploaded* only when the RPC resolves — the server has written it —
never when the send returns. The closing line counts a clean batch
(`Uploaded name` / `Uploaded n files`) and NAMES every file that failed
(`k uploaded, m failed: a, b`, detail = the first error); the page's error
bar keeps its per-file message as before.

Both transports (browser Files from the picker or a drop; native paths from
the Tauri picker or webview drag-drop) hand their batch to ONE
`runUploadBatch(items, dir)`; the `dir` stays the gesture-time snapshot
(#22) and the runner never reads `cwd`. The pure pieces — `uploadProgress`,
`uploadSummary`, `uploadSizeError` — live in `file-upload.ts` and are
unit-tested; the Files mount tests drive the picker with a deferred
`fsUpload` and check the phase text, the "counted only after the answer"
order, and the named failure.

Size guard: the server refuses a WebSocket message over 80 MB
(`WS_MAX_MESSAGE_BYTES`), and base64 grows a file by 4/3, so
`UPLOAD_MAX_BYTES` = 60 MB is refused up front with "a single file can be at
most 60 MB" — before, such a file sat in the 60 s request timeout and then
took the connection down. Byte-level progress and files beyond 60 MB need a
chunked or HTTP upload path; that is a separate issue, not this one.

### Base64 Chunking
`btoa(String.fromCharCode(...spread))` crashes on files >100KB (JS argument limit). Use 8192-byte chunks.

### iframe Sandbox
Never combine `allow-scripts` + `allow-same-origin` — negates sandbox entirely. Use `allow-same-origin` only for HTML preview.
The HTML preview's `srcdoc` is the based document of board #433 (its own
CSP, no referrer, the scope `<base>` or, without a scope, none), never the raw file.

HTTP(S) links from previews must not navigate the embedded WebView. App-level
links, Markdown, and converted HTML use the shared delegated handler in
`external-links.js`; a raw HTML preview installs the same handler directly on
the sandbox iframe's document because DOM events do not cross iframe boundaries.
The handler classifies the literal `href`: explicit HTTP(S) URLs and
protocol-relative network URLs are external; schemeless file paths and
`#fragment` links are not. Only protocol-relative URLs use the browser's
resolved `href`.
It listens to both primary `click` and middle-button `auxclick`; other auxiliary
buttons remain available for their normal context-menu behavior.
Tauri opens links through `plugin-opener`; browser mode uses a separate
`noopener` tab. A Tauri opener error is reported and never falls back to
`window.open`, which could create another in-app WebView.

### Files opened from a project starts at the DECLARED path (board #181, 2026-09-12)

Owner: "现在从 Agent 的对话页面跳转到文件时，路径有时候不太对，没有获取到当前项目真正的路径。不知道你是从 Z shell 还是从哪里读取的路径？你应该默认从我们选定的项目路径去跑，路径问题要注意一下". Every "where am I" for Files came from `fs_cwd(session)` — tmux's `pane_current_path` of the session's ACTIVE pane — and which pane is active is an accident of what was last touched in tmux: a zsh window, an agent whose cwd is a worktree under `~/work/worktrees`, a task window. The layer is the declaration, not the pane (tenets 7/9: a project declares its PATH; the running session is a projection): the Files partition or tab opened from a project's Chat starts at `project.path` (`Files` prop `root`, plumbed Hub → Drawer → Files and, on the compact route, as `openFilesTab`'s path), and a relative path reference in chat resolves against it. A declared `root` is the source the cwd-follow rule watches, so `fs_cwd` is not even asked; only a session with no project declaration (direct/adopted) follows the pane cwd as before, and the pane cwd stays one tap away as the explicit Session-directory tool (`goSessionDir`). A parked browse position for that room still wins once the user navigated. `Hub.mount.test.ts` mounts a project at `/declared` against an `fs_cwd` of `/pane/worktree`: the first listing is `/declared`, a browse into `docs` survives close/reopen, `[the plan](docs/plan.md)` stats `/declared/docs/plan.md`, and the phone route receives `/declared`; `Files.mount.test.ts` pins the no-root fallback and that a root never asks `fs_cwd`.

### File references stay in Files (#106, 2026-09-09)

Root cause: the document's **capture** external-link handler used resolved
`anchor.href`, turning `/local/.../notes.md` into `http://localhost:5173/local/...`.
It called `window.open` before the Hub/Files bubble handler routed the same
click into a preview. The late #99 `preventDefault` net could not undo a
programmatic open. Reproduced on Chromium 152.0.7977.64 against the current
`:5173` module, not inferred from an old client.

`core/path-links.ts` owns path classification, line-suffix stripping, URI
decoding and filesystem-relative resolution. Hub uses the project's declared
path (board #181; the pane cwd only for a session without one); all Files
previews use the source document's directory. Plain, Cmd/Ctrl and
middle clicks route through the same handler. The preview body covers
Markdown, converted HTML and other rendered content; the sandbox HTML
iframe installs that same handler on its own document because events cannot
bubble into the parent. It keeps `allow-same-origin` only. PDF currently
renders canvases without an annotation/link layer; CSV renders escaped table
cells, not an iframe or active links. No new renderer is introduced.

Linked previews retain their origin (document/list, parent listing and reading
position). Back buttons and mobile browser/gesture Back consume this history
before the directory floor; Hub delegates its Back handler into the Files
drawer before closing it. Desktop browser toolbar Back retains the app-shell
contract (no global history trap). An initial reference opens with its parent
listing below it. Listing the
target's parent must not race and clear the preview: it is awaited as a
non-navigating listing refresh. Newer file/directory intents invalidate older
file loads. Missing files leave the existing preview and show the localized
path error; they never fall back to browser navigation.

On first mount (also the mobile chat-to-Files jump), a cwd response records
the source directory but does not override an explicit path handoff. The
same `cwdFollowStep` decision owns this precedence; a later real cwd change
still follows normally. Previously the concurrent follow could send the
newly opened preview back to the session directory.

True HTTP(S) URLs retain the external opener in both browser and Tauri;
mailto and document fragments retain their native behavior (in the HTML
preview frame, since #433, a fragment scrolls through its own handler and any
other link is prevented — see above). The app-wide
path net remains only for otherwise unrouted surfaces, not as the fix for
an incorrect external classification. Unit tests reproduce the capture/router
ordering and source contracts pin the primary, auxiliary and iframe wiring.

### Content Security Policy and opener scope

`tauri.conf.json` sets a CSP with `script-src 'self'` and no `'unsafe-inline'`
for scripts (2026-09-03; it was `null`). The webview renders untrusted text
through `{@html}` — agent chat markdown, repository READMEs, mermaid SVG, KaTeX —
and `withGlobalTauri` exposes IPC on `window`. Escaping is the first line of
defence (`core/markdown.ts`); the CSP is the second: an escaping bug becomes a
broken image, not a script with IPC access. Inline STYLES stay allowed because
xterm, KaTeX and mermaid all emit them, and stylesheets and fonts may come from
any http(s) host. The HTML preview's `srcdoc` iframe inherits this policy and,
since board #433, adds its own meta CSP on top (policies intersect): its
subresources come from the gateway's `/dl/s/` door and `data:` only, so a
CDN stylesheet or web font in a previewed report no longer loads (a stated
v1 limit, above). Scripts in that iframe were never run (the sandbox has
no `allow-scripts`), so the policy that matters — `script-src 'self'` — costs
the preview nothing. `connect-src` allows any `ws:`/`wss:`/
`http:`/`https:` host because the server address is user-entered, plus
`ipc: http://ipc.localhost` for Tauri's IPC. Bundled index.html has no inline
script (one `<script type="module" src>`), so nothing legitimate is blocked.
The policy governs only the Tauri webview; the browser/PWA build has no CSP
header today.

The opener capability (`capabilities/default.json`) was `path: "**"`. It exists
for exactly one call — opening the file the user just saved through the save
dialog — so it is now scoped to `$HOME`, `$DOWNLOAD`, `$DOCUMENT`, `$DESKTOP`,
`$APPCACHE` and `$TEMP`. Android never uses it (`AndroidFileOpener`). A save
outside those trees still succeeds; only the "open it" button reports an
error, which is the right failure.

### Path Traversal
All filenames from remote servers sanitized with `sanitize_filename()` (Rust `Path::file_name()`) before joining to download directory.

### .pptx preview is extracted in-process
`fs_convert` used to shell out to `python3 -c "import pptx …"`. That made the
feature depend on a `python-pptx` install on the server machine; where it was
missing, the preview surfaced a raw `ModuleNotFoundError` traceback in the UI.
`src-tauri/src/pptx.rs` now reads the deck directly: a .pptx is a zip of XML, so
the module has a small central-directory zip reader (store + deflate via the
`flate2` dependency we already carry, CRC-verified) and a single-pass scan of
`ppt/slides/slideN.xml` for `<a:p>` paragraphs and `<a:tbl>` tables. Same HTML
card markup as before, so the frontend is untouched.

Details worth keeping:
- **Slide order comes from `<p:sldIdLst>`**, not file names — PowerPoint keeps
  `slideN.xml` fixed when slides are reordered or deleted. Numeric sort is only
  the fallback when `presentation.xml`/its rels are unreadable.
- **Zip64 is rejected with a clear message** rather than mis-parsed; no deck
  generator we've seen emits it under 4 GB.
- Cross-checked against `python-pptx` on 17 real decks: identical slide counts,
  no missing text. The native scan finds *more* text — it walks grouped shapes,
  which `python-pptx`'s flat `slide.shapes` skips.

### Git command argumentsThe Git RPC keeps an explicit subcommand allowlist, then passes every argument
directly through Rust `Command::args` without a shell. Shell metacharacters are
therefore ordinary argument data (the log view uses `|` in `--format`); only
NUL is rejected because operating-system argv cannot represent it.

### Git verbs report through one banner

The 2026-09-03 fix made stage/unstage/add-all failures visible instead of
silently catching them. Its three-second `flash` still expired errors and
allowed an older verb's callback to overwrite a newer outcome.

The feedback-only #167 adoption (2026-09-12) uses `OperationFeedback` and one
`createFeedbackLifetime` directly below the existing header. Each verb starts
an attempt captured against cwd, Status/Log tab and diff context. Context exit
invalidates it even if the same view reopens; disposal ignores late callbacks.
The guard applies only to feedback publication, not to Git execution.

Errors are structured `kind: 'error'`, persistent and dismissible. Text
prefixes never classify state: a successful stdout beginning with a cross is
still success. Push retains stdout, using localized `gitPushed` only when
empty; commit uses `gitCommitted`. These existing success notices expire at
the shared 1500ms lifetime without a Close action. Successful stage, unstage
and add-all remain silent. The private timer, banner paint and prefix check
are removed; the caller only preserves the banner's header placement.

Git commands/arguments, root resolution, status/log/diff loading, retry and
commit draft mutations are unchanged. Commit failure retains the draft;
successful commit clears it and refreshes status as before. `git()` still
throws on any non-zero exit, naming the exit code when stderr is empty.
`gitError` remains the separate load-error line.

Strict mount tests exercise error expiry, out-of-order callbacks, old success
expiry, cwd/tab/diff return, unmount, unchanged staging arguments and commit
failure/retry. A negative control that publishes with a fresh token instead
of the captured attempt reproduces the old-error/new-error overwrite.
Controlled Chromium checks cover persistent error, plain stdout success,
Close, header placement and the same callback race on pointer/touch in both
themes. They do not execute Git or claim native/full-App acceptance.

### Markdown preview uses the one safe renderer
The `FilePreview` body calls `renderMarkdown` from `src/lib/core/markdown.ts` — the same escape-first pipeline the chat uses (rule 13: `&` and `<` are escaped BEFORE marked parses, `>` is not, so blockquotes work and raw HTML is inert text). Files used to carry a second renderer that called `marked.parse` on the raw file, and marked v17 does not sanitize: a `README.md` in any cloned repo (or one an agent wrote) containing `<img src=x onerror=…>` ran in the app origin, where `localStorage` holds the token and `__TAURI_INTERNALS__` can invoke commands (review, 2026-09-03). The trade-off is deliberate: a README's inline HTML (badge tables, centered logos) renders as text; markdown-syntax images and links still work. Mermaid fences still render — the shared output keeps `code.language-mermaid`, and `renderMermaidBlocks` swaps them for SVG after paint. `FilePreview.source.test.ts` pins the shared renderer; Files only delegates the body and never calls `marked.parse`.

### Heavy preview libraries load on first use
pdf.js, mermaid and highlight.js (+15 grammars) are `import()`ed by memoized loaders (`loadPdfjs`, `loadMermaid`, `loadHljs`) in `file-preview.ts` the first time a PDF, a mermaid fence or a code/text file is opened. Files is statically imported by App and the Hub drawer, so the static imports it had put 1.5 MB into the entry chunk of the primary (Android) target: 2.30 MB (652 KB gzip) before, 1.14 MB (344 KB gzip) after (review, 2026-09-03). The highlighter is a `$state`: the lined preview and the editor overlay render escaped-and-plain until it lands, then re-render highlighted; a markdown file with no diagram never loads mermaid. KaTeX stays static because `core/markdown.ts` (chat) needs it on the first message.

### Navigation ownership (#110, 2026-09-09)

`file-nav.ts` owns the non-reactive directory and linked-preview histories,
file request generation and preview/info Back decisions. One factory instance
belongs to each Files component; the full Files page and Hub drawer never
share these stacks. `file-view-state.ts` still owns editor-exit and cwd-follow
decisions. Files applies the results through its existing RPC, confirmation,
motion, browser-history and DOM-scroll code.

**Back has a Forward** (board #187, owner 2026-09-12: "文件夹浏览的能不能加一个
类似浏览器后退前进的按钮，方便我跳转位置后快速回来"). The browser model, in
`file-nav.ts`: `popDirectory(from)` pushes the place you leave onto a forward
stack, `forwardDirectory(from)` pops it and makes that place a Back step
again, `rememberDirectory` (any fresh navigation) clears Forward, and the
resets clear both. The pair sits at the HEAD OF THE PATH ROW, beside the
address as a browser keeps them — not in the tools bar, which already
overflows at 390 (#164 measured nine tools; two more would push real tools
into More) — as 28/44 CommandButtons disabled at their ends (`navTick` lets
the reactive row follow the plain-state history); the crumbs scroll in their
own strip (`.bc-scroll`) so the pair stays put. The shared Back (gesture,
drawer, hardware) keeps calling the same `popDir`, so there is one history,
not a second copy of it.

This is a behavior-preserving extraction of the #106 implementation, not a
new navigation model: linked origins precede Git/parent fallback, loaded text
info first returns to its preview, directory Back retraces visits, and only
tab visits climb below the directory stack. Clearing either history does not
implicitly invalidate a file request; the existing call sites still advance
the generation explicitly. Unit tests characterize each decision and preserve
the captured listing/file/scroll references.

### Preview ownership (#110, 2026-09-09)

`FilePreview.svelte` contains the original preview-body branches and their
CSS, with no new wrapper or header. `file-preview.ts` holds MIME/highlighting/
CSV helpers and the lazy PDF, Mermaid, image and iframe-link renderers.
Files creates one renderer factory per component lifetime and keeps the
existing 50 ms scheduling, highlighter mirror, DOM bindings and code-cap
state. Live context getters deliberately retain the pre-extraction reads;
this move does not change parser behavior or asynchronous cancellation/error
policy. Closing a preview or visiting the editor does not recreate loader
caches or reset an expanded code preview.

Pure helper tests characterize existing behavior (including the simple CSV
splitter), renderer boundary tests cover image/link handling, and the real
Svelte render test covers every branch plus the 3000-line cap. Files and
FilePreview each pin their own wiring; browser comparison covers the actual
rendered output and Back chain on both layouts.

### Markdown Image MIME
Infer MIME from image file extension, not from parent markdown file's mime_hint.

### The house icon means `~`, and only `~`
`DirPicker`'s house opens the user's home (`~`, resolved by the server). Files' toolbar wore the same house for `fsCwd(session)` — the active pane's working directory — so one glyph pointed at two places depending on the screen (review, 2026-09-03). The destination was the useful one for a file browser that follows the terminal, so the CONTROL stayed and the glyph changed: it is now the `terminal` icon with a `filesSessionDir` title/aria-label ("Session directory"). Rule: an icon is a promise about where you land; reusing `home` for anything but `~` breaks it, and a new destination gets its own glyph rather than borrowing one.

### Every way out of the editor asks once — through one helper
`Files.svelte` has ONE exit for the editor, `leaveEditor(run)`: with no unsaved edits the move runs at once; with edits it is parked as `pendingAct = { kind: 'leave', run }` behind the shared ConfirmDialog and runs on confirm. Cancel drops the move — nothing is queued. Until 2026-09-03 only the back button asked; the session/pane switch, the follow-the-real-cwd rule and the drawer's "look here" (`navRequest`) each set `view = 'list'` outright and the text was silently gone (review finding, highest priority). The decision is pure and unit-tested in `file-view-state.ts`: `leaveDecision({ view, edited })` and `cwdFollowStep(reported, lastSourceDir, guard)`. The follow step commits `lastSourceDir` BEFORE the dialog, so a cancelled follow is skipped for that event and the same cwd does not ask again on the next effect run (it would otherwise re-prompt every time the tab regains visibility). `leaveEditor` reads `view`/`isEdited` under `untrack` because its callers are `$effect`s that must not re-run on every keystroke. When a session switch and a cwd follow both want to move in the same event, the later (follow) replaces the earlier pending move — following the real cwd already outranks the parked position.

## Motion

The file browser follows [motion.md](motion.md). A directory load KEEPS the
rows on screen and dims them (`.file-list.busy`, opacity 0.55) only after a
150ms threshold — DirPicker's rule, so a fast listing never blinks and the
"Loading…" placeholder appears only for the very first answer; GitPanel's
lists do the same. Things that enter animate: the bookmarks/recent panel, the
new-item/rename rows and the commit row `.appear-rise`; the drop hint, the
error banners and the push-result banner `.appear`. Copy/download feedback
uses the shared `OperationFeedback` surface and lifetime; Files declares no
private feedback animation. The bookmark star changes its glyph and shared pressed-state
paint without the former private pop animation (#157); its box never changes.
Breadcrumbs are keyed by path
and only the tip fades in. Git status rows are keyed by file and flip on
`moveMs()`; the git diff drills in from the right and the list back from the
left under 760px with the app.css `drill-in-*` keyframe pair (one copy: a
component references a global keyframe by name; only a LOCAL `@keyframes`
gets scoped). Exits everywhere are cuts.

Hover / unfold / highlight (#86, 2026-09-04): a file row's hover card
(`use:hoverInfo` on `.file-main`, principle 16) shows kind (folder / file /
symlink → target / broken link), size and modified through the SAME
`formatSize`/`formatDate` the info view uses; a breadcrumb's card is the full
path, a bookmark's or recent file's its path, and a git status row's the
porcelain code in words ("modified, staged · modified, unstaged",
`files/git-status.ts`, tested). The native `title` on the file name is gone.
A directory's ENTRANCE is one beat, at answer time (board #93, owner: "旧的
页面滑出去，新的页面进来。同时新的页面应该从上到下按行显示过渡加载。新页面加
载和滑入是同时进行的，有可能加载慢就可能慢半拍"): the navigation records its
direction (`pendingSlide` — deeper is `fwd`; up, crumbs and the history pop
are `back`), and when the answer lands the drill slide and the top-to-bottom
row unfold start TOGETHER. The tap-time slide was the flash: it finished
over the OLD rows and the swap then read as a detached blink. A slow answer
starts its entrance late — the honest reading — with the busy dim (150ms
threshold) covering the wait. The unfold (`revealDir`, dropped after
`revealMs()` per the atom's contract) also plays for a first fill and for
slide-less navigations (the desktop split, an external jump), where it IS
the whole entrance; a same-directory refresh keeps its nodes and animates
nothing; view switches (preview, editor) still slide at tap time — they
swap instantly. DirPicker keeps its one-shot first-answer `reveal`.
GitPanel's Status/Log tabs are
the ONE travelling highlight (`use:slideIndicator` + `.slide-pill`): the pill
glides, the buttons only change colour.

## Lessons Learned
- A failed operation replaces only its own pending feedback with a persistent error.
- Android `gen/` files need backup before `tauri android init`
- When wrapping a stream in `BufStream` for peek-then-dispatch, flush before returning — `BufStream`'s write buffer is discarded on drop, so the tail of the response would otherwise be lost.

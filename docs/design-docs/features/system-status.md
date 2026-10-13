# System Status (server vitals) — design

Board #56. The WHAT is in
[requirements](../../requirements/features/system-status.md); this is why the
pieces are shaped the way they are.

## The client's poll interval IS the CPU measurement window

CPU% is a delta (busy time / total time between two samples). The obvious
implementations both cost something the feature doesn't need: a background
sampler thread ticks forever for a corner nobody may be looking at, and a
sleep-inside-the-request (sample, wait 200ms, sample) stalls every poll.

Instead `system_status.rs` keeps ONE process-wide `sysinfo::System` behind a
`OnceLock<Mutex<…>>` and each RPC call reports usage **since the previous
call**. The client's low tempo (20s) becomes the measurement window — the
lazy path is also the honest one. Two consequences are deliberate:

- The **first** call of a server's life has no window and answers
  `cpu_pct: null`. The client drops that part for a tick rather than showing
  a made-up 0%.
- Two clients polling share the window (each sees usage since ANYONE last
  asked). For a glanceable number this is fine; it is the documented trade.

## Dependency: `sysinfo`, pinned exact, features cut down

`sysinfo = "=0.39.6"`, `default-features = false`, features `system` + `disk`
only (no process table, no network counters, no multithread refresh).

- **Why a crate at all**: the macOS half (host_statistics64 / sysctl FFI) is
  unsafe code this project cannot exercise in CI or on the Linux dev host;
  sysinfo's readers for both platforms are the ecosystem-standard ones. No
  shell-outs (`df`/`top` are slow and parsing them is a dialect per OS), so
  there is no injection surface and no subprocess cost.
- **Why exact-pinned**: the crate renamed its reading APIs across recent
  minors (0.30→0.31→0.33); a caret would let an unrelated `cargo update`
  break the build.
- **Why desktop-gated** (same `cfg` as `projects`): a phone is a client
  of a desktop server and never answers `system_status`; the sampler would be
  dead weight in the mobile shell.

## Which disk is "the disk"

`pick_root_disk` (pure, tested): the exact `/` mount when present with a
non-zero total, else the largest mounted disk. macOS splits the APFS
container across a read-only `/` and a data volume; "largest total" is the
capacity a person means by 「disk容量」. An empty/unreadable disk list yields
0/0, which the client treats as "nothing to say".

## Client: transport injected, tempo floored, failure keeps the reading

`src/lib/system/` is self-contained: `system.ts` (wire type + pure
formatters) and `SystemStatus.svelte` (the corner). The component takes a
`load: () => Promise<SystemStatus | null>` **prop** — it never imports
`ws.ts`, so it tests with a stub and integrates into App with two lines
(mount + wire `load` to the RPC), keeping the App/ws territory free for
concurrent work.

- **Tempo**: `interval` prop defaults to `SYS_POLL_MS` (20s) and is clamped
  to `SYS_POLL_MIN_MS` (5s) — the server computes CPU% over this interval,
  so a hot loop would be cost AND noise. Hidden (`visible === false`) stops
  the timer entirely (the hidden-terminal lesson in miniature); re-show
  reads immediately.
- **Fail-soft**: only a truthy answer overwrites the reading ("I could not
  ask" is not "there is nothing" — the roster lesson), and nothing renders
  until the first success (the verdict rule).
- **Formatting**: `fmtPair` puts used/total in the TOTAL's unit so the pair
  reads as a fraction (`210/473G`), one decimal only under 10. Labels
  CPU/MEM/DISK are universal abbreviations — no i18n entries needed.
- **The full reading is the hover card** (motion.md §1.16, board #86): the
  corner wears `use:hoverInfo` and the ONE shared card spells what the
  abbreviation drops — CPU to one decimal, memory and disk as two-decimal
  fractions with a percentage (`sysDetail`, pure, same drop-the-unknowable
  rule as `sysParts`) and the poll tempo as the note. The native `title`
  that used to carry this is gone: a second tooltip beside the card is the
  species the rule forbids. Load average and uptime are NOT on the wire
  (`system_status` returns cpu/mem/disk only), so the card does not invent
  them.

## Integration (App, board #56 final phase)

`ws.ts` exports the typed wrapper — `systemStatus(): Promise<SystemStatus |
null>` — whose `catch(() => null)` absorbs EVERY failure including an older
or mobile server's method-not-found: null is the reading the component
already treats as "keep what I have / say nothing", so no error can escape
into the page. App mounts exactly one sampler whenever connected
(`sysMounted = connected`) and passes `visible={connected}`, so a dropped
connection stops the timer. Layout changes only where that singleton paints:
desktop keeps it in the primary sidebar; touch parks it until the current
visible page contains an open shared `.side-sheet`.

**The strip belongs to the primary sidebar, never the main column.** Board
#85 replaced the full-width flow footer after the owner reported that the
grey horizontal row still read as crossing the work area. App keeps ONE
polling instance in a shell-level `.sys-sidebar`: fixed at `left: 46px`
(after the icon rail), `width: var(--sidebar-w)`, with a single named 24px
height. The page keeps the full viewport height; no footer track, colour,
border, or empty reservation extends under the terminal/content column.

Fixed is safe here because space is reserved, not hand-waved: the three
shared primary-sidebar shells (`.sidebar`, `.term-side`, `.files-left`) get
bottom padding of that exact named height while the desktop rail layout is
active. Global `border-box` makes their content area end above the strip, so
their last row remains visible and scrollable. The strip is singleton rather
than copied into every page, preserving one poll timer and one CPU sampling
window. Its z-index sits below the icon rail and popovers.

On touch, the same shell instance is hidden by default. A relational gate on
`.page-layer:not(.hidden) .side-sheet.open` reveals it at `left: 0`, the
shared drawer's exact `min(300px, 86vw)` width, and z27 (one step above the
drawer's z26). That open drawer reserves the same 24px plus `--sab`, and the
strip includes that safe-area padding, so the final list row and the reading
both clear the home indicator. Restricting the gate to the visible page
prevents an open-state class parked in a kept-alive hidden page from leaking a
status row onto another tab. One component means one 20s timer, not one per
page.

Visual hierarchy is a quiet system-monitor readout, not three cards. The
shared sidebar background continues uninterrupted; each metric has no local
fill, border, radius, or padding. A restrained 4px accent/purple/green dot is
the only category colour, labels use `--text2`, and the actual readings use
full `--text` ink plus the mono data face. Metrics use natural width and flow
from the left rather than stretching into three equal columns. Both themes
therefore stay legible without making telemetry compete with the work.

## Several servers: the reading is the focus's (board #335 ③c-5)

With Aggregate mode (websocket-client.md ③) the app holds several servers at
once, but a machine's CPU is not another machine's, so the strip never sums
or averages. It shows ONE server's reading — the focused one's. App passes
the singleton two more props: `server` (the focus's id) and `tag` (its name
by the ③c-1 rule, null in Single mode or with one server included). The one
effect that owns the timer depends on `server`: a focus move drops the last
reading (it was the other server's) and reads the new server at once, rather
than wearing a stranger's numbers for up to a whole interval — the test holds
the new server's answer and checks the old reading is already gone. The
hover card's title is `sysVitals · <tag>` when the tag is set, so in Aggregate
the card says whose numbers these are; Single is tag-free by construction.
`load` is still injected from the bound runtime, so the component imports
nothing of servers. Only the focus is polled (D4): no member's vitals are
fetched for a hover or a row, and the server switcher's card carries no
readings at all (websocket-client.md ③c-5).

## Tests

- Rust (`system_status.rs` module tests): first-call-null then bounded
  percent; `pick_root_disk` preference + fallbacks + degenerate cases; the
  serialized wire shape.
- `system.test.ts`: formatter behaviour incl. clamps and verdict-rule
  emptiness; the tempo constants.
- `system.source.test.ts` pins the contracts refactors would silently break:
  no ws/App/hub imports, the interval clamp, hidden-stops-timer, the
  failed-load-keeps-reading shape, tokens-only type.
- `App.shell.mount.test.ts` (③c-5): the reading is the focus's and named by
  the tag rule; a focus move drops the old reading before the new server
  answers and reads it at once; the other member is never polled; Single
  names no server.

## Rules and their reasons

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### Server vitals occupy reserved sidebar space; they never enter the main column

(board #56, refined by #85): desktop `system_status` samples CPU/MEM/root disk in-process through exact-pinned, desktop-gated `sysinfo`; the 20s client poll is the CPU delta window and first CPU is null. `SystemStatus` keeps the last good reading. App mounts one connected-client sampler: desktop places it at the primary sidebar's exact x/width and `.sidebar`, `.term-side`, `.files-left` reserve its named height; touch reveals that same instance only under the current visible page's open shared side drawer, whose bottom reservation includes the safe area. Metrics are natural-width and left-aligned. The main page remains full-height and receives no footer row. A fixed strip without matching sidebar reservation, duplicate per-page samplers, a full-width footer, pointer-through claims, and layer-only insets are forbidden.

### The strip shows one server's reading, the focus's, never a sum (#335 ③c-5)

A machine's CPU, memory and disk are its own; adding two machines' is a
number that describes nothing. With several servers held, `SystemStatus`
takes the focus's id and name (`server`, `tag`): a focus move drops the last
reading and reads the new server at once, and the card names whose numbers
these are when the ③c-1 rule says a name is needed. Only the focus is polled
(D4); no other member's vitals are fetched for any surface. Summing or
averaging across servers, keeping the old server's reading until the next
tick after a focus move, and a per-member sampler are forbidden.

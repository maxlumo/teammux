# Multi-server (board #335 ③) — acceptance matrix (r1 §F)

Written 2026-10-13 for ③d-2, on branch `agent/builder-3/335-3` at the ③d
tip. Every row names the test(s) that hold it in the App harness
(`src/App.shell.mount.test.ts` unless another file is named); each server
in a fixture has its own fake connection, token and machine id, and the
mocks answer per asking server (`asking()`). Rows marked **browser** are
the validator's, on the two `#352` containers rebuilt from the main+③
integration tree (validator 04:44); they are not claimed here.

The design is in `docs/design-docs/features/websocket-client.md` (§ ③); the
plan's D1–D6 and the reviewer's ③c findings are the rows' source.

## Legend

T — held by the named test · R — a real-browser row (validator) · P2 — a
recorded evidence gap, not claimed.

## 1. Same names on two servers

| row | state | evidence |
|---|---|---|
| Same-named **project** on A and B, different ids | T | `③c-2: the focused Hub s sidebar is the UNION…` (two `app` rows keyed by ref); `③c-2/P1-C1…` (id≠session, the verb reaches B by B's id) |
| Same-named **session / pane** | T | `§F reload (Aggregate)…` (A restores its `work:1.0`, B its own); `§F unavailable, not substituted…`; `③c-3: picking another server s session…` |
| Same-named **room** (notifications) | T | `③c-4: picking ANOTHER server s alert… hub_read goes to that server only — A s same-named room is untouched`; `③c-4: a system notification s tag names the room ON ITS SERVER…` |
| Same-named **agent** (Agents page) | T | `③c-5 (touch): the guest Agents editor names its server…`; `P1-2: on touch, removing B whose guest Agents editor is dirty…` (each guest is its own server's) |
| Same **#issue / file path** across servers | shared mechanism + R | the cross-server pick is a landing aimed at one tree (`landingFor`), proven for the Hub's session landing (`③c-2: picking another server s row… nothing is torn down`) and pinned as the one mechanism for Board/Files landings (`App.source`: "the Hub union s cross-server pick is a landing like the others"). A behaviour test of a same-named Board issue / Files path on two servers does not exist; the browser row covers it |
| Different **tokens, capabilities, latency** | T | every two-server fixture (`twoServers`: `tokA`/`tokB`, `m-a`/`m-b`); capabilities: `③c-4/P1-C3 (a)` (A no Hub, B Hub); latency: `③c-5…` (held answers), `P1-C4: … FIRST project list fails…` |

## 2. Isolation of the focus from the members

| row | state | evidence |
|---|---|---|
| B drops / reconnects while A types (editor draft) | T | `§F isolation: a background member drops and reconnects while the focus is typing in an editor…` (the focus's draft, connection and dial count; nobody asked); `③b-1: each member reconnects on its own loop — B dropping never touches A…` (connections and dials) |
| … while A downloads or saves | P2 | not held by an App test: the isolation test starts no download and performs no Save. A download's independence from another server's socket follows from every runtime owning its connection (`file-handling.md`, `websocket-client.md` ②b-4: a download's signed URL is its connection's), and the switch-time download tests (`a switch while A s reconnect dial hangs…`, `K, the PRE-dial entry…`) cover a download surviving another server's dial — but not a member's drop. Browser row or a later test |
| Hidden member does only list work (D4), on a tick and on a push | T | `③c-2 (D4): a hidden member s Hub refreshes only its list…` (per-method counts incl. the push path); `③c-3/P1-C4: … hidden member keeps its list CURRENT on the 20 s list cadence and stops when excluded` |
| Only the focus is polled for vitals | T | `③c-5: the system status is the FOCUSED server s reading…` (`rpc@b:systemStatus` never) |

## 3. Cross-server jumps land exactly

| row | state | evidence |
|---|---|---|
| From a notification | T | `③c-4: picking ANOTHER server s alert focuses that server (D2) and lands in ITS Hub on the message…`; touch: `③c-4/P1-C3 (a, touch)…` |
| From a Hub union row | T | `③c-2: picking another server s row moves the focus there (D2) and selects THAT project…` |
| From a Sessions union row | T | `③c-3: picking another server s session focuses that server and opens the pane THERE — A s terminal is untouched` |
| From an image / file reference in chat | R | the chat's image/file references open in the focused tree's Files (one server by construction, ②b); a cross-server reference carries its `serverId` in the ref and is a landing like the others — browser row |

## 4. One server unhealthy does not block the rest

| row | state | evidence |
|---|---|---|
| A has no Hub | T | `③c-4/P1-C3 (a)…` (desktop) and `(a, touch)` (the tab-bar door) |
| B refuses its token from boot | T | `③c-4/P1-C3 (b): a member that NEVER came up (refuses from boot) still has its index shown…` |
| B offline / reconnecting | T | `③c-4 (D6)…` (listed unavailable, not counted, Clear untouched); `③c-1: a member that is offline is still included, so the tags stay`; `③c-5: the switcher row s hover…` (status word) |
| B's first list fails / later fails | T | `P1-C4: a member whose Hub answered the handshake but whose FIRST project list fails stays listed as missing…`; `P1-C4: another server s sessions are pickable while THIS server s first Projects request still hangs` |

## 5. Mode and membership changes with dirty drafts

| row | state | evidence |
|---|---|---|
| Single → Aggregate keeps A's connection | T | `③b-3: Single → Aggregate keeps A s connection and joins B…` |
| Aggregate → Single asks each tree; Keep editing is lossless | T | `③b-3: Aggregate → Single asks each member s tree first — keep / discard` |
| Exclude a member with a draft; cancel is lossless | T | `③b-3: excluding a member asks only its tree; including it again joins it`; `③b-2: removing a background member asks ITS editor…` (keep/discard); touch Back: `③b-2: on a phone, Back answers the dialog…` |
| Exclude the focus | T | `③b-3: excluding the focus moves the focus to the next connected member first…` |
| A change interrupted by a block writes nothing | T | `P1-4 (mode): a change waiting on B s guard while a block begins writes nothing…` / `P1-4 (exclude): …` / `P1-4: a focus exclusion whose walk ends after a block…` |
| Frozen while blocked | T | `③b-3: while blocked the mode and the include switches are frozen`; `③d-3: a discard whose marker write fails blocks…` (Discard frozen) |

## 6. Reload

| row | state | evidence |
|---|---|---|
| mode, excluded set, focus restored | T | `§F reload (Aggregate): mode, excluded set, focus, each tree s draft and view come back…` |
| each tree's draft and view restored, every ref with its own `serverId` | T | same; `acceptance: a pre-#335 client migrates, is edited, goes A→B→A, and a reload finds every server s own state` |
| removed / excluded / offline server: explicit unavailable state, no same-name substitute | T | `§F unavailable, not substituted…` (removed); `§F reload (Aggregate)…` (excluded listed as excluded, contributes nothing); `③c-4 (D6)` and `③c-1 offline` (offline) |
| the handed-to tree after an identity merge adopts the moved record whole | T | `P1-NAV (handover refill)` ×4 |
| pending pre-#335 inputs across a reload; discarded stays discarded | T | `another server first leaves the inputs pending; the owner later claims them — across a reload`; `③d-3: Settings › Connection shows the pending inputs…` |

## 7. Single-mode regression

| row | state | evidence |
|---|---|---|
| Single behaves as before | T | the pre-③ suite (1805 tests at `ea56861b`, all still passing on the tip — count is not scope; the Single paths are the ones those tests exercise) plus the `(Single)` rows: `③b-2 (D2): Single switches as before`, `③c-1: Single names nothing`, `③c-3: Single lists no other servers`, `③c-4 (Single)…`, `③c-5 (Single)…`, `③b-3: … Single shows no include switches` |

## 8. Phone and desktop

| row | state | evidence |
|---|---|---|
| Same model and atoms; layout only | T | touch rows: `③c-5 (touch)…`, `③c-4/P1-C3 (a, touch)…`, `P1-2: on touch…`, `③b-2: on a phone, Back…`; desktop rows throughout |
| Forced desktop / narrow / coarse / uiZoom / safe-area screenshots | R | validator's screenshot matrix on the containers |
| Long same-prefix server names, 10em tag ellipsis on touch | P2 | recorded by the reviewer (③c P2-6); no layout evidence here |

## The M1 handover matrix

The ③b owed-handover cells (M1: F0–F7, B-series, X1–X6) are indexed on the
issue (#335, builder-3's 1125b5f4 note and the reviewer's 00:13 re-marking)
and are not restated here; this table does not replace them. Still R there:
F2 (slow release / owned-fail combination), F6 (registry change after a true
answer), the B-series real-absorb variants, X4 (manual vs automatic Dismiss
race), X6 (guest). X2's CURRENT-only branch is a source pin (below).

M1 F5 (the bound runtime never joined as a member of its own set) gained a
direct test after the validator's bisect (20:39): `M1 F5 (bound runtime never
joined…)` ×2 exits — no dial of the bound alias between the form connect and
the exit, same connection object. F1 (cancel releases the lease) and P1-B
(mirror-fail owes Retry a dial) are layered guards since 1125b5f4, kept as
defence and recorded, not behaviour-tested.

## Known evidence gaps (recorded, not claimed)

- Editor-head `ServerTag` in the Agents page is not on a tested path (③c-5 NC 13/14).
- `SystemStatus` owner keyed by id in App: covered by the component mount test (handle isolation) plus a source pin on the wiring, not by an App fixture (③c fix NC 20/21).
- C1 "Retry never repeats a completed step" is tested with the FIRST step failing; Down-ok / Archive-fail is not exercised (reviewer P2-3).
- Hidden Hub: an `agentsRefresh` scheduled while visible can still fire after a hide; no immediate `loadFeed` on show (reviewer P2-4).
- X2 CURRENT-only branch of `settleHandover` is a source pin; no App path reaches it with the window free.
- Real-browser rows above (image/file reference jump; the dirty F replay; screenshots) are the validator's on the containers.

## Real-app smoke (validator's rows)

The browser rows run on the `#352` Docker environment
(`docs/conventions/testing.md § Multi-server work ends in the Docker
environment`, on main), which this branch predates: build the image from a
main+③ INTEGRATION worktree so the containers embed the ③ UI (validator
04:44 did: `npm run test:e2e:docker -- --keep` from that worktree; the kept
environment is exclusive until the pass ends). Never the owner's dev server,
never a machine the owner did not authorise.

Preset for the Aggregate shapes, loading `gw-a`'s embedded UI:
`tmux_servers` with `gw-a` and `gw-b` (each its real address and token, no
`machineId` — the handshake fills it), `tmux_server_current` = gw-a's id,
`tmux_connection_mode` = `aggregate`. Expected on boot: two trees (`gw-b`
held + inert); the Hub sidebar a union with both servers' rows tagged; the
Sessions "Other servers" section listing `gw-b`'s; the status strip named
`gw-a`; both machine ids from the handshakes. Picking `gw-b` in the switcher:
CURRENT changes, both trees stay, roles swap, the Hub head tag and the strip
read `gw-b`, no JS error.

Preset for the absorb (dirty F) shape — a CONTROLLED alias, not two real
containers: a real server reports its `machine_id` on the first handshake, so
two containers can never produce the "alias entry without a machine id whose
later dial proves the canonical's machine" sequence; it needs an alias
address in front of ONE container (a proxy or a second address of `gw-a`)
whose first handshake is made to omit `machine_id` and whose later one
reports `gw-a`'s. Seed `tmux_servers` with the canonical (`gw-a`, its
machine id) and the alias entry (NO `machineId`), CURRENT = the alias,
`tmux_machines` WITHOUT the alias address (seeding it before boot makes the
first alias dial absorb at once); boot to two trees (alias focus, canonical
member); THEN add the alias address to `tmux_machines` under `gw-a`'s machine
and let the canonical's failover dial the alias address. The dirty premise is
a **Files editor draft** on the alias tree (the validator's 01:04 note could
not show a Board draft being recognised by the guard; do not rely on it). The
owed handover completes once the walk ends (Keep editing): CURRENT, the
mirror and the front on the canonical, the alias tree kept and asked once as
an orphan.

Preset for the Discard row (③d-3): the row appears only while the
pre-#335 inputs are PENDING, i.e. unattributable at boot. Seed the legacy
keys (`tmux_state` = a legacy nav, `tmux_hub_drafts` = `{"demo":"x"}`,
`tmux_machine_id` = `gw-a`'s machine id), `tmux_server_current` = an id that
names NO saved server (e.g. `gone`), `tmux_servers` with `gw-b` ONLY (so no
saved server's machine can claim them), no `tmux_state_layout`. Boot: the
marker records `pending`; connect to `gw-b` (the card); Settings › Connection
shows "State from an earlier version · <machine>" with Discard. A seed whose
CURRENT names a saved server, or that contains a server whose machine matches,
is folded or claimed at boot and shows no row — which is the validator's
04:59 observation.

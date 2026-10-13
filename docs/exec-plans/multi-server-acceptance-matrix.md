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
| Same **#issue / file path** across servers | T (landing) | `③c-2: picking another server s row moves the focus there (D2) and selects THAT project in its Hub; nothing is torn down` (A's Hub reads no landing aimed at B) — a landing is aimed at one tree (`landingFor`); Board/Files landings share the mechanism (`App.source`: "the Hub union s cross-server pick is a landing like the others") |
| Different **tokens, capabilities, latency** | T | every two-server fixture (`twoServers`: `tokA`/`tokB`, `m-a`/`m-b`); capabilities: `③c-4/P1-C3 (a)` (A no Hub, B Hub); latency: `③c-5…` (held answers), `P1-C4: … FIRST project list fails…` |

## 2. Isolation of the focus from the members

| row | state | evidence |
|---|---|---|
| B drops / reconnects while A types, downloads, saves | T | `§F isolation: a background member drops and reconnects while the focus is typing…`; `③b-1: each member reconnects on its own loop — B dropping never touches A…` |
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
| Single behaves as before | T | the whole pre-③ suite (2000+ tests) plus the `(Single)` rows: `③b-2 (D2): Single switches as before`, `③c-1: Single names nothing`, `③c-3: Single lists no other servers`, `③c-4 (Single)…`, `③c-5 (Single)…`, `③b-3: … Single shows no include switches` |

## 8. Phone and desktop

| row | state | evidence |
|---|---|---|
| Same model and atoms; layout only | T | touch rows: `③c-5 (touch)…`, `③c-4/P1-C3 (a, touch)…`, `P1-2: on touch…`, `③b-2: on a phone, Back…`; desktop rows throughout |
| Forced desktop / narrow / coarse / uiZoom / safe-area screenshots | R | validator's screenshot matrix on the containers |
| Long same-prefix server names, 10em tag ellipsis on touch | P2 | recorded by the reviewer (③c P2-6); no layout evidence here |

## Known evidence gaps (recorded, not claimed)

- Editor-head `ServerTag` in the Agents page is not on a tested path (③c-5 NC 13/14).
- `SystemStatus` owner keyed by id in App: covered by the component mount test (handle isolation) plus a source pin on the wiring, not by an App fixture (③c fix NC 20/21).
- C1 "Retry never repeats a completed step" is tested with the FIRST step failing; Down-ok / Archive-fail is not exercised (reviewer P2-3).
- Hidden Hub: an `agentsRefresh` scheduled while visible can still fire after a hide; no immediate `loadFeed` on show (reviewer P2-4).
- X2 CURRENT-only branch of `settleHandover` is a source pin; no App path reaches it with the window free.
- Real-browser rows above (image/file reference jump; the dirty F replay; screenshots) are the validator's on the containers.

# WebSocket Client Robustness

## Context
Mobile connections are unreliable. WebSocket client must handle disconnects, reconnects, and edge cases gracefully.

## Decision
Custom WebSocket client with auto-reconnect, pending promise cleanup, and
multi-address failover. Since board #335 ① it is four modules —
`core/connection.ts` (one link as an object), `core/ws-api.ts` (every RPC,
bound to one connection), `core/connection-registry.ts` (object lifetime) and
`core/ws.ts`, which since ②b-4 holds only the factories, the types and the
device's reachability cache (it was the one-slot facade every caller imported
through ②b-3). See
§ The transport is an object, not a module. Phase ② adds `app/refs.ts`: every
reference to a session, pane, room, issue or project carries its `ServerId`
(§ A name stopped being an address).

## How It Works
- **Browser development has one public origin.** `npm run dev:all` exposes
  Vite on `:5173`; Vite proxies WebSocket upgrades at `/ws` and streaming
  downloads at `/dl` to the loopback-bound backend (the gateway service, or
  the watched server with `TMUX_MOBILE_DEV_WITH_SERVER=1`). A fresh
  dev browser defaults its connection field to `ws(s)://location.host/ws`.
  `httpOriginForWs()` deliberately discards the trailing `/ws` segment when it
  builds signed download URLs, so downloads use the sibling `/dl` route while
  a production parent prefix such as `/tmux` remains intact. That loopback hop
  is plain `ws://`/`http://`, and nothing forces TLS off on the backend any
  more — the watcher used to pass empty `TLS_CERT`/`TLS_KEY`, while the gateway
  reads `config.toml` alone, so certificates configured there would break the
  proxy (board #343; a dev host leaves them unset). HTTPS/WSS terminates at the
  public Vite/Tailscale
  edge. The internal Rust port remains available for the separate-start
  compatibility workflow.
- **Pane-output routing is a per-target listener registry**, not a single
  callback. `addPaneOutputListener(target, cb)` / `removePaneOutputListener(target)`
  (and the `…ClosedListener` pair) keep a `Map<target, cb>`; the `pane_output`
  / `pane_closed` dispatch in `onmessage` routes each push to the listener for
  that exact `target`. This is what lets desktop split-screen mount several
  `Terminal` instances on one connection — each registers its own target and
  they no longer overwrite a shared slot. The single-pane path is the
  degenerate case (one listener for one target). See
  `docs/design-docs/features/split-screen.md`.
- `connect()` cleans up existing connection before creating new one
- `onclose` rejects all pending RPC promises (prevents caller hangs); each
  rejection carries a `reason` (e.g. `'connection lost'`,
  `'heartbeat: …'`, `'superseded by new connect'`) and an
  `err.code = 'DISCONNECTED'` so callers can distinguish cleanly.
- **Liveness is entirely at the WebSocket protocol layer now.** The server
  sends `Message::Ping` every 15 s; browsers auto-reply with `Message::Pong`
  at the WS layer without executing any application code. The server
  tracks `last_pong_at`; if it hasn't seen a pong in 45 s it tears down
  the connection. On the client that shows up as `ws.onclose` → reject
  pending RPCs → trigger reconnect UI. This removes all application-layer
  heartbeat logic from ws.ts (previously ~40 lines of `lastRxAt`,
  `HEARTBEAT_QUIET_MS`, `pingInFlight`, etc. all gone). The key property
  it gets us: a 50 MB `fs_download` frame can be in flight for tens of
  seconds and the keepalive is completely unaffected — PING/PONG goes
  through the WS framing layer, not through our JSON-RPC mutex.
- RPC timeout is 6 s by default; long-running methods (`fs_download`,
  `fs_upload`) pass `60_000` at the call site.
- **3-consecutive-RPC-timeout disconnect is gated on `pending.size === 0`
  AND inbound silence ≥ 10 s.** Two separate "link is actually alive"
  signals suppress the breaker:
  1. If a long RPC is still in flight, its single huge response frame is
     almost certainly what's delaying the short polling RPCs behind it on
     the shared WS send mutex — let the pollers fail individually.
  2. If any inbound message (pane_output push, RPC reply, handshake)
     arrived within the last 10 s (`TIMEOUT_DISCONNECT_INBOUND_SILENCE_MS`),
     the link is alive but slow — common on high-RTT cellular where 5–7 s
     round trips make 6 s RPC timeouts fire while server pushes keep
     arriving. Tearing down + re-handshaking on such a link makes things
     strictly worse. In this case the timeout counter resets to 0.
  When nothing is pending and inbound has been silent past the threshold,
  the disconnect fires as before.
- Auto-reconnect with exponential backoff
- **Transport loss is reported even when no close event arrives.** Once a socket
  has authenticated, the first RPC that finds no current OPEN socket requests
  recovery through the same one-shot disconnect callback as `onclose`.
  Repeated polling and keypresses cannot start duplicate reconnect loops; a
  deliberate `disconnect()` disables recovery before closing.
- **One reconnect loop at a time, identified by generation.** `start()` is a
  no-op while a loop runs (it returns `false`); `cancel()` ends the loop, and
  every asynchronous continuation — probe, connect, retry timer, watchdog —
  carries the generation it started under and is discarded when it is not the
  current one. A boolean `reconnecting` could not tell "cancelled" from
  "cancelled and restarted", so a superseded chain's late `connection timeout`
  used to continue the new loop's counter and `noteAddressUnreachable` a
  reachable address for two minutes (review, 2026-09-03). The disconnect
  callback, the foreground check and a failed address switch may all call
  `start()` during one outage; a typed address (`onAddress`) calls `cancel()`
  first because it is a NEW intent. `reconnect.test.ts` pins both.
- **Socket identity owns every callback, cipher, and asynchronous send.** A
  replaced socket's late close/message handler is ignored, AES-GCM counters
  live on that socket instead of in module-global state, and all encrypted RPC
  and subscription sends share one per-socket promise queue so nonce order and
  wire-frame order cannot diverge. Encryption that finishes after replacement
  cannot send through the new socket. This prevents an old connection from
  clearing or corrupting a successful in-app reconnect — the failure mode that
  previously required restarting the whole app process.
- **Inbound frames are dispatched in wire order.** Decrypt + decode is async
  and its latency depends on the frame (a ≥256-byte payload runs through
  `DecompressionStream`, a small one through a synchronous `TextDecoder`), so
  two handlers started back to back could finish in the other order — for
  `pane_output` that painted snapshot N after N+1 and, since the server only
  pushes on change, left the stale screen up. `_recvQueue`, the mirror of
  `_sendQueue`, chains every frame's handler behind the previous one's.
- **A decrypt failure is a disconnect, now.** The receive counter advances
  before the frame is checked, so after one bad frame every later frame fails
  too; the session is dead. Waiting for the idle probe's three timeouts meant
  ~20 s of a silently frozen app before reconnect started. `forceDisconnect`
  runs from the catch instead.
- **Foreground recovery also handles an apparently-open socket.** Mobile
  WebViews can suspend with `WebSocket.readyState === OPEN`, then resume after
  pane pushes or xterm's live-tail state has gone stale. On every transition
  back to `visible`, the app idempotently re-sends all active subscriptions;
  each mounted Terminal also resets transient touch state, re-fits/repaints,
  and pulls one `capture_pane` snapshot. If it was following the tail before
  suspension it resumes following the tail; deliberate scrollback remains
  pinned and only receives the new-output indicator. This recovery applies to
  Android, browser/PWA, and desktop WebViews through `visibilitychange`.
- Multi-address failover: server `machine_id` tracks alternate addresses
- Optional E2E encryption layer. **One key per direction (v2):** the server
  advertises `e2e: 2` in its nonce frame, the client asks for it and derives a
  proof key, a send key and a receive key from the token and both nonces with
  three HKDF labels. Under v1 one key did all three jobs and both directions
  counted nonces from 0, so client frame #n and server frame #n were sealed under
  the same (key, nonce) — the AES-GCM nonce-reuse failure. A server that does not
  advertise `e2e` still gets v1, so nothing older is locked out. Derivations on
  both sides are pinned to shared vectors in `ws.test.ts` and `wire.rs`.
- `JSON.parse` wrapped in try-catch in `onmessage`
- Optional chaining on server push params (`data.params?.target`)

## The transport is an object, not a module (board #335 ①)

`ws.ts` was the connection: a module-level `ws`, `pending`, `requestId`, the
pane/team listener maps, the subscription refcounts, the liveness timers and
the RPC-timeout counter all sat at file scope, and every RPC wrapper read
whichever socket was current when its promise settled. That is exactly one
connection per page, so the aggregate mode owner asked for (#335 — show the
projects of two or three servers at once) was not reachable by "open more
WebSockets": the second one would have landed in the first one's routing
tables. Phase ① turns the transport into an object and leaves the app on one
of them.

Four modules, one direction of dependency (`ws.ts` → registry → `ws-api.ts` →
`connection.ts`):

- **`core/connection.ts` — `createConnection()`.** One link to one server.
  Everything mutable about it is closure state of that object: socket and
  dialled URL, request counter and pending map, `paneOutput` / `paneClosed` /
  `teamMessage` listeners, `subRefcount`, `onDisconnect` + `recoveryEnabled` +
  `disconnectNotified`, the idle-probe clock and timer, `rpcTimeouts`. The
  per-socket attachments (send queue, receive queue, the two AES-GCM keys and
  their counters) stay where #315 put them — on the socket. Two connections
  may therefore use the same request id, subscribe to the same `app:0.0` and
  carry the same room name without colliding: neither has a table the other
  can reach.
- **`core/ws-api.ts` — `createWsApi(connection)`.** Every RPC wrapper declared
  once and bound to one connection by closure. The wire is unchanged (same
  method names, parameters, per-call timeouts, return types).
- **`core/connection-registry.ts` — `createConnectionRegistry()`.** Object
  lifetime only: `ensure` (idempotent, builds an IDLE object and never dials),
  `get`, `remove` (disposes just that one), `disposeAll`. It never reads
  storage, never parses a URL, never compares machine ids and holds no notion
  of a current entry — `app/servers.ts` remains the one authority on which
  saved server is which.
- **`core/ws.ts` — the facade.** Every export name, type and return shape
  callers had, forwarding to ONE registry slot. No app file changed. (Retired
  in ②b-4: the slot and its RPC exports are gone, see § A subtree is bound.)

Decisions worth keeping:

- **`disconnect()` keeps listeners and refcounts; `dispose()` is what releases
  them.** A connection OUTLIVES its socket — a reconnect to the same server
  replaces the socket inside one object, and the Terminals that registered
  those listeners are still mounted in hidden page layers (that is the
  `resubscribeActive()` contract in Lessons Learned). Had `disconnect()`
  cleared them, every reconnect would have silently frozen the panes.
- **`dispose()` is TERMINAL, and a dial in flight belongs to the lifetime it
  ends** (review + validator, 2026-10-09; both were P1s on the first draft of
  this phase). Two gaps made it a reset rather than a release:
  1. An attempt still waiting for the server's nonce, or holding the proof
     while auth completes, kept a promise nobody would answer and a connect
     timeout nobody would clear. `disconnect()` nulls the socket's handlers, so
     even the `onclose` that would have rejected could not run — the caller sat
     there until the 5 s timer fired, past the point the registry had declared
     the connection gone. Every unsettled dial is now a record the connection
     owns: `connect()` (which supersedes one), `disconnect()` and therefore
     `dispose()` settle it at once with the existing `DISCONNECTED` error and
     clear its timeout. A handshake that completes afterwards restores no
     listener, starts no idle probe and sends no frame.
  2. Nothing said a disposed object was finished, so a retry closure or an
     unmounted view still holding the handle could dial again AFTER
     `registry.remove(key)`. The next `ensure(key)` would then hand out a fresh
     object while the forgotten one owned a live socket: two connections behind
     one key, one of them invisible to the registry that is supposed to own
     every lifetime. A disposed handle's `connect` and `call` now reject with
     `connection disposed` — a distinct message, because a RELEASED connection
     is not an offline one — and registering a listener or a subscription on it
     is dropped instead of accumulating on a dead object. A replacement comes
     only from `registry.ensure`. `disconnect()` is unchanged and still
     reconnectable.

  `dispose()` is idempotent and touches no other object. The test fixture
  tracks `setTimeout` as well as `setInterval`: counting only intervals is what
  let the dial timeout hide.
- **The facade's slot key was a Symbol, in memory only** (until ②b-4). Not persisted, not
  derived from a URL and not a stand-in for `ServerEntry.id`. A facade that
  picked its object by address or by the machine id a candidate CLAIMS would
  have had to guess during a #315 switch, before auth decides what the target
  even is — and it would have handed Aggregate a back door for choosing a
  "current" server implicitly. One stable object instead, replaced socket by
  socket, which is precisely the old behaviour. Phase ② gives every server an
  explicit runtime keyed by its entry id and the slot goes away with it.
- **`reconnect.ts` is untouched** and App still creates the one reconnect
  machine. Retry policy, backoff and address round-robin are app-layer
  concerns; importing them into `core/` to give a Connection its own recovery
  would have inverted the layering and added a second recovery strategy.
  Phase ② composes one connection with one existing reconnect machine per
  server.
- **Device reachability stays global, in `ws.ts`.** `probeFailedAt`,
  `isAddressViable`, `noteAddressUnreachable`, `findBestAddress`,
  `classifyAddress` and the `online` / connection-change listeners describe
  the NETWORK THE DEVICE IS ON, not a server: every connection shares the
  answer, and the invalidation is a platform event. Keeping it here is also
  what lets `connection.ts` stay free of `window` (pinned by
  `connection.source.test.ts`). A viable address is not authentication and not
  machine identity.
- **The download origin is bound to its source, read before the round trip.**
  `fsDownloadHttp` read the module's `wsUrl` after its `fs_download_url` round
  trip; it now snapshots its own connection's `url()` before it. A signature is
  issued by one server, so the base it is appended to must be that server's.
  Across two connections this is the whole difference — the module reading
  would have given A's signature whichever origin dialled last, and
  `connection.test.ts` fails under exactly that mutation. On ONE connection it
  is a race tightening, not a provable equivalence: `rejectAllPending` only
  rejects promises still in the map, so a reply that already resolved while its
  `.then` was queued is not recalled, and other queued microtasks can run a
  `connect()` first. The snapshot removes that window by construction; do not
  restore the late read on the grounds that the 11 unchanged tests pass, which
  say nothing about it either way.
- **Zero behaviour change, and the proof is the tests nobody edited.**
  `ws.test.ts` (plain-token lifecycle, stale close, async send after
  replacement, request order, the v1/v2 handshake vectors, decrypt-failure
  disconnect, ordered dispatch), `server-switch.test.ts`, `reconnect.test.ts`
  and every mount test import the facade and pass unchanged. On top of that:
  `connection.test.ts` runs two real connections with real Web Crypto (same
  request ids, out-of-order replies, same pane target and room name, A's
  timeout / close / auth failure / dispose / reconnect leaving B's pending,
  subscriptions, cipher and recovery callback alone, refcount 0→1→2→1→0,
  signed-download origin, and a negative control for each),
  `connection-registry.test.ts` pins lifetime, and `connection-facade.test.ts`
  drove the real facade through A→B→A (deleted with the facade in ②b-4; the
  fleet and App.shell tests carry A→B→A since).

Known limit carried over from before the split: the `.catch` on `call()`'s
`sendOnSocket` calls `notifyDisconnect` without checking which socket the send
belonged to, so a slow encryption whose socket was replaced can ask THIS
connection to recover while its new socket is healthy. It is the baseline's
boundary, not this phase's, and the "late ciphertext reaches neither socket"
test says nothing about it; a dedicated check is still owed (reviewer P2,
2026-10-09).

What phase ① does NOT do: there is no connection mode, no second live socket
in production, no serverId on any runtime reference, no change to parking
(#315), read marks (#334) or the default page (#333). The union views and the
Aggregate switch are phases ② and ③.

One correction to how phase ① was described (reviewer P2, 2026-10-09): it was
not a strictly zero-behaviour change. `cancelDialing` settles a dial still in
flight AT ONCE on three paths — `dispose()`, `disconnect()` and a `connect()`
that supersedes an earlier one — where the old module left the promise for its
connect timeout to reject seconds later. Only `dispose` is unobservable in
production (the facade's one slot is never disposed); the other two are
reachable in Single mode, so a server switch or a disconnect during a dial now
rejects immediately instead of late. "Zero behaviour change in Single mode" is
the wrong claim; "every existing Single-mode regression still passes, byte for
byte" is the one the evidence supports.

## A name stopped being an address (board #335 ②)

Phase ② gives every referenced object a server, so one client can hold two
servers' worth of state without the two leaking into each other. Before it, a
name WAS the address: a session called `work`, a room called `proj:work`, an
issue `#3` and a project row all resolved against whichever server happened to
be current, and two servers can each have all four.

`src/lib/app/refs.ts` is the vocabulary: `ServerId` (always `ServerEntry.id`,
never a URL, a hostname or a machine id), plus `SessionRef`, `PaneRef`,
`RoomRef`, `IssueRef` and `ProjectRef`. Three properties are the whole design:

- **A ref is an identity, not a payload.** It carries the server plus the
  smallest thing tmux or the bus needs to resolve the object. `ProjectRef`
  holds `projectId` and not the project's name, path or room, because a copy in
  a ref is a second definition of what a project is and it goes stale on the
  first rename.
- **The serverId never reaches the wire.** It selects which connection carries
  a call; the call's own `session`, `target` and `room` arguments stay exactly
  the strings a single-server build sends. `refs.ts` imports nothing but
  `nav-state.retarget`, so it cannot send, and `refKey` emits a JSON tuple
  precisely so a composite key that leaked into a `target` argument would fail
  loudly instead of addressing a real pane.
- **A rename belongs to one server.** `retargetRef(ref, rename)` takes the
  serverId together with `from`/`to`, so the bug where server A's rename
  rewrites server B's identically named session cannot be written. A `RoomRef`
  and a `ProjectRef` do not move at all: the room is recorded on the project so
  a rename cannot orphan the chat, and `Project.id` is stable by construction.

`refKey` is a JSON tuple rather than `a|b|c` because every part is user data —
a session may contain any character a human types, including the separator —
and it is tagged by kind so one map can hold a project, its session, its room
and a pane that all share a name.

### A server the app can hold: runtime and fleet

Three layers, one job each:

| module | owns |
|---|---|
| `core/connection-registry.ts` | object LIFETIME — one connection per key |
| `app/servers.ts` | IDENTITY — which saved entry is which |
| `app/server-fleet.ts` | the SET of runtimes the app is holding |

`createServerRuntime(entry, { storage, slot })` is the join of the first two: a
saved `ServerEntry` plus the connection and bound API that serve it, plus the
capabilities that server answered for itself (`hub`, `backends` — `null` means
"not answered", which is not "no", because a timeout must not unmount the
always-mounted Hub). `createServerFleet({ storage })` is the membership, and
like `registry.ensure` its `include` never dials and holds no "current": a
fleet is a set, not a focus.

Identity, which is the reason a runtime exists rather than a field on
`Connection`:

- **`id` is `ServerEntry.id` and it is immutable for the object's lifetime.**
  Every phase-② view, store slot and persisted key hangs off it, so a runtime
  whose id could change under its holders would re-point them at another
  machine.
- **The server that answers decides.** `dial()` authenticates and then asks
  `recordServer` which entry that machine is. If the canonical entry is not
  this runtime's, the dial does NOT become a connected runtime under this id:
  it closes the socket and reports the entry of the machine that did answer, so
  the caller can include that one instead. Two cases collapse into that one
  result — an entry that knew its machine and reached a different one (a
  loopback tunnel or a reused LAN address), and an entry that knew no machine
  and authenticated as one that already has an entry (a migrated
  address-history row). The old entry's name, token and address are untouched
  either way.
- **One dial is one attempt.** A runtime may dial more than once, and a
  `Connection` can only reject a dial that has not SETTLED — it cannot
  un-resolve a promise whose continuation has not run. So every dial captures
  an attempt number before its first await, and a continuation that is no
  longer the current attempt returns `superseded` having touched NOTHING: it
  does not record, adopt, report an identity, or disconnect. Not disconnecting
  is the subtle half — the newer attempt's `connect` already replaced the
  socket this one dialled, so closing the connection's current socket would cut
  the attempt that superseded it. The machine id comes from the attempt's own
  `connect` result rather than from "whatever the current socket says". An
  entry removed while a dial was authenticating is NOT resurrected by
  recording the connection that just succeeded. This is the same ownership bug
  as #315's old `onAddress` continuation reconnecting to another machine, and
  a liveness flag cannot stand in for attempt identity.
- **Membership follows the entry set, reconciled after every `recordServer`.**
  That call is the one moment the saved set can change: it stamps a machine
  onto an entry and absorbs every twin of the survivor, which deletes entries
  belonging to OTHER runtimes. So the fleet reconciles against `servers.ts` —
  it never merges by address itself — and drops every runtime whose entry has
  gone. Letting each runtime discover its own loss was not enough: a runtime
  that has not dialled yet, or is still authenticating, has no occasion to
  discover anything and would sit in the fleet holding a socket for a server
  that no longer exists. `include` also declines an entry that is not in the
  saved registry, so a stale list cannot put an absorbed server back. A
  released runtime is terminal, not merely disconnected: a disconnected handle
  can dial again, keeps its liveness clock, and a reply already on its wire
  could recreate the entry identity has just absorbed.
- **Recording is never activating.** A dial writes through `recordServer` and
  `adoptHostname` only; CURRENT and the live mirror keys stay the switch
  path's, or a background server could take the screen.
- **An address is a route, not an identity** (board #55: one machine is one
  entry, however many addresses answer for it). The fleet matches by entry id
  and machine id; `server-fleet.source.test.ts` fails if the word `address`
  appears in it at all.

A runtime deliberately does not own RECONNECT yet: `app/reconnect.ts` reads
`tmux_address`, `tmux_token`, `tmux_machine_id` and `tmux_machines` off the
live unprefixed keys — off whichever server is current — so a second runtime
would reconnect to the wrong machine. It needs one scoped target reader, which
is ②b's commit; a key-remapping storage proxy would be a second mechanism to
delete two commits later.

Capabilities need two guards, and they answer different questions: is this
runtime still held, and is this the NEWEST answer. App needs neither of those
and one of its own (`serverSwitch.owns`), because its module socket could move
to another server mid-probe. A runtime's answer always came over its own
connection, so it cannot be about another server — but it can be about an
older moment of this one, and an old `method not found` must not unmount a Hub
a later probe confirmed after an upgrade or a reconnect. A failed probe is not
an answer at all: it leaves the last real one standing, for the Hub flag and
for the backend list alike, which is what "caps survive a reconnect of the same
server" has to mean. Only a server that answers with an empty list makes the
list unknown again.

### One slot per server, and the fold that gets there

A per-server key had two homes: the unprefixed one, holding whichever server
is current, and `<key>::<id>`, where the switch files the server you are
leaving. That cannot work for two servers at once — there is no "the" live
value, and B's first write would overwrite A's — so `<key>::<id>` becomes the
only home and the unprefixed key stops being a location.

`app/server-store.ts` is one server's view of storage, and deliberately a
`Storage` view rather than a new accessor vocabulary: the per-project
semantics (what a `SeenMark` is, that an empty draft removes its row, how
`stepsRows` clamps) stay in `hub-prefs.svelte.ts` and
`notify-centre.svelte.ts`, and ②b points their storage at this view without
touching their logic. A second copy of those rules here would be the "one
mechanism per job" regression, and a source test fails if one appears.

What is scoped and what is not is the load-bearing half. A RESIDENT key is
rewritten, by `servers.ts`'s `residentKey` over its `RESIDENT_KEYS` — one
list, which the identity layer also uses when it removes or merges an entry,
so a key cannot be added to one and forgotten in the other.
Everything else passes through: theme, fonts, zoom, language, shortcuts,
notification switches, the feed level and the sidebar collapse are properties
of the PERSON and the WINDOW, and scoping them would give the same human a
different app depending on which machine they are looking at. The registry's
own keys and the active mirror pass through too — their home is the
`ServerEntry`, which is already per server. A store built with an empty
serverId throws instead of falling back to the unprefixed keys, because that
fallback would write one server's drafts where every server reads them, and
only on the path where CURRENT has not resolved yet.

`migrateServerState(storage)` is the one-time fold, and three of its rules
were each a bug first.

**Completion is recorded, in ONE write.** Comparing values instead is only
idempotent while nothing else writes the slot: the moment the slot is the live
home, a second run overwrites a newer resident value with the stale unprefixed
one. Recording it in TWO markers — "the inputs are consumed" and "this
server's slot is converted" — is no better, because two writes always leave a
window: the per-server one lands, the global one fails, and then the server it
folded into skips while the NEXT server to become current folds the same
leftover inputs into its own slot. So there is one marker, one write, carrying
both facts: the layout version and which server received the inputs. A marker
that cannot be parsed still counts as consumed, because reading the inputs
twice is worse than not knowing which fold ran. The marker is written AFTER the
move, so a failure part-way leaves the inputs readable and the next run redoes
the whole fold rather than half of it — and when the marker write itself fails,
the report says `unrecorded` rather than `folded`, because `localStorage` has
no transaction. ②b must treat `unrecorded`, and a thrown error, as BOOT
MIGRATION NOT COMPLETE — which is stronger than "do not switch servers": it
must also not bring up the pages that WRITE resident state and retry
afterwards, because a writable page plus an unconsumed input set is exactly
the half-migrated client this design exists to avoid. The page's writes land
in the slot, and the retry folds the stale unprefixed values over them. Retry
before anything can write, or come up read-only.

**The live set is authoritative in full, not just its present keys.** An absent
live key means the value was CLEARED, and for the current server that is a
conclusion rather than a guess: arriving at a server surfaces its park as the
live key, so from that moment live and slot agree and any later divergence is a
live-side change. Copying only the present keys made a cleared draft and a
reset read-mark come back out of the old park the moment the slot became the
live home. The fold therefore files the WHOLE set — the old switch's park, kept
in the fold as the one place that still reads the live keys. Every other
server's park is untouched, because the live set speaks only for the current
server.

**An owner must be known, and the attribution state is persisted.** The
marker is the inputs' one attribution state: `folded` into a server, or
`pending` an owner. When CURRENT names a saved entry, that is the owner and
the fold runs at once. When it does not — empty, or an id nobody saved — the
inputs are recorded `pending`, with the machine the legacy mirror named, and
nothing is filed anywhere (the navigation's bytes are copied aside too). A
reload never re-infers this from whatever CURRENT says by then (reviewer
P1-c on cf7e7957).

**A pending input is claimed only by its machine** (reviewer P1-c on the ②
plan; P1-b on cf7e7957). Every bind meets a pending input (`claimPending`):
a server whose machine IS the legacy mirror's claims it, by the fold's rule —
the live value replaces a slot, an absent one clears it — except for a slot
its owner wrote since (reviewer P1-1 on 08fdb6ba). A non-empty slot is not
evidence of that: it may be the owner's pre-#335 park, older than the inputs.
So the pending record fingerprints every slot that existed when the inputs
were set aside, and only a slot that changed, appeared or disappeared since is
kept. A slot the identity layer MOVED is not one its owner wrote, and a
merge that hands the current alias's slots to its canonical entry hands their
baselines over too, as ONE recoverable unit (`forgetDropped`; reviewer P1s on
cde052f7, 4ef4dd07, 4807242f and 6a2ba341). The order is fixed: one intent
per (absorbed, survivor) pair is written in one write (`tmux_slot_moves`,
on every client, folded or pending — ③b), the slots are MERGED, CURRENT
moves to the survivor, the registry is committed without the twins, the
merge is noted, and only then are the twins' slots removed; one last write
per pair hands the baselines over and closes its intent. A failure anywhere
leaves the intents open, and they are finished (`resumeSlotMove`) at boot,
before every claim, and before every identity write (`recordServer`,
`repairServers`; reviewer P1 on b5adcb3b), each on its own — one that cannot
finish does not hold another. If one cannot be finished, the identity write
is refused and writes nothing. Everything a move decides — who wins a
conflict, and while inputs are pending the survivor's new baselines — is
fixed from the values BEFORE its first write, so a resume after a partial
move decides the same: a merged slot whose both sides were unchanged since
the inputs went pending is not an edit (the claim folds over it); one that
carries a change of either side is kept; a key the CURRENT twin cleared since
clears the survivor's unchanged one too (reviewer P1-B on 4807242f). Every caller of an identity write — the connect
form, the boot dial, a reconnect, an arrival, a switch, an address change, a
deep link — reports its failure to the ONE host gate (`storageFailed`), which
classifies it by the migration state, not by the error: it reruns the boot's
preparation, and if that cannot be recorded the app is blocked in that same
turn (the server tree is held — since ③a mounted, inert and hidden, its
writes held by the write gate — CURRENT and the registry freeze, Retry is
offered, and the boot dial is re-armed so Retry brings the connection back).
An ordinary failure keeps the caller's own error (reviewer P1 on 23879812).
Pending ends two ways (board #335 ③d-3; the debt P1-b on cf7e7957 left as
"discarded later by a user action"): a claim, or the PERSON discarding the
inputs from Settings › Connection, where a pending record is shown as a row
named by the machine the legacy mirror named, with the one action Discard.
The discard asks first; Cancel writes nothing; confirming is ONE write — the
marker becomes `discarded` (`discardPending`) — and touches nothing else: the
unprefixed inputs stay (a build rolled back to before #335 finds exactly the
state it left) and so does the quarantine copy. A `discarded` marker is
closed: a later boot reads it as consumed and a server whose machine matches
folds nothing (`already-done`). Nothing infers a discard. The discard is a
deferred write like every other (reviewer P1-D2 on 18a3bff4): the dialog is
withdrawn when a block begins while it waits, and the commit re-checks
`migrationBlocked` and that a record is still pending; it passes the claim's
barrier too — an open slot move (the journal's, or the legacy `moving` the
marker carries) is finished FIRST, and one that cannot be finished leaves
the marker and the intent as they are and blocks (`unrecorded` → Retry): the
recovery is never closed over. The confirmation is for ONE set of inputs
(reviewer's residual on ed593949): the ask captures the set's identity
(`PendingInputs.key`), and the row's machine, the key and a claim's
attribution all come from ONE read-only answer (`currentEvidence`, reviewer
P1-D2 on 30dcc2ad): inputs unchanged since the marker → the marker's machine;
inputs rewritten (only a pre-#335 page does) → the mirror that page keeps,
read now, or unknown when it kept none — never the old marker's machine over
new inputs, so a refused confirmation re-presents the CURRENT source and the
next confirmation is about it. The dialog is voided — not
hidden — when a block begins, the record is claimed or the set changes under
it, and the commit (`discardPending(storage, key)`) refuses a different set
as `stale` with nothing written; a pre-#335 page rewriting the inputs as
another machine's meanwhile therefore leaves them for that machine to claim.
The row shown in Settings is a PROJECTION of the marker, read only through
the host's fail-closed gate (reviewer P1-D1: at boot in `prepareStorage`,
after every fold or claim, after a discard — never at component init), so a
storage whose marker cannot be read blocks with Retry instead of mounting
nothing or reading "nothing pending"; and that read is a second fallible
step of the gate (the residual): its failure is the gate's `blocked`, never
a success the gate releases, mints or publishes on. When
the gate blocks, it OWNS the outcome: a switch that hit it shows no failed
panel of its own (which would cover the migration's Retry with one the freeze
refuses); the gate keeps the switch's target, and Retry, once storage is
recorded, resumes that switch through the switch itself (reviewer P1 on
af59fb5d). What the gate kept — the switch, a deferred deep link — is consumed
only once nothing blocks it: if Retry's own bind blocks again, the next Retry
still has it (reviewer P1 on fedd17eb). Which half it stopped in is the REGISTRY's to say: the alias still
saved means nothing was committed and its slots are intact, so they are
copied again; the alias gone means the copy was already done, so nothing is
copied (an emptied source must never overwrite the survivor) and the cleanup
is finished. A claim that cannot finish it does not fold (`unrecorded`, the
blocked shell, Retry). Each slot is then compared only with its own baseline,
so an edit or a clear the alias made after the inputs went pending stays,
and a moved old park takes the inputs. If even the intent cannot be written,
nothing moves. It fingerprints the inputs too (P2-a): if a build from before #335 has
rewritten them since, the machine they belong to is read again from its
mirror before anybody claims them. Any other server runs on its own slots
while the input stays pending, however many come first. A
server that has not reported its machine yet claims it after its
authentication. There is no terminal "consumed, nobody's" state: only a fold
ends pending.

It does not clear the unprefixed keys: nothing writes them after ②b-4, and a
client rolled back to a build from before #335 finds the state it left.

**The flip (②b-4) moved everything in ONE commit**, because the two halves
cannot be apart: `parkFrom` wrote `<key>::<id>` — the very string a resident
slot uses — from the LIVE key, so while anything wrote the live key a switch
overwrote the resident slot, and while anything read the slot a live write was
lost to it. In that commit:
- every server's state is built over its own store (`createServerState(
  createServerStore(localStorage, id))`), and the navigation is saved and read
  through it (`saveNav`, `readNav`); App reads and writes no unprefixed
  per-server key, and nothing writes `tmux_machine_id`;
- `parkFrom`/`pointTo` and the park in the switch are gone: arriving at a
  server is moving CURRENT (`activateConnected`, `activateSwitched`). An
  identity merge MERGES every twin's slots into the survivor's, slot by slot
  (`slot-merge.ts`; board #335 ③b, orchestrator 15:02/15:04 and reviewer
  15:03 — under Aggregate a background alias and its canonical are both live
  members with state of their own, and the whole copy this replaced deleted
  every survivor key the CURRENT twin lacked, and every other twin's slots
  outright): a missing source never deletes; a value lands on an empty one;
  drafts merge by room, read marks by the newer seq, alerts by key with the
  twin's renamed to the survivor; a real conflict keeps the CURRENT twin's
  value (what the person was just using), else the survivor's, and the
  loser is recorded in `tmux_slot_conflicts`, never overwritten in silence.
  That store has no cap — nothing resolves a row yet, so every row is
  unresolved and none is dropped for room — and a store that cannot be read
  (or is not a list) throws instead of starting over, so the move stays
  open and the app blocks until Retry (orchestrator 16:32 on 0f668e4f).
  The move journal (`tmux_slot_moves`) is read the same way: unparsable, not
  a list, or a row without its pair throws, so the absorption does not run
  and the app blocks; it never reads as "no move open", which would let the
  next absorption merge over an unfinished handoff (reviewer P1 on
  97824925).
  A survivor that is alive re-reads its slots once the fleet has dropped the
  twins (`onReconciled` → `reloadStored`), and so does every live state
  after Retry's preparation finished an open move;
- the boot order is migrateServers → loadServerRegistry → the fold →
  the deep link → bind. The fold runs before the link, because a link to B
  makes B current and a later fold would file A's live state into B's slot.
  With no server to fold into at boot, it runs again before the first
  server's state is built (`swapScope`), and if CURRENT had dangled, that
  server must prove itself;
- any write the boot needs before a bind — the registry's, the attribution
  marker, the quarantine copy, the fold, a claim — that fails is ONE blocked
  state (`unrecorded`; a throw is the same), never a crash out of App. While
  blocked, CURRENT and the registry are FROZEN (orchestrator, 21:45): no
  server page mounts, and nothing that could move CURRENT or record an
  identity runs — the boot dial, a deep link's activation (the link is parsed
  and stripped from the URL at once and applied after the migration is
  recorded), a switch, an address row, the optimizer, the reconnect loop or a
  late reconnect success, an arrival — nor any other registry write (a
  hostname adoption, a rename or remove, an address list edit; reviewer P2-b).
  The server lists show the reason and disable rename and remove, so a person
  is refused with a reason rather than ignored.
  The navigation's merge rewrite (`followMerges`) is a pre-bind write too, and
  its failure blocks (P1-3). The connect card shows the reason and offers only
  Retry; connected, the content area's panel does. Retry re-runs every step
  that had not completed, then resumes the CONNECTION by its real state
  (P1-2): never connected, the boot dial runs; the socket still up, the server
  comes up on it with no new dial; the socket dropped while blocked, the
  navigation is restored and the reconnect loop brings the socket back. Every
  later bind tries again too. The shell and Preferences stay;
- where to reach a server is its ENTRY, for every id (`server-target.ts`), and
  every path that moves the active address records it there once it answers —
  the form and the deep link (`activateConnected`), a failover
  (`recordServer`), an address row and the optimizer (the runtime's own dial
  with `via`); the boot comes up on, and records, the address the runtime
  dialled, and whether it dials at all is the entry's to say, not the
  mirror's (reviewer P2 on cf7e7957). Since reviewer P1-A on cc45d7d1 nothing
  that dials reads the mirror: the keys are written for the connect card's
  pre-fill and the share link, and read only there.

### A subtree is bound to one server, in that order (board #335 ②b-1)

`App` holds a `ServerRuntime` and the server-bound tree is keyed on that
HANDLE. The handle is the right key because it is the thing whose lifetime
matches what the tree may assume: a reconnect replaces the socket INSIDE one
runtime, so the handle does not change and the always-mounted pages keep the
state they are always mounted for; a different server is a different handle, so
every page, listener and subscription is rebuilt. `ServerScope.svelte` binds
the subtree at init and `useServerApi()` resolves once, which is what makes
"an operation cannot re-target itself" true for the pages inside it.

The key gives the swap and NOT its order — Svelte creates the new branch before
destroying the old one — so `app/server-scope.ts` owns the order, framework-free
so it is a test rather than a comment: unbind, let the host settle (where the
old subtree's teardown runs), invalidate what was aimed at the old tree, then
bind the new runtime. A FIRST bind skips all of it, because with nothing bound
there is nothing to tear down and a bind deferred by a tick would mount every
page unbound and then rebuild them. Two rules come from the await in the
middle: the same handle is never re-shown, and a SUPERSEDED swap shows nothing
while the handles it unbound are still carried to whoever finishes, since the
swap that supersedes it starts with nothing shown and so has no orphan of its
own to find.

Which server the tree is bound to is READ from the registry's CURRENT rather
than passed in, so no caller can name a different one, and identity repair is
the reason it must be read: `recordServer` can absorb the entry the app booted
as into a machine's survivor and re-point CURRENT at it, and from then on the
app IS on the survivor. A handle is replaced when the SERVER changes, which is
why a reconnect through the connect page and a failed switch's Back both keep
the handle they had.

Through ②b-3 production held ONE runtime, BORROWED on the facade's
compatibility slot (`app/single-runtime.ts`), so every page still importing
RPCs from `ws.ts` and every bound page talked over one socket while they moved.
That forced a suspend/handover protocol for the connect form, which re-dialled
the very socket the bound pages used. ②b-4 retired all of it once the last page
was bound: each runtime owns its connection, a connect dials a candidate first,
and the protocol's one surviving guarantee, the activation generation, is
`app/activation.ts`. See "Every runtime owns its connection" in the rules
below. Two rules from the borrowed era still hold:

- **The api gate is asked when the call is MADE.** A page holds `api` for its
  whole life, and a call like `fsWrite(path, await body)` reads the method
  before the await and sends after it; a gate on the property read would let
  both through. So each method is wrapped once, the wrappers are stable, and a
  caller that captured one still holds the gate. A detached runtime refuses
  every call at once, while its connection waits for the host's end.
- **An identity that cannot be recorded is an error, never a success.** A
  peer that authenticated while the registry write failed is reported to the
  person, and nothing comes up on it.

Clearing the landings after the DOM is gone is the second line, never the
first.

The provider renders NOTHING without a runtime. Rendering the children
anyway — merely without a context — built a whole provider-less
Files/Terminal/Hub tree during the gap in a swap, falling back to the facade,
and `{#key}` mounts the new branch before destroying the old, so that unbound
tree came up while the old server's was still alive. Both PERSON-LEVEL
surfaces therefore live outside the subtree: the Connection card, which a
fresh client must reach with no server at all, and Preferences — theme, fonts,
zoom, language, shortcuts — which the gear opens whenever the shell is there,
including when no runtime is bound, and which inside the subtree would have
rendered a blank page exactly then. Preferences' one server-bound guest, the
Agents editor on touch, is gated on a live server and bound by a GUEST scope of
its own (②b-3). Since ③a every bound member has its own guest editor, keyed by
its handle, mounted on first open and kept: only the focused member's is shown
and takes input, the others stay mounted hidden and inert, so a focus change
never destroys a draft in one (reviewer P1-C on the ③ plan). Each registers its
own back chain, exit guard and drilled state, and the page asks the SHOWN one's
at use time. A guest's LIFE is its member's, not the page's tab (reviewer P1-1
on 6b923c0d): it mounts the first time its server is shown on an agent
category, then stays mounted — hidden and inert — while another category or
another member is shown, each guest on its own last section, and App keeps
Preferences mounted (hidden) once a guest exists, so leaving the page or a
block moving it never destroys a draft. A guest's SECTION is its own too
(reviewer P1-1 residual on 9958bbfd): set when it first mounts, then changed
only by an accepted category choice while it is shown — another member's
choice never writes it, and when focus returns to a guest the page follows
that guest's section, not the reverse; any choice that would move a shown
guest's editor asks its guard, and a confirmation answering after focus moved
commits nothing. When that choice is made from a person category, the
guest's editor is hidden, so the page first REVEALS it on its own section and
asks there — its confirmation is seen and answered where it lives; "keep
editing" puts the page back (the guard reports a cancel to its host), and only
"discard" moves the section (reviewer P1 on c0969d20). The phone's Back on that
confirmation is the same answer as "keep editing" (`keepEditing`, reviewer P2
on 27c4ad6f). While a guest is held
an agent category lands on its own section, so page and guest never disagree
after Retry. A guest takes input — `visible`, its Back, its guard, a lazy
first mount — only while Preferences is on screen, the server is not held and
the touch guest applies (`guestInput`); a kept, hidden page or a block leaves
it mounted and untouched. An edit request names the server of
the tree that asked (`serverId`) and only that member's guest takes it; a
request never moves to the next member shown.

**"Shown" has one definition** (reviewer P1-2 on 6b923c0d): a tree is shown
when it is not held — focused AND not blocked. Every page's `visible` follows
it, so a blocked tree behind the Retry panel is not a reading tree: its Hub
does not take the tail or move a read mark, and its guest editor applies no
request. The window's programmatic entries — Back, reselect, the split, focus
and window-cycle shortcuts — skip a held tree's pages too: DOM `inert` stops
pointer and focus, not a handler the window calls. A caller asking whether a swap is needed asks what the swap is already
HEADING for, not what is shown: during the gap nothing is shown, and one
success path asks twice, so comparing against the gap would mint a handle
nobody ever shows or releases. Since ②b-4 there is no provider-less fallback:
`useServerApi()` outside a provider throws.

**A page reads its server ONCE; a union row names its own** (②b-1-3). Inside
a bound subtree a component reads the context once, at the top level of its
instance script, into one local const — `getContext` works only during init,
and a second read is a second chance to see a different server. Nothing that
is not a component reads it at all: a helper takes an explicit api. A union
list is the exception that proves the rule — it spans servers, so it has no
owner one context read could name, and one `useServerApi()` for every row
would send B's delete to A. Its row actions go through `server-union.onRow`,
which looks the runtime up ONCE from the clicked row's ref, hands the action
that api before its first await (so a reconnect or a switch while it waits
cannot re-target the rest), and does nothing at all when that server has no
live runtime: there is no "current server" fallback, because falling back is
how a click on B acts on A. Only App constructs a runtime or binds a scope;
the provider binds what App hands it. Source pins hold all four. No production
list projects a union yet — that arrives with the mode switch in ③ — so what
ships here is the one mechanism and the pins every such list will be held to.

**One server's state is one value** (②b-2-1, `app/server-state.ts`). What the
app remembers about a server — so far the Hub's per-project maps (lead, read
mark, draft, drawer, roster, open project), its notification centre's list,
and Files' memory together with the download rows — is a `ServerState` that
belongs
to a RUNTIME. App builds it in `swapScope`, beside the runtime and after
CURRENT moved, and the provider hands both to the subtree as one scope
(`useServerScope()`, one context key, read once at init). A different server
is a different runtime and so a different bundle, so a switch re-reads
nothing: `reloadServerState` is gone. Two rules carry it. A field joins the
bundle in the SAME commit its module singleton is deleted, because two live
instances over the same keys would each keep a copy and the later write would
win. And through ②b the store is still the bare `localStorage`, whose live
keys are whichever server is current, so a bundle is never built on first
sight of an entry — only once its server is current; b2-4 gives each bundle a
store scoped to its server, and then the timing stops mattering. One
exception to "a new runtime starts fresh": when the identity layer RECORDS
that the replaced handle's id was folded into the new one (`mergedInto`, an
alias absorbed into its canonical entry on a same-server reconnect or a
failover), it is the same machine, and the whole bundle is HANDED OVER
(`stateForRuntime`). A fresh one there emptied the Downloads rows and browse
positions of the machine still on screen and orphaned every download attempt
in flight, which a later switch then could not find to suspend (reviewer P1,
2026-10-10). Only a real change of server starts fresh. The person's
own preferences (feed level, tool-row cap, sidebar) are not in it: they are
`appPrefs`, one owner however many servers are on screen, read directly by
App and Preferences. Files' record is memory only (parked
cwds, the one-writer claim per part, each attempt's abort handle, the rows),
and its two halves travel together because the page and the Hub's drawer share
one record and a download is not stopped by dropping a reference: the switch
suspends the LEAVING server's attempts through `suspendFiles(thatServer.files)`
and awaits them before the socket moves. Since ②b-2-3 this is one function, `releaseServerState`, in the order ②a
ruled: SEAL the record — a gate, so a download that tries to register
afterwards is REFUSED and sends nothing (`suspend` only snapshots what is
tracked when it is called) — suspend every running attempt keeping its part,
and await their settle. Since ②b-4 each server has a socket of its own and
nothing moves one under its pages: the release runs inside the handle's end,
which the swap runs only once the next server is bound (order (a), below).

A handle ENDS one way, `app/handle-end.ts` (②b-2-3, reviewer P1-a on
48b40082), on every path that gives one up — the swap's invalidate, the
fleet's drop and reconcile, an activation letting go of a runtime it minted,
the App's own teardown — and ending is two steps that are not the same step. It STOPS
at once: the handle refuses every call and the host stops treating it as
reusable, and its state's release starts in that same turn (the seal is the
release's first step, so a merge found a moment later cannot adopt a state
on its way out). It is DISPOSED only once that release has settled, and the
swap shows no runtime until it has. Every path waits on the same end, so
it is idempotent. A handle whose state the handle replacing it ADOPTED (a
same-machine merge) ends without a release — which is why a merge is
concluded by the swap, never by a verdict: a verdict ends the handle before
anything adopts its state. A state already released is never adopted: its
record is sealed for good, so a failed switch's Back that discovers a merge
builds a fresh one. A runtime's own detach on an identity loss inside `dial`
is the stop step only; it never disposes itself (②b-4 closed the self-dispose
an owned slot used to keep), and the host's end follows.

Before anything destroys a server-bound tree, that tree's editors are asked,
through the one leave walk. The connect form asks before it dials, about
EVERY address: an address is not an identity — one this machine used to
answer on can answer as another machine now — and which machine answers is
known only after the dial (reviewer P1-b on 48b40082). It asks with the
address, token and socket it froze at submit, and dials exactly those,
however the fields change while the walk is open; a walk that fails is a
stay. The walk may reveal another page, so the host HOLDS the connect form
mounted for it, as it holds Preferences, and an accept returns to the
attempt that asked. An automatic reconnect — or a boot dial — whose socket
answers as another known machine ARRIVES there only after the same walk
(reviewer, 18:54 on 5ca0e79e): losing the socket is not consent to discard
local edits. A stay keeps A's tree with its handle held (refusing), closes
B's socket and says why on the connect page.

A leave walk — the switcher's, the form's or an arrival's — is ONE QUESTION
AT A TIME (`serverSwitch.guard`; reviewer P1s on 085b0e70 and 4fbce02e,
narrowed by the orchestrator at 2026-10-11 04:03). A second request while one
asks is refused, and a refusal is a stay. That is all a walk does: since every
server has its own connection (②b-4) there is no shared socket for it to own,
so it stops no loop and freezes no address. While it asks nothing NEW is put
to the person or dialled: no switch, no address change, no optimizer probe or
foreground resume, and a reconnect attempt that comes due waits on
`serverSwitch.idle()` before it dials — and then dials only if nobody claimed
the activation meanwhile. An optimizer probe begun before the walk is stale
when it answers (the walk moves the switch's intent). An arrival that comes
in while a walk asks opens no second walk; the person's answer to the first
decides. An arrival runs its walk under the attempt that reached the other
machine (claiming again would make that very attempt stale), and a stale
arrival does nothing at all. After an arrival's stay, nothing AUTOMATIC dials
(`heldOffline`, reviewer P2s): not the disconnect callback, not a foreground
resume, not a late optimizer probe; the person's own act — the connect form, a
switch, an address row — lifts it.

**Every dial is a runtime's own** (reviewer P1-A on cc45d7d1). No path dials
a raw address for a server, and nothing reads or writes the active mirror to
decide where a server is. Each runtime has its OWN reconnect loop
(`reconnectorOf(runtime)`): it asks `targetOf(storage, runtime.id)` at every
attempt — that entry's address, token and machine's failover set, never
whichever server is current by then — and dials through `runtime.dial(claim,
{ via, timeoutMs })`, so the dial checks who answered and records it itself.
A peer that answers as another machine has its socket closed by that dial
before anything of this server's can reach it, a method a page captured long
before included; a peer whose identity cannot be recorded is closed the same
way and reported through the host gate. The shell's reconnect UI is the
BOUND runtime's loop; a runtime that ends takes its loop with it. Moving the
current server to another of its addresses (an address row, the optimizer)
is `serverSwitch.connectAddress(address)`: the bound runtime redials with
`via: address` and its own token, and an answer from another machine is an
arrival, never this server resumed over it.

**One bring-up road** (reviewer P1-B on cc45d7d1, P1-3/P1-4 on 341554b3).
The boot, the connect form, a switch, an arrival, a merge and the migration
Retry all come up through `activate({ replace, elsewhere, up, minted,
chain })`, in this order:
1. mint CURRENT's runtime (`mintCurrent` = the storage gate `foldCurrent`,
   then `mintFrom`), and claim the activation AFTER the mint, whose `endAll`
   would otherwise end the claim it is about to make;
2. dial that runtime's connection;
3. if the dial answered as this server and is still the latest, run the
   storage gate AGAIN for what the dial taught it (a machine that can claim
   pending inputs, a merge whose navigation needs rewriting) — before
   anything is published;
4. only then publish: bind (the swap ends the server left, release then
   dispose), reset the memory of a server left (`replace`), wait for the
   bind to FINISH, and run `up`.

A gate that blocks publishes nothing and ends nothing (reviewer's ruling K,
06:09), whichever way the app gets there: at step 3, at step 1 (the mint's
own gate), or from the host gate (`storageFailed`, e.g. a candidate's
identity write failing mid-handoff). All three take the ONE blocked state,
`enterBlocked`, which never unbinds: a runtime a failing activation minted
is let go of, while the runtime the tree is bound to stays bound and
running — its downloads too. What the block takes away is INPUT, not the
views: since ③a (orchestrator 08:17, one mechanism for Single and Aggregate)
the server tree stays mounted but inert and hidden, the touch layout's guest
Agents/Teams editor in Preferences stays mounted but inert with the reason,
every runtime refuses new write RPCs, and the write gate holds every resident
write — so an unsaved editor is still there after Retry. Before ③a the tree
was unmounted here, and its unsaved text with it. Person-level Preferences
keep working. Retry owes
the activation its dial, and the server left is ended only once the next
runtime has passed every gate. A first boot has no source: an empty view
and Retry. Past a link's point of no return (`committed`: it is
publishing) a cancel undoes nothing, so the connect form stops offering
Cancel and stays busy until the bind is done (reviewer P2 on 027d1a92).

One USER activation is one CHAIN (`newChain`). A link can hand over to
another — its dial reached another machine (an arrival), or its gate moved
CURRENT or filed inputs into a shown runtime's slots (a fresh mint, which
dials first) — and each such link joins the chain: `done` resolves with the
LAST link's outcome, `cancel` reaches whichever link is out, and the chain
is `current` only while that link is. A failure or cancel of a chain that is
no longer current changes nothing: a newer bring-up concludes its own (an
`arriveAt`'s return to the server left runs only for a current chain). Once
a link publishes, a cancel undoes nothing. The connect form waits on `done`
(the second handshake and every link after it), and its Cancel calls
`cancel`, which lets go of the runtime the link out minted at once. A
runtime is the activation's while PROVISIONAL: `releaseMinted` ends it only
if that activation still owns it and it is not bound, so a stale activation
never ends a runtime a later one reused (reviewer P1-C). A KEPT runtime —
the one on screen, dialling again — is not the activation's to end; its own
dial closes the peer it reached if its host has moved on by then (below).
`bringUp` records and binds nothing; it only asks the server what it hosts
and restores its navigation.

**Every attempt owns itself** (reviewer P1-1/P1-2 on 341554b3). A dial whose
host moved on — a cancel, another candidate, a switch — while it is still
the connection's latest dial closes the socket it reached: nobody will ever
check who that peer is, and every call of the handle would reach it. A dial
superseded by a NEWER dial of the same runtime touches nothing, because that
newer dial already replaced the socket. Each reconnect attempt dials under
ITS OWN claim, which the machine hands to `connect` and asks again before
the identity record and before an arrival, and its own answer reaches
`onSuccess`; nothing is shared between a loop's attempts. An address change
hands the runtime's dial its own ownership (intent, no switch, claim) — "A
is still bound" is not ownership, since a newer form connect leaves A bound.

**The runtime asks** (②b-2-2). The capability handshake every connect path
runs (`serverReady`) is the bound runtime's `probeCaps()`: asked over its own
api, kept as its caps under a round number of its own, and mirrored into the
shell only while the switch still owns the intent AND that runtime is still
bound — a late answer from a server already left never lands. The Hub flag
moves only on a definitive answer, and a failed backends probe keeps the list
the runtime already had rather than wiping it to the fallback. A client with
no saved entry has nothing to dial and opens the connect card.

## Several servers at once (board #335 ③)

Phase ③ is the user-facing half of #335: with ① (the connection is an
object) and ② (every name is a server's, every store is a slot) in place,
the app can HOLD several servers and show them as one room. The ruling that
shaped it (orchestrator, 2026-10-11/12) and its six design points:

- **D1 — a member is a tree.** Every included server gets its own runtime,
  socket, state and mounted tree (held, inert, behind the focus); nothing is
  rebuilt on a focus move. No second transport, no aggregation service.
- **D2 — the focus moves in place.** Picking a connected member changes
  CURRENT and the mirror and brings its tree forward; no dial, no walk, no
  teardown. Picking a member that is NOT up is not a focus change: the app
  stays where it is and the row shows that server's own state (an excluded
  one is included and joins through its own dial); the person focuses it
  once it is up (orchestrator 02:28/03:23). Single switches as before.
- **D3 — one tree, one terminal.** A split stays within a server; another
  server's session is a selector that moves the focus there.
- **D4 — a hidden member does list work only.** Its Hub's 20 s project
  refresh and its Sessions' 20 s list refresh, the unread badge and the
  notification record on a push; no room, no pane, no vitals.
- **D5 — projections, not pollers.** The Hub sidebar (a k-way merge of each
  tree's published, ordered slice), the Sessions selector (each other
  server's published list, concatenated in saved order) and the bell (the
  included servers' bounded alert indexes, sorted by each entry's own time)
  are built from what each tree PUBLISHED, every row with its server's tag
  by one rule (`server-tag.ts`: more than one included) and its own clock
  and catalog; every action goes back to its source through the same
  confirmed flow as a local one, on an api frozen at the ask.
- **D6 — one scope for shown, counted and cleared.** The INCLUDED members;
  an offline included member is listed unavailable, not counted, not
  cleared; an excluded server is not in the view.

The sections below are the mechanics, in the order they were built: ③a the
window's view per tree and the blocked app; ③b the member set, the focus
move, the leave walk per tree, the mode and include switches, identity
changes of a member (absorbed, orphaned, the owed handover, the explicit
end); ③c the tag, the three unions, the system status and the "current
server" actions; ③d the acceptance matrix
(`docs/exec-plans/multi-server-acceptance-matrix.md`), the discard of a
pending pre-#335 input, and the requirements (settings.md, hub.md,
terminal.md). Not done, on purpose: a cross-server feed, cross-server
`@mention`, a cross-server split, any server/CLI/`tmm` change.

### The window's side of a tree: the view (board #335 ③a)

A bound tree has two halves. What the SERVER remembers — drafts, read marks,
Files' record — is its `ServerState`. What the WINDOW holds about the tree is
its `ServerView` (`app/server-view.svelte.ts`): the pane and Files session it
is on, its split, the landings aimed at it, the runtime whose navigation has
been restored, whether its server has the Hub, and the Back chains and
reselects its pages registered. Each runtime handle has its own view (③a-4),
made on first ask and handed over with its state on a same-machine merge; the
window reads and dispatches — Back, reselect, immersive, the focus shortcuts,
the sidebar motion — through the FOCUSED one, and each tree's pages register
into theirs. App renders one tree per bound member, keyed by its handle (Single
holds one; Aggregate adds its background members, below): a tree out of focus is held — inert and hidden —
and its Terminal is not `active`, so the window's terminal shortcut moves the
focused tree's pane only (`Terminal.isolation.mount.test.ts`, two real
runtimes on the same target). A landing is delivered to the tree it names.
`resetServerMemory` still resets the focused view where it always did, because
a failed switch's Back returns to the same runtime and must restore.

**Each member has its own attempt generation** (③a, reviewer P1-A on the ③
plan; `app/activation.ts`). A member's join and its reconnect attempts claim
`activations.member(runtime)`, so one server hanging, reconnecting or being
excluded never makes another's attempt stale. The window's attempts — a focus
change, the connect form, a switch, an address change — claim the window's
generation, and one that acts ON a server (`claim(runtime)`) ends that
server's own attempts in flight, which is ②b's "the form takes over the
reconnect", and nobody else's. `endAll()` ends every generation: the App's
teardown, and the cancel of a chain that was the app's. Keys are handles, so a
new runtime under the same id never inherits an old one's attempts.
It is a class with rune fields, not a `$state({...})` object, because
`navRestored` holds a runtime handle and the callbacks are functions: a deep
proxy over either breaks identity.

**A blocked app sends no new write** (③a, orchestrator's P1-D ruling). While
the app is blocked on its storage, every runtime is `setFrozen(true)`: its api
refuses a NEW write RPC at call time, with the reason, and lets a read through,
so the lists stay current and a download in flight can still be re-signed. A
call already on the wire completes; nothing refused is replayed — the draft
stays in its editor and the person sends it again after Retry. What is a write
is `RPC_KIND` in `ws-api.ts`, one table with every wrapper in it (a missing one
fails the type check and `server-runtime.frozen.test.ts`), and a name the table
does not know is refused like a write: there is no default to "read".

**A blocked app holds its resident writes** (③a, orchestrator's final P1-D
ruling). A mounted tree keeps working through a block — an alert still
arrives, a read mark still moves — but a resident slot written then is the
half-migrated client the block exists to prevent. So the app's ONE write gate
(`createWriteGate` in `server-store.ts`), closed during the block, takes every
resident write of every server store instead of the storage and answers reads
from it first, so pages and stores never disagree. Retry, once the claim has
run, flushes the table in the order it was written; the gate opens only when
all of it landed, and a write that failed stays, with what follows it, for the
next Retry. It is keyed by server, so every view of one server sees the same
pending value; a removal is held as an intent; the person's keys pass through;
an alias's pending writes land under its canonical entry by the same slot
rule as a merge on disk (`slot-merge.ts`, ③b): merged with the survivor's
pending value or, failing that, its value on disk — so a held removal of the
alias's key deletes nothing of the canonical's — and a real conflict is won
by the later write, the loser recorded; never in the alias's deleted slot.
The alias's pending entry is let go of LAST, after the loser is recorded and
the survivor's entry written: a read or record that throws leaves the table
as it was, the flush reports it did not land, and the next Retry runs the
same idempotent merge again (orchestrator 16:32 on 0f668e4f). It
is memory only: closing the page before a Retry has flushed loses what was
pending. An alert that named the alias names the canonical after the move, so
the canonical centre can open it; alerts naming any other server are left
alone (reviewer P1-4 on 6b923c0d; the App case on a live background alias
absorbed by the canonical's reconnect is in `App.shell.mount.test.ts`).

**A block ends every attempt in flight** (reviewer P1-3 on 6b923c0d).
`holdStorage` calls `activations.endAll()` in the turn it decides the block: a
dial asks its owner right before it records an identity, so an authentication
that lands afterwards writes neither the registry nor CURRENT. The frozen api
guards the wrappers; this guards the dial's own record. Connections, streams
and downloads are untouched. A chain's Cancel is local — the window's attempts
and the server it was bringing up (`claim(runtime)`) — and `endAll()` belongs
to the block and the App's teardown alone.

**Aggregate holds every included server as a background member** (③b-1;
`app/server-members.svelte.ts`). In Aggregate mode every saved entry that is
not excluded and not CURRENT is a member: its own runtime from the fleet, its
own connection, its own `ServerState` and view, and its own tree — held, inert
and hidden, with a Terminal that is neither visible nor active. Single, or an
excluded entry, has none and dials nothing. A member joins through the same
gates as a bring-up, in order: the storage gate for its id, its runtime's own
dial — owned by `activations.member(runtime)` and asked at every step whether
the set still wants it — the gate again now that the dial may have taught the
entry its machine, then publish (`onUp`: state, freeze if held, its drop hook,
its saved navigation into ITS view, its handshake). No step writes CURRENT or
takes the screen. Each member's socket drop is its own reconnect loop; the
window's reconnect banner is the focused server's only. A block publishes
nothing: `holdStorage`'s `endAll()` ends a member's dial in flight, so an
authentication that lands during the block records no identity, and Retry's
sync joins it again. A member counts as in hand only while it is published or
its own join is still current: a join the block made stale is joined again on
the same live handle, and the stale dial's late answer — before or after the
new join — concludes nothing and lets go of nothing (reviewer P1 on
97824925). The block is the whole app's until Retry (reviewer P1 on
453f02b8): a later gate — the next member's join in the same sync — never
prepares it open (`foldFor` only answers `blocked`; the preparations are the
boot, the host gate while NOT blocked, and Retry). A published member's
reconnect passes the post-dial gate too: refused, its socket is closed and
its tree kept. A member's socket that closes during the block starts no loop;
Retry's `resume` redials every published member not answering. A member's
identity record that throws goes to the one host gate (`storageFailed`), as
the focused server's does. An alias a member's dial finds absorbed leaves no row (its
canonical entry is a member of its own); two known entries on one machine
fail with the other's name and wait for the person. The set follows the
registry, CURRENT, the mode and the exclusions (`syncMembers`), never while
blocked or mid-switch; a member the focus takes over (a switch made it CURRENT)
is the focus's from then on, and a failed switch that reused a member leaves it
a member.

**Retry re-dials what a block or an absorption interrupted** (orchestrator
16:12; reviewer P1 on 97824925). The criterion is what was interrupted, never
whether a handle is alive, in Single and Aggregate alike: a stopped switch, a
connect that had recorded its server, a reconnect whose identity could not be
recorded because the app blocked, a reconnect answer that landed while
blocked, and a drop while blocked are all owed one dial (`owedActivation`);
the member set is synced again, so an interrupted join joins again. Every
automatic arrival that replaces the bound tree — a reconnect that landed on
another machine, an absorbed alias's survivor, and Retry's owed dial,
including when the absorption already moved CURRENT to the canonical — asks
that tree's pages first through ONE helper, `askToReplace(mine)`, which
checks its owner before it changes anything: a stale "keep editing" leaves
nothing offline, and a current one stays on the source with the draft.

**The focus moves between connected members without a teardown** (#335 D2,
③b-2; orchestrator 02:28). In Aggregate, picking a member that is up moves
CURRENT and the active mirror onto it (`focusServer`) and brings its tree to
the front (`scopeSwap.refocus`); the tree that was focused stays mounted and
up, and becomes a member (`aggregate.handOver` / `adopt`). Nothing dials,
nothing is unbound or ended, so no leave walk runs and every draft stays
where it was — which is also what makes a background tree something a person
can have edited, and so something a leave walk has to ask (below). A refocus
is refused while a swap is in flight, while blocked, mid-switch or mid-walk.
The move is ONE commit (reviewer P1-3 on 99566068): everything that could
refuse is checked first; storage then commits with CURRENT LAST
(`focusServer` restores the mirror and rethrows when a write fails, so
CURRENT never names a server whose mirror half-landed, nothing moves, and the
list says so); then the window's attempts aimed at the server left go stale —
the switch's intent, so a late optimizer probe of A's addresses cannot redial
over B, and the window activation — while every member's own reconnect is
untouched; only then do the front and the set move. A member that is not
connected is NOT a focus change (orchestrator 02:28 and 03:23): the app stays
where it is, nothing is asked or replaced, and the row shows that server's
own state — an excluded one is included and joins; one still connecting or
failing keeps its own loop, and the person focuses it once it is up.
Aggregate never falls back to the replacing switch for a saved server.
Single switches as before.

**A switch replaces only its own tree** (reviewer P1-1 on 99566068). The
switch panel sits OVER the kept trees rather than in place of them: every
member's tree, and Preferences while it keeps a guest, stay mounted under
it, held and inert, with their drafts; the swap lets go only of the tree it
replaces, after that tree's walk. The connect form is the one surface that
still steps aside while a switch runs.

**The mode and the include switches** (③b-3). Settings › Connection carries
the device's mode (`Connect to: One server / All included`, the shared
`Segmented`); in Aggregate every row of the ONE server list (popover and page
alike) carries its include switch (the shared `Switch`) and its member's
derived status — the dot in the one status language, and a failure's reason
after the address (not answering, paused on storage, reaches another known
server). Each change is App's and walks what it destroys before it writes:
Single→Aggregate keeps the connection the app is on and joins the rest;
Aggregate→Single asks every member's tree, one at a time, in that tree, and
any "keep editing" changes neither the mode nor a connection; excluding a
member asks only its tree; excluding the focus asks the focus's tree, moves
the focus to the next connected member in saved order (D2), then excludes it
— with no other member connected it is refused, the list saying why.
Including joins. Picking an excluded row is an include, with the include's
checks and refusals; the app stays where it is until that server is up. A
new saved server is included (nothing excluded it) and a rename changes
nothing (the set holds ids). While blocked the mode and every switch are
frozen with the registry. One change at a time: each holds the walk — and
each is ONE deferred operation (reviewer P1-4 on 3a0b4feb; orchestrator
03:40): it claims the window's activation at the ask and, after EVERY await
and right before any write, checks it is still its own, the app is not
blocked or switching, and the mode and registry it decided about are as they
were (`membershipOp().valid()`). A walk can end for reasons other than the
person answering — a Save in flight finishing resolves the Agents guard — so
a block that began during the wait cancels the change: nothing is written,
no member is ended, and Retry executes no stale decision. Order of the
commit, as it is: an exclusion or a removal ends the answered member
(`aggregate.leave`) and then writes; the mode to Single writes and then
ends every member (`leaveAll`). A write that fails after a leave therefore
leaves the declaration unchanged with the member already gone — the member
rejoins on the next sync, and the person answered Discard for that tree, so
no draft is lost; this is said here rather than claimed away. The focus exclusion is one operation with its write: a focus
that moved but could not be excluded is moved back. Picking an excluded row
is an include through the same operation, never a bare write.

**A server is named by one rule, through one atom** (③c-1). `app/server-tag.ts`
decides WHEN: more than one server included (Aggregate's included entries;
Single's one), whatever their health. App reads it once (`tagScope`) and hands
every tree its name through its `ServerScope` (`scope.tag`, a live getter, so
the tag follows include and exclude); the Hub, Board and Terminal heads render
it with `ui/ServerTag.svelte`. No page names a server itself; the identity
modules' consumer pin keeps it so.

**The Hub sidebar is a union, projected, not polled** (③c-2;
`app/hub-union.svelte.ts`). Each tree's Hub keeps its own project list,
ordered by its own server's rule and clock, and PUBLISHES that slice to App's
one union source, keyed by its runtime (a replaced runtime inherits nothing);
it withdraws the slice with its tree. The focused Hub's sidebar renders the
k-way merge over the included set (`server-union.ts`: the domain's own
comparator, each row measured by its SOURCE server's talk map, saved order
breaking ties; every row carries its ref, so two servers' `app` never collide
and the open row is named by ref). Rows wear the one tag by the one rule; a
server whose list has not arrived is listed as missing, never dropped in
silence. Picking another server's row moves the focus there (D2, no teardown)
and hands that Hub the session as a landing it alone reads
(`view.hubSelectReq` through `landingFor`); a row of a server that is not a
connected member is not a focus change (`pickMember`). A foreign row's menu
is the ONE project-action flow (reviewer P1-C1 on 018d4fa5): Close and
Delete go through the same `askAction` → confirm → `runAction` as a local
row's, with the SOURCE api (`onRow`, handed synchronously) and the row's own
project id, name and liveness frozen at the ask; the dialog names project
and server; Delete is the recoverable close + archive, never `projectDelete`
(the purge has its one entry, the recycle bin); a failure stays on the same
target with Retry, which never repeats a completed step; a focus move during
the confirm changes nothing about the target. A server with no live runtime
offers nothing. Each slice carries its list's STATE (P1-C4): a Hub publishes
from mount, so a slice whose first `projectList` has not answered — or
failed — is MISSING to the union, not an empty list; a slice whose latest
refresh failed keeps its last good rows, muted, and the server is named
unavailable; it carries its own catalog's `icon` too, so a row's agent faces
are its server's, never the focus's (P2-5). D4 is held here: a hidden
member's Hub runs only its list refresh (the 20 s `reload`) and, on a push,
only the LIST's work — the unread badge and the notification record — never
the room's (no feed merge, no roster refresh; P2-1); its room opens when it
is first shown. Single hands no union: the Hub is as before.

**The Terminal sidebar's other servers are a selector** (③c-3;
`app/sessions-union.svelte.ts`). The same shape as the Hub's union, with
tmux's order as each server's rule, so the slices concatenate in saved order
with no comparator. Each tree's Sessions page publishes the list its server
answered (name, window count, attached, first pane as the target) and the
focused page lists every OTHER included server's sessions under its own,
tagged, with a server that has not published named as missing. Picking one
is not a terminal here (D3: a split stays within one tree): it focuses that
server (D2) and opens the pane there — `openTerminal` writes into the focused
tree's view, which the focus move just made that server's. A server that is
not a connected member is not a focus change. Panes, kill, search and the
pane picker stay this server's; the foreign section is not searched, and it
does not wait on this server's first Projects answer (P1-C4): another
server's published list is shown as soon as it is published. D4 and the ③
plan's list-refresh promise: a hidden member's Sessions keeps its list CURRENT
on the same 20 s list cadence the Hub keeps (one `list_sessions_with_panes`
per tick, nothing of a pane), and on its server's reconnect; the refresh
stops when it is shown (the show path owns it), excluded or its tree goes.
The shown page still has no poll of its own.

**The Board and the phone's Terminal list are the union too** (#357, owner
2026-10-13: "在 Terminal 页面和 Board 页面，都没有整合两种或几种不同连接里的所有
项目"). Still no second mechanism. The Board publishes its slice to the Hub's
merge, generalised to `createProjectsUnion<S>` (`BoardSlice` adds the server's
per-board counts); its sidebar renders the union with one row template for
Aggregate and Single, each row filtered, clocked and counted by its own
server, tagged on the second line. A foreign Board row is the same landing the
Hub's is: `pickServerBoard` → `focusMember` → `boardIssueReq` with `id: 0`
(the board, no issue), delivered by `landingFor` to the tree it names; the
body stays one server's (D3), a hidden member's Board does the 20 s list
refresh only (D4), and answered/failed are the slice states of P1-C4. The
Terminal's union source is unchanged; what changes is WHERE its foreign rows
are drawn. On the phone the session sheet is a union LIST: the foreign
sessions are rows of the main list (`foreignInline`, a host prop App derives from the sheet's own condition,
`isTouchDevice && narrowVp` — the component never re-decides what a phone
is), each with the tag on its own line and the same pick (focus + open
there); the desktop sidebar keeps its grouped "Other servers" section, where
a tall column reads whole.

**Where the phone's foreign rows sit (board #371, 2026-10-14).** #357 put them
right under this server's projects, which is the bottom of a list longer than
the sheet: measured on a 390 px touch sheet (844 px tall), the list was 1208 px
and the foreign rows started at y=1105, so the owner's Terminal sheet showed
devbox only and read as Single next to a Chat sidebar that listed both. The
#357 tests ran the DATA path (rows exist, tagged, in order of DOM) and could
not see the fold. The rule is the Hub's and the Board's: ONE merged list, each
server's slice in its own order, the slices interleaved by the domain
comparator through the one merge (`terminal-merge.ts` →
`server-union.ts unionRows`, `compareRowsWithClock`: live first, then
activity, each row by its OWN server's clock). `Projects` runs the merge over
its rows and the foreign sessions (`Sessions` hands them in, and draws a
foreign row through a snippet because the pick action is its own); a foreign
session's clock is the Hub union's project row for (server, session), which
App already holds (`projectClocks`) and which travels WITH the row, so the
same room name on two servers is two clocks. A session with no project row is
live and unclocked, and so is THIS server's own bare (untracked) session: it
joins the same merge as the local slice (`localSessions`, drawn by `Sessions`'
existing session row with a tag line and the live dot) instead of waiting in
the SESSIONS group below, which holds none in this mode — the first cut left
them there and the same row changed place and look with the focus (reviewer P1;
regression `A→B→A` over a projected and a bare live session per server). Every
row in Aggregate wears the tag line from the scope's live tag (`scope.tag`, null
in Single); a foreign row's age slot is the Hub row's own label (the window
count "2w" beside "27m" read as weeks). Considered and refused: foreign rows
first (puts another server's two sessions ahead of what the person came to
pick), and last (the bug). Motion: the keyed each wraps every entry so
`animate:flip` has its single child whichever kind it holds.

Follow-up after review (#357, reviewer on 390ba4dd; orchestrator ruling):

- **A Board's list is two required reads, and ONE counts map.** `projectList`
  and `boardCounts` both answer for a refresh to be a list. The slice publishes
  the Board's `countsMap` as it stands — bulk batches, `boardList` results and
  the local create/delete/status confirmations all write it — plus two flags:
  `completeOnce` (a first batch where BOTH reads answered) gates `answered`,
  so a counts failure never reads as "no boards"; `listFailed` marks a later
  failure and clears on the next success. A failed batch changes flags and
  never the map, so "the last complete list" is the map as last confirmed,
  local confirmations included (a frozen snapshot, tried first, lost them —
  reviewer R1 on 0feb403e). A server still without its first complete batch
  is "no list yet"; one that failed later keeps its rows, muted, "not
  connected". `hubRooms` stays tolerant: a missing clock only orders the rows.
- **A landing is held, and it has ONE eligibility.** The cross-server pick
  sets the newest request; the target Board takes it through the existing
  guard once nothing of it is committing (`submitting`). The held landing and
  any Keep/Discard it parks share one condition — displayed ∧ focused ∧
  serving ∧ same request ∧ not destroyed. "Displayed" is the board's own
  `visible`; "focused ∧ serving" is the HOST's word, one getter on the server
  scope (`scope.eligible()`: this tree is the CURRENT binding and its runtime
  is attached), because being shown is not being the focus — a leave question
  can reveal a background tree — and a runtime detached or absorbed under a
  still-mounted tree can serve nothing. Liveness is OBSERVABLE: `alive()` is a
  plain read, so the runtime offers an `onDetach` edge (it stays rune-free),
  `ServerScope` turns it into one stamp (`runtime-liveness.svelte.ts`) that the
  eligibility it hands the pages reads — a real `detach()` wakes the effect that
  withdraws a parked question, with no poller and no other change needed. The
  landing's own parked Discard is re-checked BEFORE it clears the draft, note
  or attachments, not only before the navigation. The board never imports CURRENT or
  compares ids as a stand-in for the handle. It is evaluated at the hold, when
  the board frees, and again right before the continuation runs; any false
  VOIDS the landing and withdraws the question that belongs to it — no replay
  when the person comes back. `id: 0` is the board LIST of that project: an
  open detail is left through the same guard (dirty → Keep/Discard). The
  focus never moves to a board that then silently ignores the choice, and a
  navigation that no longer exists never asks.
- **The Board's head wears the Hub head's Name + tag stack**, one atom in
  app.css (`.title-stack`/`.name-line`, #359), and the width ghost is priced
  by the counts of the rows actually rendered.
- **A foreign Terminal row shows the project NAME** from a `(serverId,
  session) → name` map the HOST derives from the Hub union's already-published
  rows (a hidden member's Terminal never loads its own Projects) and passes as
  `foreignNames`; Sessions imports nothing of the Hub. The Terminal union is
  live sessions only; declared-but-stopped projects of another server are in
  the Hub and Board unions.
- **"2× refresh", worded exactly:** a hidden member's Hub and Board each keep
  their EXISTING 20 s timer (two pages, two timers, ~3 reads a minute apiece);
  the union adds none.

**The system status and the "current server" actions are the focus's**
(③c-5). The sidebar's vitals are ONE server's reading — the focused one's —
never several machines' summed or averaged: App hands the one `SystemStatus`
the bound HANDLE as its owner and, in Aggregate, the focus's name ALWAYS
(orchestrator 02:28: the name is the identity of the number, beside it, not
hover-only and not the >1 rule; Single names none). A new owner drops the old
reading, invalidates every answer still in flight and reads the new server at
once (reviewer P1-C2: a late answer of the old owner's never shows under the
new name; a same-id runtime replaced by a reconnect is a new owner). Only the
focus is polled (D4): no other member's vitals are fetched for a hover or
anything else; the 08:17 sentence promising each member's reading on its
Connection row is withdrawn. The server switcher's row carries the
name, the address and a failure's reason; its hover card carries only what
the row hides — the machine id, the status word behind the breathing dot,
and "Excluded" for a server left out on purpose — because a card that
repeats its element is noise (owner, 2026-10), and the native `title` that
duplicated the address is gone (one popover mechanism). The surfaces bound
to one server by construction — the scratch terminal, the Agents page
(registry, skills, MCP, teams, the global prompt), the Connection section —
live in their server's tree or act on the focus, so their owner is frozen
when the action starts; in Aggregate each head names it with the one tag,
and copy-link and the address optimizer act on the FOCUSED server, named.
Details and the component contract: system-status.md.

**Identity ends now; an editor is destroyed only when asked** (reviewer P1-5
on 3a0b4feb; orchestrator 03:40). A published member can lose its identity
without anyone asking for it: identity repair absorbs its entry into the
machine's survivor (the focus's handshake proved the same machine), or its
own reconnect reaches another known server. Both used to drop the runtime
and its tree at once — and with them a Files textarea, an unsaved agent
definition, anything that is component memory rather than a resident slot.
Now the two halves are separate. IDENTITY is detached at the identity
layer's own synchronous boundary (reviewer R1 on aed2f654): for an absorbed
entry that is the fleet's `drop` inside `reconcile` — the host's `end` hook
runs there, in the same turn, and for a published member it orphans it
(`aggregate.absorbed` → `detach`: api refusing, socket closed, loop stopped)
rather than deferring to a later sync a block could hold off; a record that
commits the registry and then throws still reconciles (`server-runtime.ts`),
so the block that follows finds the alias already detached and it sends no
RPC during it. For a member whose own reconnect reached another known
server, the boundary is its dial's answer. The TREE stays mounted, held and
inert, drafts and all, as an ORPHAN (`MemberStatus.kind === 'orphan'`). Its
ASK is owed, not forced (reviewer R2): queued (`orphansToAsk`) and run through
the one guard/reveal mechanism only when the window can present it — never
over a switch in flight (its guard would end the switch's intent), a walk
already asking, or a block (the tree is held); busy, it stays pending and is
asked when the window frees, no second modal.

The identity callback REGISTERS the owed ask and nothing more (reviewer P1-B
on e0dafe3c). It runs inside the reconcile of whatever dial absorbed the
member — a Settings connect's owned second handshake, a Connection address
row's redial — and asking there would claim the window's activation and
expire that very dial. So `orphaned` queues and schedules; the drain runs on
its own turn (`scheduleAsk`, a zero timer) and only when the window is FREE
by ONE definition, `windowBusy()`: no switch, no walk, no address connect in
flight (`serverSwitch.busy` — the module counts every operation of its own
from start to completion, the switch from its confirm walk to its
conclusion), no activation from its mint to its `done` and no form candidate
from open to close (`windowLeases`), no membership change. `switching` was
never a proxy for "a window operation is in flight": the owned handshake has
no panel. P2, same commit: the drain is scheduled when ANY of those ends —
the switch module's `onidle` (after the walk's answer has reached its
caller, after `onstate(null)`, after `addressUp`), a lease's release, a
membership operation's `finally`, Retry unblocking — and because it runs on
the next turn the caller whose end freed the window has committed (written
its mode, opened its candidate, minted its activation) before the queue is
looked at: the queue never grabs the generation the moment a guard resolves.

The BOUND runtime's identity ends at the same boundary as any member's
(reviewer P1-A on e0dafe3c; P1-A/P1-B on 4c7cd64c; P1-1/P1-2/P1-3 on
9c1f757c). "The tree is kept for the person to be asked" and "the identity
stays callable" are two different things. The fleet's `end` hook, finding
the bound runtime's id GONE from the registry (absorbed — not merely
replaced by a swap), runs `focusAbsorbed`, which does two things and nothing
else: it DETACHES (api refusing, socket closed, idle reconnect loop stopped
— idempotent, so a handle its own dial already detached is detached again
to no effect: who detached it says nothing about who will complete the
handover, since that dial's arrival may be refused by a guard in flight and
conclude nothing), and it REGISTERS the owed handover (`owedHandover =
{ leaving, to }`, `to` the survivor the registry folded the entry into —
`absorbedInto`, which reads the open move journal when the note has not
landed) and schedules the drain. It never publishes: it runs inside the
absorbing dial's reconcile, and the handover's publish writes (the storage
gate). Out of the fleet the handle is out of service, so a block that
follows cannot freeze what the fleet no longer lists; it must already
refuse, and a pre-captured call makes zero wire calls.

The HANDOVER settles on the window's own turn (`drainWindow`: handover
first, then an orphan's ask), when no window operation is in flight
(`windowBusy()`: a switch connecting, a walk, an address connect, a form's
candidate or an activation out, a membership change) and the app is not
blocked. The X2 contract (orchestrator 15:52): the debt is VOID once
another tree was bound (the swap ended this one) or once a legitimate window
operation moved CURRENT off the survivor — a connect, a switch, a focus move
owns the front and binds its own target; a failed one puts CURRENT back on
the survivor (`restoreCurrent` follows the merge) and the debt settles then
— and it is never settled by activating whatever CURRENT names. The PUBLISH
passes the same storage gate as every bind (`foldCurrent`: the inputs'
attribution and the merge's navigation rewrite for the survivor) BEFORE any
tree is shown as the front; a write that fails blocks, and tree, debt and
detached handle stay as they are for Retry, which runs the gate again and
settles. Past the gate, with the survivor a published, CONNECTED, non-orphan
member: `refocus` to it (the front moves) and its tree given the MOVED
record WHOLE (`fillViewFrom` over a cleared view): the member's view was
filled when it joined from a slot the merge has since REPLACED with the
absorbed server's record (the CURRENT source wins) and the gate re-owned —
the person's last choice on this machine, a pane, a split or deliberately
none. Leaving the view alone kept an empty view and saved that emptiness over
the moved record (found by the P1-2 test's positive assertion on the parsed
slot); filling only the non-empty fields kept the member's old pane or split
over an explicit clear or single pane (reviewer P1-NAV on 7e0f69de) — so the
four navigation fields are reset and the record adopted as it is, behind the
gate, editors and drafts untouched; the mirror written (`focusServer`;
CURRENT already names it, so a mirror failure is the gate's — it blocks, and
Retry owes the focus its dial — a layered guard since 1125b5f4: the handover
goes on to `handOver`/`adopt` after the failed mirror write and Retry's drain
settles it again, so the owed dial of an already-connected survivor is a
no-op; kept as defence, no harness shows it alone — validator 20:39), the
window's attempts aimed at the absorbed
server made stale (`supersede`, `claim`; a FAILED switch's panel, a resting
state, is put away with its reason kept as the notice), the canonical out of
the set as the focus (`handOver`), the absorbed tree into it as a member
(`adopt`, published to the trees at once — a block skips the sync), and the
sync that follows, finding its id unsaved, makes it an orphan: mounted,
held, asked when the window is free. With no such member — Single; a
canonical that dropped, or whose own reconnect reached another known machine
meanwhile and made IT an orphan (a tree is not a connection) — the one road:
an activation of the survivor (`arriveOn`, Retry's own, from the gate just
run), which asks the kept tree's guards first and replaces it through the
swap. While owed, the canonical stays a wanted member (its own dial,
returning, must not find it unwanted and leave it); the bound runtime is
never joined as a member of its own set (a join would dial it over its live
socket); the member set never lets an orphan's late answer leave it
(`answered` returns on `h.orphan` before the `wanted` test). The debt is
consumed once, whatever settles it. The connect form's walk asks a bound
tree whether or not its handle is alive (`confirmFormLeave`): a detached
handle still has its drafts.

An activation's lease is released on cancel as well as on its `done`
(F1) — layered since 1125b5f4: `done.finally(release)` releases when the
cancelled dial settles "superseded", so the cancel-path release matters only
for a socket that never settles, which no harness can show; kept as defence
(validator 20:39). The bound runtime is never joined as a member of its own
set (F5, `memberIds`: `id !== held`) — held by a direct test since fd6083f6's
follow-up: during a form connect that moved CURRENT to N while A is still
bound, the events log carries no dial of A and A's connection object is the
same before and after (the bisect showed the robust handover had masked the
harm from 1125b5f4 on).

The root has an explicit END (reviewer P1-3 on 9c1f757c). WHEN the drain
runs is one module, `app/window-drain.ts` — one timer whoever asked, run on
its own turn; leases for the window operations outside the switch module;
`end()` — and App holds ONE instance of it. `onDestroy` ends it, drops the
debt and the queue BEFORE any resource is closed; a pending drain is cleared
and does not run, a schedule after the end is refused, and `askOrphans`
returns at once — so a lease released late (an activation's `finally` when
the teardown's dispose settles its dial, a candidate's close, the switch
module's `onidle`) schedules nothing, mints nothing, dials nothing. The
third phase (end → late release → the timers run → zero drains) is pinned by
`window-drain.test.ts` on that scheduler, in explicit order, because the App
harness's fake timers could not order it (reviewer 00:13 on 1125b5f4); the
App tests pin the first two phases and the source pin ties App to the one
instance. The timer callback checks `ended` itself too, for a host whose
`clearTimeout` is a no-op.

"Discard" lets it go
(`dismiss` → release → end); "keep editing" keeps it, detached, listed in
the server list with where its identity went and one action, Dismiss, which
is the same ask. The dismissal is a deferred destruction like every
membership change: it re-validates at commit (`membershipOp().valid()` —
owner, block, switch, mode and registry unchanged), and a stale answer,
whichever it was, keeps the tree and re-owes the question. An orphan is
never joined over, never redialled, never made the focus; a sync that no
longer wants it keeps it. An unpublished member that answers elsewhere has
no tree and is let go of as before. Nothing calls a UI guard from the
identity layer: the walk is the host's, after the record.

**A leave walk asks the tree it destroys, in that tree** (③b-2; the (runtime,
view) contract ②b deferred). Every walk goes through `walkLeave(runtime)`,
the one caller of `confirmLeave`: only the guards registered under that
runtime handle are asked (`leave-guards.ts` filters by owner, never by page
name, so two trees' same-named pages are told apart and a replaced handle's
guards are not the new one's). When `runtime` is a background member, the
walk brings ITS tree in front (`revealed`; `front = revealed ?? focus`, the one
definition every tree's `held`, the guest Preferences shows and the window's
Back chain read) and reveals each guard's page there, so its dialog is seen
and answerable where its draft lives — without making it CURRENT (D2). A
guard can also say where it lives INSIDE its page (`LeaveGuard.reveal`):
Preferences' guest editors do, so a walk shows the guest on its own section
(the page follows the guest; the guest's section never moves to show a
dialog) and puts the category back afterwards (reviewer P1-2 on 99566068).
Whether the guest takes input is judged by the server in front's Hub, not
CURRENT's. When the walk ends, either way, the page, the front and the focus are as they
were; "keep editing" loses no tree's navigation or draft. On a phone, Back
during the walk asks the tree in front, so it answers that member's dialog
as "keep editing". Removing a member from the server list runs its walk
first; a cancel keeps the server.

## Multi-Server (board #55)

`src/lib/app/servers.ts` is the named-server registry over the same keys this
doc already describes. Design decisions, in the order they bit:

- **The old keys stay the ACTIVE MIRROR.** `tmux_address`/`tmux_token`/
  `tmux_socket` keep meaning "the server we are on" for a downgraded client,
  the connect card's pre-fill and the share link. Since #335 ②b-4 nothing
  that DIALS reads them (reviewer P1-A on cc45d7d1): where a server is, is its
  entry in the registry (`tmux_servers` + `tmux_server_current`).
- **One entry per known machine; an address is unique unless two different known machines used it** (board 318, owner 2026-10-08: "为什么这里有两个一样的地址，但是显示成两个server了"; refined by validator: identity is the machine, and a loopback tunnel address such as `ws://127.0.0.1:9899` honestly reaches different machines over time). `recordServer` used to match the machine id first and never look further, so a machine-less entry with the same address (migrated from the address history, or recorded before the id was known) stayed as a ghost twin forever. Now every record absorbs twins into the resolved entry — an entry with the same machine id, or with the same address and no machine id (or the same one); two entries with different known machine ids both stay, a machine-less entry is attributed to a machine only when exactly one known machine has used its address (with several it is ambiguous and nothing merges), and a connect by address never takes over another known machine's entry — and `migrateServers` runs `repairServers` on every boot to heal old lists once (idempotent; a healthy list is not rewritten). The survivor keeps its id, machine, address and token, takes a twin's name only if its own is a default and the twin's was typed, inherits CURRENT if the twin held it, and the twin's parked keys are removed. Every absorption is also recorded in `tmux_server_merges` (absorbed id → survivor, capped at 32), because anything still holding the absorbed id has to be able to follow it, and the record of the merge is the only evidence that may move it: an id merely missing from the registry was forgotten or never saved, not merged (`mergedInto`, board #335 ②b-2, reviewer P1-a 2026-10-10).
- **Identity is the MACHINE, not the address** (lead review). `tmux_machines`
  (machineId → addresses) is the existing failover authority; an entry
  persists `machineId` and upsert merges on it first, so a reconnect over
  Tailscale updates the LAN entry instead of minting a second "server".
  Migration attributes history addresses through the same map: the current
  machine's alternates never re-materialize as entries, an unseen machine
  yields one entry, unattributed addresses dedupe by address.
- **Switching is in place, no reload** (board 315, owner 2026-10-08;
  the paragraph below describes the REPLACING switch — Single mode, and in
  Aggregate a switch to a server that is not a member; since #335 ③ a focus
  move between connected members is not a switch at all (D2 above: no
  teardown, the trees stay mounted), and the tree of the server left is
  kept, held, when it is a member — see "Several servers at once"): "切换的过程要丝滑一些，不要整个画面又像到登录页面重新登录加载一样"). It was storage writes + `location.reload()` until then, which flashed the disconnected top bar and the connect card. `lib/app/server-switch.ts` is THE switch; every entry (rail/phone switcher, Settings › Connection, Add server, the failed panel's Retry/Back) calls `switchTo`. The shell (rail, tab bar) stays drawn; the trees stay MOUNTED (held, inert) while `switching` is set — a tree is unmounted only when the swap actually replaces its binding (the Single source once the target is bound; never a member's) — and the target's tree is mounted under its own runtime handle on arrival. The ORDER is the contract, each step finished before the next:
  1. **Leave guards** (`lib/app/leave-guards.ts`): every instance that will be destroyed registers its OWN guard (the Files page, the Hub drawer's Files, AgentsPage on the rail or inside Settings). Guards on the page the user is on ask first, without navigating; any other dirty one is revealed on its page and asks in its own dialog; a save/delete in flight finishes first. While the walk runs App HOLDS Settings mounted (`{#if page === 'prefs' || holdPages}`), so revealing Files can never unmount an Agents editor that has not answered (review P1: before the hold, that editor's draft was lost and its guard then skipped as "gone"). The walk always ends on the page it started from. Any "stay" and nothing happened. Since #335 ②b-2-3 each guard names its OWNER, the runtime handle whose subtree holds it (or null outside every subtree — Preferences' Agents editor until b3-3), and a leave names the handle it destroys: only that handle's guards and the owner-less ones are asked. By identity, never by server id, so a new handle for the same server neither answers for the old one's editors nor is asked about them. In Single mode that is every guard, as before.
  2. **One intent**: the CURRENT server's reconnect loop stops, `switching` hides the tree (so no keystroke, send or save reaches it), and every App async begun earlier (boot restore's `listSessions`, `optimizeConnection`) checks `serverSwitch.owns(intent)` before writing. The server being left is NOT stopped: its runtime, its socket and its downloads keep running (order (a), orchestrator 2026-10-11 04:04).
  3. **Nothing is parked** (since #335 ②b-4): the leaving server's state is in its own slots already, written there by its own store. Retry and Back reuse the frozen `from`; a half-switched world writes no slot of anybody's.
  4. **Dial the target as a candidate, without touching CURRENT**: a reload mid-switch boots the server you left. The dial WALKS THE SERVER'S ADDRESSES (board #353, owner: a server with a LAN and a public address, the LAN one dead, could not be reached until "disconnect, re-pick"): the address asked for first, then the entry's own and the machine's other addresses in failover order (`addressesOf`, `server-target.ts`), the ones that just failed last (`dialOrder`, `dial-order.ts`), each with the reconnect machine's class timeout (LAN 2s, Tailscale 3s, WAN 5s; `dialTimeoutMs`). A REACHABILITY failure (timeout, refused, closed during auth: `isReachabilityFailure`) marks the address unreachable in ws.ts's cooldown memory, closes that candidate and tries the next inside the SAME switch; an AUTH refusal stops the walk, because the server answered and another address of it would answer the same. The probe cannot do this job: an address that completes the WebSocket handshake and then never authenticates (a captive LAN, a half-open middlebox) passes it, and that is exactly the address that must not decide for the server. The address that answers is the one step 5 records, so the entry says where the server last proved to be: that is a FACT (the last address that answered), not a preference, and there is no stored "preferred address" (the owner's complaint was being stuck with no way to choose; a walk that falls over plus a one-tap pick on the failed panel answers it with less state, and a sticky LAN-or-public choice would be a new issue). The scope is the Single-mode switch's walk and the failed panel's pick; the reconnect machine keeps its own walk, and the Aggregate picker (a member's include or focus) dials through its runtime's loop and is not changed here. The reconnect machine and the switch share `dialTimeoutMs`, `isReachabilityFailure` and the memory; they do not share the walk (the machine probes in parallel first and round-robins, the switch goes in order), which is deliberate: parallel probing is what a silent address fools.
  5. **Only after auth**, `activateSwitched`: record by the machine id the server REPORTED (a new address of a known machine folds into its entry, a new machine gets a new one; an address never guesses a machine), add the address to that machine's failover set, move CURRENT to the canonical entry. Then `comeUp`: the candidate closes and the target's OWN runtime comes up on the one bring-up road (`activate({ replace: true, elsewhere: 'fail' })`).
  6. **Only once the target is bound** is the server left given up: the swap ends it — its downloads suspended with their parts kept (`releaseServerState`, file-handling.md), then disposed — and `resetServerMemory()` and `centreSurface.reset()` clear what named it.

  A failure at any step leaves the server left INTACT, still running: CURRENT goes back to it (`restoreCurrent`) unless the migration froze CURRENT, and the panel shows. Its runtime, connection, downloads AND its tree survive (since ③a the tree is held, not unmounted, so its editors and drafts are still there); Back comes up on the SAME runtime. The save gate was closed on the reset (`navRestored = null`) when the switch still unmounted the source's pages, or the reset navigation would have been saved over that slot before the restore read it (reviewer 04:05; the App.shell case "a failed switch s Back returns to A on the SAME connection") — the reason is kept, the unmount is history. Every server has its own connection, so a dial for another address of the current server or a reconnect cannot touch the switch's candidate, and an answer that arrives after a switch began lands nowhere (`probeCaps` checks the intent and the bound runtime).

  A failure keeps the panel (Retry · Back to the source · Edit · the server switcher), and, when the server has more than one address, the panel names the last address tried and lists them all (`state.addresses`): each is one tap that dials EXACTLY that address with no fall-over (`retryAt`: the pick is an argument of that one operation and is never stored, the failed state keeps what was ASKED for), and a success makes it the entry's address. Retry runs the whole walk again from what was asked for, also after a failed pick (reviewer P1 on #353: the pick had leaked into Retry and a recovered address was never walked to). Reproduced and measured on #353: a primary that answers the handshake and stays silent was dialled once, 5s, then the panel; Retry dialled the same address again. Now the alternate answers after the first address's 5s timeout, in the same switch; in FAILED only the server control and the panel work, the page buttons stay disabled. A second address of the SAME machine is not a switch: failover keeps its path and nothing resets. The disconnected connect page reaching a different server comes up the same way (`onConnected(true)`).

  | state | where it lives | on a switch |
  |---|---|---|
  | theme, fonts, zoom, locale, layout, shortcuts, rail order, widths, notifications, `tmux_servers`, `tmux_server_merges`, `tmux_machines` (keyed by machine id) | localStorage | global, untouched |
  | `tmux_state` (tab, terminal target, split), `tmux_machine_id`, `tmux_hub_project` / `_drafts` / `_seen` / `_lead` / `_drawer` / `_roster_expanded` / `tmux_hub_alerts` (per-project maps keyed by tmux session NAME: `app` on A is not `app` on B) | localStorage, `RESIDENT_KEYS`, at `<key>::<id>` (since #335 ②b-4) | untouched: each server reads its own slot |
  | every mounted component, its ws.ts listeners and subscriptions | memory | unmounted with the tree |
  | Files' parked cwds (`browsed`), download rows, served backends, the hover card, App's hub probe / serverInfo / terminal and Files targets | module/App memory | `resetServerMemory()` |
  | download parts on disk | the shell | kept; `partId` hashes the machine id, Resumable lists only this server's |

  What the tests cover, and what they do not:
  - `server-switch.test.ts` runs the real switch module, the real storage half (`servers.ts`), the real leave walk and the real `download()` against a fake transport that answers as machine A or B. Around it is a hand-written app double, not App: it proves the ORDER and the storage rules — nothing of A is given up before B is up, and a B whose own bring-up fails puts CURRENT back on A — plus `connectAddress` ownership and the one-question-at-a-time walk (`idle()`). Each has a negative control.
  - `App.shell.mount.test.ts` mounts App on a connection registry that gives every runtime an INDEPENDENT fake connection with a real dispose (reviewer P2-2 on cc45d7d1): each dial (`dial@<key>:<url>|<token>`), RPC (`rpc@<key>:<name>`) and dispose names the connection it happened on. The ruling's regressions run there: a reconnect answering as B while A's dialog is open, a captured A call refused; an unrecordable peer closed; a failed form connect that wrote the mirror never handing A its address or token; a boot or a failover that absorbs an alias bringing canonical up on its own connection; a reused provisional runtime surviving its stale minter; Cancel during the second handshake binding nothing; and the App's own end disposing every connection.
  - `leave-host.mount.test.ts` mounts the REAL Files and AgentsPage in App's page structure (`LeaveHost.test.svelte`: Files in a hidden layer, Agents under the held `prefs` condition) and drives the real walk: a cancel at either editor loses nothing, Settings stays mounted while Files asks, a save in flight is waited for. The fixture mirrors App's condition; `App.source.test.ts` pins App's own expression.
  - `Files.mount.test.ts` drives Files' real discard dialog through the walk.
  - App end to end is covered since #335 by `App.shell.mount.test.ts` (the App harness with a fake connection per server); at the time of board 315 there was none, and the browser check in `temp/check/c315.mjs` (fake ws as two machines) was the evidence for the shell, the panel and no reload.
  - `server-memory.source.test.ts` keeps the `resetServerMemory` list honest against every module-level store under `src/lib`; it is maintenance, not a proof.
- **Single click switches; a pencil renames** (2026-09-12, #165, lead decision
  01:32). The old 260ms click hold guessed whether another click would arrive
  and delayed the requested switch, repeating the roster defect retired in
  #168. The chooser now closes and invokes the same switch primitive at once;
  choosing the current entry closes without reconnecting. Each row has an
  explicitly named pencil command, disabled while that row is already being
  edited. Rename still uses the existing name input and registry operation.
  The timer, delayed-click functions and double-click handler are removed
  whole. No alternate switch path, storage format or reconnect behavior is
  introduced.
- **A row's name defaults to the hostname the server reports** (board #310,
  owner 2026-10-05: "显示的名称应该默认是主机的名称，不是连接的url"). Every auth
  answers `{authenticated, machine_id, hostname, build}` (`build`: board #368, the server's
  version, commit and build minute, read into `connection.getBuild()` and asked of the LIVE
  socket each time, never stored on the entry like the hostname: `undefined` while nothing
  answers, `null` for a server that named none, and App clears its copy the moment the
  socket drops (`onDrop`), so About says `Reconnecting...` instead of the old build), and one App effect hands that
  hostname to `servers.ts adoptHostname` for this machine's entry. A URL host
  (`hostLabel(address)`, e.g. `d1x.cloudfront.net` or `192.168.11.221`) is only
  the pre-auth placeholder. A name the user typed is never overwritten:
  `renameServer` sets `named`. The adopted value is kept as `hostname` on the
  entry, so it survives an address change (failover to the LAN address) and
  follows a renamed host, while an entry renamed by hand before #310 (no flag,
  a name that is neither its URL host nor an adopted hostname) keeps its name.
  No one-time migration: an old entry whose name is still its URL host adopts
  the hostname at its next connect. The address stays on the row's second line
  (`.sm-addr`), so two machines named alike remain distinguishable. Pinned by
  `servers.test.ts`.
- **The server chooser is a non-modal picker dialog** (2026-09-12, #165).
  It contains selection, rename and removal controls, so it follows the
  PanePicker family and native Tab order, not action-menu arrow navigation.
  Rail and Settings openers name the same dialog through haspopup/controls.
  It shares popup chrome but keeps two-line identity rows and sibling
  commands; the row budget remains stable while a name becomes an input.
  Measurements include borders, width is intrinsic before clamping, and
  the panel scrolls inside the zoom-corrected viewport inset.
  Outside pointer and opener-ancestor scroll close it; its own scroll and
  background terminal output stay open. Resize closes
  an ordinary picker, but an active rename remeasures the existing anchor
  instead: a soft keyboard must not destroy the input it just opened.
  Escape ownership is modal, then rename, then picker. Cancelling rename
  clears the draft state before focus restoration can fire blur; Enter and
  blur never commit during composition. An outside dismissal during composition
  records the current editor/menu identity and waits for the final native
  input before committing and closing, never deleting the unfinished draft.
  The same composition token gates blur and repeated close through the ending
  update; only afterward is the final native input value read and the captured
  commit/close intent completed. A replaced input or cancelled edit is ignored.
  Normal blur/outside dismissal keeps the existing rename commit behavior.
  Focus returns to the pencil or opener
  only if that origin is still connected and another control/modal has not
  taken ownership; a removed row falls back to the surviving picker after
  the existing confirmation. Application navigation shortcuts leave keys
  to focused menus/dialogs. No global Back/popstate mechanism is introduced.
  Chromium 152.0.7977.64 verifies 42 real-App picker checks on desktop and
  coarse input, including native CDP composition and adversarial ending/blur
  ordering, both openers, confirmation focus, resizing and ancestor scrolling.
  This is a controlled connection fixture, not OS-IME or APK acceptance;
  the Tauri-only navigation shortcut path is source-guarded in this run.
- **An address switch shows on the row that was tapped** (review, 2026-09-03):
  App keeps `pendingAddress` from the moment `onAddress` dials until the
  connect settles either way (`.finally`, guarded so a second tap's pending
  is not cleared by the first's outcome), and Preferences' address list gives
  every row a dot in the ONE status language — `--status-sleep` at rest, accent
  on the current address, accent + app.css `.live-dot` on the one still dialing
  (`aria-busy`, title "Connecting…"). Before, the old row stayed lit while the
  socket was rebuilt and nothing said the tap had landed. A failed direct
  connect hands over to the reconnect machine, whose bar carries on from there.
- **The failover set is editable: removable rows, drag priority** (board #222,
  owner 2026-09-20: "可以手动删除某个链接，并且可以设定连接的优先级上下拖动
  排序"). The list's stored order IS the priority — the reconnect round-robin
  walks it and `findBestAddress`'s stable class sort keeps it within a class —
  so a drag needs no new concept, only a write. A row's × removes one
  alternate; the ACTIVE address is never removable (it is the live connection,
  and deleting it would only hide the primary while it stays primary). The
  drag speaks the rail's reorder idiom through the generic `moveBefore` /
  `listDropAt` in nav-order.ts (one mechanism, not a second reorder dialect),
  but the GRIP, not the row, is the handle: the row is already the switch
  command, and on touch a whole-row vertical drag would fight the page's
  scroll — the grip opts out with `touch-action: none`, and Arrow keys on the
  focused grip are the keyboard form of the same move. Both edits hand the new
  list to App's `onAddressesChange`, which persists through
  `servers.ts` `saveMachineAddresses` — the map's ONE writer, sanitized at the
  door — and bumps a version so the derived list re-reads (localStorage is not
  reactive).
- **The rail entry is a control, not a page**: it rides the RAIL_GAP branch
  (above the configure group — "右下角agent上边"), carries no rail slot, and
  its popover follows the app's one menu recipe (fixed layer, measured then
  shown, outside-pointerdown/Escape/resize dismissal). The Settings connect
  form IS the add flow; the `+` row only navigates there.
- **The phone's entry is a row at the top of Settings** (review, 2026-09-03):
  the rail does not exist on the touch layout, so the registry had no door
  there at all — named servers were invisible on the device the app is for.
  App passes `onServers` (= `toggleServerMenu`) and `serverName` to
  Preferences only when `connected && layout.isTouchDevice`; Preferences
  renders a `.side-row` (swap icon + the server's NAME, never the raw
  address) above the category list that opens the SAME popover, anchored to
  the row.
- **The current server has ONE name outside the list: its row's** (board
  #319, owner 2026-10-08: "设置显示当前连接的名字，不是列表里的那个名字，不一致").
  The row, the rail hover card's title and the switch panel's "Back to"
  read `serverName = servers.ts currentServerName(...)`: the saved entry's
  name (this machine's entry, else the current one), then the hostname, then
  `hostLabel(address)`. Before #310 the entry name could be a stale URL host,
  so these surfaces used the authenticated hostname; since #310 the name IS
  the hostname unless the user renamed it, and a hostname-first title made a
  renamed server read as two servers. The hover card adds a Hostname line
  when it differs from the name; Settings › Connection keeps the hostname as
  its fact row.
  The popover's outside-dismissal spares whichever control opened it
  (`serverMenuTrigger`), not a class name, so both doors toggle cleanly. The
  registry is read at boot and on open/rename, so the name follows a rename.

## Alternatives Considered
- **Socket.IO**: Rejected — adds dependency, WebSocket is sufficient for JSON-RPC
- **No auto-reconnect**: Rejected — mobile connections drop frequently
- **Application-layer ping (JSON-RPC `ping` method)**: used until the
  sent-by-server WS PING migration. Problem was that the ping *response*
  shared the send mutex with every other outbound frame, so a 50 MB
  fs_download could block the pong response behind tens of seconds of
  data even on a healthy link. We iterated twice on patches
  (`heavyRpcInFlight` counter, then `lastRxAt`) before realizing the
  real fix was to move liveness out of the application layer entirely.

## Trade-offs
- Custom reconnect logic to maintain
- Pending promise rejection can cause UI flicker if not handled in components
- Server-initiated keepalive means the server is slightly more complex;
  the ping_task must coexist with the send_task + receiver loop and
  share the same `out_tx` to avoid fighting for `ws_sender` (see
  `concurrent-ws-rpc.md` for the full task layout).

## Lessons Learned
- Always reject pending promises on disconnect — otherwise callers hang forever
- Manual disconnect MUST cancel reconnect timers — otherwise zombie reconnects fire
- Wrap `JSON.parse` in try-catch — malformed messages crash the handler
- Use optional chaining on server push params — malformed messages can have missing params
- Application-layer heartbeats look clean until they start fighting with
  real application traffic on a shared transport. The first iteration
  wrapped specific heavy RPCs; the second monitored last-received-at;
  both worked *most* of the time but both were working against the
  WS layer instead of with it. WS PING/PONG is the first-principles
  answer: it's exactly what the protocol designers gave us for this,
  and it runs at a layer that is unaffected by our JSON-RPC queueing.
- EVERY path that produces a fresh server connection must call
  `resubscribeActive()` (and dispatch `ws-reconnected`): the server's
  subscription table is per-connection state, but the client's
  `subRefcount` survives the disconnect because Terminals stay mounted
  in hidden page-layers. A refcount that is already > 0 means later
  `subscribe()` calls never re-send the wire message — the terminal
  freezes on its last snapshot while `send_keys` (a plain RPC) keeps
  working, which users report as "typing is invisible but sending
  works". The reconnect machine, address switch, and optimizer paths
  all had it; the manual connect from Settings (`onConnected`) was the
  one that didn't — found only because each path wires its own
  post-connect sequence by hand. Symptom → suspect list: frozen display
  + working input = wire-subscription/refcount divergence first.
- Client-side polling RPCs such as Terminal's `list_panes` are still plain
  `call()`s and can
  independently trigger the "3 consecutive timeouts" disconnect rule.
  On WAN a 50 MB download response monopolizes the send mutex long
  enough that 3 pollers time out before the download frame finishes —
  users saw the transfer abort "disconnected" halfway through. Fix:
  gate that disconnect on `pending.size === 0` so pollers failing
  behind a long RPC don't kill the connection. When nothing is pending
  and the link still silently fails, the disconnect still fires.

## Rules and their reasons

Each entry is a decision with the reason it was made; treat them as normative. They lived in the root `CLAUDE.md` until 2026-09-02 (board #73), when that file became an index and the rules moved next to the design they belong to.

### WebSocket lifecycle

`connect()` cleans up existing. `onclose` rejects pending. `doDisconnect()` clears timers. Heartbeat ping every 15s; 2 consecutive RPC timeouts → auto-close → reconnect.

### One connection is one object; `ws.ts` holds none (#335 ①, ②b-4)

The transport's mutable state belongs to the object `createConnection()`
returns, never to a module: socket, pending map, request counter, pane/team
listeners, subscription refcounts, recovery flags, liveness timers and the
RPC-timeout counter. Add per-connection state to `connection.ts` inside the
factory, never at file scope. `createWsApi(connection)` declares every RPC
once and binds it by closure, so a call cannot resolve onto a different
connection; `createConnectionRegistry()` owns object lifetime and nothing else
(it must not dial, read storage, parse a URL, compare machine ids or hold a
"current"). `connection.ts` must not import `localStorage`, a Svelte store,
anything under `src/lib/app`, or `window` — identity, persistence, reconnect
policy and device reachability are the app layer's, and
`connection.source.test.ts` fails the build if that leaks back.
`disconnect()` KEEPS listeners and refcounts (a connection outlives its
socket; the Terminals are still mounted) and only `dispose()` releases them —
confusing the two silently freezes panes after a reconnect. `dispose()` is
TERMINAL: it settles any dial still in flight (promise and connect timeout,
not just the socket) and a disposed handle's `connect`/`call` reject with
`connection disposed` while registration on it is dropped, because an old
handle that can dial again produces a live connection the registry does not
know about. Every mutating entry point therefore carries a `disposed` guard,
pinned by `connection.source.test.ts`. `ws.ts` held one memory-only slot
through ②b-3; since ②b-4 it holds NO connection — only the factories, the
types and the device's reachability cache — and every connection belongs to a
runtime the fleet keyed by its entry id. Adding a connection or an RPC export
back to it re-creates the implicit "current server" (pinned by
`connection.source.test.ts` and `server-context.source.test.ts`).

### Every referenced object names its server (#335 ②)

A reference to a session, pane, room, issue or project carries its `ServerId`
(`ServerEntry.id`) alongside the name — `src/lib/app/refs.ts` is the only
vocabulary for it, and `refKey(ref)` the only composite key. Three rules, each
of which has a failing test behind it: a ref carries identity and never a copy
of the object's fields (a copy is a second definition that goes stale on
rename); a serverId never appears in a `session`, `target` or `room` string
sent to a server, which `refs.source.test.ts` pins by keeping `refs.ts` free of
every import but `nav-state.retarget`; and `retargetRef` takes the rename's
serverId with its `from`/`to`, so applying server A's rename to server B's
same-named session is unwritable rather than merely untested. A `RoomRef` and a
`ProjectRef` never follow a rename at all.

### A runtime is an entry plus its transport; the server that answers decides (#335 ②)

`createServerRuntime(entry, { storage, slot })` binds one `ServerEntry` to one
connection, and its `id` is `ServerEntry.id` — immutable for the object's
lifetime, because every phase-② view and store slot keys off it. `dial()`
authenticates and then asks `recordServer` whose machine answered: if the
canonical entry is not this runtime's, it closes the socket and reports that
entry instead of publishing under this id, so an address that has come to
reach another machine cannot route that machine's panes into this entry's
views. A dial RECORDS and never ACTIVATES — CURRENT and the live mirror keys
belong to the switch path, or a background server could take the screen. The
fleet matches by entry id and machine id only, and MEMBERSHIP FOLLOWS THE
ENTRY SET: it reconciles against `servers.ts` after every `recordServer`,
because that call absorbs the survivor's twins and so can delete entries
belonging to other runtimes — including ones that have not dialled yet or are
still authenticating, which have no occasion to notice. A released runtime is
terminal, never merely disconnected, and `include` declines an id the saved
registry does not list. Each dial carries an ATTEMPT identity captured before
its first await: a superseded continuation records nothing, adopts nothing,
reports nothing and above all disconnects nothing, since the socket it dialled
has already been replaced by the one that superseded it. An entry removed
mid-dial is not resurrected. `server-fleet.source.test.ts` fails if `address`,
the ws.ts facade or `localStorage` appears in either module. Capabilities are the asked
server's answer and `null` means "not answered yet" — a timeout must not flip
`hub` off, because false unmounts the always-mounted Hub and destroys the state
it exists to preserve.

### A server's state is resident in its own slot (#335 ②)

A per-server key lives at `<key>::<serverId>` and nowhere else;
`residentKey()` (in `servers.ts`) is the only function that spells that
layout, over its `RESIDENT_KEYS` — one list, so a key cannot be scoped in one
place and forgotten in another. `createServerStore(storage, serverId)` is a `Storage` view, never a
second copy of the per-project semantics — those stay in `hub-prefs` and
`notify-centre`, whose storage is this view since ②b-4. Only one server's
STATE is scoped: the person's and the window's preferences (theme, fonts,
zoom, language, shortcuts, notification switches, feed level, sidebar) pass
through, and so do the registry keys and the active mirror, whose home is the
`ServerEntry`; where to reach a server is read from the entry by id
(`server-target.ts`). An empty serverId throws
rather than falling back to the unprefixed keys. `migrateServerState` records
its completion in ONE marker write carrying the layout and the server the
inputs went to: inferring it from values stops being idempotent the moment the
slot is the live home, and two markers leave a window in which one server skips
while the next folds the same inputs. The fold files the whole live set, so an absent live
key CLEARS the slot — a cleared draft must not come back out of the old park —
and a CURRENT that is empty or names no saved server writes nothing at all. A
marker write that fails is reported as `unrecorded`, not as a completed fold,
and then the server pages are held (inert, writes held; ③a). It was enabled in the SAME commit that moved
every live read and write (②b-4, above).

### A subtree is bound to one server, and the binding is ordered (#335 ②b)

The server-bound tree is keyed on the runtime HANDLE: a reconnect keeps the
handle, so the always-mounted pages keep their state, and a different server is
a different handle, so nothing of the old one survives into the new tree. The
provider renders NOTHING without a runtime — a server-bound page with no
server is a page on the facade — so the person-level Connection surface lives
outside the subtree. `{#key}` gives the swap and not its ORDER, since Svelte
creates the new branch before destroying the old, so `app/server-scope.ts`
sequences it: unbind, settle (where the teardown runs), release the handle and
the landings aimed at the old tree, then bind. A first bind is immediate; a
superseded swap shows nothing, and every handle it touched — the one it
unbound and its own replaced target — is still released by whoever finishes.
A caller asks what the swap is HEADING for, not what is shown, or one success
path mints a handle nobody shows or releases. The bound server is READ from
CURRENT, never passed, so identity repair re-pointing CURRENT at a machine's
survivor moves the app with it; a handle is replaced when the server changes,
and a handle that is ending, or has ended, is never reused for the same id.

Through ②b-3 production held one runtime borrowed on the facade's
compatibility slot, with a suspend/handover protocol for the connect form;
both were retired in ②b-4 (next). The api gate is asked at CALL time, so a
captured method and a call that awaits partway are both refused after a
detach. A peer whose identity could not be recorded is an error, and a
superseded attempt writes no registry and brings nothing up. Clearing landings
after the DOM is gone is a second line, never the first.

### Every runtime owns its connection; a connect dials a candidate first (#335 ②b-4)

Orchestrator's ruling 2026-10-11 01:43, with the reviewer's addendum at
01:46. Once every page was bound to its scope, nothing needed the shared
socket, so each runtime gets a connection of its own from the FLEET, and a
switch includes the next server and drops the one it left. Nothing re-points
a socket that a server's pages are using.

- **A connect dials a CANDIDATE.** The connect form and a switch first dial a
  bare connection App owns (`openCandidate`). It records which machine
  answered, then closes, and only then does the server's own runtime dial.
  Handing the authenticated socket to the runtime (adopt) was rejected: it
  would add a second way for a connection to change owner. The cost is one
  extra handshake per connect.
- **The runtime's own handshake is the identity of record.** What the
  candidate found proves nothing about the second dial, because an address
  can change hands between two handshakes. If that dial reaches another
  machine, the app arrives there (`arrivedElsewhere`), as a boot dial does.
- **Nothing mounts on a runtime before it has dialled**, and nothing of the
  server left is given up before the next one is bound (order (a),
  orchestrator 2026-10-11 04:04). The swap then ends the one left — after
  its replacement had the chance to adopt its state (a same-machine merge
  keeps its Files record and downloads). A bring-up that fails returns to
  the server left, untouched.
- **One activation generation.** The candidate, a boot dial, a reconnect
  attempt, an address change and a switch each claim the host's owner
  counter, so a late result from an activation that has been superseded is
  a no-op. A cancelled or superseded activation lets go of the runtime it
  minted — only if it still owns it (reviewer P1-C on cc45d7d1).
- **The connect form is busy for its OWN attempt** (reviewer P1-D). Its busy
  state and error belong to the attempt (`mine`), apart from whether the app
  still waits on it (`live`); it waits through the server's second handshake
  and shows its failure, and Cancel — or leaving the form — cancels that
  handshake too.
- **A runtime ends one way: detach, release, dispose.** A runtime that loses
  its identity mid-dial (its entry removed, or absorbed) DETACHES. Its api
  refuses at once, including methods captured earlier, and it never disposes
  itself, which would skip the release of that server's state. The fleet's
  `drop` and `reconcile` hand a runtime to the host's end. The one runtime
  still bound is the exception: the swap that replaces it ends it, after its
  replacement has had the chance to adopt its state — but its IDENTITY ends
  at the fleet's boundary like any other's when its entry is absorbed
  (`focusAbsorbed`; reviewer P1-A on e0dafe3c, P1-B on 4c7cd64c, P1-1/2/3
  on 9c1f757c): detach, close, stop the loop is the unconditional first step
  — no `alive()` inference — and the fleet callback does nothing else but
  register the owed handover. The handover settles on the window's own turn,
  through the storage gate, never inside a dial's reconcile; void if another
  tree was bound or a legitimate operation moved CURRENT off the survivor;
  by the one activation road when no connected member can take it; consumed
  once. After the root's `ended`, nothing owed is done.
- **An owed question is asked on the window's own turn, when it is free.**
  The identity layer registers an orphan's ask (`orphaned` → queue +
  `scheduleAsk`) and never claims the window from inside a dial's reconcile
  (reviewer P1-B on e0dafe3c): the drain runs on a zero timer and only when
  `windowBusy()` is false — ONE definition: no switch, no walk, no address
  connect (`serverSwitch.busy`), no activation or form candidate out
  (`windowLeases`), no membership change — and is scheduled when any of those
  ends (`onidle`, a lease's release, a membership op's `finally`, Retry), so
  the caller whose end freed the window has committed before the queue is
  looked at (P2 on e0dafe3c). `switching` is not that definition.
- **A reconnect names its server.** `ws-reconnected` carries `serverId`, and a
  page acts only on its own server's. Each runtime has its own reconnect
  loop, told where by its own entry (reviewer P1-A on cc45d7d1).
- **Nothing outlives the shell.** App's own teardown closes the candidates,
  ends every activation in flight, cancels every runtime's reconnect loop
  with its timers cleared at once (a stale claim alone would end a loop only
  at its next timer; reviewer P2 on 341554b3), and ends every runtime in the
  fleet, the bound one included (reviewer P2-1).

### A union is a projection with one action flow and honest states (#335 ③c-2/③c-3; reviewer P1-C1/P1-C4)

The Hub and Terminal sidebars' other-server rows are projections of what each
tree PUBLISHED, merged by the one rule; nothing is polled for them. A row's
verb is the same verb its own tree offers, through the same confirmation,
with the source api and the row's own id frozen at the ask — never a second
menu that calls an api directly, never `projectDelete` from a row. A slice
says whether it has ANSWERED and whether its latest refresh FAILED: not
answered is missing, failed keeps the last good list and names the server
unavailable; an empty list is only ever an answered one. A foreign section
never waits on the local list's first answer. A hidden member keeps its
published lists current on the existing 20 s list cadence and does no room
work, on a tick or on a push; the work stops with the tree. A row is drawn
with its own server's facts (catalog, clock). Forbidden: an unconfirmed
cross-server mutation, a verb by session where the api takes an id, a
not-yet-answered slice shown as empty, a union poller, room work on a hidden
member.

### Every page that is one server's offers the ONE server door (#358, 2026-10-13)

Owner: "在 File 页面，其实也可以让我有一个地方，能很快速、方便地切换不同的 server
连接." Files is the focused server's tree (D3) and had no switcher, so on the
phone switching meant leaving the page. The door is App's one server popover
(`toggleServerMenu`, the rail's and Settings'), handed to the page as a
toggle plus the open state and the popover's id; the page renders a row —
swap glyph that quarter-turns while open, the server's tag — and owns no
registry, no list, no focus logic. Shown by the ③c-1 tag rule (more than one
server included), on both screens. A pick is the ordinary focus move (D2);
each server's Files keeps its own parked cwd (a ServerState per server), so
A in /dir-a, B in /dir-b, back to A is still /dir-a.

The door is the PAGE's, one instance, above every view (orchestrator
2026-10-13 23:17): "on the phone a preview/edit/info view IS the Files page
the person is looking at, and switching servers from there is the very case
(browsing a file on A, want B) — leaving to the list first is the friction the
issue exists to remove." It is the first child of `.files`, before the
split/single-pane chain; reading mode (a layer over the preview, #226) hides
it with the preview header. A page-local server list, a door shown by mode
rather than by the tag rule, a door inside one view's panel, or a door that
merges trees are forbidden.

### The "current server" actions act on the focus, named, frozen at the click (#335 ③c-5)

The system status strip, the scratch terminal, the Agents page (registry,
skills, MCP, teams, the global prompt) and the Connection section (copy-link,
addresses, optimizer) are each ONE server's. In Aggregate they are the
FOCUSED server's: the scratch panel and the Agents page live inside their
server's tree, so their owner is fixed by construction; the strip and the
Connection section take the focus's id and act on the runtime they resolved
when the action started, not on whatever the focus is when it completes. In
Aggregate each of these heads names its owner with the one tag
(`ui/ServerTag`, ③c-1 rule) — the status strip excepted: its name is the
Aggregate focus's always (orchestrator 02:28), and its owner is the HANDLE
(P1-C2); Single names none. The server switcher's row hover carries only what
the row hides (motion.md §1.16): machine id, the connecting/reconnecting
word, Excluded. A summed reading, an old owner's late reading under a new
name, a copy-link that reads CURRENT after an await, a native `title` beside
the card, and a hover that repeats the row are forbidden. The strip's own
contract is in system-status.md.

### Connection-link copy feedback belongs to its attempt (#167, 2026-09-12)

Both share commands previously ignored `copyText(false)` and displayed success;
their independent timers could also clear a later copy. App and the connect
form now use `createFeedbackLifetime` and its one completion scheduler. Only a
successful copy shows the brief copied state. A connect-form failure remains
visible as an inline `config-error` alert beside the share command until retry
or input change, without nesting another feedback frame inside the connect
card. App rejects the current failed attempt into Preferences' existing
command-error channel. Neither path logs the link or creates a global notice.

The link and context are captured before awaiting the clipboard. A newer
attempt, changed inputs/page/server or unmount invalidates the old outcome;
disposal also cancels expiry. App's descriptor is a serialized primitive of
page, connection state, active address, server ID and machine ID: replacing
`serverInfo` during same-machine polling must not clear feedback or invalidate
a pending copy. App additionally rechecks its non-reactive stored address,
token and socket. URLSearchParams construction and token-bearing
deep-link semantics are unchanged. Settings mount tests use fake credentials
and controlled clipboard results/timers; App wiring is source-pinned and
Preferences' existing error/retry channel is exercised by its mount test,
not claimed as a full-App or native-clipboard test.

### Servers are a named registry; the machine is the identity

(board #55): `src/lib/app/servers.ts` keeps `tmux_servers` (+`tmux_server_current`) while the old `tmux_address`/`tmux_token`/`tmux_socket` stay the ACTIVE MIRROR every existing reader keeps reading. One machine = one entry however many LAN/Tailscale/WAN addresses it answers on — `recordServer` merges by `machineId` (learned at connect) without moving CURRENT, migration attributes the retired `tmux_address_history` through `tmux_machines` and removes the key (#400, below), and the same-machine failover semantics are untouched. A different-machine successful connect goes through `activateConnected` (or, for the in-place switch, `activateSwitched` after auth — board 315): CURRENT moves to it; a same-machine alternate records in place. Switching is in place since board 315 (`server-switch.ts`, the order and the state-ownership table are in the Multi-Server section above): the per-server keys (`RESIDENT_KEYS`) live in each server's own slot, `<key>::<id>`, since #335 ②b-4 (until then they were parked and restored there), so restore targets and Hub drafts never cross servers, the content tree remounts and `resetServerMemory` clears the module caches, so nothing in memory leaks across. The desktop rail's switcher rides the RAIL_GAP branch above the configure group — a control (no drag slot), popover in the one menu recipe; Add server is a dialog over the connected shell (cancel changes nothing) and activates only after authentication. Forgetting a non-current server captures its row identity and asks through the shared `ConfirmDialog` before removing config + that server's slots.

### The registry is the only list of remembered connections (#400, 2026-10-16)

Owner, #399: "设置里记录的连接，和我登录页面缓存的所有登录 url 密码之类的不同步，我这里都删掉了，登录界面还记得很多 url". Two stores held one fact. Settings › Connection edits the registry (`tmux_servers`, plus the machine's failover set in `tmux_machines`); the connect form's list was `tmux_address_history`, written by `Settings.saveHistory` BEFORE the dial (so a failed attempt was kept as well), by the deep-link consumer, and forgotten by the form's own ×. Nothing a person deleted in Settings could reach it. A history row was always a shadow of a registry entry (every connect that wrote one also called `activateConnected`) or an attempt that never connected, which is why the fix is to delete the list, not to sync it.

- **The form's suggestions are the registry** (`rememberedAddresses`, servers.ts): CURRENT's server first, then the registry's order; each server's active address, then its machine's failover set in priority order; every row carries that server's token; an address two machines share is offered once. They are read when the form mounts and again each time the list opens, so a form held while another page deletes never offers the deleted server. The most-recently-used order and the cap of eight are gone with the list; the registry holds at most 16 servers.
- **The history key is retired, not kept in step.** `migrateServers` folds it into a NEW registry as before (the first-run path), then removes the key once the registry is on disk; on a client that already has a registry it removes the key unread, because a row the registry does not hold is a server the person deleted here or an attempt that never connected. The removal is best effort: a key that will not go is read by nothing and must not freeze the registry, and the next boot tries again. `Settings`, `AddServerDialog`, the deep-link consumer and `ConnectFields` no longer touch it.
- **A suggestion row has no ×.** Forgetting a server has ONE door, Settings › Connection, which asks through `ConfirmDialog`, walks the server's tree's guards and removes its slots (`App.serverRemove`). A second door from the form would have to repeat those guards; a bare `removeServer` from a form was the shape the lead rejected in the original server-switcher review (App.source.test.ts, "the × called removeServer directly"). Settings › Connection opens from the gear while disconnected too (the #400 test deletes a server from there with the login page up). **Limit, unchanged:** the CURRENT server is not removable anywhere (its row shows a check, `removeServer` refuses it, and #400 adds no disconnected-current removal), so "the × is gone" does not mean every stored connection can be forgotten in Settings: to forget the current server, connect to another one first.
- **The pre-fill is a registry tuple, and the mirror keys are a projection of the registry** (orchestrator's ruling on the #400 review, 2026-10-16). The form opens on `currentConnection`: CURRENT's saved address, token and socket, or its defaults when there is none. It reads nothing from `tmux_address`/`tmux_token`/`tmux_socket`, so a draft lives only while the form is open and is never remembered across a reload. Those three keys remain the connection the older readers expect, and `reconcileMirror` keeps them only while the WHOLE tuple is one the registry holds: an entry's active address or one of its failover addresses together with that entry's token and socket. Anything else is cleared, and an address is never matched alone, because an address is reachability, not credential ownership (two machines can sit behind one tunnel URL and have different tokens and sockets). It runs at every boot in `migrateServers` (so a server deleted on an OLDER build, whose address, token and socket were left in the mirror, is gone after the upgrade boot), and in the writers that can drop a tuple: `removeServer` and `saveMachineAddresses` (an address dropped from a failover set). The connect form still writes the keys before it dials, so an unfinished attempt leaves a tuple nobody holds; the next removal or boot clears it.
- **A pick applies the whole tuple, and so does the copy command** (review round 3). A suggestion row carries the server's address, token AND socket (`Suggestion`), and a pick sets all three fields: a server with no saved socket clears the previous one, so server A's socket is never set on server B (`setSocket` runs on the picked server, and `activateConnected` records its own tuple). The one exception stays, pinned since #323: picking the local gateway whose socket the desktop autofill put in and the person has not touched keeps that socket when the saved entry has none (`Settings.pickHistory` returns it to `ConnectFields`). The Add server dialog gets the same behaviour from the same component. The connected Connection page's copy command (`App.shareConnectionLink`) reads the focused server's tuple from the registry (`currentConnection`), captures it and CURRENT's id, and rechecks both after the clipboard completes, under the same feedback lifetime; it no longer reads the mirror keys, which `reconcileMirror` may have cleared while that server is connected. The link FORMAT is unchanged here (#401 changes it).
- **Known limits.** The failover sets of servers deleted before this change stay in `tmux_machines` (nothing offers them; `removeServer` does not prune a deleted machine's set, so re-adding that machine brings its alternates back). A token-only deep link (no address) used to set the pre-fill token through the mirror; the pre-fill no longer reads it. The most-recently-used order and the cap of eight went with the history.
- **Pinned by** (the pick and copy tests are the review-round-3 additions: Settings.connect.mount.test.ts with distinct A and B sockets and a B with none, AddServerDialog.mount.test.ts, App.source.test.ts, and the copy step inside the App.shell.mount.test.ts upgrade fixture) servers.test.ts (`rememberedAddresses` order, dedupe and registry-only; deletion of a server or an address; the three migration shapes and the failing-write case; `reconcileMirror` over the full tuple, both removal paths, the shared-URL A-token and B-token cases with distinct sockets, the failover-address drop and the upgrade boot), Settings.autofill.mount.test.ts (the list is the registry, re-read on open, one row opens, the form opens on CURRENT's tuple and not on a mirror, no forget button), remembered.source.test.ts (only servers.ts names the retired key) and App.shell.mount.test.ts (#400: a dead saved server tried and deleted, and the upgrade fixture with beta left in the mirror and the history — both through a reload).

### The connection link is the connection, not a page (#401, 2026-10-16)

Owner, #399: "connection 页面不是有一个 copy 链接吗，但是链接里好像还包含了前端的地址，其他应用里应该能直接粘贴这个链接，忽略前端链接". The copied link was `<front end origin>/<path>?addr=<gateway>&token=…&socket=…`, spelled twice (the login page's `Settings.buildShareUrl` and App's `shareConnectionLink`) and read once (App's `takeConnectLink`), so it only worked by opening that page. Now one module, `src/lib/core/connection-link.ts`, builds and parses it, and nothing else spells either form.

**The format (normative):** the gateway address a person would type, with the credentials as query parameters.

```
<ws|wss>://host[:port][/path]?token=<token>&socket=<tmux socket>
```

A BUILT link always carries BOTH parameters, empty when there is nothing for them (`ws://h:9899?token=&socket=`), percent-encoded (`URLSearchParams`). That is what makes a built link recognisable as a link even when it has no credentials, and an empty value means "none": it clears the field it is pasted over, instead of leaving the previous server's token or socket in place (review of #401, P1-B). The scheme is lower case and a lone `/` after the host is dropped (`ws://h:9899/` and `ws://h:9899` are the same gateway, and the registry holds the second). The endpoint's own query (`wss://h/ws?region=eu`) survives byte for byte, empty segments (`?a=1&&b=2&`) and a lone `?` included. What an endpoint cannot hold is a `token` or `socket` key, which would be indistinguishable from the credentials: the builder returns nothing for it (the Share and Copy commands say "This address cannot be shared as a link" and copy nothing) and the parser calls a repeated key unusable (P2-C). A client never dials the link itself: it splits it first.

**What `parseConnectionLink` returns:** `none` (not a link: keep the text as typed), `link` (`{ address, token, socket }`, with `null` for a parameter the link does not have and `''` for one that is present and empty; parsed by PRESENCE, not truthiness), or `unusable` (`no-address`, `ambiguous` for a repeated key, or `address-credential` for a credential inside the endpoint itself). **A usable link guarantees `endpointOf(link.address)` is an endpoint, unchanged.** Every branch (the new form, and the old `addr`/`address`/`server`) validates the endpoint AFTER extracting and decoding it, with that one function, and the builder calls it before writing a link; there is no parallel query-only or host-only check. A decoded `addr` that hides a fragment or a credential makes the WHOLE link unusable: the inner credential is never stripped and the outer token is never taken as approval to connect to a repaired target (review round 4).

**Unusable is not "not a link"**: it is text that carries a credential and must never stay in a visible field. ONE reading of a credential key serves every boundary (the key of a `a=b` piece, percent-decoded and case-folded, is `token` or `socket`: `?%74oken=` and `TOKEN=` count), and the parser's last step runs it over the WHOLE text (query, hash, free text), so a `none` answer is provably credential-free (review round 3). That covers the old token-only link in the query and in the hash, a link whose address names no host (`ws://?token=T`, `wss:///?token=T`, a malformed `addr` such as `%ZZ`), free text with a credential parameter in it (`text ?token=T`, a bare `token=T`), an empty `token=` with no address, and a repeated `token`/`socket` key. The form refuses it: the field goes back to what it held, the other fields are untouched, and one message that names no part of the text says why ("This link has no server address", or "... a token or socket appears twice"). Nothing infers an address and attaches the token to another server.

| form | example | address | token | socket |
|---|---|---|---|---|
| new | `wss://h/ws?token=T&socket=%2Fs` | `wss://h/ws` | `T` | `/s` |
| new, empty credentials | `ws://h:9899?token=&socket=` | `ws://h:9899` | `''` | `''` |
| new, one parameter | `ws://h:9899?token=T` | `ws://h:9899` | `T` | `null` (cleared on paste) |
| old, query | `https://app/x/?addr=ws://h:9899&token=T&socket=/s` | `ws://h:9899` | `T` | `/s` |
| old, aliases | `?address=…` or `?server=…` instead of `addr` | same | same | same |
| old, hash | `https://app/#/page?addr=…&token=…` | same | same | same |
| old, any front end | `tauri://localhost/?addr=…` | same | same | same |
| old, no scheme in `addr` | `https://app/?addr=h:9899` | `wss://h:9899` (the link's own scheme: https gives wss, else ws) | | |
| old, token only | `https://app/?token=T` | **unusable** (`no-address`) | | |
| no host | `ws://?token=T`, `wss:///?token=T`, `?addr=wss://%ZZ&token=T` | **unusable** (`no-address`) | | |
| credential in free text | `connect to it ?token=T`, `token=T` | **unusable** (`no-address`) | | |
| old, hidden in `addr` | `https://app/?addr=wss%3A%2F%2Fh%2Fws%23token%3DS&token=T` (a credential in the decoded endpoint) | **unusable** (`address-credential`: "This link's address contains a token or socket"; an ordinary fragment is `no-address`) | | |
| old, `addr` is not a WebSocket address | `https://app/?addr=http%3A%2F%2Fh%3A1&token=T` | **unusable** (`no-address`); it is never turned into `wss://http://h:1` | | |
| credential in a hash | `ws://h/ws#?token=T`, `ws://h/ws?x=1#token=T`, `https://app/#token=T` | **unusable** (`no-address`) | | |
| encoded or upper-case key | `text ?%74oken=T`, `https://app/?TOKEN=T` (no address) | **unusable** (`no-address`); inside a real link the key is read the same way | | |
| repeated key | `wss://h/ws?token=route&token=AUTH` | **unusable** (`ambiguous`) | | |
| bare address, no credential parameter | `ws://h:9899`, `h:9899`, `wss://h/ws?x=1`, a web page without parameters | not a link: kept as typed | | |

**Where it is accepted, and when.** (1) The address field of `ConnectFields`: the login page, the Add server dialog, and the Android app, which runs the same component. A link is split only where a whole text arrives at once, or the field is committed (P2-D): an `input` event that is a paste, a drop, or a keyboard committing a clipboard suggestion (`isBulkInsert`: `insertFromPaste`, `insertFromDrop`, `insertFromYank`, `insertReplacementText`, or an `insertText` of more than one character), and when the field is left (`change`) or Enter is pressed. **Every action that submits the form goes through the same gate** (`ConnectFields.commit`, which the Login page's `doConnect` and the Add server `submit` call before they read a field): Enter, the Connect button, the dialog's submit, an assistive or programmatic activation. It splits a link typed out in full, or refuses it. While a refusal is pending (its message is showing and nothing was edited or picked since) nothing is submitted, so a rejected input can never make the form act on the value it was restored to: no dial, no submit, no raw input sent on. The value a refusal restores is the LAST ACCEPTED address, which every pick and every usable link moves forward together with its token and socket, so a refusal never restores an earlier server's address beside a later server's credentials. **Ordinary typing stays plain editable text**: typing a link out character by character is never split halfway through the token, and is split (or refused) once the field is left. A usable link fills address, token AND socket exactly as a pick of a saved server applies its tuple (an absent or empty socket clears the previous one; the local-gateway auto-filled socket exception is the same code), and the field is rewritten to the address alone, so the token lands in the masked field and never stays in plain view. (2) The page URL at boot (`takeConnectLink`), the old form only, since a browser cannot open a `ws://` link: the parameters are applied and stripped from the address bar as before, so **opening an old link in the browser keeps working**. A link that names no server (the old token-only one) is stripped from the address bar and applies nothing, and the credential-bearing part of the hash goes with it: the route before any `?` is kept unless it still carries a credential (`#token=T`), in which case the whole hash goes (`routeOfHash`).

**`endpointOf(text)` — the one validator of an address-only field** (board #402's "Add address"). Exported from the same module and stable: it returns `{ kind: 'endpoint', address }` for a whole `ws://` or `wss://` URL with a usable host, a valid port if any, no whitespace, no fragment and no credential key anywhere (the address is canonical: lower-case scheme, a lone `/` after the host dropped, the rest byte for byte); `{ kind: 'credential' }` for any text carrying a `token` or `socket` key (a new link, an old link, free text; nothing is echoed); and `{ kind: 'invalid' }` for everything else (`http://`, a bare host, a bad port, an empty host, an empty string). It never guesses a scheme.

**Written by** the login page's Share button (from the form's fields) and the connected Connection page's Copy (from the registry tuple, #400); both call `buildConnectionLink`. The feedback is "Link copied"; the link is never displayed.

**Share and Copy never strip.** Both go through the one builder, which asks `endpointOf` first: an address that holds its own `token` or `socket` parameter (a saved endpoint from before these rules) or a fragment is refused with "This address cannot be shared as a link", nothing is copied, and nothing is rewritten into something shareable. (An address TYPED or PASTED into the field with such parameters is a link by the input rules above and is split into address, token and socket when it arrives, so what Share then sees is that tuple.)

**The token is a secret.** The module has no logging, storage or DOM access (a test pins it), fixtures use fake tokens, and nothing shows the token unless the person reveals the token field. What is typed into the address field is visible, editable text until it is committed (it is not continuously masked); a link that arrives whole is split at once, and a refused text is taken back out. A refused text is not echoed anywhere: not in the field, the message, or the page. **Limits:** a new-form link is not a web URL, so opening it from another app does nothing: it is copied and pasted (no OS-level link handler was added); a gateway address given as `http(s)://host:port?token=…` (no `addr`) is unusable; and the old token-only link, which used to pre-fill the token through the mirror keys, no longer does since the form's pre-fill is the registry's (#400). The Android app is covered by the mount tests and a Chromium Android-user-agent stand-in, not by a device run (the owner's, #247 style).

Lifecycle, each step with the test that pins it: initial tuple (Settings.connect `lifecycle: alpha...` first assertion); accepted paste or pick (Settings.autofill paste tests; Settings.connect/AddServerDialog pick tests); ordinary edit (typing tests, both consumers); commit or reject (REJECTED_LINKS in both consumers, the typed-refusal tests); button or Enter (Settings.connect "a typed link that cannot be used and a click on Connect", with and without blur; the dialog's submit and Enter tests); boot sanitisation (App.shell "boot: ..." and connection-link `routeOfHash`).

Pinned by connection-link.test.ts (build/parse round trip for IPv6, a path, awkward characters and the empty tuple; presence versus truthiness; the endpoint query byte for byte, empty segments included; one credential-key reading across query, hash, encoding and case; collisions; every row of the matrix; no host; credential-bearing text; what a bulk insert is; no logging), connection-link.fixtures.ts (the rejected inputs, shared by both form consumers), Settings.autofill.mount.test.ts and AddServerDialog.mount.test.ts (a paste of each form; the empty-credential variants over a form holding another server's tuple; every rejected input restoring the field with the address element, the other fields, the message and the page checked; typing is not split until the field is left), Settings.connect.mount.test.ts (the dial and `setSocket` tuple after an empty-credential paste), Settings.mount.test.ts (the Share link and the refused endpoint) and App.source.test.ts (one builder, one parser, nothing else spells the link).

### The failover set's order is the priority, edited through one writer

(board #222): the Connection page's address list is the machine's `tmux_machines` failover set, and its stored order is what the reconnect round-robin walks — so reordering IS setting priority, no new concept. A row's × removes an alternate (never the ACTIVE address — the live connection), and the grip drags a row to its new place (Arrow keys on the focused grip are the keyboard form); the drag reuses the rail's idiom via the generic `moveBefore`/`listDropAt` in nav-order.ts, with the grip — not the row — as the handle because the row is already the switch command and a whole-row touch drag would fight the page's scroll. Both edits go to App's `onAddressesChange`, which persists through `saveMachineAddresses` (the map's ONE writer: sanitized, deduped, an empty set drops the key) and bumps a version counter so the derived list re-reads. The hooks-management row that used to sit under the list retired in the same task — managed agents carry hooks in their isolated homes, so the global install/remove surface and its `agent_hooks_*` RPCs were deleted whole (agent-notifications.md § Hook Management).

# WebSocket Client Robustness

## Context
Mobile connections are unreliable. WebSocket client must handle disconnects, reconnects, and edge cases gracefully.

## Decision
Custom WebSocket client with auto-reconnect, pending promise cleanup, and
multi-address failover. Since board #335 ① it is four modules —
`core/connection.ts` (one link as an object), `core/ws-api.ts` (every RPC,
bound to one connection), `core/connection-registry.ts` (object lifetime) and
`core/ws.ts`, the facade every caller still imports. See
§ The transport is an object, not a module. Phase ② adds `app/refs.ts`: every
reference to a session, pane, room, issue or project carries its `ServerId`
(§ A name stopped being an address).

## How It Works
- **Browser development has one public origin.** `npm run dev:all` exposes
  Vite on `:5173`; Vite proxies WebSocket upgrades at `/ws` and streaming
  downloads at `/dl` to the watched Rust service bound to loopback. A fresh
  dev browser defaults its connection field to `ws(s)://location.host/ws`.
  `httpOriginForWs()` deliberately discards the trailing `/ws` segment when it
  builds signed download URLs, so downloads use the sibling `/dl` route while
  a production parent prefix such as `/tmux` remains intact. `dev:all`
  explicitly disables TLS on the loopback hop even when the persisted server
  config has certificates; HTTPS/WSS terminates at the public Vite/Tailscale
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
  callers had, forwarding to ONE registry slot. No app file changed.

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
- **The facade's slot key is a Symbol, in memory only.** Not persisted, not
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
  drives the real facade through A→B→A.

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
kept. It fingerprints the inputs too (P2-a): if a build from before #335 has
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
  identity merge hands the CURRENT twin's slots to the survivor whole — they
  are what the person was just using on that machine — and drops any other
  twin's;
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
  (`recordServer`), an address row and the optimizer (`addressUp`); the boot
  comes up on, and records, the address the runtime dialled, and whether it
  dials at all is the entry's to say, not the mirror's (reviewer P2 on
  cf7e7957). The mirror keys are still written for the connect card and the
  share link.

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

Production holds exactly ONE runtime through ②b, and it is built on the
facade's compatibility slot (`app/single-runtime.ts`). Sixteen modules still
import their RPCs from `ws.ts` at module level, and a runtime minted through
the fleet builds its own connection — a second, never-dialled client beside
the live one, with the un-migrated pages on the other socket. Sharing the slot
is what makes every ②b commit behaviour-identical in Single mode instead of a
flag day. It lives in its own file so `server-runtime.ts` stays facade-free
(its own pin, for the reason that a runtime reaching the compatibility slot IS
the "whichever server is current" bug).

A BORROWED slot is declared as such (`borrowed: true`) rather than handled by
convention, because "App never calls dispose" is not the dangerous path.
`server-runtime.ts` ends a runtime from three places of its OWN: the entry
removed while a dial authenticates, this id absorbed into the canonical entry
of the machine that answered, and the wrong machine answering. The second of
those is the ordinary fate of an old address-only history entry, so owning the
connection's lifetime there would close the legacy transport for the rest of
the session and every retry after it would answer "connection disposed". With
`borrowed` those three DETACH instead: the handle goes terminal, the loss is
reported through the one `onRegistryChanged` edge, and the connection is left
alive for its owner.

Detaching is also what makes two GENERATIONS of handles over one slot safe.
A replaced handle keeps its own attempt counter, so without a detach its late
continuation would still consider itself current and could record identity,
and the api object it handed out would send over a slot that now serves
another server. Three rules follow, and each was a hole first:

- **A borrowed handle detaches on `elsewhere`, whether or not its entry
  survived.** Both entries staying is the ordinary known-A → known-B case: the
  dial was A's, the socket it got reaches B, and the socket is not ours to
  close, so the handle is provably not serving A any more. An owned handle
  keeps the narrower rule — it closed its own socket, so it is still A's
  handle and may dial A again.
- **The api gate is asked when the call is MADE.** A page holds `api` for its
  whole life, and a call like `fsWrite(path, await body)` reads the method
  before the await and sends after it; a gate on the property read would let
  both through. So each method is wrapped once, the wrappers are stable, and a
  caller that captured one still holds the gate.
- **The handle stands down BEFORE the shared socket is re-dialled**, on both
  paths that can reach another server. The switch REVOKES, because leaving is
  already decided there: the tree is unmounted, the guards have answered, and
  the target is by definition another server (its `resetMemory` step runs
  before its connect). The connect form SUSPENDS, because its address may turn
  out to be this very server — revoking there would replace the handle on
  every ordinary reconnect, rebuild every always-mounted page and throw away
  the state they exist to keep, without asking a single leave guard. A
  suspended handle refuses calls (the socket is mid-flight anyway) and what
  happens to it next is decided by the VERDICT of the attempt, never by the
  attempt merely finishing:

  | conclusion | verdict | why |
  |---|---|---|
  | `same-server` | resume | authenticated, and the identity layer confirmed this entry |
  | `no-peer` | resume | the dial never got there, so there is no stranger to be confused with |
  | `other-server` | end (the host's) | a different server authenticated; the handle is ENDED — released, then disposed — and the swap binds the new one |
  | `unresolved` | hold | a peer authenticated and the registry write FAILED: refusing, but still there for the attempt that works out whose socket this is |

  An identity-activation failure is therefore an error the person sees, never
  a same-server success — swallowing it and reporting completion would resume
  the old server's pages onto an unidentified peer. ONE host ticket covers the
  whole chain, because handovers overlap: a form unmounted mid-dial and a new
  instance starting its own are two instances, and to the old one its dial is
  still its latest. So the form asks the handover whether it is still current
  before the identity write and before bringing the app up, and every
  verdict — including the terminal one — is refused for an attempt that is
  no longer current: a late "another server" would end the very handle the
  live handover is protecting. The terminal verdict is not the runtime's to
  carry out (②b-2-3, reviewer P1-a on 48b40082): it used to dispose the
  handle inside `settle`, before anything had released its server's state.
  The runtime's `settle` knows only `resume` and `hold`; "another server"
  goes to the host's one end of a handle (below).

  Clearing the landings after the DOM is gone is the second line, never the
  first — it runs ticks later, by which time the socket would already have
  changed hands.

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
Agents editor on touch, is already gated on a live server, and b3-3 gives it a
scope of its own. A caller asking whether a swap is needed asks what the swap is already
HEADING for, not what is shown: during the gap nothing is shown, and one
success path asks twice, so comparing against the gap would mint a handle
nobody ever shows or releases. b3-4 deletes the file, the slot, the borrow and
the provider-less fallback together.

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
and await their settle. The switch awaits it before the socket moves.

A handle ENDS one way, `app/handle-end.ts` (②b-2-3, reviewer P1-a on
48b40082), on every path that gives one up — the swap's invalidate, a
switch's revoke, a connect attempt's "another server" verdict, an arrival
elsewhere — and ending is two steps that are not the same step. It STOPS
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
builds a fresh one. On a borrowed slot the runtime's own detach on an
identity loss inside `dial` is the stop step only (the gate a suspend also
closes; nothing is closed), and the host's end follows; the fleet's owned
slots keep their self-dispose until b3-4, which moves server state into the
fleet.

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

A leave walk — the switcher's, the form's or an arrival's — runs as the
socket's OWNER (`serverSwitch.guard`, reviewer P1s on 085b0e70 and
4fbce02e). One walk at a time: a second request while one asks is refused,
and a refusal is a stay. Everything already running loses the socket when
the walk begins: the reconnect loop is stopped (timers, probe, the dial it
has out), the walk claims the host's one owner counter — so a reconnect
continuation, a boot dial, an address connect or an older form attempt wakes
to find it is not the owner and does nothing, opening no arrival of its own —
and the switch's intent moves, so an optimizer probe begun before the walk
moves nothing when it answers, during the walk or after it (not even the
mirror key). While it asks, nothing new starts either: no address change, no
switch, no automatic reconnect. A stay puts back what the walk froze, once it
has answered and only if nobody took the socket meanwhile: a frozen address
connect has its outcome applied (published, or handed to the reconnect
loop), or else a loop that was running starts again. An arrival runs its
walk under the attempt that reached the other machine (claiming again would
make that very attempt stale), and every socket change takes the same
counter: `connectAddress` claims it like the boot dial, the form, the
reconnect attempts and the switch. After an arrival's stay, nothing
AUTOMATIC dials (`heldOffline`, reviewer P2s): not the disconnect callback,
not a foreground resume, not a late optimizer probe; the person's own act —
the connect form, a switch, an address row — lifts it. (An address change
still does not check which machine answered; that is unchanged from before
#335.)

**The runtime asks; the reconnect loop is told where** (②b-2-2). The
capability handshake every connect path runs (`serverReady`) is the bound
runtime's `probeCaps()`: asked over its own api, kept as its caps under a round
number of its own, and mirrored into the shell only while the switch still
owns the intent AND that runtime is still bound — a late answer from a server
already left never lands. The Hub flag moves only on a definitive answer, and
a failed backends probe keeps the list the runtime already had rather than
wiping it to the fallback. The reconnect machine reads no connection keys: it
asks `target()` at every attempt, which App answers with
`server-target.targetOf(storage, CURRENT)` — the active mirror for the current
server (written ahead of the registry on four paths through ②b), the entry and
its machine's failover set for any other id. The boot connect is the bound runtime's `dial()`
too: the same borrowed connection, dialled at the route that reader names,
with the runtime's attempt identity (a superseded dial brings nothing up) and
its identity recording (an address-only entry learns its machine and is
folded by the dial itself). A client with no saved entry has nothing bound
and connects through the facade as before.

## Multi-Server (board #55)

`src/lib/app/servers.ts` is the named-server registry over the same keys this
doc already describes. Design decisions, in the order they bit:

- **The old keys stay the ACTIVE MIRROR.** `tmux_address`/`tmux_token`/
  `tmux_socket` keep meaning "the server we are on": ws.ts, the reconnect
  machine, deep links and the boot auto-connect read them unchanged, and a
  downgraded client sees the single-server world it expects. The registry
  (`tmux_servers` + `tmux_server_current`) only remembers what else exists.
- **One entry per known machine; an address is unique unless two different known machines used it** (board 318, owner 2026-10-08: "为什么这里有两个一样的地址，但是显示成两个server了"; refined by validator: identity is the machine, and a loopback tunnel address such as `ws://127.0.0.1:9899` honestly reaches different machines over time). `recordServer` used to match the machine id first and never look further, so a machine-less entry with the same address (migrated from the address history, or recorded before the id was known) stayed as a ghost twin forever. Now every record absorbs twins into the resolved entry — an entry with the same machine id, or with the same address and no machine id (or the same one); two entries with different known machine ids both stay, a machine-less entry is attributed to a machine only when exactly one known machine has used its address (with several it is ambiguous and nothing merges), and a connect by address never takes over another known machine's entry — and `migrateServers` runs `repairServers` on every boot to heal old lists once (idempotent; a healthy list is not rewritten). The survivor keeps its id, machine, address and token, takes a twin's name only if its own is a default and the twin's was typed, inherits CURRENT if the twin held it, and the twin's parked keys are removed. Every absorption is also recorded in `tmux_server_merges` (absorbed id → survivor, capped at 32), because anything still holding the absorbed id has to be able to follow it, and the record of the merge is the only evidence that may move it: an id merely missing from the registry was forgotten or never saved, not merged (`mergedInto`, board #335 ②b-2, reviewer P1-a 2026-10-10).
- **Identity is the MACHINE, not the address** (lead review). `tmux_machines`
  (machineId → addresses) is the existing failover authority; an entry
  persists `machineId` and upsert merges on it first, so a reconnect over
  Tailscale updates the LAN entry instead of minting a second "server".
  Migration attributes history addresses through the same map: the current
  machine's alternates never re-materialize as entries, an unseen machine
  yields one entry, unattributed addresses dedupe by address.
- **Switching is in place, no reload** (board 315, owner 2026-10-08: "切换的过程要丝滑一些，不要整个画面又像到登录页面重新登录加载一样"). It was storage writes + `location.reload()` until then, which flashed the disconnected top bar and the connect card. `lib/app/server-switch.ts` is THE switch; every entry (rail/phone switcher, Settings › Connection, Add server, the failed panel's Retry/Back) calls `switchTo`. The shell (rail, tab bar) stays drawn; the server-bound content tree is not mounted while `switching` is set and is remounted under `{#key serverEpoch}` on arrival. The ORDER is the contract, each step finished before the next:
  1. **Leave guards** (`lib/app/leave-guards.ts`): every instance that will be destroyed registers its OWN guard (the Files page, the Hub drawer's Files, AgentsPage on the rail or inside Settings). Guards on the page the user is on ask first, without navigating; any other dirty one is revealed on its page and asks in its own dialog; a save/delete in flight finishes first. While the walk runs App HOLDS Settings mounted (`{#if page === 'prefs' || holdPages}`), so revealing Files can never unmount an Agents editor that has not answered (review P1: before the hold, that editor's draft was lost and its guard then skipped as "gone"). The walk always ends on the page it started from. Any "stay" and nothing happened. Since #335 ②b-2-3 each guard names its OWNER, the runtime handle whose subtree holds it (or null outside every subtree — Preferences' Agents editor until b3-3), and a leave names the handle it destroys: only that handle's guards and the owner-less ones are asked. By identity, never by server id, so a new handle for the same server neither answers for the old one's editors nor is asked about them. In Single mode that is every guard, as before.
  2. **One intent**: the reconnect machine stops, `switching` unmounts the tree (so no keystroke, send or save reaches it), and every App async begun earlier (boot restore's `listSessions`, `optimizeConnection`) checks `serverSwitch.owns(intent)` before writing.
  3. **Downloads suspended**: every running attempt aborts with `SUSPEND` and is awaited, so no retry, re-sign or WS fallback of the old server's chain can go out on the next connection (`download.ts` re-checks the signal after its retry sleep, before `freshUrl`). Its part is KEPT (see file-handling.md). Then `tick()` lets the unmounted tree's persistence run (the composer's last keystroke) — under the old server.
  4. **Nothing is parked** (since #335 ②b-4): the leaving server's state is in its own slots already, written there by its own store. Retry and Back reuse the frozen `from`; a half-switched world writes no slot of anybody's.
  5. Socket closed (`disconnect()` rejects every pending RPC), `resetServerMemory()`.
  6. **Connect without touching the mirror or CURRENT**: a reload mid-switch boots the server you left.
  7. **Only after auth**, `activateSwitched`: record by the machine id the server REPORTED (a new address of a known machine folds into its entry, a new machine gets a new one; an address never guesses a machine), add the address to that machine's failover set, move CURRENT to the canonical entry, write the mirror. Then `comeUp`: `centreSurface.reset()`, `swapScope()` — which builds the target's runtime and its server state (§ One server's state is one value) — and `bringUp` (the boot path's own half after connect).

  **One socket owner.** Moving the socket to another address of the SAME server (the Connection page's address rows, the periodic optimizer) goes through `connectAddress` in the same module, under the same intent counter: a switch that starts while it dials makes it stale, and a stale attempt neither publishes its result nor restarts the reconnect loop (review P1: it used to call `reconnectMachine.start()` in its catch, and that loop reads the mirror, i.e. the server just left, over the new server's socket). `probeHub` and `loadBackends` drop an answer that arrives after a switch began. The reconnect machine's own starts (`setOnDisconnect`, the visibility resume) are skipped while `switching` is set.

  A failure keeps the panel (Retry · Back to the source · Edit · the server switcher); in FAILED only the server control and the panel work, the page buttons stay disabled. A second address of the SAME machine is not a switch: failover keeps its path and nothing resets. The disconnected connect page reaching a different server comes up the same way (`onConnected(true)`).

  | state | where it lives | on a switch |
  |---|---|---|
  | theme, fonts, zoom, locale, layout, shortcuts, rail order, widths, notifications, `tmux_servers`, `tmux_server_merges`, `tmux_machines` (keyed by machine id) | localStorage | global, untouched |
  | `tmux_state` (tab, terminal target, split), `tmux_machine_id`, `tmux_hub_project` / `_drafts` / `_seen` / `_lead` / `_drawer` / `_roster_expanded` / `tmux_hub_alerts` (per-project maps keyed by tmux session NAME: `app` on A is not `app` on B) | localStorage, `RESIDENT_KEYS`, at `<key>::<id>` (since #335 ②b-4) | untouched: each server reads its own slot |
  | every mounted component, its ws.ts listeners and subscriptions | memory | unmounted with the tree |
  | Files' parked cwds (`browsed`), download rows, served backends, the hover card, App's hub probe / serverInfo / terminal and Files targets | module/App memory | `resetServerMemory()` |
  | download parts on disk | the shell | kept; `partId` hashes the machine id, Resumable lists only this server's |

  What the tests cover, and what they do not:
  - `server-switch.test.ts` runs the real switch module, the real storage half (`servers.ts`), the real leave walk and the real `download()` against a fake transport that answers as machine A or B (one socket, `disconnect()` rejects what is pending). Around it is a hand-written app double (connected/mounted flags, unmount writes as a function list), not App: it proves the ORDER and the storage rules, plus `connectAddress` ownership (an A address still dialing when B is picked neither reconnects nor touches B). Scenarios: A→B→A with a same-named project; B fails twice → Back to A with every parked key unchanged; a pending read rejected by the switch (the fake rejects it on disconnect, so no late success continuation runs); a suspended download re-signs nothing; a dirty-guard cancel; a second address of A; a superseded intent. Each has a negative control.
  - `leave-host.mount.test.ts` mounts the REAL Files and AgentsPage in App's page structure (`LeaveHost.test.svelte`: Files in a hidden layer, Agents under the held `prefs` condition) and drives the real walk: a cancel at either editor loses nothing, Settings stays mounted while Files asks, a save in flight is waited for. The fixture mirrors App's condition; `App.source.test.ts` pins App's own expression.
  - `Files.mount.test.ts` drives Files' real discard dialog through the walk.
  - Not covered by a test: App itself end to end (no App mount harness); the browser check in `temp/check/c315.mjs` (fake ws as two machines) is the evidence for the shell, the panel and no reload.
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
  answers `{authenticated, machine_id, hostname}`, and one App effect hands that
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

### One connection is one object; `ws.ts` is a facade over one slot (#335 ①)

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
pinned by `connection.source.test.ts`. `ws.ts` holds one
memory-only Symbol slot, never persisted and never chosen by URL or machine
id, which retires in phase ② when every server gets an explicit runtime keyed
by its entry id; adding a second door onto the facade re-creates the implicit
"current server" this slot exists to avoid.

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
and then no server page mounts. It was enabled in the SAME commit that moved
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
and a handle whose lease was revoked is never reused for the same id.

Through ②b production holds ONE runtime, built on the facade's compatibility
slot in `app/single-runtime.ts` so there is one socket while the consumers
move — in its own file to keep `server-runtime.ts` facade-free, and declared
`borrowed`, because the dangerous paths are the three inside
`server-runtime.ts` that end a runtime on their own: an entry removed
mid-auth, an id absorbed into the machine's canonical entry (the ordinary fate
of an old address-only entry, which would close the legacy transport for
good), and the wrong machine answering. A borrowed runtime DETACHES on those —
terminal handle, loss reported, connection left to its owner — and on
`elsewhere` it detaches even when its entry survived, because the socket it
holds now reaches someone else. Its api is gated at CALL time, not at property
read, so a captured method and a call that awaits mid-way are both refused
after the detach. The handle stands down BEFORE the socket is re-dialled
elsewhere: the switch revokes (leaving is decided), the connect form suspends
under a TICKET and resumes only on a confirmed conclusion — the same server,
or no authenticated peer at all. A peer whose identity could not be recorded
leaves the handle suspended — refusing, but still there for the attempt that
establishes it is ours — rather than resumed or released, and a superseded
attempt concludes nothing, writes no registry and brings nothing up. Clearing landings
after the DOM is gone is a second line, never the first.

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

(board #55): `src/lib/app/servers.ts` keeps `tmux_servers` (+`tmux_server_current`) while the old `tmux_address`/`tmux_token`/`tmux_socket` stay the ACTIVE MIRROR every existing reader keeps reading. One machine = one entry however many LAN/Tailscale/WAN addresses it answers on — `recordServer` merges by `machineId` (learned at connect) without moving CURRENT, migration attributes `tmux_address_history` through `tmux_machines`, and the same-machine failover semantics are untouched. A different-machine successful connect goes through `activateConnected` (or, for the in-place switch, `activateSwitched` after auth — board 315): CURRENT moves to it; a same-machine alternate records in place. Switching is in place since board 315 (`server-switch.ts`, the order and the state-ownership table are in the Multi-Server section above): the per-server keys (`RESIDENT_KEYS`) live in each server's own slot, `<key>::<id>`, since #335 ②b-4 (until then they were parked and restored there), so restore targets and Hub drafts never cross servers, the content tree remounts and `resetServerMemory` clears the module caches, so nothing in memory leaks across. The desktop rail's switcher rides the RAIL_GAP branch above the configure group — a control (no drag slot), popover in the one menu recipe; Add server is a dialog over the connected shell (cancel changes nothing) and activates only after authentication. Forgetting a non-current server captures its row identity and asks through the shared `ConfirmDialog` before removing config + that server's slots.

### The failover set's order is the priority, edited through one writer

(board #222): the Connection page's address list is the machine's `tmux_machines` failover set, and its stored order is what the reconnect round-robin walks — so reordering IS setting priority, no new concept. A row's × removes an alternate (never the ACTIVE address — the live connection), and the grip drags a row to its new place (Arrow keys on the focused grip are the keyboard form); the drag reuses the rail's idiom via the generic `moveBefore`/`listDropAt` in nav-order.ts, with the grip — not the row — as the handle because the row is already the switch command and a whole-row touch drag would fight the page's scroll. Both edits go to App's `onAddressesChange`, which persists through `saveMachineAddresses` (the map's ONE writer: sanitized, deduped, an empty set drops the key) and bumps a version counter so the derived list re-reads. The hooks-management row that used to sit under the list retired in the same task — managed agents carry hooks in their isolated homes, so the global install/remove surface and its `agent_hooks_*` RPCs were deleted whole (agent-notifications.md § Hook Management).

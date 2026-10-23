---
type: Reference
title: Session encryption and connection state
description: "How an ongoing phone session is secured and reported: the desktop-initiated Noise KK handshake, the two-minute rekey, frames held across a rekey, replies read oldest first, secretstream framing, and the connection states, probe budget and reconnect hold behind the Offline badge."
tags: [mobile, noise, rekey, connection-state]
sources:
  - resource: src/main/mobile-bridge/session/bridge-session.ts
  - resource: src/main/mobile-bridge/session/forced-redial-reason.ts
  - resource: packages/protocol/src/crypto/noise/kk.ts
  - resource: packages/protocol/src/crypto/secretstream.ts
  - resource: packages/protocol/src/wire/session-frame.ts
  - resource: src/shared/types.ts
    title: MobileDeviceConnectionState, MobileBridgeStatus
---
# Session encryption and connection state

Once a device is paired, `src/main/mobile-bridge/session/bridge-session.ts` manages its live connection:

- The desktop always **initiates** a `Noise_KK_25519_ChaChaPoly_BLAKE2s` handshake (both statics are already known from the roster/pairing, so this is mutual authentication by construction - neither identity ever travels on the wire). The desktop is the always-on, source-of-truth side, so it owns the handshake timing rather than waiting on the phone.
- **Re-handshake every ~2 minutes** (`REHANDSHAKE_INTERVAL_MS`, WireGuard's `REKEY_AFTER_TIME`), for bounded post-compromise security - not just initial forward secrecy.
- **Frames are held across a rekey.** The phone (Noise responder) switches to the new streams the moment it writes msg2 and silently drops a frame it cannot open, while the desktop only switches when msg2 reaches it. So every desktop frame sent in that window, one relay round trip, was lost: a response cost the phone its full request timeout, and a terminal delta left the grid corrupt until the next repaint. A delayed-pipe test (`tests/unit/mobile-bridge/bridge-session-rekey-loss.test.ts`) dropped 2 of 2 such frames. `BridgeSession` now holds application frames, goodbye included, from the msg1 of a rekey on an established session until msg2 arrives, then seals them under the new keys in order. WireGuard: a sender "must either queue up packets to be sent later, or use the previous session" (https://www.wireguard.com/protocol/). The hold is bounded by `REKEY_HOLD_MAX_MS`, the whole presence budget (10 s), and a re-probe's msg1 never extends it. It is also bounded by `REKEY_HOLD_MAX_BYTES` (8 MiB), so a busy terminal stream is never held whole and then sealed in one burst. Released past either bound, frames go out under the old keys, which is right when the phone never switched and no worse than before when it did.
- **Replies are read oldest first.** When a reply stalls past the 5 s presence window, the re-probe sends a second msg1, and the phone answers both in order and ends on the second keys. `readMessage` is not transactional, so reading reply 1 with handshake 2 used to destroy handshake 2. Reply 2 then found no handshake, and the desktop stayed on the old keys while the phone moved on, losing every frame both ways until the next rekey tick. `BridgeSession` now keeps every outstanding initiation (`outstandingHandshakes`) and reads a reply against the oldest first. At 8 outstanding it sends no further msg1 rather than forget one, because a forgotten initiation's reply would be tried against every live one and destroy each. A failed read spends only a superseded initiation, and the hold releases once none is outstanding, under the keys the phone ended on. A frame that none of them can read (garbled, or injected) spends all of them and releases the hold as `read-failed`. The test that reproduced the desync dropped 3 of 3 frames before the change and none after. The phone-side fix, keeping the previous receive stream until a frame opens under the new one, is tracked on the mobile board.
- Once established, application traffic (the `BridgeMessage` envelope from `wire/messages.ts`) is sealed with **libsodium-style secretstream framing** (`crypto/secretstream.ts`, `deriveSecretstreamPair`) keyed off the Noise session's chaining key. Secretstream framing gives truncation, reorder, and replay detection out of the box, distinct per direction (`SecretstreamDirectionPair`).
- No Double Ratchet: it solves offline-queued asynchronous messaging, which this interactive, always-connected link does not have.

`src/main/mobile-bridge/wire/session-frame.ts` (re-exported from the protocol package) tags every frame as either a `Handshake` frame (routed to the in-progress `HandshakeState`) or an `Application` frame (routed to the established secretstream pair), so handshake and application traffic can share one transport connection without ambiguity.

## Per-device connection state

Each row in the Mobile Devices settings tab reports `BridgeSession.connectionState`
(`MobileDeviceConnectionState` in `src/shared/types.ts`), **not** the raw transport state. The
transport alone cannot answer "is the phone there": the desktop's relay socket reads `connected`
whenever the relay is up and the slot is dialable, with the phone powered off. So a badge driven
by the transport shows a green "Connected" for a device that is gone.

| Reported | Means |
|---|---|
| `idle` | No session open for this device yet. Renders no badge (not an error). |
| `connecting` | The transport is up and the KK handshake is in flight. |
| `connected` | The KK session is established: the phone answered, so it is genuinely attached. |
| `offline` | The relay slot is healthy but no phone is attached to it. |
| `reconnecting` | The relay link itself dropped and `RelayClient` is backing off. |
| `closed` | The transport was closed. |

Each row also carries `connectionStateSince` (ISO 8601, live, null until the device's session
has opened): when the reported state last changed, written by the same service listener that
logs the transition, and shown as "since <time>" beside the badge so a row stuck on Offline says
for how long without a log read.

`offline` and `reconnecting` are deliberately distinct: they call for opposite user actions (open
the phone vs. fix the network). `offline` is a presence conclusion rather than a transport state,
so it is **not** part of `MobileBridgeTransportState`, which must keep mirroring
`@kangentic/protocol`'s `TransportState` exactly.

Several guards keep the value honest without making it twitchy:

- **A probe budget before `offline`.** Every handshake initiation doubles as a presence probe.
  Silence for `PEER_PRESENCE_TIMEOUT_MS` (5s) spends one unit; only `PEER_PRESENCE_FAILURES_BEFORE_ABSENT`
  (2) consecutive failures conclude the peer is absent, so one slow round trip never flashes
  "Offline" on a live phone. An explicit goodbye (a `FrameTag.Final` frame) skips the budget -
  and, because a Final is only ever a deliberate unpair (neither side sends it on quit, sleep,
  backgrounding, or reconnect), the service now goes further and drops the device from the
  roster entirely (see [Revocation](pairing-and-roster.md#revocation-is-drop-plus-rekey)). The probe window is
  anchored to the start of an unestablished episode and is **never restarted** by a later
  initiation: `HANDSHAKE_RETRY_MS` (3s) re-initiates faster than the window expires, so a
  restartable window would let a relay injecting garbage handshake frames hold `offline`
  permanently out of reach and pin the badge on "Connecting..." forever.
- **One initiation per parked connection.** There is deliberately no re-probe loop once absent.
  While the relay has this device's connection *parked* (no phone attached yet), it BUFFERS
  every msg1 the desktop sends rather than dropping it or forwarding it, and flushes the whole
  buffer to the phone, in order, the instant it attaches - so a second msg1 sent while still
  parked does not speed up recovery, it forces the phone through an extra rekey the moment it
  arrives (#635). `beginHandshake()` sends at most one msg1 per parked connection: further
  presence-probe timeouts still advance the failure budget (so `offline` is still reached on
  schedule) but do not re-send. The relay's own park timeout (60s, `PARK_TIMEOUT_MS` in
  `kangentic-relay`) is what actually re-initiates a stale attempt - it closes the parked socket,
  `RelayClient` redials, and the fresh `'connected'` edge sends a fresh msg1 into what is now an
  empty buffer. The `REHANDSHAKE_INTERVAL_MS` tick is the one caller allowed to override this and
  send a fresh msg1 beside an outstanding one (which stays held, so its late reply is still read
  oldest first, up to the 8-initiation cap), as a backstop for a relay that does not time a park
  out; against the hosted relay a live parked socket never reaches it, since the 60s park timeout
  closes a parked socket well before this 120s tick could land on it.
- **A spent budget on a provably dead socket redials.** The park-timeout close above cannot reach
  a socket the relay has already reaped: the relay's keepalive (`PING_INTERVAL_MS` 30s,
  `terminate()` on a missed pong) drops a peer whose network went away, and the desktop is left
  holding an ESTABLISHED socket that still reads `connected` and that the OS never reports on.
  A router restart on 2026-09-18 left four such sockets for 31 minutes; the relay had nothing for
  the desktop the whole time, and the phone could not pair. So `onPresenceProbeTimeout()` takes
  one more decision after `markPeerAbsent()`, on EVERY exhaustion rather than only the absence
  edge (a parked device's edge fired at app start): if nothing arrived on the socket during the
  probe episode (any frame, valid or garbled, proves the relay is forwarding), and the socket is
  one the park timeout could not have been about to recycle anyway (the phone had answered on
  it, or a rekey tick found it still open past the park timeout), the session calls
  `RelayClient.redialNow({ force: true })`, which abandons the socket and dials afresh. A fresh
  park whose phone is simply away matches neither ground and keeps the 60s churn, which is what
  preserves the one-initiation-per-parked-connection property: the redial closes the old socket
  instead of sending on it, so the next `'connected'` edge's msg1 lands in an empty buffer. The
  Final-goodbye path never reaches this decision. Recovery after the network returns is bounded
  by one rekey interval plus the budget (about 130s), or the reconnect ladder if the forced dial
  itself fails. `resumeFromSleep()` and `probePresenceNow()` expose the same two levers to the
  service for the OS wake sources (see [Wake sources](relay-transport.md#wake-sources)).
- **Application traffic proves presence.** Promotion is evidence-based the same way demotion is:
  any frame the desktop can open came from the phone, since only it holds the matching send key,
  so opening one restarts the probe budget. Without that, presence rested on the handshake alone,
  and a single dropped initiation (a rekey is attempted every `REHANDSHAKE_INTERVAL_MS`, so a
  lossy relay gets a fresh chance every two minutes) drained the budget while the phone, never
  having learned a rekey was attempted, kept serving on streams the desktop was still decrypting.
  That reported "Offline" for a demonstrably live device: the exact mirror of the stale green
  "Connected" this whole state exists to remove.
- **A hold before surfacing a blip.** The relay force-closes both peers when either drops, so an
  ordinary phone reload costs a ~500ms reconnect plus a re-handshake. A session with a settled
  presence verdict keeps reporting it for `RECONNECT_GRACE_MS` (2s) after the transport leaves
  `connected`. The window covers the reconnect and, when the handshake completes inside it, the
  re-handshake, so the badge does not flicker `connected -> reconnecting -> connecting -> connected`
  on every reload. A completed handshake or an absence verdict ends the hold early, and a genuine
  outage outlasts it and correctly falls through. The verdict is whichever the session had
  (`connected` or `offline`), so an absent phone keeps reporting `offline` the same way. A session
  that has not reached a verdict yet (before its first handshake or two spent probe windows) has
  nothing to hold, so its first drop shows at once. The absent case recurs every minute: the relay's park timeout closes the parked socket of a phone
  that is away (code 4408), and `RelayClient` is back in about 1s (the 500ms backoff plus a dial).
  Before the hold covered it, each recycle flashed the badge to "Reconnecting", reset
  `connectionStateSince`, and wrote two `warn` lines.

`MobileBridgeStatus.relayState` is the separate panel-wide aggregate over each session's relay
link state (`BridgeSession.relayLinkState`), with precedence
`connected > connecting > reconnecting > closed`. That value equals the transport state, except
that it reads `connected` while a reconnect hold is armed. It describes the relay link, so it never
reads the presence verdict. A reconnect shorter than 2s on a device with a settled verdict, such as
the park recycle of an absent phone, therefore leaves the aggregate on `connected` and sends the
renderer no `mobile:stateChanged`. Because that precedence pins it at
`connected` the moment any one device connects, the renderer's `mobile:stateChanged` notification
is gated on a signature covering the aggregate **and** every device's own connection state -
gating on the aggregate alone left a second device's row frozen on "Connecting..." while its phone
was already serving data.

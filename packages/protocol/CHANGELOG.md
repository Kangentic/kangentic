# @kangentic/protocol Changelog

<!-- releases -->

## [protocol-v0.15.0] - 2026-09-18

Adds the `start-session` capability verb, so a phone can start a task's session
again in the column the task is already in, and makes a verb the receiver does
not know answerable instead of a silent drop. Both additive; `PROTOCOL_VERSION`
stays '3'.

`start-session` is appended to `CAPABILITY_VERBS` (append only: the desktop
mirrors the tuple index for index), with `StartSessionRequestPayload` (`taskId`
plus `projectId`), `StartSessionResponsePayload` (`{ ok, outcome: 'starting' |
'live' }`), `StartSessionOutcome`, and the guard `parseStartSessionResponsePayload`.
The verb answers when the start is ACCEPTED, not when the agent is up: on
`starting` the successor's arrival reaches the phone as the board and stream
events a column move already produces; on `live` a session was already running,
nothing was spawned, and no event is coming, so a phone that tapped Start from a
stale screen refreshes its board and stream itself. `live` also covers a session
queued at the desktop's concurrency limit, so read it as "coming", not "running".
A post-accept failure is reported on the desktop only, so the waiting screen
needs its own timeout and a retry.

`decodeMessage` now validates a capability-request's envelope (a string
`requestId`, a string `verb`, a JSON `payload`) before verb membership, and when
only the membership check fails it throws a typed `UnsupportedVerbError` carrying
the `requestId` and `verb`, so a receiver can answer the request instead of
dropping the frame. A malformed frame still throws a plain `Error` and stays a
silent rejection. `isUnsupportedVerbError` keys on the error's name and fields
rather than `instanceof`, because a consumer of the published dist and a
workspace-source consumer can hold two copies of the class.
`CapabilityResponseMessage` gains an optional `code?: CapabilityErrorCode` (one
member today, `UNSUPPORTED_VERB_ERROR_CODE = 'unsupported-verb'`), validated by
shape only, so a code an older peer does not know cannot cost it the `error` text
it can still show. A desktop from this version on answers an unknown verb with
`{ ok: false, error: 'Unsupported verb: <name>', code: 'unsupported-verb' }`
without running any handler. A desktop older than this version still drops the
frame and the phone times out, so the refusal helps for every verb added after
`start-session`; a client should key its "update your desktop" copy on `code`,
never on the `error` text.

### Features
- Add a start-session verb so the phone can start a task's session again (c910d20e)
- Answer an unknown capability verb with a refusal instead of dropping the frame (6afe2e06)

### Fixes
- The `spawnProgressLabel` doc comment on the session-ended payload also names an in-place restart, such as a re-sent command (38f5b44d)

### Other
- `isUnsupportedVerbError` binds its field cast once (0fdfc4b6)

## [protocol-v0.14.0] - 2026-09-13

Adds an optional `spawnProgressLabel` to the `session-ended` activity payload,
carrying the desktop's in-flight spawn-progress label (for example "Switching
model..."). Additive, and `PROTOCOL_VERSION` stays '3': absent from pre-0.14.0
desktops, and never sent as `null`.

Presence means the desktop had a respawn in flight for this task when the
session ended, so a client can tell a same-column respawn (model, agent, effort
or session-track switch) from a genuine park. `intentional` cannot carry that
distinction on its own, because `SessionManager.suspend()` sets
`status = 'suspended'` before the force-kill for a respawn and a real park
alike, and both reach a client as `intentional: true`.

Read it as INTENT, not a guarantee, on the same terms `BoardColumnWire.spawns_session`
documents. The desktop can suspend without a successor ever landing, and five
park paths do not clear the label first, so a client MUST keep whatever timeout
already bounds its session-swap wait and use the label only to skip a redundant
one. The string is the desktop's own display text: treat it as untrusted, cap
its length, and fall back to generic copy rather than parsing it.

### Features
- Add `spawnProgressLabel` to the session-ended activity payload (b528e3e6)

## [protocol-v0.13.1] - 2026-09-12

`BoardTaskWire.pr_merge_readiness` becomes optional (`?: string | null`),
matching `BoardColumnWire.spawns_session`. It shipped required in 0.13.0 even
though `parseBoardTaskWire` already reads an absent key as null, so the
required declaration bought nothing and forced every consumer that hand-builds
a `BoardTaskWire` literal to list a field the parser already defaults.

No runtime or parse behavior changes and `PROTOCOL_VERSION` stays '3'. One
direction is worth naming for readers: the field's type now includes
`undefined`, so a consumer that reads it under `strict` without handling that
case needs a check it did not need before. Producers are strictly freer.

### Fixes
- Make `BoardTaskWire.pr_merge_readiness` optional (a9624bac)

## [protocol-v0.13.0] - 2026-09-11

Adds `BoardTaskWire.pr_merge_readiness` and `BoardColumnWire.spawns_session`.
Both are additive and neither moves `PROTOCOL_VERSION`: `parseBoardTaskWire`
reads an absent readiness key as null, so a desktop that predates the field
looks exactly like one that has never judged a PR. A client that does not
recognise a readiness value should render the PR as plain open, which keeps
`queued` and `running` from breaking a phone built against the first four
values.

### Features
- Show merge readiness on the PR pill, resolved per adapter (5ab77a75)
- Fold Azure branch policies into merge readiness and report in-flight checks (44dd7abd)
- Narrow `BoardColumnWire.role` and add `spawns_session` (f163b588)

### Fixes
- Correct the `spawns_session` false contract and pin the wire round trip (e03fa313)

## [protocol-v0.12.0] - 2026-08-06

Wire `PROTOCOL_VERSION` goes '2' -> '3'. All peers must upgrade together, and
every already-paired device must re-pair.

### Breaking Changes
- The pairing relay slot is derived from the pairing token instead of being
  the token, via the new `derivePairingSlotId()` (ac5565b8)

  The 32-byte token was doing three jobs: the single-use pairing token, the
  Noise `IKpsk0` PSK, and, hex-encoded, the relay slot id sent as a cleartext
  `?slot=` query parameter. The third published the second. On a hosted relay
  TLS terminates at the edge, which therefore saw the PSK, as would anything
  logging request URIs, so `IKpsk0` degraded to plain `IK` for such an
  observer and the `psk0` contribution bought nothing against them.
  `derivePairingSlotId()` is a labeled BLAKE2s hash of the token, 16 bytes,
  matching `deriveSessionSlotId`'s shape. The routing label stays public, the
  PSK stays secret, and the token never leaves the QR code. No relay change is
  required: the relay's default slot-id pattern already accepts a 32-hex slot.

  `PROTOCOL_VERSION` is bumped because a slot is a zero-negotiation rendezvous
  value: peers deriving it differently never meet, and would otherwise hang
  until the relay's park timeout. Binding the version turns that into an
  explicit version-incompatible result at QR-scan time, before anything dials.
  The version is bound into the KK session prologue as well, which is why
  existing pairings must be re-established.

### Fixes
- A pairing ceremony can no longer be ended by an unauthenticated frame
  (ac5565b8)

  The desktop marked the pairing token consumed on the first frame received,
  before `readMessage` authenticated anything, so anyone able to deliver one
  frame to the pairing slot burned the ceremony deterministically while
  holding no key material. Since the slot id needed to deliver that frame was
  the token itself, travelling in cleartext, that was reachable by anyone who
  could read a request URI or photograph the QR. The token is now consumed
  only after a frame authenticates, and frames that fail to authenticate are
  ignored rather than ending the ceremony, in both the waiting-for-phone and
  sas-pending phases.

  Reordering alone is not sufficient: `readMessage` advances the message index
  and mixes the sender's ephemeral into the transcript before it can
  authenticate, so a rejected frame left a shared `HandshakeState` poisoned
  and the legitimate peer's later attempt failed anyway. Each inbound frame
  now gets its own responder handshake, committed only once it authenticates.
  Ignoring a failed `openPairingConfirm` is safe because `CipherState`
  advances its nonce only on a successful decrypt.

  This is abort-the-ceremony, not compromise-the-ceremony: impersonating a
  peer still requires the desktop's static key, which never crosses the relay.

## [protocol-v0.11.1] - 2026-07-26

### Fixes
- `isSecureRelayAddress` parses the URL authority instead of prefix-matching
  it (1a6b492f)

  `ws://127.0.0.1:8080@evil.test` returned true. Everything before an '@' in
  a URL authority is credentials, so that address dials evil.test, and the
  pairing token IS the Noise PSK, dialed verbatim as the relay's `?slot=`.
  One crafted QR field therefore put the PSK on the wire in cleartext to an
  attacker-chosen host, which was then persisted to the trust anchor for
  every later session. The loopback carve-out is not behind a dev gate, so
  this applied to production builds. Parsing subsumes the old boundary check
  (`localhost.evil.com` is simply a different host rather than a prefix
  needing a special case), and the IPv6 branch rejects trailing garbage
  after the closing bracket rather than trimming to it.

## [protocol-v0.11.0] - 2026-07-26

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- project groups on the project listing: `ReadBoardProjectGroup`, optional
  `groupId` / `position` on `ReadBoardProjectSummary`, and an optional
  `groups` array on the project-list response (c606221f)

  A malformed group entry is dropped rather than failing the whole listing:
  the projects are what the phone cannot work without, and grouping degrades
  to the flat list it rendered before.

## [protocol-v0.10.0] - 2026-07-26

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- read-board `archived` action: one page of completed tasks, newest first,
  each carrying its lifetime session summary (4ac99209)

  An action rather than a field on the snapshot, deliberately: a board
  subscription re-snapshots on every board change and the archive only
  grows, so folding it in would re-send an ever-larger payload for the life
  of the connection, the exact cost the 0.9.0 projections were added to
  remove.

### Fixes
- the board-profile commands are classified for the phone's capability
  allowlist (81ac8ee6)

## [protocol-v0.9.0] - 2026-07-24

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- board projections: the read-board subscribe `view` field
  ('full' | 'sessions'), the `view` echo and `taskCountsByColumnId` on the
  snapshot response, and an optional `backlog` (7e9b8986)

  Additive in both directions: a pre-0.9.0 phone sends no `view` and gets
  the old payload verbatim; a 0.9.0 phone against a pre-0.9.0 desktop gets a
  full board with no `view` echo, which is exactly how it knows the snapshot
  was not filtered.
- pairing: the sealed pairing-confirm frame (`pairing/confirm.ts`,
  `sealPairingConfirm` / `openPairingConfirm`) and key fingerprints
  (`roster/fingerprint.ts`, `formatKeyFingerprint`) (2ca5832a)

## [protocol-v0.8.0] - 2026-07-24

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- the read-stream subscribe `terminal` flag, so a subscriber can opt out of
  the PTY stream (a5a2c241)

  `event:terminal` streamed continuously to a phone showing no terminal at
  all (~13MB/hour), because every subscription carried PTY bytes the phone
  discards by design at its own terminal boundary.
- the `message-preview` activity payload: the one line a phone's session
  list renders (cc1ec5f6)
- optional `since` (epoch ms the session first needed the user) on
  `ActivityReasonWire`'s idle and permission variants (a187cbdd)
- `pairing/relay-address.ts`: a dependency-free leaf carrying
  `MAX_RELAY_ADDRESS_LENGTH` and `isSecureRelayAddress`, so the desktop's
  relay validator cannot drift from the phone's and the renderer bundle does
  not pull in the rest of the package's @noble/* crypto (8c608c1e)

### Fixes
- `get_activity_intervals` is classified as a mobile board-tool read
  (eed683d8)

## [protocol-v0.7.0] - 2026-07-20

### Breaking Changes
- five-category push taxonomy + wake-channel seam (5d4a67eb)

  `PUSH_CATEGORIES` is now exactly `input-required`, `turn-complete`,
  `session-failed`, `plan-complete`, `spawn-stalled`, replacing the prior
  four (`permission-needed`, `agent-question`, `idle`, `agent-crash`).
  `input-required` merges the old `permission-needed` and `agent-question`
  categories into one, sourced from A2A Protocol's `TaskState.INPUT_REQUIRED`
  / MCP's `input_required` rather than Claude-specific naming.
  `RegisterPushRequestPayload` gains an optional `categories` field so a
  device can register only the categories it wants pushed.

## [protocol-v0.6.0] - 2026-07-20

All additive; wire `PROTOCOL_VERSION` stays '2'.

### Features
- prompt option labels, so the phone can label a pending prompt's answer
  buttons instead of answering blind: `awaitedPromptOptions?: string[] | null`
  on the read-stream subscribe snapshot, and `options?: string[]` on the
  activity event's permission variant (4e126bd3)

  Both carry the prompt dialog's numbered labels in keystroke order
  (options[0] is answered with "1\r"). Absent or null means unknown, and the
  phone falls back to its blind approve/deny keystrokes.
- optional `showTicketNumbers` on the read-board snapshot, so the phone's
  task cards follow the desktop's Layout setting instead of guessing; absent
  means true, the desktop default (67c56254)

## [protocol-v0.5.0] - 2026-07-16

All additive; wire `PROTOCOL_VERSION` stays '2'. Includes everything since
protocol-v0.3.0 (the 0.4.0 terminal-geometry work shipped unpublished).

### Features
- terminal dimensions on the wire: `TerminalDimensionsWire`, optional
  `ptyDimensions` on the read-stream snapshot, the `terminal-resize` event,
  and the `interactive-terminal` action union (write / resize / release-size)
- session lifecycle: `session-ended` activity payload variant and optional
  `sessionStatus` on `ReadStreamResponsePayload`
- E2E push: the `register-push` capability verb, `RegisterPushRequestPayload`
  / `RegisterPushResponsePayload`, and `crypto/push-envelope.ts`
  (XChaCha20-Poly1305 sealed notification envelopes, AAD-bound to the
  recipient device key, with staleness bounds)
- project accents: optional `color` on `ReadBoardProjectSummary` and
  `projectColor` on the board snapshot

### Fixes
- `terminal-resize` accepted by the envelope decoder's event validator
  (`validateEvent`), not only `isBridgeEvent`

## [protocol-v0.3.0] - 2026-07-14

### Features
- chunked delta transcript streaming, windowed history, and compression
  (68afad59)

## [protocol-v0.2.0] - 2026-07-13

### Features
- typed feed payloads, board-tool tuples, and read-stream gap fixes
  (b7accca6)
- Phase 2 capability handlers, data feeds, and the board-tool surface
  (8bfa87d1)

## [protocol-v0.1.1] - 2026-07-10

### Features
- add protocol package, device pairing, and secure relay transport (f5c97b9d)

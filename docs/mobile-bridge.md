# Mobile Bridge

Kangentic's mobile companion app (`kangentic-mobile`, a separate repo) pairs with the desktop over an end-to-end encrypted connection so a user can walk away from their PC while agents run, then get notified, read the live conversation, see code changes, send messages back, and move tasks from their phone. The full product rationale and architecture research live in [docs/research/mobile-companion-app.md](research/mobile-companion-app.md); this doc covers what actually shipped in the desktop bridge and the shared protocol package.

This doc covers **Phase 1 (protocol, pairing & secure relay transport)**, **Phase 2 (data feeds, interactive control & capabilities)**, and the shipped core of **Phase 3 (session lifecycle honesty & E2E push notifications)**: identity, pairing ceremony, signed device roster, capability-verb envelope, ongoing session crypto, outbound relay transport client, the live capability-verb handlers, the data feeds they subscribe to (SessionManager output, the transcript service, board state, `DiffService`), and the E2E-encrypted push pipeline. See [Scope](#scope) at the bottom for what is still deferred to later phases.

## Build gating

The bridge ships in production builds: the Mobile Devices settings tab, its `mobileBridge.*` registry entries, and the reconcile that honors a persisted `mobileBridge.enabled` all compile into every build. `mobileBridge.enabled` defaults to `false`, so shipping does not turn the bridge on by itself.

Two affordances stay deliberately `__KANGENTIC_DEV__`-gated and are dead-code-eliminated from packaged builds:

- **`src/main/mobile-bridge/dev-quick-pair.ts`** - a dev-only backdoor for the mobile dev rig. It mirrors a tiny handshake through the repo's gitignored `.kangentic/mobile-dev-pairing/` directory and adopts the rig's persistent phone key straight into the signed roster with every capability granted, no QR/SAS ceremony. Every call site is gated so this can never reach a real user.
- **The `'local'` relay mode** - `ws://127.0.0.1:8080`, for pointing a dev build at a relay running on the same machine (`kangentic-relay`'s own dev server). The Select only offers it in a dev build, and `resolveRelayMode()` (`src/shared/relay.ts`) also gates the *mode itself* on `__KANGENTIC_DEV__`: `mobileBridge.*` is global config in a shared configDir, so a persisted `relayMode: 'local'` (saved from a dev build, or hand-edited) could otherwise survive into a production build on the same machine and silently dial plaintext loopback. A production build falls through to the hosted relay instead. `resolveRelayUrl()` switches on `resolveRelayMode()` rather than `inferRelayMode()`, and the settings Select binds to it too - one gate, so the mode the UI shows can never disagree with the URL the bridge dials. (Binding the Select to the raw stored mode was the earlier bug: in a production build it rendered a blank dropdown, since a controlled `<select>` whose value has no matching `<option>` selects nothing.)

## Layout

```
packages/protocol/src/       # @kangentic/protocol - shared wire schema + crypto, desktop and mobile
  crypto/
    primitives.ts            # X25519/Ed25519 keypairs, random bytes, hex helpers
    noise/                   # Noise Protocol Framework: handshake state, cipher state, KK + IKpsk0 patterns
    pairing-handshake.ts     # Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s driver for pairing
    sas.ts                   # Short Authentication String derivation
    slot.ts                  # relay rendezvous slot derivations (pairing + ongoing session)
    secretstream.ts          # libsodium-style secretstream framing for ongoing session traffic
    push-envelope.ts         # E2E push notification envelope (XChaCha20-Poly1305, recipient-key AAD)
  wire/
    messages.ts              # BridgeMessage envelope (heartbeat, capability request/response, event)
    framing.ts                # length-prefixed message encode/decode
    session-frame.ts          # handshake-vs-application frame tagging
  pairing/qr.ts               # PairingQrPayload encode/decode (kangentic-pair:// URI)
  roster/roster.ts            # signed device roster entry sign/verify
  capabilities/verbs.ts       # CAPABILITY_VERBS - the full verb allowlist
  events/event.ts             # BridgeEvent union (transcript/board/activity)
  transport/transport.ts      # Transport interface (swap point for relay vs future P2P)
  version.ts                  # PROTOCOL_VERSION, prologue encoding

src/main/mobile-bridge/       # desktop implementation, consumes @kangentic/protocol
  identity.ts                 # device keypair (X25519 + Ed25519), encrypted at rest
  roster-store.ts             # signed device roster persistence
  pairing/
    pairing-token.ts          # single-use, ~10min pairing token
    pairing-service.ts        # one pairing ceremony: handshake -> SAS -> phone confirm frame -> auto-enroll
  transport/
    relay-client.ts           # outbound WebSocket relay client with reconnect/backoff
    transport-factory.ts      # Transport swap point (relay today, P2P later)
  session/
    bridge-session.ts         # one connected device's Noise KK session + re-handshake timer
    subscription-registry.ts  # per-device live event subscriptions (read-stream/board/diff), keyed and torn down together
  push/
    push-registration-store.ts # per-device Expo token + envelope key sidecar (cleared on revoke)
    expo-push-client.ts        # injected-fetch POST to the Expo push API (no SDK), DeviceNotRegistered surfaced
    push-notifier.ts           # trigger policy: category mapping, presence suppression, cooldown, debounce
  capability-router.ts        # deny-by-default verb dispatch
  handlers/                   # one module per capability verb, registered once at attachContext()
    read-stream.ts            # SessionManager scrollback/data-tap/activity/usage + transcript deltas & windows
    transcript-sync.ts         # per-subscription transcript diff engine: indexed delta upserts, chunking, reset fallback
    read-board.ts              # repository snapshot + the consolidated board-changed bus
    read-diff.ts               # DiffService (bridge-owned DiffWatcher, never IpcContext.diffWatcher)
    send-user-message.ts       # delivery via TerminalSubmit.submitContent (bracketed paste), not a raw write
    move-task.ts               # routes through handleTaskMove (task-lifecycle-lock + transition engine)
    interactive-terminal.ts    # raw PTY write/resize/release-size (explicit grant only)
    terminal-size-guard.ts     # restores desktop PTY dims when a phone-held grid releases (any path)
    answer-permission-prompt.ts # binds the response to a specific outstanding prompt id
    board-tool.ts                # board-tool-read/board-tool-write - NOT MCP; routes directly into commandHandlers, gated by board-tool-allowlist.ts
    board-tool-allowlist.ts      # per-tool read/mutate classification (excludes query_db + create_column/delete_column + move_task/reorder_tasks/list_tasks/list_columns/list_backlog; browser/devtools/diagnostics/cross-project tools are absent from commandHandlers, so they are excluded for free)
    register-push.ts             # push registration keyed by the requesting session's roster deviceId
    project-color.ts             # deterministic per-project accent color for read-board
  prompt-options-probe.ts     # pure parser: pending dialog's numbered option labels out of a serialized PTY frame
  board-event-bus.ts          # consolidated main-process board-mutation event stream (IpcContext.boardEvents)
  session-lifecycle-feed.ts   # bridges SessionManager session-changed/exit edges onto the board-changed bus
  mobile-bridge-service.ts    # top-level service: identity, roster, pairing, sessions, attachContext()
```

The desktop service is constructed in `src/main/ipc/register-all.ts` and torn down synchronously in `src/main/index.ts`'s `clearPendingTimers` (see [Synchronous Shutdown](../.claude/rules/synchronous-shutdown.md)). It is wired to the renderer through the full 7-layer IPC bridge - channels in `src/shared/ipc-channels.ts` (`MOBILE_*`, see [Architecture > Mobile Bridge](architecture.md#mobile-bridge-14-channels)), types in `src/shared/types.ts` ("Mobile Bridge" section), the `mobile:` namespace in `src/preload/preload.ts`, the handler in `src/main/ipc/handlers/mobile-bridge.ts`, the `useMobileStore` renderer store, and the Mobile Devices settings tab.

## Why a separate package

`@kangentic/protocol` is a local npm workspace (`packages/protocol/`), built independently (`npm run build -w packages/protocol`) and published as its own npm package. It is dependency-free of anything Electron- or Node-specific in its public surface (only `@noble/ciphers`, `@noble/curves`, `@noble/hashes` - pure JS, portable to React Native), so the same wire schema, Noise implementation, and capability-verb list are shared verbatim between the desktop and the future mobile app, with no risk of the two drifting.

Its version and release cadence are **deliberately decoupled from Kangentic's own** - `packages/protocol/package.json` carries its own semver line, bumped and tagged (`protocol-vX.Y.Z`, a separate namespace from Kangentic's `vX.Y.Z` release tags) by the `/release-protocol` skill, published by its own workflow (`.github/workflows/publish-protocol.yml`), independent of the `kangentic` launcher's publish step in `release.yml`. This lets the protocol package ship on its own schedule while the mobile bridge feature is still being built out, without requiring or triggering a full Kangentic desktop release. In-repo, the desktop still consumes the package's TypeScript source directly via the `@kangentic/protocol` alias (see Layout above) - only the external, published npm artifact follows the separate versioning.

### Iterating on the protocol across repos (without publishing every change)

`@kangentic/protocol` is consumed by three repos: this monorepo (the desktop, in-repo workspace), `kangentic-mobile`, and `kangentic-relay`. Publishing to npm on every protocol tweak is a slow path, so while the wire is still firming up:

- **This monorepo's `main` is the protocol's source of truth.** Protocol changes land on `main` via PR, decoupled from npm publishing; publish (`/release-protocol`) only at a release milestone or when a consumer's cloud build needs the pinned version resolvable from npm.
- **The desktop** rebuilds the workspace after editing protocol source (`npm run build --workspace packages/protocol`) and **restarts** - the mobile-bridge runs in the Electron main process, which does not hot-reload, so an in-place protocol edit is not picked up until a restart.
- **The mobile app and the relay** pin `@kangentic/protocol` to a published `^x.y.z` in their committed `package.json`, but for local dev their tooling links the freshly built sibling `packages/protocol` into `node_modules` (kangentic-mobile's dev rig does this automatically via `ensureLocalProtocol`; see that repo's `docs/developer-guide.md`). The committed manifest is never rewritten to a local path - only `node_modules` is linked - so a fresh clone or CI still resolves the published version.
- **Wire compatibility:** additive, backward-compatible changes keep `PROTOCOL_VERSION` the same so mixed-version peers interoperate; a breaking wire change bumps `PROTOCOL_VERSION` (bound into the Noise prologue) and requires all peers to upgrade together.

## Pairing Ceremony

Direction: **the desktop displays a QR code, the phone scans it.** The desktop is the trust root.

1. The user clicks "Pair a device" in the Mobile Devices settings tab. This mints a single-use `PairingToken` (32 random bytes, ~10 minute TTL - `PAIRING_TOKEN_TTL_MS` in `pairing-token.ts`) and opens a relay connection on a slot **derived from** the token via `derivePairingSlotId()` (a labeled BLAKE2s hash, 16 bytes). The slot is deliberately not the token itself: it travels in cleartext in the relay URL's query string, while the same token is the Noise PSK, so dialing it verbatim would publish the PSK to every hop that can read a request URI. The token itself never leaves the QR code.
2. The QR payload (`PairingQrPayload`, encoded as a `kangentic-pair://...` URI by `packages/protocol/src/pairing/qr.ts`) carries: the desktop's static X25519 public key, the pairing token, the relay address, an expiry timestamp, and the protocol version. It is a pairing *bootstrap*, not a long-lived secret.
3. The phone scans the QR and runs the initiator side of a **Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s** handshake (`packages/protocol/src/crypto/pairing-handshake.ts`), with the pairing token mixed in as the Noise PSK.

### Design decision: token-bound Noise PSK instead of SPAKE2

The original research doc considered a PAKE (SPAKE2) for the pairing exchange so two devices could authenticate from a short, human-typed code. What actually shipped uses a **high-entropy, machine-generated token as a Noise PSK** instead. The reasoning, documented in `pairing-handshake.ts`'s module comment: a PAKE's real value is defending a *low-entropy, human-typed* code against offline dictionary attacks. A 32-byte token scanned from a QR is already high-entropy, so an online-guess-only, single-use property (the same property a PAKE would give a short code) falls out of the token itself - no PAKE is needed to get it. Avoiding SPAKE2 also sidesteps a real practical gap: there is no maintained, audited JavaScript SPAKE2 implementation (the one npm package is years-stale, draft-08, and Node-only, which would have broken React Native parity). Using PSK-mode Noise instead keeps exactly **one** audited crypto primitive (Noise) across both pairing and ongoing sessions, rather than two.

### SAS confirmation and the pairing-confirm frame

After the handshake completes, both sides derive a **Short Authentication String** (`packages/protocol/src/crypto/sas.ts`, `deriveShortAuthenticationString`) from the handshake transcript hash - a 6-digit code, Matrix-style commitment-before-reveal (the derivation also yields an emoji sequence, unused since neither side renders it: the digits alone already carry the full comparison, and emoji added cross-platform font risk with no assurance). The phone shows its code with a single **Confirm** button; the desktop shows the same code under "Waiting for your phone…" and does not ask a second question - the human already answered it once, on the phone. Backing out on the phone (not the code prompt) is the rejection: there is no separate reject frame.

Tapping Confirm sends a **pairing-confirm frame** (`packages/protocol/src/pairing/confirm.ts`, `sealPairingConfirm`/`openPairingConfirm`) - a fixed plaintext constant, AEAD-sealed under the cipher state the just-completed IKpsk0 handshake's `split()` already produced. This is a **liveness and intent signal, not the pairing's security boundary**: a relay-in-the-middle already holds a valid session with the desktop and could forge any frame it wants. The actual defense is unchanged - the SAS comparison the human makes before tapping Confirm. What the frame buys instead: both peers derive their transport keys from the SAME completed handshake transcript, so if the sealed frame opens under the desktop's key, the two transcripts necessarily agree, which means the SAS the human compared necessarily agreed too. **The AEAD open IS the desktop's SAS verification** - that is why the frame carries no digits of its own.

On a successful open, the desktop auto-enrolls: it signs the phone's static public key (never any key carried in a payload - `PairingService` always reads `HandshakeState.getRemoteStaticKey()`) into the device roster, using the phone-supplied device name from the handshake's message-1 payload and the full capability grant (see [Capability Verbs](#capability-verbs)). The desktop only interrupts the human on **timeout** (`waiting-for-phone` bounded by whatever is left of the pairing token's 10-minute TTL, `sas-pending` a flat 5-minute window, generous because a human is physically tapping their phone). A confirm frame that fails to open is **ignored**, not surfaced as a mismatch: the frame is unauthenticated and the relay slot is reachable by anyone who can read the request URI, so ending the ceremony on the first bad one handed any such observer a way to abort a pairing at will. Ignoring is safe because `CipherState` advances its nonce only on a successful decrypt, so the real frame still opens afterward. A device's name can be changed afterward from the paired-devices list; renaming is not part of the ceremony.

## Signed Device Roster

`src/main/mobile-bridge/roster-store.ts` persists a `DeviceRoster` (one JSON file, globally scoped - like the identity, this represents the desktop installation, not any one project). Every entry (`RosterDeviceEntry`: device id, static public key, display name, capabilities, paired-at, expiry, signature) is signed with the desktop's Ed25519 master signing key at pairing time and **re-verified against that same key every time the roster is loaded from disk**. A corrupted or hand-edited roster file degrades to "that device drops out," not "an unverified entry is silently trusted" - the roster, not the relay, is the source of truth for who is paired.

The paired-devices list identifies each device by a **key fingerprint** (`packages/protocol/src/roster/fingerprint.ts`, `formatKeyFingerprint`): the leading 16 hex characters of its static public key, in four space-separated groups. That is the identity the ceremony actually bound and the SAS actually confirmed, unlike a display name (not unique, and user-editable) or a hardware id (unavailable on modern Android, and permanent PII). The mobile app formats it identically, so a user can hold the phone next to the desktop and compare the two directly - hence front-only slice, no ellipsis, no case change.

### Revocation is drop-plus-rekey

Revoking a device (`revokeDevice()`) removes its entry from the roster **and** is intended to rotate the desktop's own static identity key. Dropping the roster entry alone is not sufficient: Noise KK's mutual authentication only proves possession of a static keypair, so a revoked device that already completed a handshake could still authenticate against a future session as long as the desktop's static key is unchanged. Phases 1 and 2 ship the roster-side "drop" half (`roster-store.ts`'s `revokeDevice`) plus live `BridgeSession`/subscription teardown for that device (`MobileBridgeService.disposeSession`); a full key-rotation-and-re-provisioning flow for any *other* still-paired devices is Phase 3 scope, since a small paired-device count is the common case in practice.

## Capability Verbs

`packages/protocol/src/capabilities/verbs.ts` defines the complete allowlist a paired device can be granted:

- `read-stream` - live scrollback, terminal output, activity/usage telemetry, and transcript deltas for one session.
- `read-board` - a project's columns and tasks, or (with no `projectId`) the machine's project list; live updates via the board-changed bus. The `view` field picks the projection: `'sessions'` (session-bearing tasks plus whole-column counts, what an agent feed draws across every project) or `'full'` (every task, for the one board the user has open). Either way the backlog stays home; only a pre-0.9.0 request that names no `view` still gets it.
- `read-diff` - a task's diff file list or a single file's content, via `DiffService`; live "something changed, re-fetch" pushes via a bridge-owned `DiffWatcher`.
- `send-user-message` - deliver text to a running session via the same bracketed-paste path (`TerminalSubmit.submitContent`) the renderer's Browser-pane Send affordance uses.
- `move-task` - move a task between columns, optionally placing it at a `targetPosition` within the destination column, via `handleTaskMove` (respects `withTaskLock` and the transition engine).
- `answer-permission-prompt` - the most sensitive verb; binds a phone's raw keystrokes to a specific outstanding permission-prompt id before writing them to the PTY.
- `interactive-terminal` - raw PTY write-path parity (full desktop-terminal keystroke control). Three actions ride the one grant: `write` (the default; an action-less payload from a pre-0.4.0 phone parses as a write), `resize` (fit-to-phone: sets the PTY grid so the TUI redraws phone-shaped), and `release-size` (give the grid back). Resize deliberately shares the write grant - a device trusted to type raw bytes into the PTY gains nothing new from resizing it. While a phone holds a session's grid, a per-device guard (`handlers/terminal-size-guard.ts`) registered in the same `SubscriptionRegistry` restores the desktop's last dimensions on EVERY release path: explicit `release-size`, device disconnect, roster revoke, or bridge shutdown; it disarms without restoring when the session exits. Contention is latest-writer-wins - a desktop resize while a phone holds simply wins and becomes the new restore target; with two phones, either one's release restores desktop dims (documented limitation).
- `board-tool-read` / `board-tool-write` - the long-tail task/backlog CRUD surface (create, edit, delete, link PR, ...) that has no dedicated verb, split by read vs mutate access so the grant granularity matches the rest of the model. **Not MCP** - no agent, LLM, or JSON-RPC round-trip is involved; see [Board Tool Surface](#board-tool-surface) below.
- `register-push` - register (or unregister) the device for E2E-encrypted push notifications: the phone hands over its Expo push token plus a device-generated 32-byte push-envelope key, keyed by the requesting session's authenticated roster identity, never by payload content. See [Push Notifications](#push-notifications-e2e) below.

There is **deliberately no shell, file-read, or arbitrary-command verb** - absent from the protocol entirely, not filtered at runtime. This mirrors the lesson from SSH forced-command escapes and is the counter-example to Chrome Remote Desktop / VS Code tunnels, which are identity-gated but capability-unscoped. Adding a verb to this list is a protocol change; it does not by itself grant anything to a device - a device's roster entry still has to include the verb in its `CapabilitySet`, and the desktop's `CapabilityRouter` still has to have a handler registered for it.

`src/main/mobile-bridge/capability-router.ts` is the desktop-side dispatch point: it checks the requesting session's `CapabilitySet` (bound at pairing time) before even looking up a handler, so an unauthorized verb is rejected before any handler code runs. Every verb has a registered handler (`src/main/mobile-bridge/handlers/`, wired once by `MobileBridgeService.attachContext()`); an authorized-but-unregistered verb would still fail closed with an explicit "no handler registered" error rather than doing nothing silently - that guarantee stays load-bearing even though nothing exercises it in production today. The check itself is unconditional infrastructure, independent of what a device happens to be granted - see [Full access on pair](#full-access-on-pair) for what changed there.

### Full access on pair

`DEFAULT_PAIRING_CAPABILITIES` (granted automatically on a successful pairing) is **all ten verbs** - `[...CAPABILITY_VERBS]`. The phone is an extension of the user's own desktop environment, not a third-party integration: the same person holds both devices, and the QR scan plus SAS comparison (now the pairing-confirm frame - see [SAS confirmation](#sas-confirmation-and-the-pairing-confirm-frame)) already prove physical possession of both, so pairing is the only approval the human needs to give. What stays true regardless of the grant: the protocol still defines no shell, file, or arbitrary-command verb at all, and **unpair remains the kill switch**.

A device paired before this change is upgraded to the full grant once, automatically, the next time the bridge starts (`MobileBridgeService.attachContext()`'s `migrateDevicesToFullCapabilityGrant()`, before the first `reconcile()` opens any session) - routed through `setDeviceCapabilities()` so the roster entry is correctly re-signed rather than silently invalidated (capabilities are inside the Ed25519-signed payload; see [Signed Device Roster](#signed-device-roster)).

The per-device capability CHECK stays (`CapabilityRouter.dispatch`'s deny-by-default gate, `setDeviceCapabilities()`'s IPC/service surface) as the seam for a future narrower preset ("view only"), but the Mobile Devices settings tab no longer exposes a per-verb toggle UI - there is nothing to configure at pairing time, and per-device controls are limited to rename and unpair/revoke.

## Data Feeds

Each `read-*` handler subscribes to a live main-process source and pushes `BridgeEvent`s (`packages/protocol/src/events/event.ts`: `transcript` / `activity` / `terminal` / `terminal-resize` / `board` / `diff`) over the established `BridgeSession`, tracked per-device in a `SubscriptionRegistry` so a device's live subscriptions tear down together on disconnect or revocation:

- **`read-stream`** taps `SessionManager`'s **unfiltered `data-tap` event** (`src/main/pty/session-manager.ts`), added specifically for this feed: SessionManager's pre-existing `data` event is gated to `focusedSessionIds` (the renderer's active tab), so a background session's output never reached a listener that isn't the focused renderer tab. `data-tap` fires for every session's output unconditionally and does not feed the renderer's backpressure accounting (that protocol exists only for the focused-tab drain handshake). Raw output is coalesced on a short timer before pushing (`TerminalEvent`), with a small-payload fast path that flushes a keystroke echo immediately instead of waiting out the timer. The subscribe snapshot reports the PTY's grid (`ptyDimensions`), and `SessionManager`'s `pty-resize` emission (fired on every resize of any origin, plus once at spawn) is forwarded as a `terminal-resize` event - after flushing pending old-grid output first - so the phone renders at exactly the grid the bytes were laid out for instead of guessing a width. `activity`/`usage`/`event` telemetry pushes as `ActivityEvent`. Transcripts never ship wholesale (a long session's full conversation exceeds the 1 MiB frame cap): `handlers/transcript-sync.ts` diffs each new `resolveTaskTranscript` revision against exactly what this subscription was last sent (uuid-keyed, with a source-reference serialization cache) and pushes only the changed/new entries as absolute-indexed `TranscriptEvent` delta upserts, split into byte-budgeted chunks - or a `reset` signal when the phone cannot patch (shrink, reorder, degraded/index source). Subscribing seeds the sync state without pushing; the phone bootstraps its view with the `transcript-window` action (newest `limit` entries before `beforeIndex`, byte-budgeted), and pages older history the same way on scroll-up. The subscribe snapshot also reports `sessionStatus` (`running` / `queued` / `suspended` / `exited`; absent from pre-0.5.0 desktops, which the phone reads as `running`), and when the streamed session's PTY exits the subscription's last word - pushed between the final terminal flush and its own teardown - is a `session-ended` activity payload whose `intentional` flag distinguishes a deliberate stop from a crash.

Feed payload CONTENTS are typed by the wire mirrors in `packages/protocol/src/events/payloads.ts` (`TranscriptEntryWire`, `ActivityStateWire`/`ActivityReasonWire`, `SessionUsageWire`, `BoardColumnWire`/`BoardTaskWire`/`BacklogItemWire`, `DiffFileListWire`/`DiffFileContentWire`), which deliberately MIRROR the desktop shapes rather than import them - the protocol package is a dependency-light leaf shared with the phone. `src/main/mobile-bridge/handlers/wire-mappers.ts` is the one place each mirror meets its desktop source type, replacing the Phase-2-era `as unknown as JsonValue` casts, so a desktop-type change that would break the wire surfaces there as a compile error. The protocol package also ships the phone-side runtime guards (`isBridgeEvent`, `parseTranscriptEntriesWire`, `parseReadStreamResponsePayload`, ...) that narrow a decoded payload before the phone trusts a field.
- **`read-board`** subscribes to `IpcContext.boardEvents` (below), filtered by `projectId`.
- **`read-diff`** subscribes a **bridge-owned `DiffWatcher`** instance (`MobileBridgeService`'s own `diffWatcher` field), never `IpcContext.diffWatcher` - that instance is shared with the renderer's Changes panel and is single-watch-per-path, so a bridge teardown would kill the renderer's live watch on the same worktree (and vice versa).

### Consolidated board-changed bus

`src/main/mobile-bridge/board-event-bus.ts`'s `BoardEventBus` (exposed as `IpcContext.boardEvents`, a plain Node `EventEmitter`, not an IPC channel) is a single main-process-internal stream for every agent-driven board mutation, so `read-board` subscribes once instead of listening to each ad-hoc `IPC.*_BY_AGENT` renderer-push channel individually. It is fed **additively**, right next to the existing `sendToRenderer(...)` calls in every board-mutating callback of `buildCommandContextForProject` (`src/main/agent/mcp-project-context.ts`) and the PR-linking push (`src/main/pr/pr-linking.ts`) - the renderer's existing `*_BY_AGENT` pushes and `useAgentDrivenInvalidation` are untouched.

Session lifecycle edges feed the same bus: `src/main/mobile-bridge/session-lifecycle-feed.ts`'s `SessionLifecycleBoardFeed` (started in `attachContext()`, disposed with the service) subscribes `SessionManager`'s `session-changed` and `exit` emissions and emits a `task-updated` board change per edge - immediately, plus one settle re-emit after ~1s coalesced per task, because several lifecycle edges land before their follow-up DB writes settle. Without it, a phone's board view kept showing a stale "running" badge until the next agent-driven mutation happened to fire.

`read-board` also stamps every project-list entry with a `color` and the board snapshot with a `projectColor`: a deterministic accent (`handlers/project-color.ts` hashes the project id onto a curated 12-tone palette that reads well on the phone's near-black theme), so both sides agree with nothing stored. A future user-set project color overrides through the same wire fields.

### Permission-prompt id binding

There is no dedicated permission-prompt object in the desktop app - a prompt is just the agent's own TUI prompt, and the activity engine tracks only that one is pending (`ActivityStatsSnapshot.permissionPending`) plus which tool it is for (`permissionAwaitedToolId`, the `tool_use_id` - added in Phase 2, kept in sync between the engine-internal and IPC copies of `ActivityStatsSnapshot` per `activity-stats-snapshot-parity.test.ts`). `answer-permission-prompt`'s handler synthesizes a prompt id (`${sessionId}:${permissionAwaitedToolId}`), reports it in `read-stream`'s snapshot as `awaitedPromptId`, and rejects an answer whose `promptId` does not match the CURRENT live value - the safety property that makes this verb meaningfully different from a plain `interactive-terminal` write. The phone sends raw keystrokes; no agent-specific interpretation happens in the bridge (per `agent-adapters-boundary.md`).

A prompt that appears (or clears) AFTER the subscribe snapshot is pushed live as the `permission` activity payload (`{type: 'permission', promptId, pending, options?}`): `read-stream`'s subscription re-derives the awaited id on every activity/session-event emission and pushes only on change (pending `false` carries the id that just cleared). Without this, a phone could answer only prompts already outstanding at subscribe time or blindly re-subscribe to discover new ones.

The phone answers with raw keystrokes either way, but since 0.6.0 it no longer has to LABEL its buttons blind: `src/main/mobile-bridge/prompt-options-probe.ts` (`extractPromptOptions`, pure) parses the pending dialog's numbered option rows (`❯ 1. Yes`, `2. Yes, and don't ask again...`, box border tolerated; last complete 1..n run wins, minimum two options) out of the same serialized frame the mobile seed uses, rendered through the shared `VirtualScreen` VT-grid (`src/main/pty/virtual-screen.ts`, extracted from the Claude model-picker probe). The subscribe snapshot reports the labels as `awaitedPromptOptions` (probed from the frame already fetched for `scrollback`), and the live pending push attaches them as `options`, probing when the prompt appears with one short retry in case the activity emission beat the TUI's dialog paint. Both fields are additive and best-effort: absent or null means "unknown", and the phone falls back to its blind approve/deny keystrokes. `answer-permission-prompt` is untouched - keystrokes remain the answer transport, and no agent-specific parsing enters the bridge (any TUI that draws a numbered dialog parses; anything else yields null).

## Board Tool Surface

`board-tool-read` / `board-tool-write` are **not the MCP protocol** - despite the `{tool, params}` shape, no agent, LLM, or JSON-RPC round-trip happens anywhere in this path. `handleBoardTool` (`src/main/mobile-bridge/handlers/board-tool.ts`) is a plain function call straight into `commandHandlers` (`src/main/agent/commands/index.ts` - the same registry the in-process MCP HTTP server also happens to dispatch into), reusing the exact handlers and board-mutation side-effect fan-out without re-deriving the `register*Tools` layer's zod schemas, defaulting, rate limiting, or LLM-facing prose formatting. This is the same kind of direct reuse `read-board`/`move-task` do against their own repositories/`handleTaskMove` - a thin authorization + routing wrapper over the existing engine, not a second protocol surface. It exists for the long tail of task/backlog CRUD (create, edit, delete, link PR, backlog promote/update/delete, stats, transcript, handoff) that would be tedious to give each its own bespoke verb. The `tool` field a request names is the **internal `commandHandlers` key** (e.g. `'create_task'`), not a public MCP tool name.

`src/main/mobile-bridge/handlers/board-tool-allowlist.ts` classifies every `commandHandlers` key as `'read'` or `'mutate'`, building the table from the protocol package's `BOARD_TOOL_READ_NAMES` / `BOARD_TOOL_WRITE_NAMES` tuples (`packages/protocol/src/capabilities/board-tools.ts`) so the phone's typed tool-name unions and the desktop's enforcement cannot drift (`board-tool-allowlist.test.ts` fails if a new registry entry ships unclassified, or if the protocol tuples drift from the registry's actual key set). Excluded from both verbs:
- `query_db` (raw SQL escape hatch).
- `create_column`, `delete_column` - board **structure**, not the task CRUD this path exists for, and the worst fit for a surface that skips the `register*Tools` zod layer: `board-tool.ts` validates only that `params` is an object, so `delete_column`'s `params.column as string` and `create_column`'s dozen-plus `String()`/`Number()`/`Boolean()` coercions would take arbitrary JSON with no narrowing. Reshaping a board from a phone is not a capability anyone has asked for; if it is ever wanted it should get a bespoke verb with its own schema, not arrive by omission here.
- `move_task`, `reorder_tasks`, `list_tasks`, `list_columns`, `list_backlog` - real, safe `commandHandlers` entries, but **duplicates** of the dedicated `move-task` and `read-board` verbs, which give a cleaner contract (swimlaneId not column-name resolution; full `Task`/`Swimlane` objects; `read-board` also has a live subscription these one-shot tools lack). `move-task` already carries a `targetPosition`, so single-task within-column placement is a phone capability today; `reorder_tasks` would be a second contract for that same action, differing only in doing a whole column at once. If bulk re-sequencing from a phone is ever wanted it belongs in `move-task`'s verb family with a real schema, not reached by omission here. Excluding them keeps exactly one path per capability instead of two competing ones.
- Everything not in `commandHandlers` at all: the `kangentic_browser_*` family, the dev-only `kangentic_devtools_*` family, the diagnostics tools (`tail_logs`, `get_recent_crashes`, ...), and the remaining cross-project tools (`list_projects`, unified `search`, `move_task_to_project`) are registered through entirely separate registries, so building the allowlist from `commandHandlers`'s keys excludes them for free, with no separate name-matching needed.

A phone bootstraps its project list through `read-board` with no `projectId`, since `commandHandlers` has no `list_projects` entry.

## Push Notifications (E2E)

Push payloads transit Expo's push service (and APNs/FCM under it), which must never see notification content. The pipeline keeps every hop blind:

1. **Registration** (`register-push` verb, `handlers/register-push.ts`): the phone sends its Expo push token, a device-generated 32-byte push key (base64url, length-checked at the protocol parse boundary), and optionally its enabled `categories` (absent means every category; an explicit empty list means none). The desktop stores all of it in `push/push-registration-store.ts`'s `mobile-push-registrations.json` sidecar (config dir, roster-store pattern, tolerant load), keyed by the requesting session's authenticated roster `deviceId` - never by payload content, so one device cannot register or unregister another. Revoking a device also clears its registration, unconditionally. Preferences are enforced **desktop-side**: the phone's category list is checked before a notification is even sealed, so a future iOS Notification Service Extension never needs to know about them.
2. **Envelope** (`packages/protocol/src/crypto/push-envelope.ts`): the desktop seals a `PushEnvelopePlaintext` (`category`, `projectId`, `taskId`, `sessionId`, `taskTitle`, `detail`, `sentAt`) with XChaCha20-Poly1305 under the device's push key: a fresh random 24-byte nonce prepended to the ciphertext, the recipient device's static public key as AAD (a blob sealed for one device cannot be replayed at another), base64url without padding. `openPushEnvelope` (run on-device: Android Notifee / iOS Notification Service Extension) rejects tampering, wrong keys, wrong recipients, malformed plaintext, unknown categories, and any `sentAt` older than 24h or more than 5min in the future; every failure degrades to the generic placeholder, never to plaintext.
3. **Triggers** (`push/push-notifier.ts`, keyed off `SessionManager`'s `activity`/`exit` emissions, plus two sources elsewhere). Five categories, named for cross-vendor task-lifecycle vocabulary (`input-required` mirrors A2A's `TaskState.INPUT_REQUIRED`) rather than any one agent's terms:
   - `input-required` - the session transitioned INTO the `permission` activity state (an approval request or an `AskUserQuestion` alike - the phone renders one "needs your input" experience for both, so the desktop no longer distinguishes them on the wire).
   - `turn-complete` - the session transitioned `thinking` -> `idle`.
   - `session-failed` - the session exited with `intentional` false (a crash; a deliberate stop never notifies).
   - `plan-complete` - the session emitted `plan-exit` (a plan was approved).
   - `spawn-stalled` - a task's spawn (worktree/git prep) has been in flight past the stall threshold; this one has no `sessionId` yet (the session doesn't exist until spawn finishes), so it notifies keyed by `taskId` instead.
   Permission triggers are debounced 2s and re-checked at fire time, so a prompt answered at the desk within the window never pings the phone.
4. **Suppression**: a device with a live established bridge session is never pinged (presence suppression - the user is already watching from it), then the device's category preferences are checked, then each (device, session-or-task, category) tuple has a 30s cooldown.
5. **Delivery** (`push/wake-channel.ts`, `push/expo-push-client.ts`): `PushNotifier` talks to a vendor-neutral `WakeChannel` interface, not to Expo directly - the only implementation today, `createExpoWakeChannel`, is a plain injected-fetch POST to the Expo push API (no SDK), one 5s retry on network error, with `mutableContent: true` set so the future iOS Notification Service Extension is invoked. A drop-in replacement (e.g. a small Cloudflare Worker holding the same push credentials) only has to implement `WakeChannel`. The visible `title` is always `Kangentic` and the `body` a static per-category placeholder; **only `data.blob` carries real content**, and a unit test asserts no plaintext field value appears anywhere else in the POST body. The Android `channelId` maps per category: `needs-attention`, `completions`, `failures`, `stalls`. A `DeviceNotRegistered` ticket drops the registration.

## Ongoing Session: Noise KK + Re-handshake + Secretstream

Once a device is paired, `src/main/mobile-bridge/session/bridge-session.ts` manages its live connection:

- The desktop always **initiates** a `Noise_KK_25519_ChaChaPoly_BLAKE2s` handshake (both statics are already known from the roster/pairing, so this is mutual authentication by construction - neither identity ever travels on the wire). The desktop is the always-on, source-of-truth side, so it owns the handshake timing rather than waiting on the phone.
- **Re-handshake every ~2 minutes** (`REHANDSHAKE_INTERVAL_MS`, WireGuard's `REKEY_AFTER_TIME`), for bounded post-compromise security - not just initial forward secrecy.
- Once established, application traffic (the `BridgeMessage` envelope from `wire/messages.ts`) is sealed with **libsodium-style secretstream framing** (`crypto/secretstream.ts`, `deriveSecretstreamPair`) keyed off the Noise session's chaining key. Secretstream framing gives truncation, reorder, and replay detection out of the box, distinct per direction (`SecretstreamDirectionPair`).
- No Double Ratchet: it solves offline-queued asynchronous messaging, which this interactive, always-connected link does not have.

`src/main/mobile-bridge/wire/session-frame.ts` (re-exported from the protocol package) tags every frame as either a `Handshake` frame (routed to the in-progress `HandshakeState`) or an `Application` frame (routed to the established secretstream pair), so handshake and application traffic can share one transport connection without ambiguity.

### Per-device connection state

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

`offline` and `reconnecting` are deliberately distinct: they call for opposite user actions (open
the phone vs. fix the network). `offline` is a presence conclusion rather than a transport state,
so it is **not** part of `MobileBridgeTransportState`, which must keep mirroring
`@kangentic/protocol`'s `TransportState` exactly.

Two guards keep the value honest without making it twitchy:

- **A probe budget before `offline`.** Every handshake initiation doubles as a presence probe.
  Silence for `PEER_PRESENCE_TIMEOUT_MS` (5s) spends one unit; only `PEER_PRESENCE_FAILURES_BEFORE_ABSENT`
  (2) consecutive failures conclude the peer is absent, so one slow round trip never flashes
  "Offline" on a live phone. An explicit goodbye (a `FrameTag.Final` frame) skips the budget. Once
  absent, `PEER_PROBE_INTERVAL_MS` (15s) keeps probing so a returning phone is picked up in ~20s
  rather than on the next rekey tick. The probe window is anchored to the start of an
  unestablished episode and is **never restarted** by a later initiation: `HANDSHAKE_RETRY_MS`
  (3s) re-initiates faster than the window expires, so a restartable window would let a relay
  injecting garbage handshake frames hold `offline` permanently out of reach and pin the badge on
  "Connecting..." forever.
- **Application traffic proves presence.** Promotion is evidence-based the same way demotion is:
  any frame the desktop can open came from the phone, since only it holds the matching send key,
  so opening one restarts the probe budget. Without that, presence rested on the handshake alone,
  and a single dropped initiation (a rekey is attempted every `REHANDSHAKE_INTERVAL_MS`, so a
  lossy relay gets a fresh chance every two minutes) drained the budget while the phone, never
  having learned a rekey was attempted, kept serving on streams the desktop was still decrypting.
  That reported "Offline" for a demonstrably live device: the exact mirror of the stale green
  "Connected" this whole state exists to remove.
- **A hold before surfacing a blip.** The relay force-closes both peers when either drops, so an
  ordinary phone reload costs a ~500ms reconnect plus a re-handshake. A known-good session keeps
  reporting `connected` for `RECONNECT_GRACE_MS` (2s), spanning the reconnect *and* the
  re-handshake, so the badge does not flicker `connected -> reconnecting -> connecting -> connected`
  on every reload. A genuine outage outlasts the hold and correctly falls through.

`MobileBridgeStatus.relayState` is the separate panel-wide aggregate over each session's
*transport* state, with precedence `connected > connecting > reconnecting > closed`. It describes
the relay link, so it deliberately stays transport-based. Because that precedence pins it at
`connected` the moment any one device connects, the renderer's `mobile:stateChanged` notification
is gated on a signature covering the aggregate **and** every device's own connection state -
gating on the aggregate alone left a second device's row frozen on "Connecting..." while its phone
was already serving data.

## Relay Transport

`src/main/mobile-bridge/transport/relay-client.ts` is the desktop's **outbound-only** WebSocket client to a blind relay (self-hostable, or Kangentic's hosted instance). The relay forwards opaque ciphertext frames only - it authenticates nothing and reads nothing, because every frame is already Noise-encrypted (or, during pairing, is itself a Noise handshake message the relay cannot decrypt).

- **Wire contract:** connect to `${relayUrl}?slot=<hex-encoded-slot-id>`. Both slot ids are *derived*: `derivePairingSlotId(token)` during pairing, and `deriveSessionSlotId(desktopKey, phoneKey)` for an ongoing session (both in `packages/protocol/src/crypto/slot.ts`, both 16 bytes / 32 hex characters). The relay rendezvouses the two connections presenting the *same* value and never interprets its cryptographic meaning, only its bytes. **Both slots are routing labels, never key material** - the slot rides in a query string, the most-logged part of a URL, so nothing secret may be placed there. **The relay server lives in the separate [`kangentic-relay`](https://github.com/Kangentic/kangentic-relay) repo**, which implements exactly this contract (see its README for the self-host quickstart and full config reference).
- **Reconnect with capped exponential backoff:** starts at 500ms, doubles up to a 30s ceiling, resets on a successful connect.
- **Per-session byte cap** (`maxBytesPerSession`, default 256MB) as defense-in-depth against a runaway send loop on either end.
- **Accountless:** no Kangentic account/entitlement coupling in this client. Any such gate belongs only on the hosted relay's own connection-acceptance policy (open-core design - see the research doc section 10); this client behaves identically against a self-hosted or Kangentic-hosted relay.
- `src/main/mobile-bridge/transport/transport-factory.ts` is the deliberate swap point: pairing service, bridge sessions, and the capability router only ever see the `Transport` interface (`packages/protocol/src/transport/transport.ts`). A future WebRTC data-channel implementation (Phase 4) slots in at `createTransport()` with nothing above it changing.

### Honest relay-metadata statement

Even a correctly-implemented blind relay is not metadata-invisible. A relay operator (including a self-hoster, or Kangentic operating the hosted instance) can observe: source and destination IPs, connection timing, frame sizes and frequency, and the pairing graph (which slot ids co-occur). None of that is message *content* - the relay cannot decrypt anything - but it is real, observable metadata. Mitigations: self-hosting the relay, single-use pairing tokens, and the relay's own connection caps and per-IP/per-slot rate limits so only paired devices can consume relay capacity at all (implemented in `kangentic-relay`'s guards; see its README). This statement should stay in any user-facing security documentation rather than being implied away.

## Scope

**Shipped (Bridge Phase 1 - protocol, pairing & secure relay transport):**

- `@kangentic/protocol` package: wire schema, Noise KK + IKpsk0 implementations, secretstream framing, capability verb list, roster signing, QR payload encode/decode, transport interface.
- Device identity (encrypted at rest via Electron `safeStorage`, refuses to persist unprotected).
- Signed device roster with revoke-drop (rekey-on-revoke is scaffolded but the full multi-device re-provisioning flow is deferred).
- QR pairing ceremony (token-bound Noise PSK + SAS confirmation) with desktop settings UI.
- The desktop's outbound relay CLIENT connection with reconnect/backoff.
- Mobile Devices settings tab: enable toggle, relay mode (resolved default vs. custom override) with a Test connection probe, pairing flow, paired-device list, revoke.
- **Pairing overhaul (one comparison, one tap):** the pairing-confirm frame (`packages/protocol/src/pairing/confirm.ts`) and desktop auto-enroll on it, replacing the desktop's own "Codes match" / "Codes don't match" question; the emoji half of the SAS display dropped everywhere (digits only); explicit ceremony timeouts on both the `waiting-for-phone` and `sas-pending` phases (there was none before - the pairing token's TTL was only checked lazily); `startPairing()` now supersedes a stale in-progress ceremony instead of throwing, and the settings tab cancels on unmount, so "Pair a device" always reopens a fresh QR. Paired-device cards now show the device's X25519 key fingerprint (`formatKeyFingerprint`, `packages/protocol/src/roster/fingerprint.ts` - matches `kangentic-mobile`'s own display exactly), live per-device connection state, and paired date, with rename added alongside revoke. See [Full access on pair](#full-access-on-pair) for the paired capability grant.

**Shipped (Bridge Phase 2 - data feeds, interactive control & capabilities):**

- `interactive-terminal`, `board-tool-read`, `board-tool-write` added to `CAPABILITY_VERBS`; per-verb request/response payload types (`packages/protocol/src/wire/payloads.ts`); `terminal`/`diff` event kinds and a reshaped project-keyed `BoardEvent` (`packages/protocol/src/events/event.ts`); a per-kind `framing.ts` event validator; `deriveSessionSlotId` for the ongoing-session relay slot.
- `MobileBridgeService.attachContext()` + `syncSessions()`: opens one live `BridgeSession` per roster device, routes decoded `capability-request` messages through `CapabilityRouter.dispatch()`.
- All 9 capability-verb handlers (`src/main/mobile-bridge/handlers/`), each described under [Data Feeds](#data-feeds) and [Board Tool Surface](#board-tool-surface) above.
- `SessionManager`'s unfiltered `data-tap` event and `ActivityStatsSnapshot.permissionAwaitedToolId`.
- The consolidated `BoardEventBus` (`IpcContext.boardEvents`).
- ~~Per-device capability-granting UI in the Mobile Devices settings tab (one toggle per verb, driven by `MOBILE_CAPABILITY_VERBS`).~~ Superseded: pairing now grants all ten verbs (see [Full access on pair](#full-access-on-pair)) and the per-verb toggle UI was removed; the capability CHECK and `setDeviceCapabilities()` surface it depended on stay as the seam for a future narrower preset.
- **Protocol 0.2.0 (typed feed payloads):** wire mirrors + phone-side runtime guards for every feed/response payload that was `JsonValue` in 0.1.x (`packages/protocol/src/events/payloads.ts`, typed `events/event.ts` + `wire/payloads.ts`, `capabilities/board-tools.ts` tool-name tuples), the desktop `wire-mappers.ts` adoption, the subscribe-time transcript seed, and the live `permission` activity event. Wire-compatible with 0.1.x (`PROTOCOL_VERSION` unchanged): it types what was already sent, plus two additive emissions.
- Still deferred within Phase 2's own scope: re-handshaking `BridgeSession` on a transport reconnect (mid-interval connect latency is a UX rough edge, not a correctness gap - the existing ~2-minute timer still re-handshakes).

**Shipped (Bridge Phase 3 - session lifecycle honesty & E2E push):**

- Protocol: the `session-ended` activity payload and read-stream `sessionStatus`, the `register-push` verb + payloads, the E2E push envelope (`crypto/push-envelope.ts`), and optional project accent colors on the read-board payloads. All additive and wire-compatible (absent fields parse as before on older peers).
- Desktop: `SessionLifecycleBoardFeed` (lifecycle edges onto the board-changed bus), the read-stream `session-ended` push + `sessionStatus` snapshot field, the push stack described under [Push Notifications](#push-notifications-e2e), and derived project accent colors in `read-board`.

**Shipped (Protocol 0.8.0 - what a session list actually costs):**

- Protocol: the read-stream subscribe `terminal` flag and the `message-preview` activity payload. Both additive and wire-compatible - absent means the previous behaviour, so an older phone and an older desktop each keep working against a newer peer.
- Desktop: `resolveTaskTranscript` revalidates a task by `fs.stat` before parsing any session, using file signatures recorded in the stitch memo itself (not read back from the file cache, which is a bounded LRU and goes empty on a busy board); `transcript-cache.ts`'s cap raised 16 -> 64 with a 192MB byte budget; `read-stream` honours `terminal: false` by attaching neither the `data-tap` nor the `pty-resize` listener and returning an empty `scrollback` instead of building a serialized frame; `message-preview.ts` derives the one line a phone's session list renders from the transcript the subscription already resolves.
- Why: measured from a Pixel over a LOOPBACK relay, one Home-feed refresh touched 20 transcript files totalling 319MB (a `--resume` writes a NEW file replaying its parent's whole history, so one task resumed five times owned 267MB across five near-identical files), and individual `transcript-window` requests took 0.7 to 3.8 seconds - the SMALLEST response was the slowest, because the cost was finding the entries rather than sending them. Separately, `event:terminal` streamed continuously to a phone showing no terminal at all (~13MB/hour), because every subscription carried PTY bytes the phone discards by design at its own terminal boundary.

**Shipped (Protocol 0.9.0 - a board projection that matches what a phone draws):**

- Protocol: the read-board subscribe `view` field (`'full' | 'sessions'`), the `view` echo and `taskCountsByColumnId` on the snapshot response, and an optional `backlog`. Additive in both directions: a pre-0.9.0 phone sends no `view` and gets the old payload verbatim; a 0.9.0 phone against a pre-0.9.0 desktop gets a full board with no `view` echo, which is exactly how it knows the snapshot was not filtered.
- Desktop: `read-board` builds the backlog only for a request that named no `view`, filters `tasks` to session-bearing ones under `'sessions'`, and sends whole-column counts alongside, since a phone appending a card to a column cannot take the column's length from a filtered list.
- Why: measured across a 15-project desktop, the boards were 63kB compressed of a ~96kB cold start. 23kB of that was a backlog no phone build has ever rendered, and another 30kB was tasks with no session on them, which the Agents feed never draws. Worse, a board subscription re-snapshots on every board change, so the whole payload repeated for as long as the phone stayed connected: for the busiest project that is 17.7kB per change against 4.6kB for the projection. The `'sessions'` view is 12kB for the same 15 projects, and the Board tab upgrades the one project the user actually opens to `'full'`.

**Shipped (Protocol 0.10.0 - a phone can open a finished conversation):**

- Protocol: a read-board `archived` action returning one page of completed tasks, newest first, each carrying its lifetime session summary. Additive, so `PROTOCOL_VERSION` stays '2' and the handshake is unchanged.
- Desktop: `listArchivedPage` is a paging sibling of `listArchivedPreview` (the preview takes no offset, and `listArchived` loads the entire archive - the cost its own comment warns about - to serve one screenful); the summary is `getSummaryForTask`'s existing lifetime aggregate, so a task worked across five `--resume` legs reports all five session rows rather than under-reporting to the final leg, with `toolBreakdown` dropped at the wire mapper for want of a phone counterpart. `read-stream`'s `transcript-window` branch moves ABOVE the live-session gate rather than relaxing it, so every other action still demands a running session exactly as before, and resolving the owning project gains a database fallback because the session manager's lookup is backed by the live registry.
- Why: neither 0.9.0 projection carries a completed task, since both are built from the non-archived task list - a phone that only ever subscribed had no way to know the archive existed. The archive is an action rather than a snapshot field on purpose: a board subscription re-snapshots on every board change and the archive only grows, so folding it in would re-send an ever-larger payload for the life of the connection, the exact cost the 0.9.0 projections were added to remove. And because a task is archived only after its agent is suspended and its `session_id` nulled, the live-session gate made a finished conversation permanently unreadable, which is most of what a completed task is worth opening for.

**Shipped (Protocol 0.11.0 - the project list a phone draws is the one the desktop groups):**

- Protocol: `ReadBoardProjectGroup`, optional `groupId` / `position` on `ReadBoardProjectSummary`, and an optional `groups` array on the project-list response. Additive; `PROTOCOL_VERSION` stays '2'. A malformed group entry is dropped rather than failing the whole listing, since the projects are what the phone cannot work without and grouping degrades to the flat list it rendered before.
- Desktop: `read-board`'s project-list branch includes each project's `group_id` and `position` plus the group list itself. This needed no new plumbing - `ProjectGroupRepository` is already on `IpcContext`, and both fields are already columns on `projects`.
- Why: the phone's switcher was a flat list of every project on the machine, in no order the user recognizes, while the desktop sidebar had grouped them for some time - and that structure is exactly what a small screen needs most. An older phone ignores the new fields; a newer phone against an older desktop receives no groups, puts every project in the ungrouped bucket, and renders the same flat list it always did.

**Shipped (Protocol 0.11.1 - a relay address is parsed, not prefix-matched):**

- `isSecureRelayAddress` now parses the URL authority instead of prefix-matching it. `ws://127.0.0.1:8080@evil.test` previously returned true, because everything before an `@` in an authority is credentials: that address dials `evil.test`, and since the pairing token WAS the Noise PSK, dialed verbatim as the relay's `?slot=`, one crafted QR field put the PSK on the wire in cleartext to an attacker-chosen host, which `activePairing` then persisted as the trust anchor for every later session. (That particular exposure is closed as of 0.12.0 below, which derives the slot instead - but the address-pinning reason for this fix stands on its own, which is why the rule stays.) The loopback carve-out sits outside any dev gate, so this reached production builds.
- Parsing subsumes the old boundary check (`localhost.evil.com` is simply a different host, not a prefix needing a special case). The IPv6 branch REJECTS trailing garbage after the closing bracket rather than trimming to it: truncating reads `ws://[::1]evil.com` as the host `[::1]`, handing the carve-out to an attacker-controlled name - a narrower hole than the original, but the same kind. The module stays hand-rolled rather than using `new URL()` by contract: the renderer deep-imports it, so pulling in the rest of the package would drag Noise crypto into that bundle, and the mobile app runs the same rules on Hermes, whose URL implementation is partial.

**Shipped (Protocol 0.12.0 - the pairing slot is derived, and an unauthenticated frame cannot end a ceremony):**

- Protocol: `derivePairingSlotId(token)` (`crypto/slot.ts`), a labeled BLAKE2s hash giving a 16-byte pairing slot. **Breaking**, and the first `PROTOCOL_VERSION` bump since '2': the slot is a zero-negotiation rendezvous value, so peers deriving it differently never meet. Binding the version turns that into a `version-incompatible` result at QR-scan time, before anything dials, instead of a hang until the relay's park timeout. The version is also in the KK prologue, so every already-paired device must re-pair - acceptable only because mobile has not rolled out.
- Why: the 32-byte token was doing three jobs - the single-use pairing token, the Noise `IKpsk0` PSK, and (hex-encoded) the relay slot dialed as a cleartext `?slot=` query parameter. The third published the first two. On a hosted relay, whatever terminates TLS sees the full request URI, so `IKpsk0` degraded to plain `IK` for such an observer and the `psk0` contribution bought nothing against them. Deriving the slot keeps the routing label public and the PSK secret; the token now never leaves the QR. No relay change was needed - its default `SLOT_ID_PATTERN` already accepts a 32-hex slot.
- Desktop: `PairingService` no longer consumes the pairing token before authenticating. It builds a **fresh responder handshake per inbound frame** and commits it only once `readMessage` succeeds, because `readMessage` advances `messageIndex` and mixes the sender's ephemeral into the transcript *before* it authenticates, so a rejected frame would poison a shared `HandshakeState` even after the token survived. Rejected frames are ignored rather than ending the ceremony, in both `waiting-for-phone` and `sas-pending` (safe in the latter because `CipherState` advances its nonce only on a successful decrypt). Message 2 is now sent after every state transition is committed, closing a re-entrancy window that only opens once multiple frames can arrive in one phase, and its send is wrapped so a transport that throws (`RelayClient` rejects a send while not connected) fails the ceremony immediately rather than parking it for the whole SAS timeout.
- Why: the token was marked consumed on the *first frame received*, before any authentication. Since the slot id needed to deliver that frame was the token itself, travelling in cleartext in the relay URL, anyone who could read the request URI - or photograph the QR - could burn a ceremony deterministically with one frame and no key material. The user saw "pairing is broken," not an attack. Guessing stays bounded by the token's 10-minute TTL, the relay's per-IP rate limits, and its cap of two peers per slot; an attempt counter that aborted at N would only have turned a one-frame denial into an N-frame one.
- Residual, not fixed here: an attacker who learns the slot can still squat it (the relay caps a slot at two peers and answers the third with close code 4409), denying the pairing. No desktop change addresses that, and the derived slot makes the slot much harder to learn in the first place.
- Residual, not fixed here: a phone on an older `PROTOCOL_VERSION` that dials anyway is now indistinguishable from a hostile frame. Its message 1 fails `readMessage` on the prologue mismatch and is ignored rather than ending the ceremony, so the desktop sits in `waiting-for-phone` until the token's 10-minute TTL instead of surfacing an error immediately, as it did before. The QR-scan version check is what is meant to catch this, and it lives in the mobile app: there is no desktop-side oracle that could separate "wrong version" from "wrong token" pre-authentication without also handing an attacker a probe.
- Residual, not fixed here: `sas-pending` now accepts unbounded rejected confirm frames where it previously ended on the first, and `openPairingConfirm` runs its AEAD over the whole raw frame before any length check. `RelayClient` bounds only what it SENDS (`maxBytesPerSession`); its `onmessage` path has no size guard, and pairing frames never pass through `decodeMessage`'s `MAX_FRAME_LENGTH`. So an attacker who reaches the slot can spend main-process CPU proportional to frame size for the full 5-minute window. The bound belongs on the transport's receive path rather than in `PairingService`, which is why it is not fixed here.

**Explicitly out of scope, later phases:**

- **Bridge Phase 3 remainder:** full desktop static-key rotation and re-provisioning of remaining paired devices on revoke; fuller device-management UX beyond rename/revoke (grouping, a narrower capability preset such as "view only").
- **Bridge Phase 4 (direct P2P + IPv6 speed upgrade):** WebRTC data channels (`node-datachannel` desktop / `react-native-webrtc` mobile), signaling over the already-secure channel, DTLS fingerprint pinning, IPv6-first candidate ordering, Tailscale detection.
- **The relay SERVER.** This doc describes the desktop's client-side contract against a relay; the relay itself (a tiny stateless blind byte-forwarder) lives in the separate, open-source [`kangentic-relay`](https://github.com/Kangentic/kangentic-relay) repo and is not part of this codebase.
- The mobile app itself (`kangentic-mobile`, a separate repo).

## See Also

- [Mobile Companion App Research](research/mobile-companion-app.md) - Full product rationale, transport decision (relay-first), security architecture, notification design, and phasing this doc summarizes.
- [Architecture > Mobile Bridge](architecture.md#mobile-bridge-14-channels) - IPC channel table.
- [Configuration](configuration.md) - `AppConfig.mobileBridge` (`enabled`, `relayMode`, `relayUrl`) and `src/shared/relay.ts`'s resolver/validator.
- [Board Integration](board-integration.md) - The analogous per-provider adapter pattern this bridge's `Transport` swap point mirrors in spirit.

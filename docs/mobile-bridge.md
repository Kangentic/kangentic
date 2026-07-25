# Mobile Bridge

Kangentic's mobile companion app (`kangentic-mobile`, a separate repo) pairs with the desktop over an end-to-end encrypted connection so a user can walk away from their PC while agents run, then get notified, read the live conversation, see code changes, send messages back, and move tasks from their phone. The full product rationale and architecture research live in [docs/research/mobile-companion-app.md](research/mobile-companion-app.md); this doc covers what actually shipped in the desktop bridge and the shared protocol package.

This doc covers **Phase 1 (protocol, pairing & secure relay transport)**, **Phase 2 (data feeds, interactive control & capabilities)**, and the shipped core of **Phase 3 (session lifecycle honesty & E2E push notifications)**: identity, pairing ceremony, signed device roster, capability-verb envelope, ongoing session crypto, outbound relay transport client, the live capability-verb handlers, the data feeds they subscribe to (SessionManager output, the transcript service, board state, `DiffService`), and the E2E-encrypted push pipeline. See [Scope](#scope) at the bottom for what is still deferred to later phases.

## Layout

```
packages/protocol/src/       # @kangentic/protocol - shared wire schema + crypto, desktop and mobile
  crypto/
    primitives.ts            # X25519/Ed25519 keypairs, random bytes, hex helpers
    noise/                   # Noise Protocol Framework: handshake state, cipher state, KK + IKpsk0 patterns
    pairing-handshake.ts     # Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s driver for pairing
    sas.ts                   # Short Authentication String derivation
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
    pairing-service.ts        # one pairing ceremony: handshake -> SAS -> confirm
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
    board-tool-allowlist.ts      # per-tool read/mutate classification (excludes query_db + move_task/list_tasks/list_columns/list_backlog, which duplicate dedicated verbs; browser/devtools/diagnostics/cross-project tools are absent from commandHandlers, so they are excluded for free)
    register-push.ts             # push registration keyed by the requesting session's roster deviceId
    project-color.ts             # deterministic per-project accent color for read-board
  prompt-options-probe.ts     # pure parser: pending dialog's numbered option labels out of a serialized PTY frame
  board-event-bus.ts          # consolidated main-process board-mutation event stream (IpcContext.boardEvents)
  session-lifecycle-feed.ts   # bridges SessionManager session-changed/exit edges onto the board-changed bus
  mobile-bridge-service.ts    # top-level service: identity, roster, pairing, sessions, attachContext()
```

The desktop service is constructed in `src/main/ipc/register-all.ts` and torn down synchronously in `src/main/index.ts`'s `clearPendingTimers` (see [Synchronous Shutdown](../.claude/rules/synchronous-shutdown.md)). It is wired to the renderer through the full 7-layer IPC bridge - channels in `src/shared/ipc-channels.ts` (`MOBILE_*`, see [Architecture > Mobile Bridge](architecture.md#mobile-bridge-10-channels)), types in `src/shared/types.ts` ("Mobile Bridge" section), the `mobile:` namespace in `src/preload/preload.ts`, the handler in `src/main/ipc/handlers/mobile-bridge.ts`, the `useMobileStore` renderer store, and the Mobile Devices settings tab.

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

1. The user clicks "Pair a device" in the Mobile Devices settings tab. This mints a single-use `PairingToken` (32 random bytes, ~10 minute TTL - `PAIRING_TOKEN_TTL_MS` in `pairing-token.ts`) and opens a relay connection on a slot keyed by the token's hex encoding.
2. The QR payload (`PairingQrPayload`, encoded as a `kangentic-pair://...` URI by `packages/protocol/src/pairing/qr.ts`) carries: the desktop's static X25519 public key, the pairing token, the relay address, an expiry timestamp, and the protocol version. It is a pairing *bootstrap*, not a long-lived secret.
3. The phone scans the QR and runs the initiator side of a **Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s** handshake (`packages/protocol/src/crypto/pairing-handshake.ts`), with the pairing token mixed in as the Noise PSK.

### Design decision: token-bound Noise PSK instead of SPAKE2

The original research doc considered a PAKE (SPAKE2) for the pairing exchange so two devices could authenticate from a short, human-typed code. What actually shipped uses a **high-entropy, machine-generated token as a Noise PSK** instead. The reasoning, documented in `pairing-handshake.ts`'s module comment: a PAKE's real value is defending a *low-entropy, human-typed* code against offline dictionary attacks. A 32-byte token scanned from a QR is already high-entropy, so an online-guess-only, single-use property (the same property a PAKE would give a short code) falls out of the token itself - no PAKE is needed to get it. Avoiding SPAKE2 also sidesteps a real practical gap: there is no maintained, audited JavaScript SPAKE2 implementation (the one npm package is years-stale, draft-08, and Node-only, which would have broken React Native parity). Using PSK-mode Noise instead keeps exactly **one** audited crypto primitive (Noise) across both pairing and ongoing sessions, rather than two.

### SAS confirmation

After the handshake completes, both sides derive a **Short Authentication String** (`packages/protocol/src/crypto/sas.ts`, `deriveShortAuthenticationString`) from the handshake transcript hash - a 6-digit code plus a short emoji sequence, Matrix-style commitment-before-reveal. The desktop's settings UI shows this alongside a device-name field and two buttons: "Codes match" and "Codes don't match." The user visually compares the code against what the phone displays. This step defeats a photographed or relayed QR: an attacker who intercepts the QR cannot also make both sides' SAS values agree, because the SAS is derived from a live handshake transcript involving both parties' ephemeral keys, not from anything printed on the QR.

Confirming ("Codes match") signs the phone's static public key into the device roster with a display name and an initial capability grant (`DEFAULT_PAIRING_CAPABILITIES` - `read-stream`, `read-board`, `read-diff`, `board-tool-read`, `register-push`; write/control verbs are granted explicitly afterward, not by default). Rejecting ("Codes don't match") or cancelling tears down the pairing ceremony without touching the roster.

## Signed Device Roster

`src/main/mobile-bridge/roster-store.ts` persists a `DeviceRoster` (one JSON file, globally scoped - like the identity, this represents the desktop installation, not any one project). Every entry (`RosterDeviceEntry`: device id, static public key, display name, capabilities, paired-at, expiry, signature) is signed with the desktop's Ed25519 master signing key at pairing time and **re-verified against that same key every time the roster is loaded from disk**. A corrupted or hand-edited roster file degrades to "that device drops out," not "an unverified entry is silently trusted" - the roster, not the relay, is the source of truth for who is paired.

### Revocation is drop-plus-rekey

Revoking a device (`revokeDevice()`) removes its entry from the roster **and** is intended to rotate the desktop's own static identity key. Dropping the roster entry alone is not sufficient: Noise KK's mutual authentication only proves possession of a static keypair, so a revoked device that already completed a handshake could still authenticate against a future session as long as the desktop's static key is unchanged. Phases 1 and 2 ship the roster-side "drop" half (`roster-store.ts`'s `revokeDevice`) plus live `BridgeSession`/subscription teardown for that device (`MobileBridgeService.disposeSession`); a full key-rotation-and-re-provisioning flow for any *other* still-paired devices is Phase 3 scope, since a small paired-device count is the common case in practice.

## Capability Verbs

`packages/protocol/src/capabilities/verbs.ts` defines the complete allowlist a paired device can be granted:

- `read-stream` - live scrollback, terminal output, activity/usage telemetry, and transcript deltas for one session.
- `read-board` - a project's columns/tasks/backlog, or (with no `projectId`) the machine's project list; live updates via the board-changed bus.
- `read-diff` - a task's diff file list or a single file's content, via `DiffService`; live "something changed, re-fetch" pushes via a bridge-owned `DiffWatcher`.
- `send-user-message` - deliver text to a running session via the same bracketed-paste path (`TerminalSubmit.submitContent`) the renderer's Browser-pane Send affordance uses.
- `move-task` - move a task between columns via `handleTaskMove` (respects `withTaskLock` and the transition engine).
- `answer-permission-prompt` - the most sensitive verb; binds a phone's raw keystrokes to a specific outstanding permission-prompt id before writing them to the PTY.
- `interactive-terminal` - raw PTY write-path parity (full desktop-terminal keystroke control), an explicit-grant-only verb, not in the read-only default. Three actions ride the one grant: `write` (the default; an action-less payload from a pre-0.4.0 phone parses as a write), `resize` (fit-to-phone: sets the PTY grid so the TUI redraws phone-shaped), and `release-size` (give the grid back). Resize deliberately shares the write grant - a device trusted to type raw bytes into the PTY gains nothing new from resizing it. While a phone holds a session's grid, a per-device guard (`handlers/terminal-size-guard.ts`) registered in the same `SubscriptionRegistry` restores the desktop's last dimensions on EVERY release path: explicit `release-size`, device disconnect, roster revoke, or bridge shutdown; it disarms without restoring when the session exits. Contention is latest-writer-wins - a desktop resize while a phone holds simply wins and becomes the new restore target; with two phones, either one's release restores desktop dims (documented limitation).
- `board-tool-read` / `board-tool-write` - the long-tail task/backlog CRUD surface (create, edit, delete, link PR, ...) that has no dedicated verb, split by read vs mutate access so the grant granularity matches the rest of the model. **Not MCP** - no agent, LLM, or JSON-RPC round-trip is involved; see [Board Tool Surface](#board-tool-surface) below.
- `register-push` - register (or unregister) the device for E2E-encrypted push notifications: the phone hands over its Expo push token plus a device-generated 32-byte push-envelope key, keyed by the requesting session's authenticated roster identity, never by payload content. See [Push Notifications](#push-notifications-e2e) below.

There is **deliberately no shell, file-read, or arbitrary-command verb** - absent from the protocol entirely, not filtered at runtime. This mirrors the lesson from SSH forced-command escapes and is the counter-example to Chrome Remote Desktop / VS Code tunnels, which are identity-gated but capability-unscoped. Adding a verb to this list is a protocol change; it does not by itself grant anything to a device - a device's roster entry still has to include the verb in its `CapabilitySet`, and the desktop's `CapabilityRouter` still has to have a handler registered for it.

`src/main/mobile-bridge/capability-router.ts` is the desktop-side dispatch point: it checks the requesting session's `CapabilitySet` (bound at pairing time, adjustable per-device afterward via the Mobile Devices settings tab's per-verb toggles) before even looking up a handler, so an unauthorized verb is rejected before any handler code runs. Every verb has a registered handler (`src/main/mobile-bridge/handlers/`, wired once by `MobileBridgeService.attachContext()`); an authorized-but-unregistered verb would still fail closed with an explicit "no handler registered" error rather than doing nothing silently - that guarantee stays load-bearing even though nothing exercises it in production today.

`DEFAULT_PAIRING_CAPABILITIES` (granted automatically on a successful pairing) is the read-only set plus push registration: `read-stream`, `read-board`, `read-diff`, `board-tool-read`, `register-push` (registering for notifications neither reads nor mutates the board or any session). Every write/control verb (`send-user-message`, `move-task`, `answer-permission-prompt`, `interactive-terminal`, `board-tool-write`) requires an explicit grant afterward via the settings UI.

## Data Feeds

Each `read-*` handler subscribes to a live main-process source and pushes `BridgeEvent`s (`packages/protocol/src/events/event.ts`: `transcript` / `activity` / `terminal` / `terminal-resize` / `board` / `diff`) over the established `BridgeSession`, tracked per-device in a `SubscriptionRegistry` so a device's live subscriptions tear down together on disconnect or revocation:

- **`read-stream`** taps `SessionManager`'s **unfiltered `data-tap` event** (`src/main/pty/session-manager.ts`), added specifically for this feed: SessionManager's pre-existing `data` event is gated to `focusedSessionIds` (the renderer's active tab), so a background session's output never reached a listener that isn't the focused renderer tab. `data-tap` fires for every session's output unconditionally and does not feed the renderer's backpressure accounting (that protocol exists only for the focused-tab drain handshake). Raw output is coalesced on a short timer before pushing (`TerminalEvent`), with a small-payload fast path that flushes a keystroke echo immediately instead of waiting out the timer. The subscribe snapshot reports the PTY's grid (`ptyDimensions`), and `SessionManager`'s `pty-resize` emission (fired on every resize of any origin, plus once at spawn) is forwarded as a `terminal-resize` event - after flushing pending old-grid output first - so the phone renders at exactly the grid the bytes were laid out for instead of guessing a width. `activity`/`usage`/`event` telemetry pushes as `ActivityEvent`. Transcripts never ship wholesale (a long session's full conversation exceeds the 1 MiB frame cap): `handlers/transcript-sync.ts` diffs each new `resolveTaskTranscript` revision against exactly what this subscription was last sent (uuid-keyed, with a source-reference serialization cache) and pushes only the changed/new entries as absolute-indexed `TranscriptEvent` delta upserts, split into byte-budgeted chunks - or a `reset` signal when the phone cannot patch (shrink, reorder, degraded/index source). Subscribing seeds the sync state without pushing; the phone bootstraps its view with the `transcript-window` action (newest `limit` entries before `beforeIndex`, byte-budgeted), and pages older history the same way on scroll-up. The subscribe snapshot also reports `sessionStatus` (`running` / `queued` / `suspended` / `exited`; absent from pre-0.5.0 desktops, which the phone reads as `running`), and when the streamed session's PTY exits the subscription's last word - pushed between the final terminal flush and its own teardown - is a `session-ended` activity payload whose `intentional` flag distinguishes a deliberate stop from a crash.

Feed payload CONTENTS are typed by the wire mirrors in `packages/protocol/src/events/payloads.ts` (`TranscriptEntryWire`, `ActivityStateWire`/`ActivityReasonWire`, `SessionUsageWire`, `BoardColumnWire`/`BoardTaskWire`/`BacklogItemWire`, `DiffFileListWire`/`DiffFileContentWire`), which deliberately MIRROR the desktop shapes rather than import them - the protocol package is a dependency-light leaf shared with the phone. `src/main/mobile-bridge/handlers/wire-mappers.ts` is the one place each mirror meets its desktop source type, replacing the Phase-2-era `as unknown as JsonValue` casts, so a desktop-type change that would break the wire surfaces there as a compile error. The protocol package also ships the phone-side runtime guards (`isBridgeEvent`, `parseTranscriptEntriesWire`, `parseReadStreamResponsePayload`, ...) that narrow a decoded payload before the phone trusts a field.
- **`read-board`** subscribes to `IpcContext.boardEvents` (below), filtered by `projectId`.
- **`read-diff`** subscribes a **bridge-owned `DiffWatcher`** instance (`MobileBridgeService`'s own `diffWatcher` field), never `IpcContext.diffWatcher` - that instance is shared with the renderer's Changes panel and is single-watch-per-path, so a bridge teardown would kill the renderer's live watch on the same worktree (and vice versa).

### Consolidated board-changed bus

`src/main/mobile-bridge/board-event-bus.ts`'s `BoardEventBus` (exposed as `IpcContext.boardEvents`, a plain Node `EventEmitter`, not an IPC channel) is a single main-process-internal stream for every agent-driven board mutation, so `read-board` subscribes once instead of listening to each ad-hoc `IPC.*_BY_AGENT` renderer-push channel individually. It is fed **additively**, right next to the existing `sendToRenderer(...)` calls in `buildCommandContextForProject`'s six callbacks (`src/main/agent/mcp-project-context.ts`) and the PR-linking push (`src/main/pr/pr-linking.ts`) - the renderer's existing `*_BY_AGENT` pushes and `useAgentDrivenInvalidation` are untouched.

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
- `move_task`, `list_tasks`, `list_columns`, `list_backlog` - real, safe `commandHandlers` entries, but **duplicates** of the dedicated `move-task` and `read-board` verbs, which give a cleaner contract (swimlaneId not column-name resolution; full `Task`/`Swimlane` objects; `read-board` also has a live subscription these one-shot tools lack). Excluding them here keeps exactly one path per capability instead of two competing ones.
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

## Relay Transport

`src/main/mobile-bridge/transport/relay-client.ts` is the desktop's **outbound-only** WebSocket client to a blind relay (self-hostable, or Kangentic's hosted instance). The relay forwards opaque ciphertext frames only - it authenticates nothing and reads nothing, because every frame is already Noise-encrypted (or, during pairing, is itself a Noise handshake message the relay cannot decrypt).

- **Wire contract:** connect to `${relayUrl}?slot=<hex-encoded-slot-id>`. During pairing, the slot id is the pairing token (so the relay rendezvouses the phone and desktop connections that present the *same* token); for an ongoing session, it is a value derived from the paired device's static key. The relay never interprets the slot id's cryptographic meaning, only its bytes. **The relay server lives in the separate [`kangentic-relay`](https://github.com/Kangentic/kangentic-relay) repo**, which implements exactly this contract (see its README for the self-host quickstart and full config reference).
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

**Shipped (Bridge Phase 2 - data feeds, interactive control & capabilities):**

- `interactive-terminal`, `board-tool-read`, `board-tool-write` added to `CAPABILITY_VERBS`; per-verb request/response payload types (`packages/protocol/src/wire/payloads.ts`); `terminal`/`diff` event kinds and a reshaped project-keyed `BoardEvent` (`packages/protocol/src/events/event.ts`); a per-kind `framing.ts` event validator; `deriveSessionSlotId` for the ongoing-session relay slot.
- `MobileBridgeService.attachContext()` + `syncSessions()`: opens one live `BridgeSession` per roster device, routes decoded `capability-request` messages through `CapabilityRouter.dispatch()`.
- All 9 capability-verb handlers (`src/main/mobile-bridge/handlers/`), each described under [Data Feeds](#data-feeds) and [Board Tool Surface](#board-tool-surface) above.
- `SessionManager`'s unfiltered `data-tap` event and `ActivityStatsSnapshot.permissionAwaitedToolId`.
- The consolidated `BoardEventBus` (`IpcContext.boardEvents`).
- Per-device capability-granting UI in the Mobile Devices settings tab (one toggle per verb, driven by `MOBILE_CAPABILITY_VERBS`).
- **Protocol 0.2.0 (typed feed payloads):** wire mirrors + phone-side runtime guards for every feed/response payload that was `JsonValue` in 0.1.x (`packages/protocol/src/events/payloads.ts`, typed `events/event.ts` + `wire/payloads.ts`, `capabilities/board-tools.ts` tool-name tuples), the desktop `wire-mappers.ts` adoption, the subscribe-time transcript seed, and the live `permission` activity event. Wire-compatible with 0.1.x (`PROTOCOL_VERSION` unchanged): it types what was already sent, plus two additive emissions.
- Still deferred within Phase 2's own scope: re-handshaking `BridgeSession` on a transport reconnect (mid-interval connect latency is a UX rough edge, not a correctness gap - the existing ~2-minute timer still re-handshakes).

**Shipped (Bridge Phase 3 - session lifecycle honesty & E2E push):**

- Protocol: the `session-ended` activity payload and read-stream `sessionStatus`, the `register-push` verb + payloads, the E2E push envelope (`crypto/push-envelope.ts`), and optional project accent colors on the read-board payloads. All additive and wire-compatible (absent fields parse as before on older peers).
- Desktop: `SessionLifecycleBoardFeed` (lifecycle edges onto the board-changed bus), the read-stream `session-ended` push + `sessionStatus` snapshot field, the push stack described under [Push Notifications](#push-notifications-e2e), and derived project accent colors in `read-board`.

**Shipped (Protocol 0.8.0 - what a session list actually costs):**

- Protocol: the read-stream subscribe `terminal` flag and the `message-preview` activity payload. Both additive and wire-compatible - absent means the previous behaviour, so an older phone and an older desktop each keep working against a newer peer.
- Desktop: `resolveTaskTranscript` revalidates a task by `fs.stat` before parsing any session, using file signatures recorded in the stitch memo itself (not read back from the file cache, which is a bounded LRU and goes empty on a busy board); `transcript-cache.ts`'s cap raised 16 -> 64 with a 192MB byte budget; `read-stream` honours `terminal: false` by attaching neither the `data-tap` nor the `pty-resize` listener and returning an empty `scrollback` instead of building a serialized frame; `message-preview.ts` derives the one line a phone's session list renders from the transcript the subscription already resolves.
- Why: measured from a Pixel over a LOOPBACK relay, one Home-feed refresh touched 20 transcript files totalling 319MB (a `--resume` writes a NEW file replaying its parent's whole history, so one task resumed five times owned 267MB across five near-identical files), and individual `transcript-window` requests took 0.7 to 3.8 seconds - the SMALLEST response was the slowest, because the cost was finding the entries rather than sending them. Separately, `event:terminal` streamed continuously to a phone showing no terminal at all (~13MB/hour), because every subscription carried PTY bytes the phone discards by design at its own terminal boundary.

**Explicitly out of scope, later phases:**

- **Bridge Phase 3 remainder:** full desktop static-key rotation and re-provisioning of remaining paired devices on revoke; fuller device-management UX beyond the per-verb toggles.
- **Bridge Phase 4 (direct P2P + IPv6 speed upgrade):** WebRTC data channels (`node-datachannel` desktop / `react-native-webrtc` mobile), signaling over the already-secure channel, DTLS fingerprint pinning, IPv6-first candidate ordering, Tailscale detection.
- **The relay SERVER.** This doc describes the desktop's client-side contract against a relay; the relay itself (a tiny stateless blind byte-forwarder) lives in the separate, open-source [`kangentic-relay`](https://github.com/Kangentic/kangentic-relay) repo and is not part of this codebase.
- The mobile app itself (`kangentic-mobile`, a separate repo).

## See Also

- [Mobile Companion App Research](research/mobile-companion-app.md) - Full product rationale, transport decision (relay-first), security architecture, notification design, and phasing this doc summarizes.
- [Architecture > Mobile Bridge](architecture.md#mobile-bridge-11-channels) - IPC channel table.
- [Configuration](configuration.md) - `AppConfig.mobileBridge` (`enabled`, `relayMode`, `relayUrl`) and `src/shared/relay.ts`'s resolver/validator.
- [Board Integration](board-integration.md) - The analogous per-provider adapter pattern this bridge's `Transport` swap point mirrors in spirit.

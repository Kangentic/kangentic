---
type: Reference
title: Mobile bridge overview
description: The bridge's dev-only quick-pair and local relay mode, the source layout of src/main/mobile-bridge and packages/protocol, why @kangentic/protocol is a separate package with its own version tags, and how protocol changes stay wire-compatible across the desktop, mobile and relay repos.
tags: [mobile, bridge, protocol, layout]
sources:
  - resource: src/main/mobile-bridge/
  - resource: packages/protocol/src/
  - resource: src/shared/relay.ts
    title: resolveRelayMode, resolveRelayUrl
  - resource: .github/workflows/publish-protocol.yml
---
# Mobile bridge overview

Kangentic's mobile companion app (`kangentic-mobile`, a separate repo) pairs with the desktop over an end-to-end encrypted connection so a user can walk away from their PC while agents run, then get notified, read the live conversation, see code changes, send messages back, and move tasks from their phone. The full product rationale and architecture research live in [docs/research/mobile-companion-app.md](../../research/mobile-companion-app.md); this doc covers what actually shipped in the desktop bridge and the shared protocol package.

This doc covers **Phase 1 (protocol, pairing & secure relay transport)**, **Phase 2 (data feeds, interactive control & capabilities)**, and the shipped core of **Phase 3 (session lifecycle honesty & E2E push notifications)**: identity, pairing ceremony, signed device roster, capability-verb envelope, ongoing session crypto, outbound relay transport client, the live capability-verb handlers, the data feeds they subscribe to (SessionManager output, the transcript service, board state, `DiffService`), and the E2E-encrypted push pipeline. See [Scope](scope.md) for what is still deferred to later phases.

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
    push-clear.ts            # sealed clear message (data.clear), same key, AAD and freshness window as push-envelope
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
  request-spans.ts            # timing spans a handler records against one phone request, for the slow-request line
  pairing/
    pairing-token.ts          # single-use, ~10min pairing token
    pairing-service.ts        # one pairing ceremony: handshake -> SAS -> phone confirm frame -> auto-enroll
  transport/
    relay-client.ts           # outbound WebSocket relay client with reconnect/backoff, forced redial, dial watchdog, stack choice per dial
    relay-websocket.ts        # Electron's net.WebSocket as the fallback stack (proxy configured, or undici failing twice)
    transport-factory.ts      # Transport swap point (relay today, P2P later)
  session/
    bridge-session.ts         # one connected device's Noise KK session + re-handshake timer + spent-budget redial
    forced-redial-reason.ts   # closed enum for why a session forced a redial (paired-silent / parked-stale), shared by the event and the analytics gate
    subscription-registry.ts  # per-device live event subscriptions (read-stream/board/diff), keyed and torn down together
  push/
    push-registration-store.ts # per-device Expo token + envelope key sidecar (cleared on revoke)
    wake-channel.ts            # WakeChannel interface, the vendor-neutral seam PushNotifier sends through (Expo is the only implementation)
    expo-push-client.ts        # injected-fetch POST to the Expo push API (no SDK), DeviceNotRegistered surfaced
    push-notifier.ts           # trigger policy: category mapping, presence suppression, cooldown, debounce, clear triggers and sends
    push-clear-ledger.ts       # per-device record of notifications sent and clears owed (memory only)
    spawn-stall-watcher.ts     # main-process timer that feeds the spawn-stalled category
  capability-router.ts        # deny-by-default verb dispatch
  handlers/                   # one module per capability verb, registered once at attachContext()
    read-stream.ts            # SessionManager scrollback/data-tap/activity/usage + transcript deltas & windows
    transcript-sync.ts         # per-subscription transcript diff engine: indexed delta upserts, chunking, reset fallback
    read-board.ts              # repository snapshot + the consolidated board-changed bus
    read-diff.ts               # DiffService (bridge-owned DiffWatcher, never IpcContext.diffWatcher)
    send-user-message.ts       # delivery via TerminalSubmit.submitContent (bracketed paste), not a raw write; held for a task with no running agent
    move-task.ts               # routes through handleTaskMove (task-lifecycle-lock + transition engine)
    start-session.ts           # resume or start in the task's current column via startTaskSession (paused: resumeTaskSession; else autoSpawnForTask -> spawnAgent)
    pause-session.ts           # pause a task's live session via pauseTaskSession, the desktop Pause button's own path
    command-terminal.ts        # start or resume (startCommandTerminal, unattended), list-earlier (CommandTerminalHistory.list) or stop (endCommandTerminal) a Command Terminal, refusals by typed code
    interactive-terminal.ts    # raw PTY write/resize/release-size (explicit grant only)
    terminal-size-guard.ts     # restores desktop PTY dims when a phone-held grid releases (any path)
    answer-permission-prompt.ts # binds the response to a specific outstanding prompt id
    board-tool.ts                # board-tool-read/board-tool-write - NOT MCP; routes directly into commandHandlers, gated by board-tool-allowlist.ts
    board-tool-allowlist.ts      # per-tool read/mutate classification (excludes query_db + create_column/delete_column + move_task/reorder_tasks/list_tasks/list_columns/list_backlog + reserve_dev_ports/check_dev_ports + the automation tools + every workflow tool but list/get/pause/resume; browser/devtools/diagnostics/cross-project tools are absent from commandHandlers, so they are excluded for free)
    workflow-wire.ts             # a board's workflow facts per task (strip, route, wait, lock), read from the desktop board's own workflow summaries
    register-push.ts             # push registration keyed by the requesting session's roster deviceId
    project-color.ts             # deterministic per-project accent color for read-board
    known-project.ts             # resolves the project a verb names (read-board, read-diff, the task verbs, a command-terminal start), refusing an id the desktop does not know
    session-refusals.ts          # the session refusals; the unknown-session code is added for a missing row and for an ended (suspended or exited) one
    index.ts                     # registers every handler with the capability router
    permission-prompt-id.ts      # builds the prompt id answer-permission-prompt binds a response to
    send-event.ts                # pushes one event to a paired phone over its session
    wire-mappers.ts              # maps desktop types to their wire shapes
  prompt-options-probe.ts     # pure parser: pending dialog's numbered option labels out of a serialized PTY frame
  board-event-bus.ts          # consolidated main-process board-mutation event stream (IpcContext.boardEvents)
  session-lifecycle-feed.ts   # bridges SessionManager session-changed/session-removed/exit edges onto the board-changed bus
  mobile-bridge-service.ts    # top-level service: identity, roster, pairing, sessions, attachContext()
```

The desktop service is constructed in `src/main/ipc/register-all.ts` and torn down synchronously in `src/main/index.ts`'s `clearPendingTimers` (see [Synchronous Shutdown](../../../.claude/rules/synchronous-shutdown.md)). It is wired to the renderer through the full 7-layer IPC bridge - channels in `src/shared/ipc-channels.ts` (`MOBILE_*`, see [Mobile Bridge](../../architecture/ipc/app-channels.md#mobile-bridge-14-channels)), types in `src/shared/types.ts` ("Mobile Bridge" section), the `mobile:` namespace in `src/preload/preload.ts`, the handler in `src/main/ipc/handlers/mobile-bridge.ts`, the `useMobileStore` renderer store, and the Mobile Devices settings tab.

## Why a separate package

`@kangentic/protocol` is a local npm workspace (`packages/protocol/`), built independently (`npm run build -w packages/protocol`) and published as its own npm package. It is dependency-free of anything Electron- or Node-specific in its public surface (only `@noble/ciphers`, `@noble/curves`, `@noble/hashes` - pure JS, portable to React Native), so the same wire schema, Noise implementation, and capability-verb list are shared verbatim between the desktop and the future mobile app, with no risk of the two drifting.

Its version and release cadence are **deliberately decoupled from Kangentic's own** - `packages/protocol/package.json` carries its own semver line, bumped and tagged (`protocol-vX.Y.Z`, a separate namespace from Kangentic's `vX.Y.Z` release tags) by the `/release-protocol` skill, published by its own workflow (`.github/workflows/publish-protocol.yml`), independent of the `kangentic` launcher's publish step in `release.yml`. This lets the protocol package ship on its own schedule while the mobile bridge feature is still being built out, without requiring or triggering a full Kangentic desktop release. In-repo, the desktop still consumes the package's TypeScript source directly via the `@kangentic/protocol` alias (see Layout above) - only the external, published npm artifact follows the separate versioning.

### Iterating on the protocol across repos (without publishing every change)

`@kangentic/protocol` is consumed by three repos: this monorepo (the desktop, in-repo workspace), `kangentic-mobile`, and `kangentic-relay`. Publishing to npm on every protocol tweak is a slow path, so while the wire is still firming up:

- **This monorepo's `main` is the protocol's source of truth.** Protocol changes land on `main` via PR, decoupled from npm publishing; publish (`/release-protocol`) only at a release milestone or when a consumer's cloud build needs the pinned version resolvable from npm.
- **The desktop** rebuilds the workspace after editing protocol source (`npm run build --workspace packages/protocol`) and **restarts** - the mobile-bridge runs in the Electron main process, which does not hot-reload, so an in-place protocol edit is not picked up until a restart.
- **The mobile app and the relay** pin `@kangentic/protocol` to a published `^x.y.z` in their committed `package.json`, but for local dev their tooling links the freshly built sibling `packages/protocol` into `node_modules` (kangentic-mobile's dev rig does this automatically via `ensureLocalProtocol`; see that repo's `docs/contributing/developer-guide.md`). The committed manifest is never rewritten to a local path - only `node_modules` is linked - so a fresh clone or CI still resolves the published version.
- **Wire compatibility:** additive, backward-compatible changes keep `PROTOCOL_VERSION` the same so mixed-version peers interoperate; a breaking wire change bumps `PROTOCOL_VERSION` (bound into the Noise prologue) and requires all peers to upgrade together. A new capability verb is additive. A desktop whose build carries the unsupported-verb refusal (see [Capability Verbs](capability-verbs.md#capability-verbs-1)) answers an unknown verb with an `unsupported-verb` code instead of dropping the frame, which is what makes an old desktop detectable from a newer phone; a desktop older than that refusal still drops the frame silently.

## See Also

- [Mobile Companion App Research](../../research/mobile-companion-app.md) - Full product rationale, transport decision (relay-first), security architecture, notification design, and phasing this doc summarizes.
- [Mobile Bridge](../../architecture/ipc/app-channels.md#mobile-bridge-14-channels) - IPC channel table.
- [Settings](../../settings/index.md) - `AppConfig.mobileBridge` (`enabled`, `relayMode`, `relayUrl`) and `src/shared/relay.ts`'s resolver/validator.
- [Board Integration](../boards.md) - The analogous per-provider adapter pattern this bridge's `Transport` swap point mirrors in spirit.

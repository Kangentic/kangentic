# Mobile bridge

## Start here

* [Mobile bridge overview](overview.md) - The bridge's dev-only quick-pair and local relay mode, the source layout of src/main/mobile-bridge and packages/protocol, why @kangentic/protocol is a separate package with its own version tags, and how protocol changes stay wire-compatible across the desktop, mobile and relay repos.

## Pairing and security

* [Pairing and device roster](pairing-and-roster.md) - How a phone pairs: the QR payload, single-use token and derived relay slot, the token-bound Noise PSK chosen over SPAKE2, SAS comparison and the pairing-confirm frame, the Ed25519-signed device roster, drop-plus-rekey revocation, and the full-access grant re-applied at each launch.
* [Session encryption and connection state](session-encryption.md) - How an ongoing phone session is secured and reported: the desktop-initiated Noise KK handshake, the two-minute rekey, frames held across a rekey, replies read oldest first, secretstream framing, and the connection states, probe budget and reconnect hold behind the Offline badge.

## What a phone can do

* [Capability verbs](capability-verbs.md) - The verbs a paired phone can call and each handler's contract: when move-task, start-session and pause-session answer, command-terminal refusal codes, interactive-terminal grid ownership, permission-prompt id binding, the unsupported-verb refusal, and which board tools the allowlist leaves out.
* [Data feeds](data-feeds.md) - How read-stream, read-board and read-diff feed a phone: the data-tap seed barrier and terminal seed shrinking, transcript delta sync, board snapshot fields (spawn_progress, resumable, paused, paused_session_id, pausable, commandTerminals), and the board-changed bus with its lifecycle and spawn-progress feeds.
* [Push notifications](push-notifications.md) - How the desktop sends end-to-end encrypted pushes through Expo: device registration, the XChaCha20-Poly1305 envelope with recipient-key AAD, the six categories and their debounce, presence suppression and cooldown, iOS versus Android payload shape, and clear messages that remove stale alerts.

## Connection and history

* [Relay transport](relay-transport.md) - The desktop's outbound WebSocket client to the blind relay: slot wire contract, undici versus Chromium stack choice, backoff, forced redial and dial watchdog, power and unlock wake handling, a table for reading each mobile-bridge log line, and what a relay operator can still observe.
* [Scope and protocol history](scope.md) - What shipped in each bridge phase and protocol release from 0.2.0 to 0.21.0 with the reason for each change, including the derived pairing slot in 0.12.0 and the start, pause and command-terminal verbs, the workflow fields, the built but unreleased task report read, and what stays out of scope.

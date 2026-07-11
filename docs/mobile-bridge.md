# Mobile Bridge

Kangentic's mobile companion app (`kangentic-mobile`, a separate repo) pairs with the desktop over an end-to-end encrypted connection so a user can walk away from their PC while agents run, then get notified, read the live conversation, see code changes, send messages back, and move tasks from their phone. The full product rationale and architecture research live in [docs/research/mobile-companion-app.md](research/mobile-companion-app.md); this doc covers what actually shipped in the desktop bridge and the shared protocol package.

This doc covers **Phase 1: Protocol, pairing & secure relay transport** - the identity, pairing ceremony, signed device roster, capability-verb envelope, ongoing session crypto, and outbound relay transport client. See [Scope](#scope) at the bottom for what is explicitly deferred to later phases.

## Layout

```
packages/protocol/src/       # @kangentic/protocol - shared wire schema + crypto, desktop and mobile
  crypto/
    primitives.ts            # X25519/Ed25519 keypairs, random bytes, hex helpers
    noise/                   # Noise Protocol Framework: handshake state, cipher state, KK + IKpsk0 patterns
    pairing-handshake.ts     # Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s driver for pairing
    sas.ts                   # Short Authentication String derivation
    secretstream.ts          # libsodium-style secretstream framing for ongoing session traffic
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
  session/bridge-session.ts   # one connected device's Noise KK session + re-handshake timer
  capability-router.ts        # deny-by-default verb dispatch (no handlers yet - Phase 2)
  mobile-bridge-service.ts    # top-level service: identity, roster, pairing, sessions
```

The desktop service is constructed in `src/main/ipc/register-all.ts` and torn down synchronously in `src/main/index.ts`'s `clearPendingTimers` (see [Synchronous Shutdown](../.claude/rules/synchronous-shutdown.md)). It is wired to the renderer through the full 7-layer IPC bridge - channels in `src/shared/ipc-channels.ts` (`MOBILE_*`, see [Architecture > Mobile Bridge](architecture.md#mobile-bridge-10-channels)), types in `src/shared/types.ts` ("Mobile Bridge" section), the `mobile:` namespace in `src/preload/preload.ts`, the handler in `src/main/ipc/handlers/mobile-bridge.ts`, the `useMobileStore` renderer store, and the Mobile Devices settings tab.

## Why a separate package

`@kangentic/protocol` is a local npm workspace (`packages/protocol/`), built independently (`npm run build -w packages/protocol`) and published as its own npm package. It is dependency-free of anything Electron- or Node-specific in its public surface (only `@noble/ciphers`, `@noble/curves`, `@noble/hashes` - pure JS, portable to React Native), so the same wire schema, Noise implementation, and capability-verb list are shared verbatim between the desktop and the future mobile app, with no risk of the two drifting.

Its version and release cadence are **deliberately decoupled from Kangentic's own** - `packages/protocol/package.json` carries its own semver line, bumped and tagged (`protocol-vX.Y.Z`, a separate namespace from Kangentic's `vX.Y.Z` release tags) by the `/release-protocol` skill, published by its own workflow (`.github/workflows/publish-protocol.yml`), independent of the `kangentic` launcher's publish step in `release.yml`. This lets the protocol package ship on its own schedule while the mobile bridge feature is still being built out, without requiring or triggering a full Kangentic desktop release. In-repo, the desktop still consumes the package's TypeScript source directly via the `@kangentic/protocol` alias (see Layout above) - only the external, published npm artifact follows the separate versioning.

## Pairing Ceremony

Direction: **the desktop displays a QR code, the phone scans it.** The desktop is the trust root.

1. The user clicks "Pair a device" in the Mobile Devices settings tab. This mints a single-use `PairingToken` (32 random bytes, ~10 minute TTL - `PAIRING_TOKEN_TTL_MS` in `pairing-token.ts`) and opens a relay connection on a slot keyed by the token's hex encoding.
2. The QR payload (`PairingQrPayload`, encoded as a `kangentic-pair://...` URI by `packages/protocol/src/pairing/qr.ts`) carries: the desktop's static X25519 public key, the pairing token, the relay address, an expiry timestamp, and the protocol version. It is a pairing *bootstrap*, not a long-lived secret.
3. The phone scans the QR and runs the initiator side of a **Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s** handshake (`packages/protocol/src/crypto/pairing-handshake.ts`), with the pairing token mixed in as the Noise PSK.

### Design decision: token-bound Noise PSK instead of SPAKE2

The original research doc considered a PAKE (SPAKE2) for the pairing exchange so two devices could authenticate from a short, human-typed code. What actually shipped uses a **high-entropy, machine-generated token as a Noise PSK** instead. The reasoning, documented in `pairing-handshake.ts`'s module comment: a PAKE's real value is defending a *low-entropy, human-typed* code against offline dictionary attacks. A 32-byte token scanned from a QR is already high-entropy, so an online-guess-only, single-use property (the same property a PAKE would give a short code) falls out of the token itself - no PAKE is needed to get it. Avoiding SPAKE2 also sidesteps a real practical gap: there is no maintained, audited JavaScript SPAKE2 implementation (the one npm package is years-stale, draft-08, and Node-only, which would have broken React Native parity). Using PSK-mode Noise instead keeps exactly **one** audited crypto primitive (Noise) across both pairing and ongoing sessions, rather than two.

### SAS confirmation

After the handshake completes, both sides derive a **Short Authentication String** (`packages/protocol/src/crypto/sas.ts`, `deriveShortAuthenticationString`) from the handshake transcript hash - a 6-digit code plus a short emoji sequence, Matrix-style commitment-before-reveal. The desktop's settings UI shows this alongside a device-name field and two buttons: "Codes match" and "Codes don't match." The user visually compares the code against what the phone displays. This step defeats a photographed or relayed QR: an attacker who intercepts the QR cannot also make both sides' SAS values agree, because the SAS is derived from a live handshake transcript involving both parties' ephemeral keys, not from anything printed on the QR.

Confirming ("Codes match") signs the phone's static public key into the device roster with a display name and an initial capability grant (`DEFAULT_PAIRING_CAPABILITIES` - `read-stream`, `read-board`, `read-diff`; write/control verbs are granted explicitly afterward, not by default). Rejecting ("Codes don't match") or cancelling tears down the pairing ceremony without touching the roster.

## Signed Device Roster

`src/main/mobile-bridge/roster-store.ts` persists a `DeviceRoster` (one JSON file, globally scoped - like the identity, this represents the desktop installation, not any one project). Every entry (`RosterDeviceEntry`: device id, static public key, display name, capabilities, paired-at, expiry, signature) is signed with the desktop's Ed25519 master signing key at pairing time and **re-verified against that same key every time the roster is loaded from disk**. A corrupted or hand-edited roster file degrades to "that device drops out," not "an unverified entry is silently trusted" - the roster, not the relay, is the source of truth for who is paired.

### Revocation is drop-plus-rekey

Revoking a device (`revokeDevice()`) removes its entry from the roster **and** is intended to rotate the desktop's own static identity key. Dropping the roster entry alone is not sufficient: Noise KK's mutual authentication only proves possession of a static keypair, so a revoked device that already completed a handshake could still authenticate against a future session as long as the desktop's static key is unchanged. Phase 1 ships the roster-side "drop" half (`roster-store.ts`'s `revokeDevice`) plus session teardown for that device; a full key-rotation-and-re-provisioning flow for any *other* still-paired devices is Phase 2/3 scope, since Phase 1 typically has at most one paired device to reason about in practice.

## Capability Verbs

`packages/protocol/src/capabilities/verbs.ts` defines the complete allowlist a paired device can be granted:

- `read-stream`
- `read-board`
- `read-diff`
- `send-user-message`
- `move-task`
- `answer-permission-prompt`

There is **deliberately no shell, file-read, or arbitrary-command verb** - absent from the protocol entirely, not filtered at runtime. This mirrors the lesson from SSH forced-command escapes and is the counter-example to Chrome Remote Desktop / VS Code tunnels, which are identity-gated but capability-unscoped. Adding a verb to this list is a protocol change; it does not by itself grant anything to a device - a device's roster entry still has to include the verb in its `CapabilitySet`, and the desktop's `CapabilityRouter` still has to have a handler registered for it.

`src/main/mobile-bridge/capability-router.ts` is the desktop-side dispatch point: it checks the requesting session's `CapabilitySet` (bound at pairing time, adjustable per-device afterward) before even looking up a handler, so an unauthorized verb is rejected before any handler code runs. **Phase 1 ships the router and the deny-by-default authorization check only - no verb has a registered handler yet.** An authorized-but-unregistered verb fails closed with an explicit "no handler registered" error rather than doing nothing silently. Wiring real handlers (SessionManager output tap, transcript service, repositories, DiffService, activity engine, the PTY write path) is Phase 2.

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

**Shipped in this phase (Bridge Phase 1):**

- `@kangentic/protocol` package: wire schema, Noise KK + IKpsk0 implementations, secretstream framing, capability verb list, roster signing, QR payload encode/decode, transport interface.
- Device identity (encrypted at rest via Electron `safeStorage`, refuses to persist unprotected).
- Signed device roster with revoke-drop (rekey-on-revoke is scaffolded but the full multi-device re-provisioning flow is deferred).
- QR pairing ceremony (token-bound Noise PSK + SAS confirmation) with desktop settings UI.
- The desktop's outbound relay CLIENT connection with reconnect/backoff.
- `CapabilityRouter` with the deny-by-default authorization check (no verb handlers registered).
- Mobile Devices settings tab: enable toggle, relay URL, pairing flow, paired-device list, revoke.

**Explicitly out of scope for this phase:**

- **Bridge Phase 2 (data feeds, interactive control & capabilities):** actual capability-verb handlers wired to `SessionManager`'s output tap, the transcript service, repositories, `DiffService`, and the activity engine; the PTY write path for phone-originated input, including `answer-permission-prompt` bound to a specific outstanding prompt id; a consolidated main-side board event stream; the MCP tool surface exposed to paired devices.
- **Bridge Phase 3 (notifications & push sender):** moving the notification should-fire policy into main; an Expo push sender; presence suppression; the paired-devices capability-editing UI beyond revoke.
- **Bridge Phase 4 (direct P2P + IPv6 speed upgrade):** WebRTC data channels (`node-datachannel` desktop / `react-native-webrtc` mobile), signaling over the already-secure channel, DTLS fingerprint pinning, IPv6-first candidate ordering, Tailscale detection.
- **The relay SERVER.** This doc describes the desktop's client-side contract against a relay; the relay itself (a tiny stateless blind byte-forwarder) lives in the separate, open-source [`kangentic-relay`](https://github.com/Kangentic/kangentic-relay) repo and is not part of this codebase.
- The mobile app itself (`kangentic-mobile`, a separate repo).

## See Also

- [Mobile Companion App Research](research/mobile-companion-app.md) - Full product rationale, transport decision (relay-first), security architecture, notification design, and phasing this doc summarizes.
- [Architecture > Mobile Bridge](architecture.md#mobile-bridge-10-channels) - IPC channel table.
- [Configuration](configuration.md) - `AppConfig.mobileBridge` (`enabled`, `relayUrl`).
- [Board Integration](board-integration.md) - The analogous per-provider adapter pattern this bridge's `Transport` swap point mirrors in spirit.

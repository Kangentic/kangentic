---
type: Reference
title: Pairing and device roster
description: "How a phone pairs: the QR payload, single-use token and derived relay slot, the token-bound Noise PSK chosen over SPAKE2, SAS comparison and the pairing-confirm frame, the Ed25519-signed device roster, drop-plus-rekey revocation, and the full-access grant re-applied at each launch."
tags: [mobile, pairing, roster, noise]
sources:
  - resource: src/main/mobile-bridge/pairing/pairing-service.ts
  - resource: src/main/mobile-bridge/pairing/pairing-token.ts
  - resource: src/main/mobile-bridge/roster-store.ts
  - resource: src/main/mobile-bridge/mobile-bridge-service.ts
  - resource: packages/protocol/src/crypto/pairing-handshake.ts
  - resource: packages/protocol/src/crypto/sas.ts
  - resource: packages/protocol/src/crypto/slot.ts
  - resource: packages/protocol/src/pairing/confirm.ts
  - resource: packages/protocol/src/pairing/qr.ts
  - resource: packages/protocol/src/roster/roster.ts
  - resource: packages/protocol/src/roster/fingerprint.ts
---
# Pairing and device roster

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

On a successful open, the desktop auto-enrolls: it signs the phone's static public key (never any key carried in a payload - `PairingService` always reads `HandshakeState.getRemoteStaticKey()`) into the device roster, using the phone-supplied device name from the handshake's message-1 payload and the full capability grant (see [Capability Verbs](capability-verbs.md#capability-verbs-1)). The desktop only interrupts the human on **timeout** (`waiting-for-phone` bounded by whatever is left of the pairing token's 10-minute TTL, `sas-pending` a flat 5-minute window, generous because a human is physically tapping their phone). A confirm frame that fails to open is **ignored**, not surfaced as a mismatch: the frame is unauthenticated and the relay slot is reachable by anyone who can read the request URI, so ending the ceremony on the first bad one handed any such observer a way to abort a pairing at will. Ignoring is safe because `CipherState` advances its nonce only on a successful decrypt, so the real frame still opens afterward. A device's name can be changed afterward from the paired-devices list; renaming is not part of the ceremony.

## Signed Device Roster

`src/main/mobile-bridge/roster-store.ts` persists a `DeviceRoster` (one JSON file, globally scoped - like the identity, this represents the desktop installation, not any one project). Every entry (`RosterDeviceEntry`: device id, static public key, display name, capabilities, paired-at, expiry, signature) is signed with the desktop's Ed25519 master signing key at pairing time and **re-verified against that same key every time the roster is loaded from disk**. A corrupted or hand-edited roster file degrades to "that device drops out," not "an unverified entry is silently trusted" - the roster, not the relay, is the source of truth for who is paired.

The paired-devices list identifies each device by a **key fingerprint** (`packages/protocol/src/roster/fingerprint.ts`, `formatKeyFingerprint`): the leading 16 hex characters of its static public key, in four space-separated groups. That is the identity the ceremony actually bound and the SAS actually confirmed, unlike a display name (not unique, and user-editable) or a hardware id (unavailable on modern Android, and permanent PII). The mobile app formats it identically, so a user can hold the phone next to the desktop and compare the two directly - hence front-only slice, no ellipsis, no case change.

### Revocation is drop-plus-rekey

Revoking a device (`revokeDevice()`) removes its entry from the roster **and** is intended to rotate the desktop's own static identity key. Dropping the roster entry alone is not sufficient: Noise KK's mutual authentication only proves possession of a static keypair, so a revoked device that already completed a handshake could still authenticate against a future session as long as the desktop's static key is unchanged. Phases 1 and 2 ship the roster-side "drop" half (`roster-store.ts`'s `revokeDevice`) plus live `BridgeSession`/subscription teardown for that device (`MobileBridgeService.disposeSession`); a full key-rotation-and-re-provisioning flow for any *other* still-paired devices is Phase 3 scope, since a small paired-device count is the common case in practice.

Revocation is also **announced**: before the drop, `revokeDevice()` sends a `FrameTag.Final` goodbye over the established session (`BridgeSession.sendGoodbye`, a no-op when the session is not established or its transport is down), so a connected phone clears its own pairing - trust anchor, push key, cached desktop content - immediately instead of showing "Connecting" forever against a slot the desktop will never dial again. The same signal works in reverse: when the phone's own unpair Final arrives, the desktop drops the device outright (roster, push registration, session) rather than merely marking it offline, with no goodbye echoed back. A Final is only ever sent on deliberate unpair - never on quit, disable, shutdown, backgrounding, or reconnect - which is exactly what lets both sides act on it as revocation.

### Full access on pair

`DEFAULT_PAIRING_CAPABILITIES` (granted automatically on a successful pairing) is **every verb** - `[...CAPABILITY_VERBS]`, so a verb added to the protocol is granted on pair with no desktop change. The phone is an extension of the user's own desktop environment, not a third-party integration: the same person holds both devices, and the QR scan plus SAS comparison (now the pairing-confirm frame - see [SAS confirmation](#sas-confirmation-and-the-pairing-confirm-frame)) already prove physical possession of both, so pairing is the only approval the human needs to give. What stays true regardless of the grant: the protocol still defines no shell, file, or arbitrary-command verb at all, and **unpair remains the kill switch**.

Every app launch checks each paired device's grant (`migrateDevicesToFullCapabilityGrant()`, run once per launch inside the `whenStorageReady()` warm-up that `attachContext()` starts and that session sync awaits, so it lands before any session opens), and re-grants the full set to a device missing any verb. Its guard is an in-memory flag, so the check repeats on every launch. That is how a device paired before this change, or before a new verb, gets the full grant. It also means a narrower set written through `setDeviceCapabilities()` lasts only until the next launch, so a future narrower preset has to change this migration to grant only verbs added since the device paired, or to remember that it ran. The re-grant goes through `setDeviceCapabilities()` so the roster entry is correctly re-signed rather than silently invalidated (capabilities are inside the Ed25519-signed payload; see [Signed Device Roster](#signed-device-roster)).

The per-device capability CHECK stays (`CapabilityRouter.dispatch`'s deny-by-default gate, `setDeviceCapabilities()`'s IPC/service surface) as the seam for a future narrower preset ("view only"), but the Mobile Devices settings tab no longer exposes a per-verb toggle UI - there is nothing to configure at pairing time, and per-device controls are limited to rename and unpair/revoke.

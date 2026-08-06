/**
 * The protocol version string. Bumped on any wire-incompatible change to
 * framing, message shapes, the handshake patterns, or the relay slot
 * derivations in this package.
 *
 * A slot derivation counts because the slot is a zero-negotiation rendezvous
 * value: peers computing it differently never meet, and would otherwise just
 * hang until the relay's park timeout. Binding the version here instead turns
 * that into an explicit "update the app" at QR-scan time, before anything
 * dials. v3 derives the pairing slot from the token rather than using the
 * token verbatim (see crypto/slot.ts's derivePairingSlotId).
 *
 * Bound into every Noise handshake's prologue (see crypto/noise/kk.ts and
 * crypto/pairing-handshake.ts), so two peers running different protocol
 * versions fail the handshake outright instead of silently downgrading: a
 * differing prologue produces a differing transcript hash `h` from the
 * first MixHash call, which cascades into every derived key.
 */
export const PROTOCOL_VERSION = '3';

export function encodeProtocolVersion(version: string = PROTOCOL_VERSION): Uint8Array {
  return new TextEncoder().encode(`kangentic-bridge-v${version}`);
}

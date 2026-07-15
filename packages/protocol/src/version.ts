/**
 * The protocol version string. Bumped on any wire-incompatible change to
 * framing, message shapes, or the handshake patterns in this package.
 *
 * Bound into every Noise handshake's prologue (see crypto/noise/kk.ts and
 * crypto/pairing-handshake.ts), so two peers running different protocol
 * versions fail the handshake outright instead of silently downgrading: a
 * differing prologue produces a differing transcript hash `h` from the
 * first MixHash call, which cascades into every derived key.
 */
export const PROTOCOL_VERSION = '2';

export function encodeProtocolVersion(version: string = PROTOCOL_VERSION): Uint8Array {
  return new TextEncoder().encode(`kangentic-bridge-v${version}`);
}

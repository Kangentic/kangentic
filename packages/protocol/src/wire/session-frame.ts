/**
 * A one-byte frame-kind prefix for the ONGOING SESSION connection only
 * (not pairing, which never mixes frame kinds on its dedicated
 * connection). A bridge session periodically re-handshakes on the same
 * transport connection it also carries application traffic on (Noise KK
 * every ~2 minutes, per the research doc's bounded post-compromise
 * security design), so an incoming frame is otherwise ambiguous: "the
 * next message of an in-progress Noise handshake" and "a secretstream-sealed
 * application frame" are both just opaque bytes at the transport level.
 * This tiny, unauthenticated-but-harmless prefix removes that ambiguity
 * for BOTH peers (desktop and mobile), so it lives here rather than as a
 * desktop-only convention.
 */
export const SessionFrameKind = {
  Handshake: 0,
  Application: 1,
} as const;
export type SessionFrameKind = (typeof SessionFrameKind)[keyof typeof SessionFrameKind];

export function wrapSessionFrame(kind: SessionFrameKind, payload: Uint8Array): Uint8Array {
  const wrapped = new Uint8Array(payload.length + 1);
  wrapped[0] = kind;
  wrapped.set(payload, 1);
  return wrapped;
}

export function unwrapSessionFrame(frame: Uint8Array): { kind: SessionFrameKind; payload: Uint8Array } {
  if (frame.length < 1) throw new Error('Session frame is too short to contain a kind byte');
  const kind = frame[0];
  if (kind !== SessionFrameKind.Handshake && kind !== SessionFrameKind.Application) {
    throw new Error(`Unknown session frame kind: ${kind}`);
  }
  return { kind, payload: frame.subarray(1) };
}

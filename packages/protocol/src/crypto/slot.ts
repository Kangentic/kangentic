/**
 * Derives the relay rendezvous slot id for an ONGOING (post-pairing) bridge
 * session, as a deterministic function of both peers' static public keys
 * (see relay-client.ts's wire-contract doc: "a value derived from the
 * paired device's static key for an ongoing session"). Desktop-first
 * ordering in the concatenation keeps it symmetric: both peers already know
 * both static keys from the pairing roster, so either side computes the
 * same slot id independently, with no extra negotiation round-trip.
 *
 * This is a BLIND rendezvous label only - the relay never learns its
 * cryptographic meaning, only its bytes, and every frame sent through it is
 * already Noise-encrypted. It is intentionally stable (a pure function of
 * the two static keys) rather than a rotating epoch, so a relay operator
 * can correlate a device's reconnects over time by watching the same slot
 * id recur; the channel CONTENTS stay end-to-end encrypted regardless. A
 * rotating-epoch variant is a candidate future hardening, not required for
 * Phase 2.
 */
import { deriveLabeledKey, concatBytes, bytesToHex } from './primitives';

const SESSION_SLOT_LABEL = 'kangentic-session-slot-v1';
const SESSION_SLOT_LENGTH = 16;

export function deriveSessionSlotId(desktopStaticPublicKey: Uint8Array, phoneStaticPublicKey: Uint8Array): string {
  const material = concatBytes(desktopStaticPublicKey, phoneStaticPublicKey);
  return bytesToHex(deriveLabeledKey(material, SESSION_SLOT_LABEL, SESSION_SLOT_LENGTH));
}

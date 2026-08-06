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

const PAIRING_SLOT_LABEL = 'kangentic-pairing-slot-v1';
const PAIRING_SLOT_LENGTH = 16;

/**
 * Derives the relay rendezvous slot id for the PAIRING ceremony from the
 * pairing token, for both peers to dial.
 *
 * The slot must be derived rather than being the token itself, because it
 * travels in cleartext in the relay URL's query string while the same token is
 * the Noise IKpsk0 pre-shared key. Dialing it verbatim published the PSK to
 * every hop that can read a request URI - on a hosted relay that includes
 * whatever terminates TLS - which reduced IKpsk0 to plain IK for such an
 * observer. A one-way labeled hash keeps the routing label public and the PSK
 * secret: the token itself now never leaves the QR code.
 *
 * The result is a routing label, NOT key material. Its 128 bits are sized to
 * defeat blind enumeration, which is all a rendezvous label has to do.
 */
export function derivePairingSlotId(pairingToken: Uint8Array): string {
  return bytesToHex(deriveLabeledKey(pairingToken, PAIRING_SLOT_LABEL, PAIRING_SLOT_LENGTH));
}

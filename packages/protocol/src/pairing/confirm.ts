/**
 * The pairing-confirm frame: one AEAD-sealed message the phone sends after
 * the human taps Confirm, over the transport key the completed IKpsk0
 * handshake just produced (HandshakeState.writeMessage's `split` result -
 * see pairing-handshake.ts). This is a LIVENESS AND INTENT signal, not the
 * pairing's security boundary: a relay-in-the-middle already holds a valid
 * session with the desktop and could forge any frame it wants. The actual
 * defense is unchanged - the human compares the desktop's SAS digits
 * against the phone's, and only taps Confirm on a match.
 *
 * What this frame buys instead: both peers derive their transport keys
 * from the SAME completed handshake transcript (getHandshakeHash/split are
 * both functions of the transcript), so if the sealed frame opens under the
 * desktop's key, the two transcripts necessarily agree - which means the
 * SAS the human compared necessarily agreed too. The AEAD open IS the
 * desktop's SAS verification; that is why the frame carries no digits of
 * its own.
 *
 * A failed open is IGNORED rather than treated as a ceremony-ending failure.
 * The frame is unauthenticated and the relay slot is reachable by anyone who
 * can read the request URI, so treating one bad frame as a mismatch let an
 * observer end a pairing at will. The caller stays in its sas-pending phase
 * and lets its own timeout decide - see pairing-service.ts's
 * handleConfirmFrame().
 *
 * There is no reject frame. Backing out of the ceremony on the phone closes
 * the transport without sending this frame; close-without-confirm is the
 * rejection, observed by the desktop as its pairing timeout (see
 * pairing-service.ts's phase timers).
 */
import { CipherState } from '../crypto/noise/cipher-state';

const PAIRING_CONFIRM_PLAINTEXT = new TextEncoder().encode('kangentic-pairing-confirm-v1');
const EMPTY_ASSOCIATED_DATA = new Uint8Array(0);

/**
 * Seals the confirm frame under the initiator-to-responder cipher state
 * (index 0 of HandshakeState's `split` pair, by Noise Protocol Framework
 * convention). Called once per ceremony, so nonce reuse under this key is
 * not a concern - the key itself is fresh per handshake transcript.
 */
export function sealPairingConfirm(initiatorToResponder: CipherState): Uint8Array {
  return initiatorToResponder.encryptWithAd(EMPTY_ASSOCIATED_DATA, PAIRING_CONFIRM_PLAINTEXT);
}

/**
 * Opens a received confirm frame. Returns false (never throws) on a
 * tampered/wrong-key ciphertext or an unexpected plaintext, so the caller
 * can treat "could not verify" uniformly whether the failure was
 * cryptographic or structural.
 *
 * A false return from a FAILED DECRYPT leaves `initiatorToResponder` untouched:
 * CipherState advances its nonce only on a successful decrypt, so a caller may
 * keep waiting for the real frame after rejecting any number of bad ones. Scoped
 * to that path deliberately - the structural checks below return false only
 * after a decrypt already succeeded and already advanced the nonce. They are
 * unreachable in practice (an authenticating tag means the plaintext is the one
 * sealPairingConfirm wrote) and kept as belt-and-braces, but a caller that ever
 * made them reachable would not inherit the keep-waiting guarantee.
 */
export function openPairingConfirm(initiatorToResponder: CipherState, frame: Uint8Array): boolean {
  let plaintext: Uint8Array;
  try {
    plaintext = initiatorToResponder.decryptWithAd(EMPTY_ASSOCIATED_DATA, frame);
  } catch {
    return false;
  }
  if (plaintext.length !== PAIRING_CONFIRM_PLAINTEXT.length) return false;
  let mismatch = 0;
  for (let index = 0; index < plaintext.length; index += 1) {
    mismatch |= plaintext[index] ^ PAIRING_CONFIRM_PLAINTEXT[index];
  }
  return mismatch === 0;
}

/** Noise message-pattern tokens (section 5.3, plus "psk" from section 9). */
export type NoiseToken = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';

export interface NoisePattern {
  /** Used to construct the protocol name, e.g. "KK" -> Noise_KK_25519_ChaChaPoly_BLAKE2s. */
  readonly name: string;
  readonly initiatorPreMessage: readonly NoiseToken[];
  readonly responderPreMessage: readonly NoiseToken[];
  readonly messages: readonly (readonly NoiseToken[])[];
  /**
   * Noise section 9.2: in a PSK handshake every "e" token calls
   * MixKey(e.public_key) in addition to the MixHash(e.public_key) a
   * non-PSK handshake always does. This must be a property of the
   * PATTERN (not inferred from "was a psk option passed"), since it
   * changes how the "e" token itself is processed, independent of
   * whether the pattern's own "psk" token has been reached yet.
   */
  readonly usesPsk: boolean;
}

/**
 * Both parties' static keys are known in advance (mutual authentication by
 * construction, no trust-on-first-use). Used for ongoing bridge sessions
 * once a device is in the signed roster.
 *
 *   KK:
 *     -> s
 *     <- s
 *     ...
 *     -> e, es, ss
 *     <- e, ee, se
 */
export const KK_PATTERN: NoisePattern = {
  name: 'KK',
  initiatorPreMessage: ['s'],
  responderPreMessage: ['s'],
  messages: [
    ['e', 'es', 'ss'],
    ['e', 'ee', 'se'],
  ],
  usesPsk: false,
};

/**
 * The initiator (phone) knows the responder's (desktop's) static key from
 * the QR in advance; the responder learns the initiator's static key from
 * the "s" token in message 1, which is exactly how the desktop learns the
 * phone's identity key during pairing. The "psk0" modifier mixes the
 * pairing token in before any Diffie-Hellman step, so message 1 only
 * decrypts (and the "s"/payload fields inside it only authenticate) for a
 * peer that has the same token - a wrong guess fails at DecryptAndHash
 * with no oracle beyond "handshake failed".
 *
 *   IKpsk0:
 *     <- s
 *     ...
 *     -> psk, e, es, s, ss
 *     <- e, ee, se
 */
export const IKPSK0_PATTERN: NoisePattern = {
  name: 'IKpsk0',
  initiatorPreMessage: [],
  responderPreMessage: ['s'],
  messages: [
    ['psk', 'e', 'es', 's', 'ss'],
    ['e', 'ee', 'se'],
  ],
  usesPsk: true,
};

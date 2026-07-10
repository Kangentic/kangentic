/**
 * Per-direction framed AEAD applied on top of an established Noise
 * session, giving truncation/reorder/replay detection "out of the box":
 * a noble-only equivalent of libsodium's crypto_secretstream_xchacha20poly1305
 * (the research doc's stated design), not a byte-compatible reimplementation.
 *
 * Each direction gets its own 32-byte key and a 24-byte nonce header,
 * both derived from the Noise session's final chaining key via a
 * domain-separated label (deriveLabeledKey) - nothing extra needs to be
 * transmitted to set this up, since both peers compute identical values
 * from the same chaining key. Per message, the nonce is the header with
 * its low 64 bits XORed against a monotonic counter; a one-byte TAG is
 * authenticated (as associated data) but not encrypted, so a receiver can
 * tell a MESSAGE frame from a REKEY or FINAL boundary before - and even
 * if - decryption fails.
 *
 * Because both seal() and open() drive the AEAD nonce from the receiver's
 * own expected counter (not one read off the wire), a replayed, reordered,
 * or truncated frame fails to authenticate rather than silently decrypting:
 * the detection IS the authentication failure, not a separate check.
 */
import { concatBytes, deriveLabeledKey, xaeadDecrypt, xaeadEncrypt, XCHACHA_NONCE_LENGTH } from './primitives';

export const FrameTag = {
  Message: 0,
  Rekey: 1,
  Final: 2,
} as const;
export type FrameTag = (typeof FrameTag)[keyof typeof FrameTag];

const NONCE_COUNTER_OFFSET = XCHACHA_NONCE_LENGTH - 8;
const MAX_COUNTER = 0xffffffffffffffffn;

export class SecretstreamState {
  private key: Uint8Array;
  private readonly nonceHeader: Uint8Array;
  private counter = 0n;

  constructor(key: Uint8Array, nonceHeader: Uint8Array) {
    if (nonceHeader.length !== XCHACHA_NONCE_LENGTH) {
      throw new Error(`Secretstream nonce header must be ${XCHACHA_NONCE_LENGTH} bytes, got ${nonceHeader.length}`);
    }
    this.key = key;
    this.nonceHeader = nonceHeader;
  }

  private nonceForCounter(counter: bigint): Uint8Array {
    const nonce = this.nonceHeader.slice();
    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    const suffix = view.getBigUint64(NONCE_COUNTER_OFFSET, true);
    view.setBigUint64(NONCE_COUNTER_OFFSET, suffix ^ counter, true);
    return nonce;
  }

  /** Encrypts one frame and advances this direction's counter. */
  seal(plaintext: Uint8Array, tag: FrameTag = FrameTag.Message): Uint8Array {
    if (this.counter >= MAX_COUNTER) throw new Error('Secretstream counter space exhausted; re-handshake required');
    const associatedData = Uint8Array.of(tag);
    const ciphertext = xaeadEncrypt(this.key, this.nonceForCounter(this.counter), associatedData, plaintext);
    this.counter += 1n;
    return concatBytes(associatedData, ciphertext);
  }

  /**
   * Decrypts one frame and advances this direction's counter. Throws if
   * the frame does not authenticate against the counter this instance
   * currently expects - which is exactly what happens if a frame was
   * replayed, reordered, or the stream was truncated and resumed wrong.
   */
  open(frame: Uint8Array): { tag: FrameTag; plaintext: Uint8Array } {
    if (frame.length < 1) throw new Error('Secretstream frame is too short to contain a tag byte');
    if (this.counter >= MAX_COUNTER) throw new Error('Secretstream counter space exhausted; re-handshake required');
    const tag = frame[0] as FrameTag;
    const associatedData = frame.subarray(0, 1);
    const ciphertext = frame.subarray(1);
    const plaintext = xaeadDecrypt(this.key, this.nonceForCounter(this.counter), associatedData, ciphertext);
    this.counter += 1n;
    return { tag, plaintext };
  }

  /** Rotates this direction's key without a full Noise re-handshake, matching libsodium's REKEY tag. */
  rekey(): void {
    this.key = deriveLabeledKey(this.key, 'kangentic-secretstream-rekey', this.key.length);
  }
}

export interface SecretstreamDirectionPair {
  send: SecretstreamState;
  receive: SecretstreamState;
}

/**
 * Derives both directions' secretstream state from a completed Noise
 * session's chaining key (HandshakeState.getChainingKey(), valid once
 * split() has run). Both peers call this with the SAME chaining key and
 * opposite `isInitiator` values, so `initiator.send` pairs with
 * `responder.receive` and vice versa.
 */
export function deriveSecretstreamPair(chainingKey: Uint8Array, isInitiator: boolean): SecretstreamDirectionPair {
  const initiatorKey = deriveLabeledKey(chainingKey, 'kangentic-secretstream-key-initiator', 32);
  const responderKey = deriveLabeledKey(chainingKey, 'kangentic-secretstream-key-responder', 32);
  const initiatorNonceHeader = deriveLabeledKey(chainingKey, 'kangentic-secretstream-nonce-initiator', XCHACHA_NONCE_LENGTH);
  const responderNonceHeader = deriveLabeledKey(chainingKey, 'kangentic-secretstream-nonce-responder', XCHACHA_NONCE_LENGTH);

  const initiatorState = new SecretstreamState(initiatorKey, initiatorNonceHeader);
  const responderState = new SecretstreamState(responderKey, responderNonceHeader);

  return isInitiator
    ? { send: initiatorState, receive: responderState }
    : { send: responderState, receive: initiatorState };
}

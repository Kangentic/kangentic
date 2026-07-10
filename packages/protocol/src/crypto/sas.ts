/**
 * Matrix-style short authentication string (SAS), derived from a completed
 * pairing handshake's transcript hash (HandshakeState.getHandshakeHash()).
 * Both peers compute this AFTER the handshake finishes, so it is a
 * commitment over everything that happened - both static keys, both
 * ephemeral keys, and the pairing token's contribution via MixKeyAndHash.
 * A relay-in-the-middle that terminated two separate handshakes (one with
 * each peer, forwarding neither honestly) would produce two DIFFERENT
 * transcript hashes, so the SAS values shown on each screen would not
 * match - this is what "defeats a photographed or relayed QR" means in
 * practice: the human comparison step is what catches it.
 *
 * This is inspired by Matrix's SAS verification (commitment-before-reveal,
 * a short decimal code plus an emoji sequence for the same underlying
 * bytes), not a byte-compatible reimplementation of Matrix's own derivation.
 */
import { deriveLabeledKey } from './primitives';

const SAS_LABEL = 'kangentic-pairing-sas';

/** A representative, deliberately small, unambiguous set: no near-duplicate emoji, no PUA/flag glyphs that render inconsistently across platforms. */
const SAS_EMOJI_TABLE = [
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
  '🐧', '🐦', '🦄', '🐴', '🐝', '🐢', '🐍', '🐙', '🦀', '🐳', '🐬', '🐠', '🦋', '🐌', '🐞', '🦂',
  '🌵', '🌲', '🌸', '🍀', '🍎', '🍌', '🍉', '🍇', '🍓', '🍒', '🥑', '🌽', '🍕', '🍔', '🍩', '🎂',
  '⚽', '🏀', '🎸', '🎲', '🎯', '🚗', '🚀', '⛵', '🚲', '⌛', '🔑', '💎', '🎈', '🎁', '🔔', '⭐',
] as const;

export interface ShortAuthenticationString {
  /** A 6-digit code, e.g. "042917". */
  digits: string;
  /** 5 emoji from a fixed 64-entry table. */
  emoji: string[];
}

/**
 * Derives SAS bytes from the transcript hash via a domain-separated HKDF
 * label, independent of any other derivation from the same hash. 4 bytes
 * feed the decimal code, 5 bytes feed the emoji sequence - 9 bytes total,
 * comfortably inside a single 32-byte HKDF output.
 */
function deriveSasBytes(handshakeHash: Uint8Array): Uint8Array {
  return deriveLabeledKey(handshakeHash, SAS_LABEL, 9);
}

export function deriveShortAuthenticationString(handshakeHash: Uint8Array): ShortAuthenticationString {
  const bytes = deriveSasBytes(handshakeHash);
  // Manual big-endian uint32 read instead of a DataView over bytes.buffer:
  // avoids any assumption about the returned Uint8Array's byteOffset within
  // its backing ArrayBuffer.
  const digitsRaw = (bytes[0] * 2 ** 24) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  const digitsValue = digitsRaw % 1_000_000;
  const digits = digitsValue.toString(10).padStart(6, '0');

  const emoji: string[] = [];
  for (let i = 0; i < 5; i++) {
    emoji.push(SAS_EMOJI_TABLE[bytes[4 + i] % SAS_EMOJI_TABLE.length]);
  }

  return { digits, emoji };
}

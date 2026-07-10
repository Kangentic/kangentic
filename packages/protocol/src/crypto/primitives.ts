/**
 * Thin wrappers over @noble/curves, @noble/hashes, and @noble/ciphers - the
 * only place in this package that imports noble directly. Everything above
 * this module (Noise state machine, secretstream, SAS, roster signing) goes
 * through these functions so the primitive choice stays swappable in one
 * place and every byte length is asserted at the boundary.
 */
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { blake2s } from '@noble/hashes/blake2.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { randomBytes as nobleRandomBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js';

export const X25519_KEY_LENGTH = 32;
export const ED25519_KEY_LENGTH = 32;
export const ED25519_SIGNATURE_LENGTH = 64;
export const HASH_LENGTH = 32;
export const AEAD_KEY_LENGTH = 32;
export const CHACHA_NONCE_LENGTH = 12;
export const XCHACHA_NONCE_LENGTH = 24;
export const AEAD_TAG_LENGTH = 16;

function assertLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes, got ${bytes.length}`);
  }
}

export function randomBytes(length: number): Uint8Array {
  return nobleRandomBytes(length);
}

export { hexToBytes, bytesToHex };

export interface X25519KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateX25519KeyPair(): X25519KeyPair {
  return x25519.keygen();
}

export function x25519PublicKeyFrom(secretKey: Uint8Array): Uint8Array {
  assertLength(secretKey, X25519_KEY_LENGTH, 'x25519 secret key');
  return x25519.getPublicKey(secretKey);
}

/** Diffie-Hellman: DH(localSecretKey, remotePublicKey). Throws on a low-order/invalid peer key. */
export function x25519SharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  assertLength(secretKey, X25519_KEY_LENGTH, 'x25519 secret key');
  assertLength(publicKey, X25519_KEY_LENGTH, 'x25519 public key');
  return x25519.getSharedSecret(secretKey, publicKey);
}

export interface Ed25519KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  return ed25519.keygen();
}

export function ed25519Sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  assertLength(secretKey, ED25519_KEY_LENGTH, 'ed25519 secret key');
  return ed25519.sign(message, secretKey);
}

export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  assertLength(signature, ED25519_SIGNATURE_LENGTH, 'ed25519 signature');
  assertLength(publicKey, ED25519_KEY_LENGTH, 'ed25519 public key');
  return ed25519.verify(signature, message, publicKey);
}

export function hashBlake2s(data: Uint8Array): Uint8Array {
  return blake2s(data);
}

/**
 * Noise's HKDF(chaining_key, input_key_material, num_outputs): HKDF-Extract
 * with salt=chaining_key, ikm=input_key_material, then HKDF-Expand with an
 * empty info, chunked into num_outputs HASH_LENGTH-byte blocks. This is
 * exactly RFC 5869 HKDF with a zero-length info string, so the noble
 * convenience function (extract+expand combined) is used directly rather
 * than hand-rolling the counter loop.
 */
export function noiseHkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, numOutputs: 2 | 3): Uint8Array[] {
  const output = nobleHkdf(blake2s, inputKeyMaterial, chainingKey, new Uint8Array(0), numOutputs * HASH_LENGTH);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < numOutputs; i++) {
    chunks.push(output.subarray(i * HASH_LENGTH, (i + 1) * HASH_LENGTH));
  }
  return chunks;
}

/**
 * Independent, domain-separated key derivation from a Noise chaining key,
 * for material that is NOT part of the Noise handshake itself (e.g. the
 * secretstream framing keys derived once a session's split() has run).
 * Reusing one secret for multiple purposes via distinct labels is safe
 * KDF practice as long as every purpose gets its own label; this is a
 * plain HKDF-Expand-style derivation (salt=chainingKey, ikm=empty,
 * info=label), independent of noiseHkdf's own empty-info convention.
 */
export function deriveLabeledKey(chainingKey: Uint8Array, label: string, length: number): Uint8Array {
  return nobleHkdf(blake2s, new Uint8Array(0), chainingKey, new TextEncoder().encode(label), length);
}

/**
 * AEAD_ENCRYPT/AEAD_DECRYPT per Noise section 12.3: ChaCha20-Poly1305 (RFC
 * 7539) with the 96-bit nonce formed as 32 zero bits followed by the
 * little-endian encoding of the 64-bit counter `n`.
 */
function chachaNonce(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(CHACHA_NONCE_LENGTH);
  const view = new DataView(nonce.buffer);
  view.setBigUint64(4, counter, true);
  return nonce;
}

export function aeadEncrypt(key: Uint8Array, counter: bigint, associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
  assertLength(key, AEAD_KEY_LENGTH, 'AEAD key');
  const cipher = chacha20poly1305(key, chachaNonce(counter), associatedData);
  return cipher.encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, counter: bigint, associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  assertLength(key, AEAD_KEY_LENGTH, 'AEAD key');
  const cipher = chacha20poly1305(key, chachaNonce(counter), associatedData);
  return cipher.decrypt(ciphertext);
}

/** XChaCha20-Poly1305 with a 24-byte nonce - used by the secretstream framing, not the Noise handshake. */
export function xaeadEncrypt(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
  assertLength(key, AEAD_KEY_LENGTH, 'XAEAD key');
  assertLength(nonce, XCHACHA_NONCE_LENGTH, 'XAEAD nonce');
  const cipher = xchacha20poly1305(key, nonce, associatedData);
  return cipher.encrypt(plaintext);
}

export function xaeadDecrypt(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  assertLength(key, AEAD_KEY_LENGTH, 'XAEAD key');
  assertLength(nonce, XCHACHA_NONCE_LENGTH, 'XAEAD nonce');
  const cipher = xchacha20poly1305(key, nonce, associatedData);
  return cipher.decrypt(ciphertext);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

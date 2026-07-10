/**
 * Noise Protocol Framework section 5.1: the CipherState object. `k` is
 * either null (no key set yet, EncryptWithAd/DecryptWithAd are the
 * identity function) or a 32-byte ChaCha20-Poly1305 key; `n` is the
 * 64-bit nonce counter, reset to 0 every time the key changes.
 */
import { aeadDecrypt, aeadEncrypt } from '../primitives';

const MAX_NONCE = 0xffffffffffffffffn;

export class CipherState {
  private key: Uint8Array | null = null;
  private nonce = 0n;

  initializeKey(key: Uint8Array | null): void {
    this.key = key;
    this.nonce = 0n;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  encryptWithAd(associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.key === null) return plaintext;
    if (this.nonce >= MAX_NONCE) throw new Error('Noise CipherState nonce space exhausted');
    const ciphertext = aeadEncrypt(this.key, this.nonce, associatedData, plaintext);
    this.nonce += 1n;
    return ciphertext;
  }

  /** Nonce is only advanced on a SUCCESSFUL decrypt; aeadDecrypt throws on tag failure. */
  decryptWithAd(associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.key === null) return ciphertext;
    if (this.nonce >= MAX_NONCE) throw new Error('Noise CipherState nonce space exhausted');
    const plaintext = aeadDecrypt(this.key, this.nonce, associatedData, ciphertext);
    this.nonce += 1n;
    return plaintext;
  }
}

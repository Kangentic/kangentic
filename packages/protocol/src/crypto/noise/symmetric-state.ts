/**
 * Noise Protocol Framework section 5.2: the SymmetricState object. Wraps a
 * CipherState plus the chaining key `ck` and running transcript hash `h`.
 */
import { concatBytes, hashBlake2s, noiseHkdf, HASH_LENGTH } from '../primitives';
import { CipherState } from './cipher-state';

export class SymmetricState {
  private readonly cipherState = new CipherState();
  private chainingKey: Uint8Array;
  private hash: Uint8Array;

  constructor(protocolName: Uint8Array) {
    if (protocolName.length <= HASH_LENGTH) {
      this.hash = concatBytes(protocolName, new Uint8Array(HASH_LENGTH - protocolName.length));
    } else {
      this.hash = hashBlake2s(protocolName);
    }
    this.chainingKey = this.hash;
    this.cipherState.initializeKey(null);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [nextChainingKey, tempKey] = noiseHkdf(this.chainingKey, inputKeyMaterial, 2);
    this.chainingKey = nextChainingKey;
    this.cipherState.initializeKey(tempKey);
  }

  mixHash(data: Uint8Array): void {
    this.hash = hashBlake2s(concatBytes(this.hash, data));
  }

  /** Processes a "psk" token: MixKeyAndHash(psk) per Noise section 9. */
  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [nextChainingKey, tempHash, tempKey] = noiseHkdf(this.chainingKey, inputKeyMaterial, 3);
    this.chainingKey = nextChainingKey;
    this.mixHash(tempHash);
    this.cipherState.initializeKey(tempKey);
  }

  getHandshakeHash(): Uint8Array {
    return this.hash;
  }

  /**
   * The raw chaining key, meaningful only after the handshake's message
   * patterns are exhausted (alongside split()). Exposed so a caller can
   * derive ADDITIONAL independent key material (e.g. secretstream framing
   * keys) via its own domain-separated HKDF label - see
   * crypto/secretstream.ts's deriveTransportKey. This is standard KDF
   * practice (TLS 1.3's key schedule does the same): reusing one secret
   * for multiple purposes via distinct labels is safe; Split()'s own
   * derivation (empty info) and a labeled derivation never collide.
   */
  getChainingKey(): Uint8Array {
    return this.chainingKey;
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipherState.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipherState.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  hasKey(): boolean {
    return this.cipherState.hasKey();
  }

  /** Only valid once every message pattern has been processed. */
  split(): [CipherState, CipherState] {
    const [tempKey1, tempKey2] = noiseHkdf(this.chainingKey, new Uint8Array(0), 2);
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(tempKey1);
    c2.initializeKey(tempKey2);
    return [c1, c2];
  }
}

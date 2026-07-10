/**
 * Noise Protocol Framework section 5.3: the HandshakeState object. A
 * generic token interpreter driven by a NoisePattern, so both the ongoing
 * session pattern (KK) and the pairing pattern (IKpsk0) share this exact
 * code - only the pattern table and the supplied key material differ.
 */
import { X25519_KEY_LENGTH, AEAD_TAG_LENGTH, concatBytes, generateX25519KeyPair, x25519SharedSecret, type X25519KeyPair } from '../primitives';
import { CipherState } from './cipher-state';
import { SymmetricState } from './symmetric-state';
import type { NoisePattern, NoiseToken } from './patterns';

export interface HandshakeStateOptions {
  pattern: NoisePattern;
  initiator: boolean;
  /** Bound into the transcript before any key material - kills downgrade attacks when it encodes the negotiated protocol version. */
  prologue: Uint8Array;
  /** Local static keypair. Required whenever the pattern's local role sends or has pre-shared an "s" token. */
  s?: X25519KeyPair;
  /** Local ephemeral keypair. Only ever set by a test harness; production code always lets writeMessage() generate it. */
  e?: X25519KeyPair;
  /** Remote static public key. Required whenever the pattern's local role receives an "s" pre-message (e.g. KK) or already knows it out-of-band (e.g. IK's responder key from a QR). */
  rs?: Uint8Array;
  re?: Uint8Array;
  /** 32-byte pre-shared key. Required by patterns with a "psk" token. */
  psk?: Uint8Array;
  /** Test-only override for ephemeral keypair generation, to replay a fixed test vector. */
  generateEphemeral?: () => X25519KeyPair;
}

export interface HandshakeWriteResult {
  message: Uint8Array;
  /** Present once the pattern's last message has been written. */
  split?: [CipherState, CipherState];
}

export interface HandshakeReadResult {
  payload: Uint8Array;
  /** Present once the pattern's last message has been read. */
  split?: [CipherState, CipherState];
}

export class HandshakeState {
  private readonly symmetricState: SymmetricState;
  private readonly pattern: NoisePattern;
  private readonly initiator: boolean;
  private readonly generateEphemeral: () => X25519KeyPair;
  private readonly psk?: Uint8Array;
  private s?: X25519KeyPair;
  private e?: X25519KeyPair;
  private rs?: Uint8Array;
  private re?: Uint8Array;
  private messageIndex = 0;

  constructor(options: HandshakeStateOptions) {
    this.pattern = options.pattern;
    this.initiator = options.initiator;
    this.s = options.s;
    this.e = options.e;
    this.rs = options.rs;
    this.re = options.re;
    this.psk = options.psk;
    this.generateEphemeral = options.generateEphemeral ?? generateX25519KeyPair;

    const protocolName = new TextEncoder().encode(`Noise_${this.pattern.name}_25519_ChaChaPoly_BLAKE2s`);
    this.symmetricState = new SymmetricState(protocolName);
    this.symmetricState.mixHash(options.prologue);

    // Initiator's pre-message keys are ALWAYS mixed before the responder's,
    // regardless of which role this instance is playing locally.
    for (const token of this.pattern.initiatorPreMessage) {
      this.symmetricState.mixHash(this.resolvePreMessageKey(token, true));
    }
    for (const token of this.pattern.responderPreMessage) {
      this.symmetricState.mixHash(this.resolvePreMessageKey(token, false));
    }
  }

  private resolvePreMessageKey(token: NoiseToken, isInitiatorSide: boolean): Uint8Array {
    if (token !== 's') throw new Error(`Unsupported pre-message token: ${token}`);
    const isLocalSide = isInitiatorSide === this.initiator;
    if (isLocalSide) {
      if (!this.s) throw new Error('Local static key required by this pattern but not provided');
      return this.s.publicKey;
    }
    if (!this.rs) throw new Error('Remote static key required by this pattern but not provided');
    return this.rs;
  }

  private requireLocalKeyPair(which: 'e' | 's'): X25519KeyPair {
    const keyPair = which === 'e' ? this.e : this.s;
    if (!keyPair) throw new Error(`Local "${which}" key required for this token but not available`);
    return keyPair;
  }

  private requireRemoteKey(which: 're' | 'rs'): Uint8Array {
    const publicKey = which === 're' ? this.re : this.rs;
    if (!publicKey) throw new Error(`Remote "${which}" key required for this token but not available`);
    return publicKey;
  }

  private requirePsk(): Uint8Array {
    if (!this.psk) throw new Error('PSK required by this pattern but not provided');
    return this.psk;
  }

  private dh(local: X25519KeyPair, remotePublicKey: Uint8Array): Uint8Array {
    return x25519SharedSecret(local.secretKey, remotePublicKey);
  }

  private mixDhToken(token: 'ee' | 'es' | 'se' | 'ss'): void {
    switch (token) {
      case 'ee':
        this.symmetricState.mixKey(this.dh(this.requireLocalKeyPair('e'), this.requireRemoteKey('re')));
        return;
      case 'es':
        this.symmetricState.mixKey(
          this.initiator
            ? this.dh(this.requireLocalKeyPair('e'), this.requireRemoteKey('rs'))
            : this.dh(this.requireLocalKeyPair('s'), this.requireRemoteKey('re')),
        );
        return;
      case 'se':
        this.symmetricState.mixKey(
          this.initiator
            ? this.dh(this.requireLocalKeyPair('s'), this.requireRemoteKey('re'))
            : this.dh(this.requireLocalKeyPair('e'), this.requireRemoteKey('rs')),
        );
        return;
      case 'ss':
        this.symmetricState.mixKey(this.dh(this.requireLocalKeyPair('s'), this.requireRemoteKey('rs')));
        return;
    }
  }

  private nextTokens(): readonly NoiseToken[] {
    const tokens = this.pattern.messages[this.messageIndex];
    if (!tokens) throw new Error('No more messages remain in this handshake pattern');
    this.messageIndex += 1;
    return tokens;
  }

  private maybeSplit(): [CipherState, CipherState] | undefined {
    return this.messageIndex >= this.pattern.messages.length ? this.symmetricState.split() : undefined;
  }

  writeMessage(payload: Uint8Array): HandshakeWriteResult {
    const tokens = this.nextTokens();
    const buffers: Uint8Array[] = [];

    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.e = this.generateEphemeral();
          buffers.push(this.e.publicKey);
          this.symmetricState.mixHash(this.e.publicKey);
          // Section 9.2: in a PSK handshake, every "e" token ALSO calls
          // MixKey(e.public_key), not just MixHash. Non-PSK patterns skip this.
          if (this.pattern.usesPsk) this.symmetricState.mixKey(this.e.publicKey);
          break;
        }
        case 's': {
          buffers.push(this.symmetricState.encryptAndHash(this.requireLocalKeyPair('s').publicKey));
          break;
        }
        case 'psk':
          this.symmetricState.mixKeyAndHash(this.requirePsk());
          break;
        default:
          this.mixDhToken(token);
      }
    }

    buffers.push(this.symmetricState.encryptAndHash(payload));
    return { message: concatBytes(...buffers), split: this.maybeSplit() };
  }

  readMessage(message: Uint8Array): HandshakeReadResult {
    const tokens = this.nextTokens();
    let offset = 0;

    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.re = message.subarray(offset, offset + X25519_KEY_LENGTH);
          offset += X25519_KEY_LENGTH;
          this.symmetricState.mixHash(this.re);
          if (this.pattern.usesPsk) this.symmetricState.mixKey(this.re);
          break;
        }
        case 's': {
          const fieldLength = this.symmetricState.hasKey() ? X25519_KEY_LENGTH + AEAD_TAG_LENGTH : X25519_KEY_LENGTH;
          const field = message.subarray(offset, offset + fieldLength);
          offset += fieldLength;
          this.rs = this.symmetricState.decryptAndHash(field);
          break;
        }
        case 'psk':
          this.symmetricState.mixKeyAndHash(this.requirePsk());
          break;
        default:
          this.mixDhToken(token);
      }
    }

    const payload = this.symmetricState.decryptAndHash(message.subarray(offset));
    return { payload, split: this.maybeSplit() };
  }

  getHandshakeHash(): Uint8Array {
    return this.symmetricState.getHandshakeHash();
  }

  /** See SymmetricState.getChainingKey(): only meaningful once split() has occurred. */
  getChainingKey(): Uint8Array {
    return this.symmetricState.getChainingKey();
  }

  /** The remote static public key, once learned (pre-shared or received via an "s" token). */
  getRemoteStaticKey(): Uint8Array | undefined {
    return this.rs;
  }
}

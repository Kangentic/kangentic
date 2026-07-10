/**
 * Driver for the one-time pairing handshake: Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s.
 *
 * The phone (initiator) already knows the desktop's (responder's) static
 * public key from the QR, and sends its own static key authenticated
 * within message 1. The pairing token is mixed in as a PSK before any
 * Diffie-Hellman step, so a peer without the token cannot produce a
 * transcript that decrypts on the other side - see patterns.ts for the
 * full token trace.
 */
import { encodeProtocolVersion } from '../version';
import type { X25519KeyPair } from './primitives';
import { HandshakeState } from './noise/handshake-state';
import { IKPSK0_PATTERN } from './noise/patterns';

export interface PairingInitiatorOptions {
  /** The phone's own static identity keypair. */
  localStatic: X25519KeyPair;
  /** The desktop's static public key, read from the QR payload. */
  remoteStatic: Uint8Array;
  /** The 32-byte single-use pairing token from the QR payload, used as the Noise PSK. */
  pairingToken: Uint8Array;
  protocolVersion?: string;
}

export function createPairingInitiatorHandshake(options: PairingInitiatorOptions): HandshakeState {
  return new HandshakeState({
    pattern: IKPSK0_PATTERN,
    initiator: true,
    prologue: encodeProtocolVersion(options.protocolVersion),
    s: options.localStatic,
    rs: options.remoteStatic,
    psk: options.pairingToken,
  });
}

export interface PairingResponderOptions {
  /** The desktop's own static identity keypair (the one published in the QR). */
  localStatic: X25519KeyPair;
  /** The same 32-byte single-use pairing token minted for this QR. */
  pairingToken: Uint8Array;
  protocolVersion?: string;
}

export function createPairingResponderHandshake(options: PairingResponderOptions): HandshakeState {
  return new HandshakeState({
    pattern: IKPSK0_PATTERN,
    initiator: false,
    prologue: encodeProtocolVersion(options.protocolVersion),
    s: options.localStatic,
    psk: options.pairingToken,
  });
}

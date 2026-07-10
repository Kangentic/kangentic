/** Driver for the ongoing bridge session handshake: Noise_KK_25519_ChaChaPoly_BLAKE2s. */
import { encodeProtocolVersion } from '../../version';
import type { X25519KeyPair } from '../primitives';
import { HandshakeState } from './handshake-state';
import { KK_PATTERN } from './patterns';

export interface KKHandshakeOptions {
  initiator: boolean;
  /** Local device's static identity keypair. */
  localStatic: X25519KeyPair;
  /** Peer's static public key, already pinned in the signed device roster. */
  remoteStatic: Uint8Array;
  protocolVersion?: string;
}

export function createKKHandshake(options: KKHandshakeOptions): HandshakeState {
  return new HandshakeState({
    pattern: KK_PATTERN,
    initiator: options.initiator,
    prologue: encodeProtocolVersion(options.protocolVersion),
    s: options.localStatic,
    rs: options.remoteStatic,
  });
}

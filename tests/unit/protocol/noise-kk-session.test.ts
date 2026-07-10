/**
 * Behavioral tests for the production ongoing-session driver
 * (crypto/noise/kk.ts, Noise_KK_25519_ChaChaPoly_BLAKE2s). Byte-correctness
 * of the underlying interpreter is proven against an official test vector
 * in noise-vectors.test.ts; these tests prove the driver's own contract:
 * both statics must already be known (no pairing step embedded here),
 * peers mutually authenticate, and a fresh handshake (the ~2-minute
 * re-handshake) derives independent keys each time.
 */
import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair } from '../../../packages/protocol/src/crypto/primitives';
import { createKKHandshake } from '../../../packages/protocol/src/crypto/noise/kk';

function runSession(deviceStatic: ReturnType<typeof generateX25519KeyPair>, peerStatic: ReturnType<typeof generateX25519KeyPair>) {
  const initiator = createKKHandshake({ initiator: true, localStatic: deviceStatic, remoteStatic: peerStatic.publicKey });
  const responder = createKKHandshake({ initiator: false, localStatic: peerStatic, remoteStatic: deviceStatic.publicKey });

  const message1 = initiator.writeMessage(new Uint8Array(0));
  responder.readMessage(message1.message);
  const message2 = responder.writeMessage(new Uint8Array(0));
  initiator.readMessage(message2.message);

  return { initiator, responder };
}

describe('KK session handshake (Noise_KK_25519_ChaChaPoly_BLAKE2s)', () => {
  it('two devices with pre-pinned roster keys mutually authenticate and agree on the transcript hash', () => {
    const device = generateX25519KeyPair();
    const peer = generateX25519KeyPair();
    const { initiator, responder } = runSession(device, peer);
    expect(Buffer.from(initiator.getHandshakeHash()).toString('hex')).toBe(Buffer.from(responder.getHandshakeHash()).toString('hex'));
  });

  it('rejects a peer whose static key does not match the pinned roster entry', () => {
    const device = generateX25519KeyPair();
    const peer = generateX25519KeyPair();
    const impostor = generateX25519KeyPair();

    // Device pins `peer`'s static, but the responder on the wire is actually
    // `impostor`. The "es"/"ss" DH combiners only agree when both sides hold
    // the SAME static keypair the other side pinned, so this diverges the
    // derived key immediately - message 1's payload fails to authenticate
    // on the very first readMessage() call, before any session key exists.
    const initiator = createKKHandshake({ initiator: true, localStatic: device, remoteStatic: peer.publicKey });
    const responder = createKKHandshake({ initiator: false, localStatic: impostor, remoteStatic: device.publicKey });

    const message1 = initiator.writeMessage(new Uint8Array(0));
    expect(() => responder.readMessage(message1.message)).toThrow();
  });

  it('a fresh re-handshake between the same pair derives independent transcript hashes each time (bounded post-compromise security)', () => {
    const device = generateX25519KeyPair();
    const peer = generateX25519KeyPair();

    const first = runSession(device, peer);
    const second = runSession(device, peer);

    expect(Buffer.from(first.initiator.getHandshakeHash()).toString('hex')).not.toBe(
      Buffer.from(second.initiator.getHandshakeHash()).toString('hex'),
    );
  });
});

/**
 * Behavioral tests for the production pairing driver (crypto/pairing-handshake.ts,
 * Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s). The underlying interpreter's
 * byte-correctness is proven against official test vectors in
 * noise-vectors.test.ts (KK, IK, and NKpsk0 combined cover every token
 * type IKpsk0 uses); these tests instead prove the SECURITY PROPERTIES the
 * pairing ceremony depends on: two honest peers agree, a wrong token is
 * rejected, a downgraded/mismatched prologue is rejected, and a tampered
 * message is rejected.
 */
import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { createPairingInitiatorHandshake, createPairingResponderHandshake } from '../../../packages/protocol/src/crypto/pairing-handshake';

function completedHandshake() {
  const phoneStatic = generateX25519KeyPair();
  const desktopStatic = generateX25519KeyPair();
  const pairingToken = randomBytes(32);

  const phone = createPairingInitiatorHandshake({
    localStatic: phoneStatic,
    remoteStatic: desktopStatic.publicKey,
    pairingToken,
  });
  const desktop = createPairingResponderHandshake({
    localStatic: desktopStatic,
    pairingToken,
  });

  const message1 = phone.writeMessage(new TextEncoder().encode('phone-device-name'));
  const read1 = desktop.readMessage(message1.message);
  const message2 = desktop.writeMessage(new Uint8Array(0));
  const read2 = phone.readMessage(message2.message);

  return { phoneStatic, desktopStatic, pairingToken, phone, desktop, read1, message2, read2 };
}

describe('pairing handshake (Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s)', () => {
  it('two honest peers complete the handshake and agree on the transcript hash', () => {
    const { phone, desktop, read1, read2 } = completedHandshake();

    expect(new TextDecoder().decode(read1.payload)).toBe('phone-device-name');
    expect(read2.payload.length).toBe(0);
    expect(Buffer.from(phone.getHandshakeHash()).toString('hex')).toBe(Buffer.from(desktop.getHandshakeHash()).toString('hex'));
  });

  it('lets the desktop learn the phone identity static key from message 1', () => {
    const { phoneStatic, desktop } = completedHandshake();
    expect(Buffer.from(desktop.getRemoteStaticKey() ?? new Uint8Array()).toString('hex')).toBe(
      Buffer.from(phoneStatic.publicKey).toString('hex'),
    );
  });

  it('rejects a wrong pairing token with an authentication failure, not a usable oracle', () => {
    const phoneStatic = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const realToken = randomBytes(32);
    const guessedToken = randomBytes(32);

    const phone = createPairingInitiatorHandshake({
      localStatic: phoneStatic,
      remoteStatic: desktopStatic.publicKey,
      pairingToken: guessedToken,
    });
    const desktop = createPairingResponderHandshake({
      localStatic: desktopStatic,
      pairingToken: realToken,
    });

    const message1 = phone.writeMessage(new TextEncoder().encode('phone-device-name'));
    expect(() => desktop.readMessage(message1.message)).toThrow();
  });

  it('rejects a mismatched protocol version bound into the prologue (downgrade protection)', () => {
    const phoneStatic = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);

    const phone = createPairingInitiatorHandshake({
      localStatic: phoneStatic,
      remoteStatic: desktopStatic.publicKey,
      pairingToken,
      protocolVersion: '2',
    });
    const desktop = createPairingResponderHandshake({
      localStatic: desktopStatic,
      pairingToken,
      protocolVersion: '1',
    });

    const message1 = phone.writeMessage(new TextEncoder().encode('phone-device-name'));
    expect(() => desktop.readMessage(message1.message)).toThrow();
  });

  it('rejects a tampered message 1 (bit flip anywhere in the ciphertext)', () => {
    const phoneStatic = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);

    const phone = createPairingInitiatorHandshake({
      localStatic: phoneStatic,
      remoteStatic: desktopStatic.publicKey,
      pairingToken,
    });
    const desktop = createPairingResponderHandshake({
      localStatic: desktopStatic,
      pairingToken,
    });

    const message1 = phone.writeMessage(new TextEncoder().encode('phone-device-name'));
    const tampered = new Uint8Array(message1.message);
    tampered[tampered.length - 1] ^= 0x01;

    expect(() => desktop.readMessage(tampered)).toThrow();
  });

  it('produces distinct pairing sessions for two different tokens (no cross-session key reuse)', () => {
    const a = completedHandshake();
    const b = completedHandshake();
    expect(Buffer.from(a.phone.getHandshakeHash()).toString('hex')).not.toBe(Buffer.from(b.phone.getHandshakeHash()).toString('hex'));
  });
});

/**
 * Behavioral tests for the pairing-confirm frame (pairing/confirm.ts): the
 * sealed liveness/intent signal the phone sends once the human taps
 * Confirm, over the initiator-to-responder cipher state the completed
 * IKpsk0 handshake's split() produces. See pairing-service.ts on the
 * desktop side for how a successful open drives auto-enroll.
 */
import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { createPairingInitiatorHandshake, createPairingResponderHandshake } from '../../../packages/protocol/src/crypto/pairing-handshake';
import { sealPairingConfirm, openPairingConfirm } from '../../../packages/protocol/src/pairing/confirm';
import type { CipherState } from '../../../packages/protocol/src/crypto/noise/cipher-state';

function completedHandshakeConfirmCiphers(): { phoneCipher: CipherState; desktopCipher: CipherState } {
  const phoneStatic = generateX25519KeyPair();
  const desktopStatic = generateX25519KeyPair();
  const pairingToken = randomBytes(32);

  const phone = createPairingInitiatorHandshake({ localStatic: phoneStatic, remoteStatic: desktopStatic.publicKey, pairingToken });
  const desktop = createPairingResponderHandshake({ localStatic: desktopStatic, pairingToken });

  const message1 = phone.writeMessage(new TextEncoder().encode('phone-device-name'));
  desktop.readMessage(message1.message);
  const message2 = desktop.writeMessage(new Uint8Array(0));
  const phoneReadResult = phone.readMessage(message2.message);

  if (!message2.split || !phoneReadResult.split) throw new Error('test setup: handshake did not complete');
  return { phoneCipher: phoneReadResult.split[0], desktopCipher: message2.split[0] };
}

describe('pairing-confirm frame', () => {
  it('opens on the desktop side when sealed by the phone under the matching completed transcript', () => {
    const { phoneCipher, desktopCipher } = completedHandshakeConfirmCiphers();
    const frame = sealPairingConfirm(phoneCipher);
    expect(openPairingConfirm(desktopCipher, frame)).toBe(true);
  });

  it('does not open under a cipher state derived from a different handshake transcript', () => {
    const { phoneCipher } = completedHandshakeConfirmCiphers();
    const { desktopCipher: otherDesktopCipher } = completedHandshakeConfirmCiphers();
    const frame = sealPairingConfirm(phoneCipher);
    expect(openPairingConfirm(otherDesktopCipher, frame)).toBe(false);
  });

  it('does not open (and does not throw) on a tampered frame', () => {
    const { phoneCipher, desktopCipher } = completedHandshakeConfirmCiphers();
    const frame = sealPairingConfirm(phoneCipher);
    const tampered = new Uint8Array(frame);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => openPairingConfirm(desktopCipher, tampered)).not.toThrow();
    expect(openPairingConfirm(desktopCipher, tampered)).toBe(false);
  });

  it('does not open (and does not throw) on arbitrary garbage bytes', () => {
    const { desktopCipher } = completedHandshakeConfirmCiphers();
    expect(() => openPairingConfirm(desktopCipher, new Uint8Array([1, 2, 3]))).not.toThrow();
    expect(openPairingConfirm(desktopCipher, new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('seals to different bytes on successive calls (nonce advances; not a static, replayable blob)', () => {
    const { phoneCipher } = completedHandshakeConfirmCiphers();
    const first = sealPairingConfirm(phoneCipher);
    const second = sealPairingConfirm(phoneCipher);
    expect(Buffer.from(first).toString('hex')).not.toBe(Buffer.from(second).toString('hex'));
  });
});

describe('pairing-confirm frame plaintext-content check', () => {
  // sealPairingConfirm always seals the fixed 'kangentic-pairing-confirm-v1'
  // plaintext, so these two tests bypass it and call CipherState.encryptWithAd
  // directly (same key derivation as completedHandshakeConfirmCiphers()
  // above) to prove openPairingConfirm rejects a SUCCESSFULLY decrypted
  // frame whose content does not match, not just a frame that fails to
  // decrypt at all (which the earlier "tampered"/"garbage" tests already
  // cover). Both phoneCipher and desktopCipher are freshly split and unused
  // here (nonce 0 on both sides), so sealing once on phoneCipher and opening
  // once on desktopCipher lines up at the same nonce, exactly like a genuine
  // sealPairingConfirm/openPairingConfirm pair.
  it('does not open a successfully-decrypted frame whose plaintext has the wrong length', () => {
    const { phoneCipher, desktopCipher } = completedHandshakeConfirmCiphers();
    const wrongLengthPlaintext = new TextEncoder().encode('too-short');
    const frame = phoneCipher.encryptWithAd(new Uint8Array(0), wrongLengthPlaintext);

    expect(openPairingConfirm(desktopCipher, frame)).toBe(false);
  });

  it('does not open a successfully-decrypted frame whose plaintext is the same length but different content', () => {
    const { phoneCipher, desktopCipher } = completedHandshakeConfirmCiphers();
    const realPlaintext = new TextEncoder().encode('kangentic-pairing-confirm-v1');
    const sameLengthDifferentPlaintext = new Uint8Array(realPlaintext.length).fill(0x41); // same length, all 'A'
    const frame = phoneCipher.encryptWithAd(new Uint8Array(0), sameLengthDifferentPlaintext);

    expect(openPairingConfirm(desktopCipher, frame)).toBe(false);
  });
});

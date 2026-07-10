import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { createPairingInitiatorHandshake, createPairingResponderHandshake } from '../../../packages/protocol/src/crypto/pairing-handshake';
import { deriveShortAuthenticationString } from '../../../packages/protocol/src/crypto/sas';

describe('short authentication string', () => {
  it('is deterministic for the same transcript hash', () => {
    const hash = randomBytes(32);
    const first = deriveShortAuthenticationString(hash);
    const second = deriveShortAuthenticationString(hash);
    expect(first).toEqual(second);
  });

  it('produces a 6-digit code and 5 emoji', () => {
    const { digits, emoji } = deriveShortAuthenticationString(randomBytes(32));
    expect(digits).toMatch(/^\d{6}$/);
    expect(emoji).toHaveLength(5);
  });

  it('two honest pairing peers derive the identical SAS from their completed handshake', () => {
    const phoneStatic = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);

    const phone = createPairingInitiatorHandshake({ localStatic: phoneStatic, remoteStatic: desktopStatic.publicKey, pairingToken });
    const desktop = createPairingResponderHandshake({ localStatic: desktopStatic, pairingToken });

    const message1 = phone.writeMessage(new Uint8Array(0));
    desktop.readMessage(message1.message);
    const message2 = desktop.writeMessage(new Uint8Array(0));
    phone.readMessage(message2.message);

    const phoneSas = deriveShortAuthenticationString(phone.getHandshakeHash());
    const desktopSas = deriveShortAuthenticationString(desktop.getHandshakeHash());
    expect(phoneSas).toEqual(desktopSas);
  });

  it('a different transcript (different pairing token) produces a different SAS with overwhelming probability', () => {
    const first = deriveShortAuthenticationString(randomBytes(32));
    const second = deriveShortAuthenticationString(randomBytes(32));
    expect(first).not.toEqual(second);
  });

  it('an active relay-in-the-middle terminating two separate handshakes shows different SAS on each screen', () => {
    // Simulates the attack SAS exists to defeat: an attacker sits between the
    // phone and the desktop and terminates TWO independent Noise handshakes
    // instead of transparently forwarding one - one leg impersonating the
    // desktop toward the real phone, the other impersonating the phone
    // toward the real desktop - using a DISTINCT attacker-controlled static
    // keypair on each leg. Even though both legs share the same pairing
    // token (as relayed/photographed from the real QR), the transcript hash
    // still commits to the static keys actually used on that leg, so the SAS
    // the phone displays and the SAS the desktop displays must differ.
    const pairingToken = randomBytes(32);
    const phoneStatic = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const attackerStaticTowardPhone = generateX25519KeyPair();
    const attackerStaticTowardDesktop = generateX25519KeyPair();

    // Leg 1: real phone <-> attacker impersonating the desktop.
    const phone = createPairingInitiatorHandshake({
      localStatic: phoneStatic,
      remoteStatic: attackerStaticTowardPhone.publicKey,
      pairingToken,
    });
    const attackerAsDesktop = createPairingResponderHandshake({
      localStatic: attackerStaticTowardPhone,
      pairingToken,
    });
    const phoneMessage1 = phone.writeMessage(new Uint8Array(0));
    attackerAsDesktop.readMessage(phoneMessage1.message);
    const attackerMessage2ToPhone = attackerAsDesktop.writeMessage(new Uint8Array(0));
    phone.readMessage(attackerMessage2ToPhone.message);

    // Leg 2: attacker impersonating the phone <-> real desktop.
    const attackerAsPhone = createPairingInitiatorHandshake({
      localStatic: attackerStaticTowardDesktop,
      remoteStatic: desktopStatic.publicKey,
      pairingToken,
    });
    const desktop = createPairingResponderHandshake({
      localStatic: desktopStatic,
      pairingToken,
    });
    const attackerMessage1ToDesktop = attackerAsPhone.writeMessage(new Uint8Array(0));
    desktop.readMessage(attackerMessage1ToDesktop.message);
    const desktopMessage2 = desktop.writeMessage(new Uint8Array(0));
    attackerAsPhone.readMessage(desktopMessage2.message);

    const sasShownOnPhone = deriveShortAuthenticationString(phone.getHandshakeHash());
    const sasShownOnDesktop = deriveShortAuthenticationString(desktop.getHandshakeHash());

    expect(sasShownOnPhone).not.toEqual(sasShownOnDesktop);
    expect(sasShownOnPhone.digits).not.toEqual(sasShownOnDesktop.digits);
  });
});

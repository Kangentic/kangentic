import { describe, expect, it } from 'vitest';
import { deriveSessionSlotId, derivePairingSlotId } from '../../../packages/protocol/src/crypto/slot';
import { generateX25519KeyPair, randomBytes, bytesToHex } from '../../../packages/protocol/src/crypto/primitives';

describe('deriveSessionSlotId', () => {
  it('is deterministic across calls for the same key pair', () => {
    const desktop = generateX25519KeyPair();
    const phone = generateX25519KeyPair();
    const first = deriveSessionSlotId(desktop.publicKey, phone.publicKey);
    const second = deriveSessionSlotId(desktop.publicKey, phone.publicKey);
    expect(first).toBe(second);
  });

  it('argument order matters, which is why both peers must agree on desktop-first', () => {
    // Both peers know both static keys from the pairing roster, so each side
    // always calls deriveSessionSlotId(desktopKey, phoneKey) - desktop
    // first, regardless of which side is calling. If the function were
    // order-independent this convention would not matter; it is not, so
    // both sides genuinely have to agree on the ordering.
    const desktop = generateX25519KeyPair();
    const phone = generateX25519KeyPair();
    const desktopFirst = deriveSessionSlotId(desktop.publicKey, phone.publicKey);
    const phoneFirst = deriveSessionSlotId(phone.publicKey, desktop.publicKey);
    expect(desktopFirst).not.toBe(phoneFirst);
  });

  it('produces a distinct slot id for a distinct phone key', () => {
    const desktop = generateX25519KeyPair();
    const phoneA = generateX25519KeyPair();
    const phoneB = generateX25519KeyPair();
    expect(deriveSessionSlotId(desktop.publicKey, phoneA.publicKey)).not.toBe(
      deriveSessionSlotId(desktop.publicKey, phoneB.publicKey),
    );
  });

  it('produces a distinct slot id for a distinct desktop key', () => {
    const desktopA = generateX25519KeyPair();
    const desktopB = generateX25519KeyPair();
    const phone = generateX25519KeyPair();
    expect(deriveSessionSlotId(desktopA.publicKey, phone.publicKey)).not.toBe(
      deriveSessionSlotId(desktopB.publicKey, phone.publicKey),
    );
  });

  it('returns a 32-character lowercase hex string (16 bytes)', () => {
    const desktop = generateX25519KeyPair();
    const phone = generateX25519KeyPair();
    const slotId = deriveSessionSlotId(desktop.publicKey, phone.publicKey);
    expect(slotId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('derivePairingSlotId', () => {
  it('is deterministic, so both peers dialing the same token meet on one slot', () => {
    const pairingToken = randomBytes(32);
    expect(derivePairingSlotId(pairingToken)).toBe(derivePairingSlotId(pairingToken));
  });

  /**
   * The regression guard this function exists for. The pairing slot used to be
   * the token itself, hex-encoded, which published the Noise IKpsk0 pre-shared
   * key in cleartext to every hop that can read a request URI. If this ever
   * goes back to equalling the raw token, that exposure is back.
   */
  it('does NOT equal the raw pairing token, which is the Noise PSK', () => {
    const pairingToken = randomBytes(32);
    expect(derivePairingSlotId(pairingToken)).not.toBe(bytesToHex(pairingToken));
  });

  it('produces a distinct slot id for a distinct token', () => {
    expect(derivePairingSlotId(randomBytes(32))).not.toBe(derivePairingSlotId(randomBytes(32)));
  });

  it('returns a 32-character lowercase hex string (16 bytes)', () => {
    // The relay's default SLOT_ID_PATTERN is ^([0-9a-f]{32}|[0-9a-f]{64})$, so
    // this shape is accepted with no relay-side change.
    expect(derivePairingSlotId(randomBytes(32))).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is domain-separated from the session slot derivation', () => {
    // Same 32 bytes fed to both derivations must not collide: the labels are
    // what keep a pairing slot and a session slot from ever being the same
    // rendezvous.
    const material = randomBytes(32);
    expect(derivePairingSlotId(material)).not.toBe(deriveSessionSlotId(material, new Uint8Array(0)));
  });
});

import { describe, expect, it } from 'vitest';
import { deriveSessionSlotId } from '../../../packages/protocol/src/crypto/slot';
import { generateX25519KeyPair } from '../../../packages/protocol/src/crypto/primitives';

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

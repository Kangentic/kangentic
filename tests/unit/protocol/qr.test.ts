import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { decodePairingQrPayload, encodePairingQrPayload, PAIRING_URI_SCHEME, type PairingQrPayload } from '../../../packages/protocol/src/pairing/qr';

function samplePayload(overrides: Partial<PairingQrPayload> = {}): PairingQrPayload {
  return {
    desktopStaticPublicKey: generateX25519KeyPair().publicKey,
    pairingToken: randomBytes(32),
    relayAddress: 'wss://relay.kangentic.com',
    expiresAt: '2026-07-10T00:10:00.000Z',
    protocolVersion: '1',
    ...overrides,
  };
}

describe('pairing QR payload', () => {
  it('round-trips through encode/decode', () => {
    const payload = samplePayload();
    const uri = encodePairingQrPayload(payload);
    expect(uri.startsWith(`${PAIRING_URI_SCHEME}://`)).toBe(true);

    const decoded = decodePairingQrPayload(uri);
    expect(Buffer.from(decoded.desktopStaticPublicKey).toString('hex')).toBe(Buffer.from(payload.desktopStaticPublicKey).toString('hex'));
    expect(Buffer.from(decoded.pairingToken).toString('hex')).toBe(Buffer.from(payload.pairingToken).toString('hex'));
    expect(decoded.relayAddress).toBe(payload.relayAddress);
    expect(decoded.expiresAt).toBe(payload.expiresAt);
    expect(decoded.protocolVersion).toBe(payload.protocolVersion);
  });

  it('never carries a long-lived secret - only a 32-byte single-use token', () => {
    const payload = samplePayload();
    const uri = encodePairingQrPayload(payload);
    // The encoded body is bounded: 1 version + 32 static key + 32 token +
    // 4 length + relay bytes + 4 length + expiresAt bytes. Assert it stays
    // in that small ballpark rather than growing to accommodate a bigger secret.
    expect(uri.length).toBeLessThan(300);
  });

  it('rejects a non-kangentic-pair URI', () => {
    expect(() => decodePairingQrPayload('https://example.com')).toThrow();
  });

  it('rejects an oversized relay address at encode time', () => {
    const payload = samplePayload({ relayAddress: 'wss://' + 'a'.repeat(600) });
    expect(() => encodePairingQrPayload(payload)).toThrow();
  });

  it('rejects a corrupted/truncated payload at decode time', () => {
    const uri = encodePairingQrPayload(samplePayload());
    const truncated = uri.slice(0, uri.length - 40);
    expect(() => decodePairingQrPayload(truncated)).toThrow();
  });
});

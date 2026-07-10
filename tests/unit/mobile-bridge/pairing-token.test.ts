/**
 * Unit tests for src/main/mobile-bridge/pairing/pairing-token.ts
 *
 * Pure logic, no fs/electron mocking needed: mintPairingToken() and
 * isPairingTokenValid() only touch @kangentic/protocol's randomBytes() and
 * an injectable `now` clock, so a real clock is never involved here.
 *
 * The service-level rejection behavior that consumes these checks (a
 * message-1 handshake attempt against an expired or already-consumed
 * token emitting 'failed') is covered in pairing-service.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { isPairingTokenValid, mintPairingToken, PAIRING_TOKEN_TTL_MS } from '../../../src/main/mobile-bridge/pairing/pairing-token';

describe('pairing token validity', () => {
  it('is valid immediately after minting', () => {
    const now = 1_000_000;
    const token = mintPairingToken(now);
    expect(isPairingTokenValid(token, now)).toBe(true);
  });

  it('is valid the instant before expiresAt and invalid at or after it', () => {
    const now = 1_000_000;
    const token = mintPairingToken(now);

    expect(isPairingTokenValid(token, token.expiresAt - 1)).toBe(true);
    expect(isPairingTokenValid(token, token.expiresAt)).toBe(false);
    expect(isPairingTokenValid(token, token.expiresAt + 1)).toBe(false);
  });

  it('is invalid once consumed, even when not yet expired', () => {
    const now = 1_000_000;
    const token = mintPairingToken(now);
    token.consumed = true;

    expect(isPairingTokenValid(token, now)).toBe(false);
  });

  it('mints a token with the documented 10 minute TTL', () => {
    const now = 1_000_000;
    const token = mintPairingToken(now);

    expect(token.expiresAt - token.createdAt).toBe(PAIRING_TOKEN_TTL_MS);
    expect(PAIRING_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('defaults `now` to the current wall clock when omitted', () => {
    const before = Date.now();
    const token = mintPairingToken();
    const after = Date.now();

    expect(token.createdAt).toBeGreaterThanOrEqual(before);
    expect(token.createdAt).toBeLessThanOrEqual(after);
  });
});

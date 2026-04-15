import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { __internal, shouldRefresh } from '../../src/main/boards/adapters/asana/oauth';
import { TOKEN_REFRESH_MARGIN_SECONDS } from '../../src/main/boards/adapters/asana/constants';
import type { AsanaCredential } from '../../src/main/boards/adapters/asana/credential-store';

const { generateVerifier, challengeForVerifier } = __internal;

function cred(expiresAt: string): AsanaCredential {
  return {
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt,
    userEmail: 'user@example.com',
    savedAt: new Date().toISOString(),
  };
}

describe('PKCE verifier/challenge generation', () => {
  it('produces a verifier with the RFC 7636 length range (43-128 chars)', () => {
    const verifier = generateVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('produces a verifier that is URL-safe base64 (no padding, no "+", no "/")', () => {
    const verifier = generateVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns a different verifier on each call', () => {
    const first = generateVerifier();
    const second = generateVerifier();
    expect(first).not.toBe(second);
  });

  it('challenge is BASE64URL(SHA256(verifier))', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(challengeForVerifier(verifier)).toBe(expected);
  });

  it('challenge is deterministic for the same verifier', () => {
    const verifier = generateVerifier();
    expect(challengeForVerifier(verifier)).toBe(challengeForVerifier(verifier));
  });
});

describe('shouldRefresh', () => {
  const now = new Date('2026-04-15T12:00:00Z').getTime();

  it('returns true when already expired', () => {
    expect(shouldRefresh(cred('2026-04-15T11:00:00Z'), now)).toBe(true);
  });

  it('returns true when within the safety margin', () => {
    const expiresAt = new Date(now + (TOKEN_REFRESH_MARGIN_SECONDS - 5) * 1000).toISOString();
    expect(shouldRefresh(cred(expiresAt), now)).toBe(true);
  });

  it('returns false when well before expiry', () => {
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();
    expect(shouldRefresh(cred(expiresAt), now)).toBe(false);
  });

  it('returns true when expiresAt is unparseable', () => {
    expect(shouldRefresh(cred('not-a-date'), now)).toBe(true);
  });
});

/**
 * The E2E push envelope is what keeps notification content invisible to
 * Expo/APNs/FCM: the blob must open only with the right push key AND the
 * right recipient identity (AAD), reject any tampering, and reject stale
 * or future-dated replays. Every rejection path throws, because the
 * device-side caller degrades a throw to the generic placeholder.
 */
import { describe, expect, it } from 'vitest';
import {
  openPushEnvelope,
  sealPushEnvelope,
  isPushCategory,
  PUSH_CATEGORIES,
  PUSH_ENVELOPE_MAX_AGE_MS,
  PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS,
  type PushEnvelopePlaintext,
} from '../../../packages/protocol/src/crypto/push-envelope';
import { randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { base64UrlDecode, base64UrlEncode } from '../../../packages/protocol/src/wire/base64url';

function plaintextFixture(overrides: Partial<PushEnvelopePlaintext> = {}): PushEnvelopePlaintext {
  return {
    category: 'input-required',
    projectId: 'proj-1',
    taskId: 'task-1',
    sessionId: 'sess-1',
    taskTitle: 'Fix the bug',
    detail: 'Bash',
    sentAt: Date.now(),
    ...overrides,
  };
}

describe('push envelope', () => {
  const pushKey = randomBytes(32);
  const recipientKey = randomBytes(32);

  it('round-trips a sealed envelope', () => {
    const plaintext = plaintextFixture();
    const blob = sealPushEnvelope(pushKey, recipientKey, plaintext);
    expect(openPushEnvelope(pushKey, recipientKey, blob)).toEqual(plaintext);
  });

  it('produces a padding-free base64url blob with a fresh nonce per seal', () => {
    const plaintext = plaintextFixture();
    const first = sealPushEnvelope(pushKey, recipientKey, plaintext);
    const second = sealPushEnvelope(pushKey, recipientKey, plaintext);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
  });

  it('rejects a tampered ciphertext (flipped byte)', () => {
    const blob = sealPushEnvelope(pushKey, recipientKey, plaintextFixture());
    const bytes = base64UrlDecode(blob);
    bytes[30] ^= 0x01; // past the 24-byte nonce, inside the ciphertext
    expect(() => openPushEnvelope(pushKey, recipientKey, base64UrlEncode(bytes))).toThrow();
  });

  it('rejects the wrong push key', () => {
    const blob = sealPushEnvelope(pushKey, recipientKey, plaintextFixture());
    expect(() => openPushEnvelope(randomBytes(32), recipientKey, blob)).toThrow();
  });

  it('rejects the wrong recipient key (AAD mismatch)', () => {
    const blob = sealPushEnvelope(pushKey, recipientKey, plaintextFixture());
    expect(() => openPushEnvelope(pushKey, randomBytes(32), blob)).toThrow();
  });

  it('rejects a stale sentAt (older than the freshness window)', () => {
    const stale = plaintextFixture({ sentAt: Date.now() - PUSH_ENVELOPE_MAX_AGE_MS - 60_000 });
    const blob = sealPushEnvelope(pushKey, recipientKey, stale);
    expect(() => openPushEnvelope(pushKey, recipientKey, blob)).toThrow(/stale/);
  });

  it('rejects a sentAt too far in the future', () => {
    const future = plaintextFixture({ sentAt: Date.now() + PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS + 60_000 });
    const blob = sealPushEnvelope(pushKey, recipientKey, future);
    expect(() => openPushEnvelope(pushKey, recipientKey, blob)).toThrow(/future/);
  });

  it('rejects a malformed blob', () => {
    expect(() => openPushEnvelope(pushKey, recipientKey, 'not base64url!!!')).toThrow();
    expect(() => openPushEnvelope(pushKey, recipientKey, base64UrlEncode(randomBytes(10)))).toThrow(/too short/);
    expect(() => openPushEnvelope(pushKey, recipientKey, base64UrlEncode(randomBytes(80)))).toThrow();
  });

  it('rejects a decrypted plaintext with an unknown category', () => {
    // Seal a syntactically valid envelope whose category is not in the set,
    // bypassing the typed seal signature via a cast-free JSON round-trip:
    // build the plaintext object as unknown-category on purpose.
    const bogus = { ...plaintextFixture(), category: 'marketing-blast' } as unknown as PushEnvelopePlaintext;
    const blob = sealPushEnvelope(pushKey, recipientKey, bogus);
    expect(() => openPushEnvelope(pushKey, recipientKey, blob)).toThrow(/category/);
  });

  it('isPushCategory accepts exactly the known categories', () => {
    for (const category of PUSH_CATEGORIES) expect(isPushCategory(category)).toBe(true);
    expect(isPushCategory('permission_needed')).toBe(false);
    expect(isPushCategory('')).toBe(false);
    expect(isPushCategory(null)).toBe(false);
  });
});

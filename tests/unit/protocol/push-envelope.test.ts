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
  isPushSessionKind,
  PUSH_CATEGORIES,
  PUSH_SESSION_KINDS,
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

  it('round-trips a workflow-complete envelope, which names no task and no session', () => {
    const plaintext = plaintextFixture({
      category: 'workflow-complete', taskId: '', sessionId: '', taskTitle: 'Usage budgets', detail: 'All 9 tasks are in Done.',
    });
    const blob = sealPushEnvelope(pushKey, recipientKey, plaintext);
    expect(openPushEnvelope(pushKey, recipientKey, blob)).toEqual(plaintext);
  });

  it('keeps workflow-complete last, so every older category keeps its place', () => {
    expect(PUSH_CATEGORIES[PUSH_CATEGORIES.length - 1]).toBe('workflow-complete');
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

  it('round-trips a Command Terminal alert with its session kind (protocol 0.20.0)', () => {
    const plaintext = plaintextFixture({ taskTitle: 'Audit Unused Feature Flags', sessionKind: 'command-terminal' });
    const blob = sealPushEnvelope(pushKey, recipientKey, plaintext);
    expect(openPushEnvelope(pushKey, recipientKey, blob)).toEqual(plaintext);
  });

  it('opens a task alert with no session kind at all', () => {
    const blob = sealPushEnvelope(pushKey, recipientKey, plaintextFixture());
    expect('sessionKind' in openPushEnvelope(pushKey, recipientKey, blob)).toBe(false);
  });

  it('drops a session kind it does not know instead of rejecting the alert', () => {
    // A newer desktop may add a kind; the notification must still open, and
    // its tap then routes as a task alert would.
    const fromNewerDesktop = { ...plaintextFixture(), sessionKind: 'future-kind' } as unknown as PushEnvelopePlaintext;
    const opened = openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, fromNewerDesktop));
    expect('sessionKind' in opened).toBe(false);
    expect(opened.taskTitle).toBe('Fix the bug');
  });

  it('round-trips an input-required alert naming its wait kind (protocol 0.26.0)', () => {
    for (const waitKind of ['question', 'approval'] as const) {
      const plaintext = plaintextFixture({ detail: '', waitKind });
      expect(openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, plaintext))).toEqual(plaintext);
    }
  });

  it('drops a wait kind it does not know instead of rejecting the alert', () => {
    const fromNewerDesktop = { ...plaintextFixture(), waitKind: 'future-kind' } as unknown as PushEnvelopePlaintext;
    const opened = openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, fromNewerDesktop));
    expect('waitKind' in opened).toBe(false);
    expect(opened.category).toBe('input-required');
  });

  it('round-trips a Notify me alert with its own title and body (protocol 0.26.0)', () => {
    const plaintext = plaintextFixture({ sessionId: '', detail: 'Blocked', title: 'Cap retries in the sync client', body: 'Blocked' });
    expect(openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, plaintext))).toEqual(plaintext);
  });

  it('drops a title or body that is not a string, and the alert still opens', () => {
    const malformed = { ...plaintextFixture(), title: 42, body: null } as unknown as PushEnvelopePlaintext;
    const opened = openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, malformed));
    expect('title' in opened).toBe(false);
    expect('body' in opened).toBe(false);
    expect(opened.taskTitle).toBe('Fix the bug');
  });

  it('opens a task alert with none of the optional fields without adding them', () => {
    const opened = openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, plaintextFixture()));
    for (const field of ['waitKind', 'title', 'body']) expect(field in opened).toBe(false);
  });

  it('isPushSessionKind accepts exactly the known kinds', () => {
    for (const kind of PUSH_SESSION_KINDS) expect(isPushSessionKind(kind)).toBe(true);
    expect(isPushSessionKind('task')).toBe(false);
    expect(isPushSessionKind(undefined)).toBe(false);
  });

  describe('piggybacked clears', () => {
    const CLEAR_ENTRY = {
      category: 'turn-complete' as const,
      projectId: 'proj-1',
      taskId: 'task-1',
      sessionId: 'sess-0',
      notifiedAt: Date.now() - 60_000,
    };

    it('round-trips an envelope carrying clears', () => {
      const plaintext = plaintextFixture({ clears: [CLEAR_ENTRY, { ...CLEAR_ENTRY, category: 'spawn-stalled', sessionId: '' }] });
      const blob = sealPushEnvelope(pushKey, recipientKey, plaintext);
      expect(openPushEnvelope(pushKey, recipientKey, blob)).toEqual(plaintext);
    });

    it('opens an envelope with no clears without adding the field', () => {
      const blob = sealPushEnvelope(pushKey, recipientKey, plaintextFixture());
      expect('clears' in openPushEnvelope(pushKey, recipientKey, blob)).toBe(false);
    });

    /**
     * A clears list is a passenger: whatever is wrong with it, the
     * notification it rides on must still open, or the user loses a real
     * alert to a bookkeeping error.
     */
    it('a malformed clears list is dropped and the notification still opens', () => {
      const notAnArray = { ...plaintextFixture(), clears: 'everything' } as unknown as PushEnvelopePlaintext;
      const openedFromString = openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, notAnArray));
      expect('clears' in openedFromString).toBe(false);
      expect(openedFromString.taskTitle).toBe('Fix the bug');

      const allBad = { ...plaintextFixture(), clears: [{ category: 'turn-complete' }, 42, null] } as unknown as PushEnvelopePlaintext;
      expect('clears' in openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, allBad))).toBe(false);
    });

    it('keeps the well-formed entries of a partly malformed list', () => {
      const mixed = { ...plaintextFixture(), clears: [CLEAR_ENTRY, { ...CLEAR_ENTRY, notifiedAt: 'yesterday' }] } as unknown as PushEnvelopePlaintext;
      expect(openPushEnvelope(pushKey, recipientKey, sealPushEnvelope(pushKey, recipientKey, mixed)).clears).toEqual([CLEAR_ENTRY]);
    });
  });
});

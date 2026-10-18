/**
 * The sealed push clear tells a phone which notifications resolved at the
 * desk. It shares the envelope's construction, so it must reject what the
 * envelope rejects (a tamper, the wrong key or recipient, a stale or future
 * replay), and every rejection throws: the phone's handler turns a throw into
 * "do nothing", never into a visible notification. Its entries are parsed
 * tolerantly, so a newer desktop's additions never cost the entries an older
 * phone understands.
 */
import { describe, expect, it } from 'vitest';
import {
  openPushClear,
  parsePushClearPlaintext,
  sealPushClear,
  sealedPushBlobLength,
  PUSH_CLEAR_DATA_KEY,
  PUSH_ENVELOPE_DATA_KEY,
  type PushClearPlaintext,
} from '../../../packages/protocol/src/crypto/push-clear';
import {
  openPushEnvelope,
  sealPushEnvelope,
  PUSH_ENVELOPE_MAX_AGE_MS,
  PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS,
  type PushClearEntry,
} from '../../../packages/protocol/src/crypto/push-envelope';
import { randomBytes } from '../../../packages/protocol/src/crypto/primitives';
import { base64UrlDecode, base64UrlEncode } from '../../../packages/protocol/src/wire/base64url';

function entryFixture(overrides: Partial<PushClearEntry> = {}): PushClearEntry {
  return {
    category: 'input-required',
    projectId: 'proj-1',
    taskId: 'task-1',
    sessionId: 'sess-1',
    notifiedAt: Date.now() - 120_000,
    ...overrides,
  };
}

function clearFixture(overrides: Partial<PushClearPlaintext> = {}): PushClearPlaintext {
  return { clears: [entryFixture()], sentAt: Date.now(), ...overrides };
}

describe('push clear', () => {
  const pushKey = randomBytes(32);
  const recipientKey = randomBytes(32);

  it('round-trips a sealed clear', () => {
    const plaintext = clearFixture({
      clears: [
        entryFixture(),
        entryFixture({ category: 'spawn-stalled', sessionId: '' }),
        entryFixture({ category: 'turn-complete', sessionId: 'term-1', sessionKind: 'command-terminal' }),
      ],
    });
    expect(openPushClear(pushKey, recipientKey, sealPushClear(pushKey, recipientKey, plaintext))).toEqual(plaintext);
  });

  it('names the two data keys a phone tells the kinds apart by', () => {
    expect(PUSH_ENVELOPE_DATA_KEY).toBe('blob');
    expect(PUSH_CLEAR_DATA_KEY).toBe('clear');
  });

  it('rejects a tampered ciphertext (flipped byte)', () => {
    const bytes = base64UrlDecode(sealPushClear(pushKey, recipientKey, clearFixture()));
    bytes[30] ^= 0x01;
    expect(() => openPushClear(pushKey, recipientKey, base64UrlEncode(bytes))).toThrow();
  });

  it('rejects the wrong push key', () => {
    const blob = sealPushClear(pushKey, recipientKey, clearFixture());
    expect(() => openPushClear(randomBytes(32), recipientKey, blob)).toThrow();
  });

  it('rejects the wrong recipient key (AAD mismatch)', () => {
    const blob = sealPushClear(pushKey, recipientKey, clearFixture());
    expect(() => openPushClear(pushKey, randomBytes(32), blob)).toThrow();
  });

  it('rejects a stale sentAt', () => {
    const blob = sealPushClear(pushKey, recipientKey, clearFixture({ sentAt: Date.now() - PUSH_ENVELOPE_MAX_AGE_MS - 60_000 }));
    expect(() => openPushClear(pushKey, recipientKey, blob)).toThrow(/stale/);
  });

  it('rejects a sentAt too far in the future', () => {
    const blob = sealPushClear(pushKey, recipientKey, clearFixture({ sentAt: Date.now() + PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS + 60_000 }));
    expect(() => openPushClear(pushKey, recipientKey, blob)).toThrow(/future/);
  });

  it('rejects a blob too short to hold a nonce and tag', () => {
    expect(() => openPushClear(pushKey, recipientKey, base64UrlEncode(randomBytes(10)))).toThrow(/too short/);
  });

  it('rejects a message whose clears is not an array, or whose sentAt is not a number', () => {
    expect(() => parsePushClearPlaintext({ clears: 'all', sentAt: Date.now() })).toThrow(/clears/);
    expect(() => parsePushClearPlaintext({ sentAt: Date.now() })).toThrow(/clears/);
    expect(() => parsePushClearPlaintext({ clears: [], sentAt: 'now' })).toThrow(/sentAt/);
    expect(() => parsePushClearPlaintext([])).toThrow(/object/);
  });

  it('ignores unknown fields on the message and on its entries', () => {
    const fromNewerDesktop = {
      clears: [{ ...entryFixture(), reason: 'answered-at-desk' }],
      sentAt: Date.now(),
      batchId: 'b-1',
    } as unknown as PushClearPlaintext;
    const opened = openPushClear(pushKey, recipientKey, sealPushClear(pushKey, recipientKey, fromNewerDesktop));
    expect(opened).toEqual({ clears: [entryFixture({ notifiedAt: fromNewerDesktop.clears[0].notifiedAt })], sentAt: fromNewerDesktop.sentAt });
  });

  /**
   * Entry-level tolerance: one entry this phone cannot read costs only
   * itself. A newer desktop's new category is the realistic case.
   */
  it('drops an entry with an unknown category, a non-string id or a non-finite notifiedAt, and keeps the rest', () => {
    const good = entryFixture();
    const mixed = {
      clears: [
        { ...good, category: 'a-category-from-the-future' },
        { ...good, taskId: 42 },
        { ...good, notifiedAt: null },
        { ...good, notifiedAt: 'yesterday' },
        'not-an-entry',
        good,
      ],
      sentAt: Date.now(),
    } as unknown as PushClearPlaintext;
    expect(openPushClear(pushKey, recipientKey, sealPushClear(pushKey, recipientKey, mixed)).clears).toEqual([good]);
  });

  it('omits a session kind it does not know rather than dropping the entry', () => {
    const plaintext = { clears: [{ ...entryFixture(), sessionKind: 'future-kind' }], sentAt: Date.now() } as unknown as PushClearPlaintext;
    const [opened] = openPushClear(pushKey, recipientKey, sealPushClear(pushKey, recipientKey, plaintext)).clears;
    expect('sessionKind' in opened).toBe(false);
    expect(opened.sessionId).toBe('sess-1');
  });

  /**
   * One key and one AAD seal both kinds. A clear delivered where a
   * notification belongs must fail the envelope parse (the phone then shows
   * its placeholder, which junk could cause anyway), never open as an alert.
   */
  it('a clear blob does not open as a notification envelope', () => {
    const blob = sealPushClear(pushKey, recipientKey, clearFixture());
    expect(() => openPushEnvelope(pushKey, recipientKey, blob)).toThrow(/category/);
  });

  it('a notification envelope with no clears does not open as a clear', () => {
    const blob = sealPushEnvelope(pushKey, recipientKey, {
      category: 'input-required',
      projectId: 'proj-1',
      taskId: 'task-1',
      sessionId: 'sess-1',
      taskTitle: 'Fix the bug',
      detail: '',
      sentAt: Date.now(),
    });
    expect(() => openPushClear(pushKey, recipientKey, blob)).toThrow(/clears/);
  });

  it('sealedPushBlobLength predicts the sealed length exactly, multi-byte text included', () => {
    const plaintexts: object[] = [
      clearFixture(),
      clearFixture({ clears: [] }),
      clearFixture({ clears: Array.from({ length: 9 }, (_, index) => entryFixture({ sessionId: `sess-${index}` })) }),
      { category: 'turn-complete', taskTitle: 'Réparer le café ☕ 修复', sentAt: Date.now() },
    ];
    for (const plaintext of plaintexts) {
      expect(sealedPushBlobLength(plaintext)).toBe(sealPushClear(pushKey, recipientKey, plaintext as PushClearPlaintext).length);
    }
  });
});

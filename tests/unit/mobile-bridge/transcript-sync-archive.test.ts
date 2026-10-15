/**
 * `TranscriptSync.diff` treats a transcript read from Kangentic's archive like
 * a live one: the archive keeps the file's own uuids and only changes when the
 * archive does, so the phone gets incremental deltas, not a full re-fetch on
 * every change. An index read stays unstable (its uuids are synthesized from
 * chunk ids), so it keeps resetting.
 *
 * The harness is copied from `transcript-sync.test.ts`, which seeds only the
 * `live` and `index` sources.
 */
import { describe, it, expect } from 'vitest';
import type { TranscriptEntry } from '../../../src/shared/types';
import type { ResolvedTaskTranscript } from '../../../src/main/agent/transcript-service';
import { TranscriptSync } from '../../../src/main/mobile-bridge/handlers/transcript-sync';

function userEntry(uuid: string, text = `text for ${uuid}`): TranscriptEntry {
  return { kind: 'user', uuid, ts: 1000, text };
}

function assistantEntry(uuid: string, blockText: string): TranscriptEntry {
  return { kind: 'assistant', uuid, ts: 2000, blocks: [{ type: 'text', text: blockText }] };
}

function resolved(revision: number, entries: TranscriptEntry[], overrides: Partial<ResolvedTaskTranscript> = {}): ResolvedTaskTranscript {
  return { revision, entries, source: 'live', degraded: false, ...overrides } as ResolvedTaskTranscript;
}

describe('TranscriptSync over an archived transcript', () => {
  it('sends an incremental delta for an appended entry, not a reset', () => {
    const sync = new TranscriptSync();
    const first = userEntry('u1');
    sync.seed(resolved(1, [first], { source: 'archive', degraded: false }));

    const appended = assistantEntry('a1', 'a reply read from the saved copy');
    const payloads = sync.diff(resolved(2, [first, appended], { source: 'archive', degraded: false }));

    expect(payloads).toEqual([{
      mode: 'delta',
      revision: 2,
      totalEntries: 2,
      upserts: [{ index: 1, entry: { kind: 'assistant', uuid: 'a1', ts: 2000, blocks: [{ type: 'text', text: 'a reply read from the saved copy' }] } }],
    }]);
  });

  it('keeps diffing across several polls and sends nothing when the revision has not moved', () => {
    const sync = new TranscriptSync();
    const first = userEntry('u1');
    const second = assistantEntry('a1', 'first reply');
    sync.seed(resolved(1, [first], { source: 'archive' }));

    const afterSecond = sync.diff(resolved(2, [first, second], { source: 'archive' }));
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].mode).toBe('delta');

    expect(sync.diff(resolved(2, [first, second], { source: 'archive' }))).toEqual([]);

    const afterThird = sync.diff(resolved(3, [first, second, userEntry('u2')], { source: 'archive' }));
    expect(afterThird).toHaveLength(1);
    const delta = afterThird[0];
    if (delta.mode !== 'delta') throw new Error('expected a delta');
    expect(delta.upserts.map((upsert) => upsert.index)).toEqual([2]);
  });

  it('still resets when an archived transcript shrinks or a uuid moves', () => {
    const shrunk = new TranscriptSync();
    shrunk.seed(resolved(1, [userEntry('u1'), userEntry('u2')], { source: 'archive' }));
    expect(shrunk.diff(resolved(2, [userEntry('u1')], { source: 'archive' }))).toEqual([
      { mode: 'reset', revision: 2, totalEntries: 1 },
    ]);

    const moved = new TranscriptSync();
    moved.seed(resolved(1, [userEntry('u1'), userEntry('u2')], { source: 'archive' }));
    expect(moved.diff(resolved(2, [userEntry('u2'), userEntry('u1')], { source: 'archive' }))).toEqual([
      { mode: 'reset', revision: 2, totalEntries: 2 },
    ]);
  });

  it('resets for an archived transcript that is flagged degraded: degraded still wins', () => {
    const sync = new TranscriptSync();
    const first = userEntry('u1');
    sync.seed(resolved(1, [first], { source: 'archive', degraded: true }));
    expect(sync.diff(resolved(2, [first, userEntry('u2')], { source: 'archive', degraded: true }))).toEqual([
      { mode: 'reset', revision: 2, totalEntries: 2 },
    ]);
  });

  it('contrast: an index read that is not flagged degraded still resets on an append', () => {
    // `degraded: false` isolates the source clause. With `degraded: true` the
    // reset would come from the degraded flag alone and prove nothing here.
    const sync = new TranscriptSync();
    const first = userEntry('u1');
    sync.seed(resolved(1, [first], { source: 'index', degraded: false }));
    expect(sync.diff(resolved(2, [first, userEntry('u2')], { source: 'index', degraded: false }))).toEqual([
      { mode: 'reset', revision: 2, totalEntries: 2 },
    ]);
  });

  it('contrast: a live read diffs the same append as a delta', () => {
    const sync = new TranscriptSync();
    const first = userEntry('u1');
    sync.seed(resolved(1, [first], { source: 'live' }));
    const payloads = sync.diff(resolved(2, [first, userEntry('u2')], { source: 'live' }));
    expect(payloads).toHaveLength(1);
    expect(payloads[0].mode).toBe('delta');
  });
});

import { describe, it, expect } from 'vitest';
import type { TranscriptEntry } from '../../../src/shared/types';
import type { ResolvedTaskTranscript } from '../../../src/main/agent/transcript-service';
import {
  DELTA_CHUNK_BUDGET_CHARS,
  sliceTranscriptWindow,
  TranscriptSync,
  WINDOW_DEFAULT_LIMIT,
} from '../../../src/main/mobile-bridge/handlers/transcript-sync';

function userEntry(uuid: string, text = `text for ${uuid}`): TranscriptEntry {
  return { kind: 'user', uuid, ts: 1000, text };
}

function assistantEntry(uuid: string, blockText: string): TranscriptEntry {
  return { kind: 'assistant', uuid, ts: 2000, blocks: [{ type: 'text', text: blockText }] };
}

function resolved(revision: number, entries: TranscriptEntry[], overrides: Partial<ResolvedTaskTranscript> = {}): ResolvedTaskTranscript {
  return { revision, entries, source: 'live', degraded: false, ...overrides } as ResolvedTaskTranscript;
}

describe('TranscriptSync', () => {
  it('returns nothing when the revision has not moved', () => {
    const sync = new TranscriptSync();
    const transcript = resolved(1, [userEntry('u1')]);
    sync.seed(transcript);
    expect(sync.diff(transcript)).toEqual([]);
  });

  it('seed marks entries as known so the next diff carries only what changed', () => {
    const sync = new TranscriptSync();
    const first = userEntry('u1');
    sync.seed(resolved(1, [first]));

    const appended = assistantEntry('a1', 'streamed reply');
    const payloads = sync.diff(resolved(2, [first, appended]));

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      mode: 'delta',
      revision: 2,
      totalEntries: 2,
      upserts: [{ index: 1, entry: { kind: 'assistant', uuid: 'a1', ts: 2000, blocks: [{ type: 'text', text: 'streamed reply' }] } }],
    });
  });

  it('a mutating tail entry (same uuid, new content) is re-sent as an upsert at its index', () => {
    const sync = new TranscriptSync();
    const first = userEntry('u1');
    sync.seed(resolved(1, [first, assistantEntry('a1', 'partial')]));

    const payloads = sync.diff(resolved(2, [first, assistantEntry('a1', 'partial plus more streamed text')]));

    expect(payloads).toHaveLength(1);
    const delta = payloads[0];
    if (delta.mode !== 'delta') throw new Error('expected a delta');
    expect(delta.upserts.map((upsert) => upsert.index)).toEqual([1]);
  });

  it('an unchanged entry (same object reference) is never re-sent even when a neighbor changes', () => {
    const sync = new TranscriptSync();
    const stable = userEntry('u1');
    sync.seed(resolved(1, [stable]));

    const payloads = sync.diff(resolved(2, [stable, userEntry('u2')]));

    expect(payloads).toHaveLength(1);
    const delta = payloads[0];
    if (delta.mode !== 'delta') throw new Error('expected a delta');
    expect(delta.upserts.map((upsert) => upsert.entry.uuid)).toEqual(['u2']);
  });

  it('a re-parsed but content-identical entry (new reference, same JSON) is not re-sent', () => {
    const sync = new TranscriptSync();
    sync.seed(resolved(1, [userEntry('u1', 'same words')]));

    const payloads = sync.diff(resolved(2, [userEntry('u1', 'same words'), userEntry('u2')]));

    expect(payloads).toHaveLength(1);
    const delta = payloads[0];
    if (delta.mode !== 'delta') throw new Error('expected a delta');
    expect(delta.upserts.map((upsert) => upsert.entry.uuid)).toEqual(['u2']);
  });

  it('splits a large delta into several chunks under the byte budget', () => {
    const sync = new TranscriptSync();
    sync.seed(resolved(1, []));

    const bigText = 'x'.repeat(Math.floor(DELTA_CHUNK_BUDGET_CHARS / 3));
    const entries = [0, 1, 2, 3, 4, 5].map((position) => assistantEntry(`big-${position}`, bigText));
    const payloads = sync.diff(resolved(2, entries));

    expect(payloads.length).toBeGreaterThan(1);
    const allUpserts = payloads.flatMap((payload) => (payload.mode === 'delta' ? payload.upserts : []));
    expect(allUpserts.map((upsert) => upsert.index)).toEqual([0, 1, 2, 3, 4, 5]);
    for (const payload of payloads) {
      if (payload.mode !== 'delta') throw new Error('expected deltas');
      const chars = payload.upserts.reduce((sum, upsert) => sum + JSON.stringify(upsert.entry).length, 0);
      expect(chars).toBeLessThanOrEqual(DELTA_CHUNK_BUDGET_CHARS);
    }
  });

  it('emits a reset when the transcript shrinks', () => {
    const sync = new TranscriptSync();
    sync.seed(resolved(1, [userEntry('u1'), userEntry('u2')]));
    expect(sync.diff(resolved(2, [userEntry('u1')]))).toEqual([{ mode: 'reset', revision: 2, totalEntries: 1 }]);
  });

  it('emits a reset when a uuid moves to a different index', () => {
    const sync = new TranscriptSync();
    sync.seed(resolved(1, [userEntry('u1'), userEntry('u2')]));
    expect(sync.diff(resolved(2, [userEntry('u2'), userEntry('u1'), userEntry('u3')]))).toEqual([
      { mode: 'reset', revision: 2, totalEntries: 3 },
    ]);
  });

  it('emits a reset on every change for degraded/index sources whose uuids are unstable', () => {
    const sync = new TranscriptSync();
    sync.seed(resolved(1, [userEntry('u1')], { source: 'index', degraded: true }));
    expect(sync.diff(resolved(2, [userEntry('u1'), userEntry('u2')], { source: 'index', degraded: true }))).toEqual([
      { mode: 'reset', revision: 2, totalEntries: 2 },
    ]);
  });

  it('seed after a diff is a no-op (a session event can race the async subscribe-time seed)', () => {
    const sync = new TranscriptSync();
    const payloads = sync.diff(resolved(3, [userEntry('u1')]));
    expect(payloads).toHaveLength(1);

    sync.seed(resolved(2, [userEntry('u1')]));
    expect(sync.diff(resolved(4, [userEntry('u1'), userEntry('u2')]))).toHaveLength(1);
  });
});

describe('sliceTranscriptWindow', () => {
  const entries = Array.from({ length: 10 }, (_, position) => userEntry(`u${position}`));

  it('returns the newest window by default', () => {
    const slice = sliceTranscriptWindow(resolved(5, entries), undefined, 3);
    expect(slice.revision).toBe(5);
    expect(slice.totalEntries).toBe(10);
    expect(slice.startIndex).toBe(7);
    expect(slice.entries.map((entry) => entry.uuid)).toEqual(['u7', 'u8', 'u9']);
  });

  it('pages older history via beforeIndex', () => {
    const slice = sliceTranscriptWindow(resolved(5, entries), 7, 3);
    expect(slice.startIndex).toBe(4);
    expect(slice.entries.map((entry) => entry.uuid)).toEqual(['u4', 'u5', 'u6']);
  });

  it('clamps beforeIndex past the end and applies the default limit', () => {
    const slice = sliceTranscriptWindow(resolved(5, entries), 999, undefined);
    expect(slice.startIndex).toBe(Math.max(0, 10 - WINDOW_DEFAULT_LIMIT));
    expect(slice.entries).toHaveLength(10);
  });

  it('stops early on the byte budget but always returns at least one entry', () => {
    const huge = assistantEntry('huge', 'y'.repeat(DELTA_CHUNK_BUDGET_CHARS));
    const slice = sliceTranscriptWindow(resolved(5, [userEntry('u0'), huge]), undefined, 5);
    expect(slice.entries.map((entry) => entry.uuid)).toEqual(['huge']);
    expect(slice.startIndex).toBe(1);
  });

  it('returns an empty window for an empty transcript', () => {
    const slice = sliceTranscriptWindow(resolved(0, []), undefined, undefined);
    expect(slice).toEqual({ revision: 0, totalEntries: 0, startIndex: 0, entries: [] });
  });
});

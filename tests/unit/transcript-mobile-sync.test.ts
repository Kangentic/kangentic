/**
 * The retrieval worker's `transcript.mobileSync` and `transcript.mobileRelease`:
 * one phone subscription's sync state lives in the worker, keyed by `syncId`,
 * and a sync the worker does not know answers a `diff` with a `reset`.
 *
 * The handlers are driven directly. `resolveTaskTranscript` is the one thing
 * replaced, so a test can hold a read open and release it when it chooses; the
 * sync bookkeeping, `TranscriptSync` and the preview are the shipped ones.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { TranscriptEntry } from '../../src/shared/types';
import type { ResolvedTaskTranscript } from '../../src/main/agent/transcript-service';
import type { WorkerContext } from '../../src/main/retrieval/worker/methods';

const { resolveTaskTranscriptMock } = vi.hoisted(() => ({ resolveTaskTranscriptMock: vi.fn() }));

vi.mock('../../src/main/agent/transcript-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/transcript-service')>();
  return { ...actual, resolveTaskTranscript: resolveTaskTranscriptMock };
});

import { transcriptHandlers } from '../../src/main/retrieval/worker/transcript-methods';

type ResolvedRead = ResolvedTaskTranscript | null;

/** `resolveTaskTranscript` is mocked, so the database is never touched. */
const context: WorkerContext = {
  getDb: () => ({}) as unknown as Database.Database,
  closeDb: () => undefined,
  vecLoadError: () => null,
  emit: () => undefined,
};

function userEntry(uuid: string): TranscriptEntry {
  return { kind: 'user', uuid, ts: 1000, text: `text for ${uuid}` };
}

function assistantEntry(uuid: string, text: string): TranscriptEntry {
  return { kind: 'assistant', uuid, ts: 2000, blocks: [{ type: 'text', text }] };
}

/** A live, non-degraded transcript: the only kind `TranscriptSync.diff` patches with a delta. */
function transcriptOf(revision: number, entries: TranscriptEntry[]): ResolvedTaskTranscript {
  return { revision, entries, source: 'live', degraded: false } as ResolvedTaskTranscript;
}

function deferredRead(): { promise: Promise<ResolvedRead>; resolve: (value: ResolvedRead) => void } {
  let resolve: (value: ResolvedRead) => void = () => undefined;
  const promise = new Promise<ResolvedRead>((resolveRead) => { resolve = resolveRead; });
  return { promise, resolve };
}

function mobileSync(syncId: string, mode: 'seed' | 'diff') {
  return transcriptHandlers['transcript.mobileSync']({ syncId, projectId: 'project-1', sessionId: 'session-1', mode, remoteTargets: [] }, context);
}

function mobileRelease(syncId: string) {
  return transcriptHandlers['transcript.mobileRelease']({ syncId }, context);
}

// What the phone was seeded with, and one revision later: the same entries
// (same uuids, same object references) plus one appended. A diff against a seed
// of the first is a `delta`; a diff against nothing is a `reset`, so the two
// cannot be confused with the other ways `diff` itself answers a reset (a
// degraded source, a shrink, a uuid that moved).
const seededEntries = [userEntry('u1'), assistantEntry('a1', 'the first reply')];
const seeded = transcriptOf(1, seededEntries);
const appended = transcriptOf(2, [...seededEntries, userEntry('u2')]);

beforeEach(() => {
  resolveTaskTranscriptMock.mockReset();
});

describe('transcript.mobileSync', () => {
  // Every sync id is fresh: the worker keeps its sync state in module scope.

  it('answers a diff after a seed with only what changed (control)', async () => {
    const syncId = 'sync-control';
    resolveTaskTranscriptMock.mockResolvedValueOnce(seeded);
    expect(await mobileSync(syncId, 'seed')).toEqual({ payloads: [], preview: 'the first reply' });

    resolveTaskTranscriptMock.mockResolvedValueOnce(appended);
    const diffed = await mobileSync(syncId, 'diff');

    expect(diffed.payloads).toEqual([
      expect.objectContaining({ mode: 'delta', revision: 2, totalEntries: 3, upserts: [expect.objectContaining({ index: 2 })] }),
    ]);
  });

  it('answers a diff for a sync the worker never saw with a reset, so the phone refetches its window', async () => {
    resolveTaskTranscriptMock.mockResolvedValueOnce(appended);

    const diffed = await mobileSync('sync-never-seen', 'diff');

    expect(diffed.payloads).toEqual([{ mode: 'reset', revision: 2, totalEntries: 3 }]);
  });

  // Red-green: this pins the `releasedMidRead` / `releasedDuringRead` guard in
  // `transcript.mobileSync`. The seed's read is still awaiting when the release
  // lands. Without the guard the seed finishes afterwards, `mobileSyncs.set`
  // recreates the state the release just deleted, and nothing ever releases it
  // again (a sync id is never reused): the seed then returns the preview and not
  // `{ payloads: [], preview: null }`, and the later diff finds a known sync and
  // answers a `delta` where it must answer a `reset`. Both assertions go red.
  it('leaves no sync state behind when a release lands while the seed is still awaiting its read', async () => {
    const syncId = 'sync-released-mid-seed';
    const heldRead = deferredRead();
    resolveTaskTranscriptMock.mockReturnValueOnce(heldRead.promise);

    // The handler reaches its await synchronously, so the read is in flight here.
    const seeding = mobileSync(syncId, 'seed');
    await mobileRelease(syncId);
    heldRead.resolve(seeded);

    // The subscription is gone: the late seed sends nothing and keeps nothing.
    expect(await seeding).toEqual({ payloads: [], preview: null });

    resolveTaskTranscriptMock.mockResolvedValueOnce(appended);
    const diffed = await mobileSync(syncId, 'diff');

    expect(diffed.payloads).toEqual([{ mode: 'reset', revision: 2, totalEntries: 3 }]);
  });

  // Red-green: the release marker must outlive the first of two reads in
  // flight. If the first read to finish cleared it, the second would see no
  // release, create the state and leave it behind: the later diff would answer
  // a `delta`, not a `reset`.
  it('keeps ignoring a released subscription until every read that was awaiting it has finished', async () => {
    const syncId = 'sync-released-mid-two-reads';
    const firstRead = deferredRead();
    const secondRead = deferredRead();
    resolveTaskTranscriptMock.mockReturnValueOnce(firstRead.promise);
    resolveTaskTranscriptMock.mockReturnValueOnce(secondRead.promise);

    const firstSeed = mobileSync(syncId, 'seed');
    const secondSeed = mobileSync(syncId, 'seed');
    await mobileRelease(syncId);
    firstRead.resolve(seeded);
    expect(await firstSeed).toEqual({ payloads: [], preview: null });
    secondRead.resolve(seeded);
    expect(await secondSeed).toEqual({ payloads: [], preview: null });

    resolveTaskTranscriptMock.mockResolvedValueOnce(appended);
    const diffed = await mobileSync(syncId, 'diff');

    expect(diffed.payloads).toEqual([{ mode: 'reset', revision: 2, totalEntries: 3 }]);
  });

  it('forgets a seeded subscription on release, so its next diff is a reset', async () => {
    const syncId = 'sync-released-after-seed';
    resolveTaskTranscriptMock.mockResolvedValueOnce(seeded);
    await mobileSync(syncId, 'seed');

    await mobileRelease(syncId);
    resolveTaskTranscriptMock.mockResolvedValueOnce(appended);
    const diffed = await mobileSync(syncId, 'diff');

    expect(diffed.payloads).toEqual([{ mode: 'reset', revision: 2, totalEntries: 3 }]);
  });
});

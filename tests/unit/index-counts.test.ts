/**
 * `index-counts.ts` counts one project's index for both Index surfaces (the
 * map's snapshot and Settings' status poll). Each read it makes fails on its
 * own: a read that throws costs only its own figure, never the whole count.
 * The index lives in a worker's database, so a table can be missing or locked
 * mid-read, and a count that threw would blank the whole panel.
 */

import { describe, it, expect, vi } from 'vitest';
import { corporaOf, readIndexCounts, summaryCountsOf, type CorpusTotalsRow, type SummaryCountSource } from '../../src/main/retrieval/index-counts';
import type { RetrievalStore } from '../../src/main/retrieval/retrieval-store';
import { NO_SUMMARIES, waitingCorporaOf } from '../../src/shared/index-summary';
import type { SummaryChoiceCount } from '../../src/shared/types';

const WRITTEN_WITH: SummaryChoiceCount[] = [{ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low', count: 4 }];

/** The reads `index-counts.ts` makes of the store, and nothing else. */
type CountingStore = Pick<RetrievalStore, 'summaryCounts' | 'countChunksNeedingEmbedding' | 'hasVec'>;

function storeOf(reads: Partial<CountingStore>): RetrievalStore {
  const unused = (): never => {
    throw new Error('this read is not part of the test');
  };
  const store: CountingStore = {
    summaryCounts: unused,
    countChunksNeedingEmbedding: unused,
    // Its vector tables exist unless a test says they do not.
    hasVec: true,
    ...reads,
  };
  return store as unknown as RetrievalStore;
}

function summarySourceOf(reads: Partial<SummaryCountSource> = {}): SummaryCountSource {
  return {
    awaitingRewrite: () => 3,
    writtenWith: () => WRITTEN_WITH,
    ...reads,
  };
}

const failingRead = (): never => {
  throw new Error('no such table');
};

/** What a project counts when the scheduler has done nothing: main adds the real activity. */
const NO_ACTIVITY = { skipped: 0, state: 'idle', retryInMs: null, choice: null };

describe('summaryCountsOf', () => {
  const store = storeOf({ summaryCounts: () => ({ written: 5, finishedTasks: 6 }) });

  it('reads the written and finished counts from the store and the rest from the summary source', () => {
    expect(summaryCountsOf(store, summarySourceOf())).toEqual({
      written: 5,
      finishedTasks: 6,
      awaitingRewrite: 3,
      writtenWith: WRITTEN_WITH,
      ...NO_ACTIVITY,
    });
  });

  // Red-green: `summaryCountsOf` wraps `store.summaryCounts()` in `readOr`. Spread
  // it bare (`...store.summaryCounts()`) and the throw escapes `summaryCountsOf`,
  // so this test fails with the thrown error instead of the zeros.
  it('zeroes written and finishedTasks when the store cannot count them, keeping the summary source figures', () => {
    const failingStore = storeOf({ summaryCounts: failingRead });
    expect(summaryCountsOf(failingStore, summarySourceOf())).toEqual({
      written: 0,
      finishedTasks: 0,
      awaitingRewrite: 3,
      writtenWith: WRITTEN_WITH,
      ...NO_ACTIVITY,
    });
  });

  // Red-green: the `readOr` around `summaryStore.awaitingRewrite()` in
  // `summaryCountsOf`. Without it, the throw escapes.
  // Without the fallback `0` (say, `readOr(..., 3)`), the value assertion fails.
  it('falls back to zero awaiting rewrite alone when that read fails', () => {
    const counts = summaryCountsOf(store, summarySourceOf({ awaitingRewrite: failingRead }));
    expect(counts).toEqual({
      written: 5,
      finishedTasks: 6,
      awaitingRewrite: 0,
      writtenWith: WRITTEN_WITH,
      ...NO_ACTIVITY,
    });
  });

  // Red-green: the `readOr` around `summaryStore.writtenWith()` in
  // `summaryCountsOf`. Without it the throw escapes, and a
  // fallback that is not an empty list fails the `[]` assertion.
  it('falls back to an empty written-with list alone when that read fails', () => {
    const counts = summaryCountsOf(store, summarySourceOf({ writtenWith: failingRead }));
    expect(counts).toEqual({
      written: 5,
      finishedTasks: 6,
      awaitingRewrite: 3,
      writtenWith: [],
      ...NO_ACTIVITY,
    });
  });

  it('still returns a full set of zeros when every read fails', () => {
    const failingStore = storeOf({ summaryCounts: failingRead });
    const failingSource = summarySourceOf({ awaitingRewrite: failingRead, writtenWith: failingRead });
    expect(summaryCountsOf(failingStore, failingSource)).toEqual({
      written: 0,
      finishedTasks: 0,
      awaitingRewrite: 0,
      writtenWith: [],
      ...NO_ACTIVITY,
    });
  });
});

describe('corporaOf', () => {
  // The conversation and code rows have totals whose embedded count is below
  // their chunk count, so a result that treated them as fully embedded would not
  // match. The task row is fully embedded, so it is the control for that case.
  const totals: CorpusTotalsRow[] = [
    { corpus: 'conversation', documents: 2, chunks: 10, embeddedChunks: 2 },
    { corpus: 'task', documents: 1, chunks: 4, embeddedChunks: 4 },
    { corpus: 'change', documents: 1, chunks: 3, embeddedChunks: 0 },
    { corpus: 'code', documents: 1, chunks: 2, embeddedChunks: 1 },
  ];

  // Red-green: the `try/catch` around `countChunksNeedingEmbedding` in
  // `corporaOf`. Without it, the throw escapes `corporaOf`. If the catch left an empty map instead of `null`
  // (`waiting = new Map()`), every embedded corpus would read as fully embedded
  // (`chunks - 0`) and the conversation row (10, not 2) and the code row (2, not 1)
  // below would fail. The task row is 4 of 4 either way and does not discriminate.
  it('falls back to the totals\' own embedded counts when the waiting read throws', () => {
    const store = storeOf({ countChunksNeedingEmbedding: failingRead });
    expect(corporaOf(store, totals, { modelTag: 'bge@2', semantic: true })).toEqual([
      { corpus: 'conversation', documents: 2, chunks: 10, embeddedChunks: 2, embeds: true },
      { corpus: 'task', documents: 1, chunks: 4, embeddedChunks: 4, embeds: true },
      { corpus: 'change', documents: 1, chunks: 3, embeddedChunks: 0, embeds: false },
      // No row in the totals: zeros, and it does not embed.
      { corpus: 'commit', documents: 0, chunks: 0, embeddedChunks: 0, embeds: false },
      { corpus: 'code', documents: 1, chunks: 2, embeddedChunks: 1, embeds: true },
    ]);
  });

  it('subtracts the passages that wait from each embedded corpus and ignores the corpora that never embed', () => {
    const countChunksNeedingEmbedding = vi.fn(
      () => new Map<string, number>([['task', 1], ['code', 5], ['change', 99]]),
    );
    const store = storeOf({ countChunksNeedingEmbedding });
    expect(corporaOf(store, totals, { modelTag: 'bge@2', semantic: true })).toEqual([
      // Nothing waits here: every passage is embedded, whatever the stale totals say.
      { corpus: 'conversation', documents: 2, chunks: 10, embeddedChunks: 10, embeds: true },
      { corpus: 'task', documents: 1, chunks: 4, embeddedChunks: 3, embeds: true },
      // Text only: what waits is not read, so the totals stand.
      { corpus: 'change', documents: 1, chunks: 3, embeddedChunks: 0, embeds: false },
      { corpus: 'commit', documents: 0, chunks: 0, embeddedChunks: 0, embeds: false },
      // The totals trail a fresh index: more wait than the totals hold, so the
      // corpus counts at least the passages that wait, none of them embedded.
      { corpus: 'code', documents: 1, chunks: 5, embeddedChunks: 0, embeds: true },
    ]);
    expect(countChunksNeedingEmbedding).toHaveBeenCalledWith('bge@2');
  });

  it('does not read what waits while semantic search is off, and keeps the totals\' counts', () => {
    const countChunksNeedingEmbedding = vi.fn(() => new Map<string, number>([['task', 4]]));
    const store = storeOf({ countChunksNeedingEmbedding });
    const corpora = corporaOf(store, totals, { modelTag: 'bge@2', semantic: false });
    expect(countChunksNeedingEmbedding).not.toHaveBeenCalled();
    expect(corpora.find((entry) => entry.corpus === 'conversation')).toMatchObject({ chunks: 10, embeddedChunks: 2 });
    expect(corpora.find((entry) => entry.corpus === 'task')).toMatchObject({ chunks: 4, embeddedChunks: 4 });
  });

  // The real store answers `countChunksNeedingEmbedding` with an EMPTY map while
  // it has no vector table (a project not drained since semantic search was
  // switched on). Read as "nothing waits", that makes every passage embedded, so
  // the corpus never reads as waiting and is never drained.
  //
  // Red-green: `corporaOf`'s waiting read. Without `&& store.hasVec` the empty map is
  // read, the conversation row becomes 10 of 10 embedded, `waitingCorporaOf`
  // lists nothing, and the read-count assertion fails too.
  it('keeps the totals\' counts and lists the corpus as waiting when the store has no vector table', () => {
    // No vector table, so no passage has a vector yet.
    const unembeddedTotals: CorpusTotalsRow[] = [{ corpus: 'conversation', documents: 2, chunks: 10, embeddedChunks: 0 }];
    const countChunksNeedingEmbedding = vi.fn(() => new Map<string, number>());
    const store = storeOf({ countChunksNeedingEmbedding, hasVec: false });
    const corpora = corporaOf(store, unembeddedTotals, { modelTag: 'bge@2', semantic: true });
    expect(countChunksNeedingEmbedding).not.toHaveBeenCalled();
    expect(corpora.find((entry) => entry.corpus === 'conversation')).toEqual(
      { corpus: 'conversation', documents: 2, chunks: 10, embeddedChunks: 0, embeds: true },
    );
    expect(waitingCorporaOf(corpora)).toContain('conversation');
  });
});

describe('readIndexCounts', () => {
  const totals: CorpusTotalsRow[] = [{ corpus: 'conversation', documents: 2, chunks: 10, embeddedChunks: 10 }];

  /**
   * Spies that answer with real figures. They answer rather than throw because
   * `summaryCountsOf` wraps every read in `readOr`: a read that throws is
   * swallowed into zeros, so a reverted gate would still return zeros and a
   * throwing stub could not tell it from the gate holding. A call is the only
   * thing that tells them apart.
   */
  function summaryReadsOf() {
    const summaryCounts = vi.fn(() => ({ written: 5, finishedTasks: 6 }));
    const awaitingRewrite = vi.fn(() => 3);
    const writtenWith = vi.fn(() => WRITTEN_WITH);
    return {
      summaryCounts,
      awaitingRewrite,
      writtenWith,
      store: storeOf({ summaryCounts }),
      summarySource: summarySourceOf({ awaitingRewrite, writtenWith }),
    };
  }

  // Red-green: `options.summaries ? summaryCountsOf(...) : ...` in
  // `readIndexCounts`. Make it always call `summaryCountsOf` and all three spies
  // are called and `summaries` carries 5 / 6 / 3 in place of zeros. Dropping the
  // spread of `writtenWith: []` for the shared `NO_SUMMARIES` object also fails
  // the last assertion, which is why a fresh list is asserted beside it.
  it('reads no summary count while summaries are off, and returns the empty set', () => {
    const reads = summaryReadsOf();

    const counts = readIndexCounts(reads.store, reads.summarySource, totals, { modelTag: 'bge@2', semantic: false, summaries: false });

    expect(reads.summaryCounts).not.toHaveBeenCalled();
    expect(reads.awaitingRewrite).not.toHaveBeenCalled();
    expect(reads.writtenWith).not.toHaveBeenCalled();
    expect(counts.summaries).toEqual({ ...NO_SUMMARIES, writtenWith: [] });
    // A list of its own, so one caller adding to it cannot change what the next gets.
    expect(counts.summaries.writtenWith).not.toBe(NO_SUMMARIES.writtenWith);
  });

  // The contrast for the case above: the same reads, switched on, are made once
  // each, so the spies in that case are watching reads that happen when allowed.
  it('reads the summary counts once while summaries are on', () => {
    const reads = summaryReadsOf();

    const counts = readIndexCounts(reads.store, reads.summarySource, totals, { modelTag: 'bge@2', semantic: false, summaries: true });

    expect(reads.summaryCounts).toHaveBeenCalledTimes(1);
    expect(reads.awaitingRewrite).toHaveBeenCalledTimes(1);
    expect(reads.writtenWith).toHaveBeenCalledTimes(1);
    expect(counts.summaries).toEqual({
      written: 5,
      finishedTasks: 6,
      awaitingRewrite: 3,
      writtenWith: WRITTEN_WITH,
      ...NO_ACTIVITY,
    });
  });

  it('counts the corpora whether or not the summaries are read', () => {
    const reads = summaryReadsOf();
    const withSummaries = readIndexCounts(reads.store, reads.summarySource, totals, { modelTag: 'bge@2', semantic: false, summaries: true });
    const withoutSummaries = readIndexCounts(reads.store, reads.summarySource, totals, { modelTag: 'bge@2', semantic: false, summaries: false });

    expect(withoutSummaries.corpora).toEqual(withSummaries.corpora);
    expect(withoutSummaries.corpora.find((entry) => entry.corpus === 'conversation')).toMatchObject({ documents: 2, chunks: 10 });
  });
});

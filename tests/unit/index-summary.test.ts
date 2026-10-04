/**
 * The fold both Index surfaces share (`src/shared/index-summary.ts`): the
 * Settings card sums every indexed project with it on main, and the map's panel
 * sums the projects it draws with it in the renderer. On All projects the two
 * then read the same figures, which is what this file pins:
 *  - a corpus's counts add, and it embeds only if it embeds everywhere,
 *  - the summaries' counts add, writing wins over retrying wins over idle (a
 *    running pass or a failed call anywhere is what the line shows), and the
 *    soonest retry is the one named,
 *  - the line's facts come from the sum the same way on both sides, and
 *  - "indexed" is one predicate, the set the picker's All button selects.
 */
import { describe, it, expect } from 'vitest';
import {
  isIndexedProject,
  NO_SUMMARIES,
  sourceStatusOf,
  sumIndex,
  summaryStatusOf,
  sumSummaryCounts,
} from '../../src/shared/index-summary';
import type {
  KnowledgeGraphIndexCorpusSummary,
  KnowledgeGraphIndexSummary,
  KnowledgeGraphSummaryCounts,
} from '../../src/shared/types';

function corpus(
  name: KnowledgeGraphIndexCorpusSummary['corpus'],
  documents: number,
  chunks: number,
  embeddedChunks: number,
  embeds = true,
): KnowledgeGraphIndexCorpusSummary {
  return { corpus: name, documents, chunks, embeddedChunks, embeds };
}

function summaries(overrides: Partial<KnowledgeGraphSummaryCounts> = {}): KnowledgeGraphSummaryCounts {
  return { ...NO_SUMMARIES, writtenWith: [], ...overrides };
}

function indexSummary(overrides: Partial<KnowledgeGraphIndexSummary> = {}): KnowledgeGraphIndexSummary {
  return { corpora: [], summaries: summaries(), storageBytes: 0, ...overrides };
}

const SONNET = { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'low' };
const HAIKU = { agent: 'claude', model: 'claude-haiku-4-5', effort: 'low' };

describe('sumIndex', () => {
  it('adds each corpus\'s counts across projects, keeping the corpus order', () => {
    const total = sumIndex([
      indexSummary({ corpora: [corpus('conversation', 10, 100, 100), corpus('task', 5, 20, 10)] }),
      indexSummary({ corpora: [corpus('conversation', 4, 40, 30), corpus('task', 1, 3, 0)] }),
    ]);
    expect(total.corpora).toEqual([corpus('conversation', 14, 140, 130), corpus('task', 6, 23, 10)]);
  });

  it('keeps a corpus only one project has', () => {
    const total = sumIndex([
      indexSummary({ corpora: [corpus('conversation', 10, 100, 100)] }),
      indexSummary({ corpora: [corpus('conversation', 2, 20, 20), corpus('code', 7, 70, 35)] }),
    ]);
    const byCorpus = new Map(total.corpora.map((entry) => [entry.corpus, entry]));
    expect(byCorpus.get('conversation')).toEqual(corpus('conversation', 12, 120, 120));
    expect(byCorpus.get('code')).toEqual(corpus('code', 7, 70, 35));
    expect(total.corpora).toHaveLength(2);
  });

  it('marks a corpus as embedding only when it embeds in every project that has it', () => {
    const embedsBoth = sumIndex([indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] }), indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] })]);
    const embedsFirstOnly = sumIndex([indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] }), indexSummary({ corpora: [corpus('commit', 1, 1, 0, false)] })]);
    const embedsSecondOnly = sumIndex([indexSummary({ corpora: [corpus('commit', 1, 1, 0, false)] }), indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] })]);
    expect(embedsBoth.corpora[0].embeds).toBe(true);
    expect(embedsFirstOnly.corpora[0].embeds).toBe(false);
    expect(embedsSecondOnly.corpora[0].embeds).toBe(false);
  });

  it('adds the summaries written, the finished tasks, the rewrites, the skipped and the bytes stored', () => {
    const total = sumIndex([
      indexSummary({ summaries: summaries({ written: 300, finishedTasks: 412, skipped: 1, awaitingRewrite: 2 }), storageBytes: 3000 }),
      indexSummary({ summaries: summaries({ written: 20, finishedTasks: 30, skipped: 4, awaitingRewrite: 3 }), storageBytes: 500 }),
    ]);
    expect(total.summaries).toMatchObject({ written: 320, finishedTasks: 442, skipped: 5, awaitingRewrite: 5 });
    expect(total.storageBytes).toBe(3500);
  });

  it('does not change what it was given', () => {
    const first = indexSummary({ corpora: [corpus('conversation', 10, 100, 100)] });
    const second = indexSummary({ corpora: [corpus('conversation', 4, 40, 30)] });
    const firstBefore = structuredClone(first);
    const secondBefore = structuredClone(second);
    sumIndex([first, second]);
    expect(first).toEqual(firstBefore);
    expect(second).toEqual(secondBefore);
  });
});

describe('sumSummaryCounts', () => {
  it('reads writing when any project is writing, whatever the others do', () => {
    const states: Array<KnowledgeGraphSummaryCounts['state']> = ['idle', 'retrying', 'writing'];
    for (let writingAt = 0; writingAt < 3; writingAt += 1) {
      const order = [...states.slice(writingAt), ...states.slice(0, writingAt)];
      const total = sumSummaryCounts(order.map((state) => summaries({ state, retryInMs: state === 'retrying' ? 60_000 : null })));
      expect(total.state, order.join(',')).toBe('writing');
      // A retry beside a running pass is not what the line shows.
      expect(total.retryInMs).toBeNull();
    }
  });

  it('reads retrying over idle, at the soonest retry', () => {
    const total = sumSummaryCounts([
      summaries({ state: 'retrying', retryInMs: 240_000 }),
      summaries({ state: 'idle' }),
      summaries({ state: 'retrying', retryInMs: 60_000 }),
    ]);
    expect(total).toMatchObject({ state: 'retrying', retryInMs: 60_000 });
  });

  it('reads idle only when every project is idle', () => {
    expect(sumSummaryCounts([summaries(), summaries()]).state).toBe('idle');
    expect(sumSummaryCounts([]).state).toBe('idle');
  });

  it('merges what wrote the summaries by choice, most first, and keeps the current choice', () => {
    const total = sumSummaryCounts([
      summaries({ writtenWith: [{ ...SONNET, count: 3 }, { ...HAIKU, count: 1 }] }),
      summaries({ writtenWith: [{ ...HAIKU, count: 5 }], choice: SONNET }),
    ]);
    expect(total.writtenWith).toEqual([{ ...HAIKU, count: 6 }, { ...SONNET, count: 3 }]);
    expect(total.choice).toEqual(SONNET);
  });
});

describe('summaryStatusOf', () => {
  it('gives the time left at the rate for what is left to write and rewrite, not counting the skipped', () => {
    // 412 finished, 300 written, 2 passed over, 8 to rewrite: 110 + 8 left.
    const status = summaryStatusOf(summaries({ written: 300, finishedTasks: 412, skipped: 2, awaitingRewrite: 8 }), 59);
    expect(status.minutesLeft).toBe(2);
  });

  it('gives no time without a rate, or with nothing left', () => {
    expect(summaryStatusOf(summaries({ written: 1, finishedTasks: 5 }), null).minutesLeft).toBeNull();
    expect(summaryStatusOf(summaries({ written: 5, finishedTasks: 5 }), 30).minutesLeft).toBeNull();
  });
});

describe('sourceStatusOf', () => {
  const index = indexSummary({ corpora: [corpus('conversation', 12, 200, 150), corpus('commit', 40, 40, 0, false), corpus('task', 6, 10, 10)] });

  it('reads the share with a vector, rounded down, and the time left at the rate', () => {
    expect(sourceStatusOf(index, 'conversation', true, 25)).toEqual({ count: 12, percent: 75, minutesLeft: 2 });
  });

  it('never waits on a keyword-only corpus, a caught-up one, or with semantic search unavailable', () => {
    expect(sourceStatusOf(index, 'commit', true, 25)).toEqual({ count: 40, percent: null, minutesLeft: null });
    expect(sourceStatusOf(index, 'task', true, 25)).toEqual({ count: 6, percent: null, minutesLeft: null });
    expect(sourceStatusOf(index, 'conversation', false, 25)).toEqual({ count: 12, percent: null, minutesLeft: null });
  });

  it('never reads 100% while a passage still waits', () => {
    const almost = indexSummary({ corpora: [corpus('conversation', 1, 1_000, 999)] });
    expect(sourceStatusOf(almost, 'conversation', true, null)?.percent).toBe(99);
  });

  it('says nothing of a corpus the index does not list', () => {
    expect(sourceStatusOf(index, 'code', true, null)).toBeUndefined();
  });
});

describe('isIndexedProject', () => {
  it('counts a project with indexed conversations, the set All projects draws', () => {
    expect(isIndexedProject(1)).toBe(true);
    expect(isIndexedProject(0)).toBe(false);
  });
});

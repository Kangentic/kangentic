/**
 * Unit tests for `sumCoverage` and `sumIndex` in
 * src/renderer/components/knowledge-graph/use-graph-view.ts.
 *
 * With a project scope of two or more, the Knowledge Graph draws one map and
 * one Index panel over several projects, so the per-project coverage and index
 * summaries are folded into one. The fold has to say something true of all of
 * them:
 *  - counts add, and the embedded share is recomputed from the summed totals
 *    (an average of shares would weigh a tiny project like a huge one),
 *  - a problem in any project stays a problem (the worse tone wins, whichever
 *    project comes first),
 *  - a corpus's counts add, and it embeds only if it embeds everywhere,
 *  - a missing count of skipped summaries is zero, and
 *  - "Updated" is the OLDEST project's time, so it holds for everything shown,
 *    with a project that has never indexed anything not counted as a time.
 *
 * Both are pure, so this file needs no DOM and no store.
 */
import { describe, it, expect } from 'vitest';
import { sumCoverage, sumIndex } from '../../src/renderer/components/knowledge-graph/use-graph-view';
import type {
  KnowledgeGraphCoverageBucket,
  KnowledgeGraphCoverageSummary,
  KnowledgeGraphIndexCorpusSummary,
  KnowledgeGraphIndexSummary,
} from '../../src/shared/types';

type Tone = KnowledgeGraphCoverageBucket['tone'];
type BucketName = 'indexed' | 'sourceMissingButSearchable' | 'empty' | 'failed' | 'notYetIndexed';

const BUCKET_NAMES: BucketName[] = ['indexed', 'sourceMissingButSearchable', 'empty', 'failed', 'notYetIndexed'];

function bucket(documents: number, chunks: number, tone: Tone = 'ok'): KnowledgeGraphCoverageBucket {
  return { documents, chunks, tone };
}

function coverage(overrides: Partial<KnowledgeGraphCoverageSummary> = {}): KnowledgeGraphCoverageSummary {
  return {
    indexed: bucket(0, 0),
    sourceMissingButSearchable: bucket(0, 0),
    empty: bucket(0, 0),
    failed: bucket(0, 0),
    notYetIndexed: bucket(0, 0),
    totalDocumentsWithChunks: 0,
    totalChunks: 0,
    totalEmbeddedChunks: 0,
    embeddedFraction: 0,
    knownDocumentIdsMatched: 0,
    ...overrides,
  };
}

/** A summary with zero everywhere but one bucket. */
function coverageWithBucket(name: BucketName, value: KnowledgeGraphCoverageBucket): KnowledgeGraphCoverageSummary {
  const summary = coverage();
  summary[name] = value;
  return summary;
}

function corpus(
  name: KnowledgeGraphIndexCorpusSummary['corpus'],
  documents: number,
  chunks: number,
  embeddedChunks: number,
  embeds = true,
): KnowledgeGraphIndexCorpusSummary {
  return { corpus: name, documents, chunks, embeddedChunks, embeds };
}

function indexSummary(overrides: Partial<KnowledgeGraphIndexSummary> = {}): KnowledgeGraphIndexSummary {
  return {
    corpora: [],
    summaries: { written: 0, finishedTasks: 0 },
    storageBytes: 0,
    lastIndexedAt: null,
    ...overrides,
  };
}

describe('sumCoverage', () => {
  it('adds every count across projects', () => {
    const first = coverage({
      indexed: bucket(10, 100),
      sourceMissingButSearchable: bucket(20, 200),
      empty: bucket(3, 0),
      failed: bucket(1, 0),
      notYetIndexed: bucket(4, 40),
      totalDocumentsWithChunks: 30,
      totalChunks: 300,
      totalEmbeddedChunks: 150,
      knownDocumentIdsMatched: 28,
    });
    const second = coverage({
      indexed: bucket(5, 50),
      sourceMissingButSearchable: bucket(6, 60),
      empty: bucket(7, 0),
      failed: bucket(2, 0),
      notYetIndexed: bucket(8, 80),
      totalDocumentsWithChunks: 11,
      totalChunks: 110,
      totalEmbeddedChunks: 10,
      knownDocumentIdsMatched: 9,
    });

    const total = sumCoverage([first, second]);

    expect(total.indexed).toEqual(bucket(15, 150));
    expect(total.sourceMissingButSearchable).toEqual(bucket(26, 260));
    expect(total.empty).toEqual(bucket(10, 0));
    expect(total.failed).toEqual(bucket(3, 0));
    expect(total.notYetIndexed).toEqual(bucket(12, 120));
    expect(total.totalDocumentsWithChunks).toBe(41);
    expect(total.totalChunks).toBe(410);
    expect(total.totalEmbeddedChunks).toBe(160);
    expect(total.knownDocumentIdsMatched).toBe(37);
  });

  it('sums three projects, not just a pair', () => {
    const total = sumCoverage([
      coverage({ indexed: bucket(1, 10), totalChunks: 10 }),
      coverage({ indexed: bucket(2, 20), totalChunks: 20 }),
      coverage({ indexed: bucket(4, 40), totalChunks: 40 }),
    ]);

    expect(total.indexed).toEqual(bucket(7, 70));
    expect(total.totalChunks).toBe(70);
  });

  it('recomputes the embedded share from the summed totals rather than averaging the shares', () => {
    // 100 of 100 embedded beside 0 of 900: averaging the two shares reads 0.5,
    // while one chunk in ten actually has a vector.
    const total = sumCoverage([
      coverage({ totalChunks: 100, totalEmbeddedChunks: 100, embeddedFraction: 1 }),
      coverage({ totalChunks: 900, totalEmbeddedChunks: 0, embeddedFraction: 0 }),
    ]);

    expect(total.embeddedFraction).toBeCloseTo(0.1, 10);
  });

  it('reads an embedded share of zero, not NaN, when no project holds any chunk', () => {
    const total = sumCoverage([
      coverage({ totalChunks: 0, totalEmbeddedChunks: 0, embeddedFraction: 0 }),
      coverage({ totalChunks: 0, totalEmbeddedChunks: 0, embeddedFraction: 0 }),
    ]);

    expect(total.embeddedFraction).toBe(0);
  });

  it('keeps one project as it is, with its share recomputed from its own totals', () => {
    const only = coverage({
      indexed: bucket(9, 90, 'neutral'),
      totalChunks: 90,
      totalEmbeddedChunks: 45,
      embeddedFraction: 0.5,
    });

    const total = sumCoverage([only]);

    expect(total.indexed).toEqual(bucket(9, 90, 'neutral'));
    expect(total.embeddedFraction).toBe(0.5);
  });

  const TONE_PAIRS: Array<{ first: Tone; second: Tone; worse: Tone }> = [
    { first: 'ok', second: 'ok', worse: 'ok' },
    { first: 'ok', second: 'neutral', worse: 'neutral' },
    { first: 'neutral', second: 'ok', worse: 'neutral' },
    { first: 'ok', second: 'problem', worse: 'problem' },
    { first: 'problem', second: 'ok', worse: 'problem' },
    { first: 'neutral', second: 'problem', worse: 'problem' },
    { first: 'problem', second: 'neutral', worse: 'problem' },
    { first: 'neutral', second: 'neutral', worse: 'neutral' },
  ];

  for (const { first, second, worse } of TONE_PAIRS) {
    it(`reads ${first} beside ${second} as ${worse}, in every bucket`, () => {
      for (const name of BUCKET_NAMES) {
        const total = sumCoverage([
          coverageWithBucket(name, bucket(1, 1, first)),
          coverageWithBucket(name, bucket(1, 1, second)),
        ]);
        expect(total[name].tone, name).toBe(worse);
      }
    });
  }

  it('lets the worst of three projects decide the tone wherever it sits', () => {
    for (const problemAt of [0, 1, 2]) {
      const tones: Tone[] = ['ok', 'ok', 'ok'];
      tones[problemAt] = 'problem';
      const total = sumCoverage(tones.map((tone) => coverage({ failed: bucket(1, 0, tone) })));
      expect(total.failed.tone, `problem at ${problemAt}`).toBe('problem');
    }
  });

  it('does not change what it was given', () => {
    const first = coverage({ indexed: bucket(10, 100, 'ok'), totalChunks: 100, totalEmbeddedChunks: 50 });
    const second = coverage({ indexed: bucket(5, 50, 'problem'), totalChunks: 50, totalEmbeddedChunks: 5 });
    const firstBefore = structuredClone(first);
    const secondBefore = structuredClone(second);

    sumCoverage([first, second]);

    expect(first).toEqual(firstBefore);
    expect(second).toEqual(secondBefore);
  });
});

describe('sumIndex', () => {
  it('adds each corpus\'s counts across projects, keeping the corpus order', () => {
    const total = sumIndex([
      indexSummary({ corpora: [corpus('conversation', 10, 100, 100), corpus('task', 5, 20, 10)] }),
      indexSummary({ corpora: [corpus('conversation', 4, 40, 30), corpus('task', 1, 3, 0)] }),
    ]);

    expect(total.corpora).toEqual([
      corpus('conversation', 14, 140, 130),
      corpus('task', 6, 23, 10),
    ]);
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
    const embedsBoth = sumIndex([
      indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] }),
      indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] }),
    ]);
    const embedsFirstOnly = sumIndex([
      indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] }),
      indexSummary({ corpora: [corpus('commit', 1, 1, 0, false)] }),
    ]);
    const embedsSecondOnly = sumIndex([
      indexSummary({ corpora: [corpus('commit', 1, 1, 0, false)] }),
      indexSummary({ corpora: [corpus('commit', 1, 1, 0, true)] }),
    ]);

    expect(embedsBoth.corpora[0].embeds).toBe(true);
    expect(embedsFirstOnly.corpora[0].embeds).toBe(false);
    expect(embedsSecondOnly.corpora[0].embeds).toBe(false);
  });

  it('adds the summaries written, the finished tasks and the bytes stored', () => {
    const total = sumIndex([
      indexSummary({ summaries: { written: 300, finishedTasks: 412, skipped: 1 }, storageBytes: 3000 }),
      indexSummary({ summaries: { written: 20, finishedTasks: 30, skipped: 4 }, storageBytes: 500 }),
    ]);

    expect(total.summaries).toEqual({ written: 320, finishedTasks: 442, skipped: 5 });
    expect(total.storageBytes).toBe(3500);
  });

  it('counts a project that reports no skipped summaries as zero skipped', () => {
    const total = sumIndex([
      indexSummary({ summaries: { written: 1, finishedTasks: 2 } }),
      indexSummary({ summaries: { written: 3, finishedTasks: 4, skipped: 6 } }),
    ]);

    expect(total.summaries.skipped).toBe(6);
  });

  it('reads Updated from the oldest project, whichever comes first', () => {
    const older = '2026-09-01T08:00:00.000Z';
    const newer = '2026-09-20T17:30:00.000Z';

    expect(sumIndex([
      indexSummary({ lastIndexedAt: older }),
      indexSummary({ lastIndexedAt: newer }),
    ]).lastIndexedAt).toBe(older);
    expect(sumIndex([
      indexSummary({ lastIndexedAt: newer }),
      indexSummary({ lastIndexedAt: older }),
    ]).lastIndexedAt).toBe(older);
  });

  it('does not let a project that never indexed anything stand in for a time', () => {
    const only = '2026-09-10T12:00:00.000Z';

    expect(sumIndex([
      indexSummary({ lastIndexedAt: null }),
      indexSummary({ lastIndexedAt: only }),
    ]).lastIndexedAt).toBe(only);
    expect(sumIndex([
      indexSummary({ lastIndexedAt: only }),
      indexSummary({ lastIndexedAt: null }),
    ]).lastIndexedAt).toBe(only);
    // The field is optional on the summary, so an absent one is the same as null.
    expect(sumIndex([
      indexSummary({ lastIndexedAt: undefined }),
      indexSummary({ lastIndexedAt: only }),
    ]).lastIndexedAt).toBe(only);
  });

  it('reads no time when no project has indexed anything', () => {
    expect(sumIndex([
      indexSummary({ lastIndexedAt: null }),
      indexSummary({ lastIndexedAt: undefined }),
    ]).lastIndexedAt).toBeNull();
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

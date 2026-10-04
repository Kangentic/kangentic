/**
 * Unit tests for `sumCoverage` in
 * src/renderer/components/knowledge-graph/use-graph-view.ts.
 *
 * With a project scope of two or more, the Knowledge Graph draws one map over
 * several projects, so the per-project coverage summaries are folded into one.
 * The fold has to say something true of all of them:
 *  - counts add, and the embedded share is recomputed from the summed totals
 *    (an average of shares would weigh a tiny project like a huge one), and
 *  - a problem in any project stays a problem (the worse tone wins, whichever
 *    project comes first).
 *
 * The index summaries' fold, `sumIndex`, is shared with the Settings card and
 * tested in `index-summary.test.ts`.
 *
 * Pure, so this file needs no DOM and no store.
 */
import { describe, it, expect } from 'vitest';
import { sumCoverage } from '../../src/renderer/components/knowledge-graph/use-graph-view';
import type {
  KnowledgeGraphCoverageBucket,
  KnowledgeGraphCoverageSummary,
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

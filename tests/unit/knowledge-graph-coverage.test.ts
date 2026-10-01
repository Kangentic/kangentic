/**
 * Unit tests for the Knowledge Graph's conversation coverage
 * (`src/main/retrieval/graph/coverage-aggregate.ts`), which the Index panel reads.
 *
 * The headline test reproduces the REAL measured corpus shape, because the bug
 * this module exists to prevent is subtle and would ship looking fine: counts
 * built naively on `memory_index_state` report 223 sessions / 22,483 chunks
 * while the graph beside it renders 637 nodes / 51,228 chunks. The two numbers
 * come from different tables that disagree for 65% of a mature corpus.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregateCoverage,
  type CoverageChunkRow,
  type CoverageIndexStateRow,
} from '../../src/main/retrieval/graph/coverage-aggregate';

const CORPUS = 'conversation';

function stateRow(docId: string, status: string): CoverageIndexStateRow {
  return { corpus: CORPUS, docId, status };
}

function chunkRow(docId: string, chunkCount: number, embeddedCount = chunkCount): CoverageChunkRow {
  return { corpus: CORPUS, docId, chunkCount, embeddedCount };
}

describe('coverage reconciliation', () => {
  it('counts a missing-source document that still has chunks as SEARCHABLE, not failed', () => {
    // The single most important case. 414 of the real corpus's 637 indexed
    // sessions are in exactly this state: the transcript JSONL was deleted (a
    // pruned worktree), but the indexed text and embeddings are still in the DB
    // and still answer queries.
    const summary = aggregateCoverage({
      indexState: [stateRow('gone', 'missing-source')],
      chunkTotals: [chunkRow('gone', 80)],
      knownDocumentIds: [],
    });

    expect(summary.sourceMissingButSearchable).toEqual({ documents: 1, chunks: 80, tone: 'neutral' });
    expect(summary.failed.documents).toBe(0);
    expect(summary.empty.documents).toBe(0);
    // It counts toward what the graph renders.
    expect(summary.totalDocumentsWithChunks).toBe(1);
    expect(summary.totalChunks).toBe(80);
  });

  it('never paints missing-source as a problem', () => {
    const summary = aggregateCoverage({
      indexState: [stateRow('a', 'missing-source'), stateRow('b', 'missing-source')],
      chunkTotals: [chunkRow('a', 10), chunkRow('b', 20)],
      knownDocumentIds: [],
    });
    expect(summary.sourceMissingButSearchable.tone).toBe('neutral');
    expect(summary.failed.tone).toBe('ok');
  });

  it('treats only unsupported and error as problems', () => {
    const summary = aggregateCoverage({
      indexState: [stateRow('u', 'unsupported'), stateRow('e', 'error'), stateRow('ok', 'ok')],
      chunkTotals: [chunkRow('ok', 5)],
      knownDocumentIds: [],
    });
    expect(summary.failed).toEqual({ documents: 2, chunks: 0, tone: 'problem' });
    expect(summary.indexed).toEqual({ documents: 1, chunks: 5, tone: 'ok' });
  });

  it('separates a missing-source row whose chunks are ALSO gone', () => {
    const summary = aggregateCoverage({
      indexState: [stateRow('hollow', 'missing-source')],
      chunkTotals: [],
      knownDocumentIds: [],
    });
    expect(summary.empty.documents).toBe(1);
    expect(summary.sourceMissingButSearchable.documents).toBe(0);
    expect(summary.totalDocumentsWithChunks).toBe(0);
  });

  it('keeps chunks whose state row vanished entirely', () => {
    // Otherwise the strip's totals stop matching the rendered node count, which
    // is the exact class of discrepancy this module exists to eliminate.
    const summary = aggregateCoverage({
      indexState: [],
      chunkTotals: [chunkRow('orphan', 42)],
      knownDocumentIds: [],
    });
    expect(summary.totalDocumentsWithChunks).toBe(1);
    expect(summary.totalChunks).toBe(42);
    expect(summary.sourceMissingButSearchable.documents).toBe(1);
  });

  it('counts known documents the sweep has not reached', () => {
    const summary = aggregateCoverage({
      indexState: [stateRow('done', 'ok')],
      chunkTotals: [chunkRow('done', 3)],
      knownDocumentIds: ['done', 'pending-1', 'pending-2'],
    });
    expect(summary.notYetIndexed.documents).toBe(2);
    expect(summary.notYetIndexed.tone).toBe('neutral');
  });

  it('makes an id-space mistake observable instead of silent', () => {
    // Doc ids for the conversation corpus are `sessions.agent_session_id`, not
    // `sessions.id` - verified against the live corpus, where joining doc_id to
    // sessions.id matches ZERO rows. Passing the wrong id space produces a
    // plausible-looking summary in which every document reads as pending. The
    // only tell is knownDocumentIdsMatched === 0 against a populated index.
    const populated = {
      indexState: [stateRow('agent-1', 'ok'), stateRow('agent-2', 'ok')],
      chunkTotals: [chunkRow('agent-1', 10), chunkRow('agent-2', 10)],
    };

    const wrongIdSpace = aggregateCoverage({ ...populated, knownDocumentIds: ['session-1', 'session-2'] });
    expect(wrongIdSpace.knownDocumentIdsMatched).toBe(0);
    expect(wrongIdSpace.notYetIndexed.documents).toBe(2);
    expect(wrongIdSpace.totalDocumentsWithChunks).toBe(2); // index is clearly populated

    const rightIdSpace = aggregateCoverage({ ...populated, knownDocumentIds: ['agent-1', 'agent-2'] });
    expect(rightIdSpace.knownDocumentIdsMatched).toBe(2);
    expect(rightIdSpace.notYetIndexed.documents).toBe(0);
  });

  it('reports the embedded fraction', () => {
    const summary = aggregateCoverage({
      indexState: [stateRow('a', 'ok'), stateRow('b', 'ok')],
      chunkTotals: [chunkRow('a', 10, 10), chunkRow('b', 10, 5)],
      knownDocumentIds: [],
    });
    expect(summary.totalChunks).toBe(20);
    expect(summary.totalEmbeddedChunks).toBe(15);
    expect(summary.embeddedFraction).toBeCloseTo(0.75, 6);
  });

  it('handles a completely empty index', () => {
    const summary = aggregateCoverage({ indexState: [], chunkTotals: [], knownDocumentIds: [] });
    expect(summary.totalChunks).toBe(0);
    expect(summary.embeddedFraction).toBe(0);
    expect(summary.totalDocumentsWithChunks).toBe(0);
  });

  it('reproduces the real corpus shape, and its totals match the rendered graph', () => {
    // 802 state rows: 223 'ok', 579 'missing-source'. Of the missing-source
    // rows, 414 still hold chunks and 165 are hollow. 637 documents hold chunks
    // totalling 51,228. A naive read of the state table would say 223/22,483.
    const indexState: CoverageIndexStateRow[] = [];
    const chunkTotals: CoverageChunkRow[] = [];

    for (let index = 0; index < 223; index += 1) {
      const docId = `ok-${index}`;
      indexState.push(stateRow(docId, 'ok'));
      chunkTotals.push(chunkRow(docId, 101)); // 223 * 101 = 22,523
    }
    for (let index = 0; index < 414; index += 1) {
      const docId = `gone-${index}`;
      indexState.push(stateRow(docId, 'missing-source'));
      chunkTotals.push(chunkRow(docId, 69)); // 414 * 69 = 28,566
    }
    for (let index = 0; index < 165; index += 1) {
      indexState.push(stateRow(`hollow-${index}`, 'missing-source'));
    }

    const summary = aggregateCoverage({ indexState, chunkTotals, knownDocumentIds: [] });

    expect(indexState).toHaveLength(802);
    expect(summary.indexed.documents).toBe(223);
    expect(summary.sourceMissingButSearchable.documents).toBe(414);
    expect(summary.empty.documents).toBe(165);
    expect(summary.failed.documents).toBe(0);

    // THE assertion: what the strip reports equals what the graph renders.
    expect(summary.totalDocumentsWithChunks).toBe(637);
    expect(summary.totalChunks).toBe(22_523 + 28_566);
    expect(summary.embeddedFraction).toBe(1);

    // And it is decisively larger than the naive state-table read would give.
    expect(summary.totalChunks).toBeGreaterThan(summary.indexed.chunks * 2);
  });
});

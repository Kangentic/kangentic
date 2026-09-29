/**
 * Coverage reconciliation for the Knowledge Graph's header strip.
 *
 * This is a RECONCILIATION, not a readout, and that distinction is the whole
 * reason the module exists. `memory_index_state` is per-document bookkeeping
 * written at index time; `memory_chunks` is what the index actually holds. They
 * disagree, badly. Measured on the real corpus:
 *
 *   memory_index_state : 802 rows - 223 'ok' totalling 22,483 chunks
 *   memory_chunks      : 637 documents totalling 51,228 chunks
 *
 * A strip built naively on the state table would report 223 sessions and 22,483
 * chunks while the graph beside it rendered 637 nodes. The gap is 579
 * `missing-source` rows, of which **414 still hold live, fully searchable
 * chunks**: the transcript JSONL was deleted (a pruned worktree, a cleaned
 * `.claude/projects`) but the indexed text and its embeddings remain in the DB.
 *
 * So `missing-source` is NOT an error. It is the steady state for most of a
 * mature corpus, and painting it red would be actively misleading. Only
 * `unsupported` and `error` are problems. The one genuinely empty case -
 * a state row whose chunks are gone too - is reported separately and quietly.
 *
 * Pure functions over plain rows: no DB handle, no IPC, fully unit-testable.
 */

/** One `memory_index_state` row, narrowed to what coverage needs. */
export interface CoverageIndexStateRow {
  readonly corpus: string;
  readonly docId: string;
  /** 'ok' | 'unsupported' | 'missing-source' | 'error' */
  readonly status: string;
}

/** Live per-document truth, counted from `memory_chunks`. */
export interface CoverageChunkRow {
  readonly corpus: string;
  readonly docId: string;
  readonly chunkCount: number;
  readonly embeddedCount: number;
}

export interface CoverageInput {
  readonly indexState: ReadonlyArray<CoverageIndexStateRow>;
  readonly chunkTotals: ReadonlyArray<CoverageChunkRow>;
  /**
   * Documents the corpus adapter could eventually index. Anything here with
   * neither a state row nor chunks has not been reached by the sweep yet.
   *
   * These must be DOC ids, in the corpus's own id space - which for
   * conversations is `sessions.agent_session_id`, the agent CLI's transcript
   * id, NOT `sessions.id`. Verified against the live corpus: joining
   * `memory_chunks.doc_id` to `sessions.id` matches zero rows. Passing session
   * ids here silently classifies EVERY document as un-indexed, which reads as a
   * catastrophically incomplete index rather than as the wiring mistake it is.
   * Sessions with a null `agent_session_id` never produced a transcript and
   * must be excluded rather than counted as pending.
   */
  readonly knownDocumentIds: ReadonlyArray<string>;
}

/** A coverage bucket. `tone` tells the UI how to paint it, so the renderer
 *  never has to re-derive which states are actually problems. */
export interface CoverageBucket {
  readonly documents: number;
  readonly chunks: number;
  readonly tone: 'ok' | 'neutral' | 'problem';
}

export interface CoverageSummary {
  /** Indexed and searchable, source transcript still present. */
  readonly indexed: CoverageBucket;
  /** Indexed and FULLY SEARCHABLE, but the source transcript is gone. The
   *  steady state for most of a mature corpus - never a problem tone. */
  readonly sourceMissingButSearchable: CoverageBucket;
  /** A state row whose chunks are gone too: genuinely nothing to search. */
  readonly empty: CoverageBucket;
  /** `unsupported` or `error`. The only buckets painted as problems. */
  readonly failed: CoverageBucket;
  /** Known documents the sweep has not reached yet. */
  readonly notYetIndexed: CoverageBucket;

  /** Totals across everything that actually holds chunks, which is what the
   *  graph renders. These are the numbers that must match the node count. */
  readonly totalDocumentsWithChunks: number;
  readonly totalChunks: number;
  readonly totalEmbeddedChunks: number;
  /** 0..1. Embedded share of chunks; 1 means the semantic layer is complete. */
  readonly embeddedFraction: number;

  /**
   * How many of `knownDocumentIds` were recognised as already indexed.
   *
   * Exposed to make an id-space mistake OBSERVABLE instead of silent. Passing
   * `sessions.id` where doc ids are `sessions.agent_session_id` produces a
   * perfectly plausible-looking summary in which every document reads as
   * pending; the only tell is that this number is 0 while the index is clearly
   * populated. A caller (or a test) can assert on it. It carries no meaning
   * when `knownDocumentIds` is empty.
   */
  readonly knownDocumentIdsMatched: number;
}

const EMPTY_BUCKET: CoverageBucket = { documents: 0, chunks: 0, tone: 'ok' };

function bucket(documents: number, chunks: number, tone: CoverageBucket['tone']): CoverageBucket {
  return { documents, chunks, tone };
}

/**
 * Reconcile index-state bookkeeping against the chunks actually present.
 *
 * Documents are classified by what they CAN DO for the user (is it searchable?)
 * rather than by what the state table says happened, because those two answers
 * differ for 65% of a real corpus.
 */
export function aggregateCoverage(input: CoverageInput): CoverageSummary {
  const chunkTotalsByKey = new Map<string, CoverageChunkRow>();
  for (const row of input.chunkTotals) {
    chunkTotalsByKey.set(`${row.corpus}::${row.docId}`, row);
  }

  let indexedDocuments = 0;
  let indexedChunks = 0;
  let missingSourceDocuments = 0;
  let missingSourceChunks = 0;
  let emptyDocuments = 0;
  let failedDocuments = 0;
  let failedChunks = 0;

  const seenDocIds = new Set<string>();

  for (const state of input.indexState) {
    seenDocIds.add(state.docId);
    const key = `${state.corpus}::${state.docId}`;
    const totals = chunkTotalsByKey.get(key);
    const chunks = totals?.chunkCount ?? 0;

    if (state.status === 'unsupported' || state.status === 'error') {
      failedDocuments += 1;
      failedChunks += chunks;
      continue;
    }

    if (chunks === 0) {
      // Covers a 'missing-source' row whose chunks are gone AND an 'ok' row
      // that produced nothing. Either way there is nothing to search.
      emptyDocuments += 1;
      continue;
    }

    if (state.status === 'missing-source') {
      missingSourceDocuments += 1;
      missingSourceChunks += chunks;
    } else {
      indexedDocuments += 1;
      indexedChunks += chunks;
    }
  }

  // Chunks can outlive their state row entirely (the row was deleted while the
  // chunks were not). Those are still searchable and must not vanish from the
  // strip, or the totals stop matching the rendered node count.
  for (const [key, totals] of chunkTotalsByKey) {
    const docId = key.slice(key.indexOf('::') + 2);
    if (seenDocIds.has(docId)) continue;
    seenDocIds.add(docId);
    missingSourceDocuments += 1;
    missingSourceChunks += totals.chunkCount;
  }

  let notYetIndexed = 0;
  let knownDocumentIdsMatched = 0;
  for (const docId of input.knownDocumentIds) {
    if (seenDocIds.has(docId)) knownDocumentIdsMatched += 1;
    else notYetIndexed += 1;
  }

  let totalDocumentsWithChunks = 0;
  let totalChunks = 0;
  let totalEmbeddedChunks = 0;
  for (const totals of chunkTotalsByKey.values()) {
    if (totals.chunkCount <= 0) continue;
    totalDocumentsWithChunks += 1;
    totalChunks += totals.chunkCount;
    totalEmbeddedChunks += totals.embeddedCount;
  }

  return {
    indexed: bucket(indexedDocuments, indexedChunks, 'ok'),
    sourceMissingButSearchable: bucket(missingSourceDocuments, missingSourceChunks, 'neutral'),
    empty: emptyDocuments === 0 ? EMPTY_BUCKET : bucket(emptyDocuments, 0, 'neutral'),
    failed: failedDocuments === 0 ? EMPTY_BUCKET : bucket(failedDocuments, failedChunks, 'problem'),
    notYetIndexed: notYetIndexed === 0 ? EMPTY_BUCKET : bucket(notYetIndexed, 0, 'neutral'),
    totalDocumentsWithChunks,
    totalChunks,
    totalEmbeddedChunks,
    embeddedFraction: totalChunks === 0 ? 0 : totalEmbeddedChunks / totalChunks,
    knownDocumentIdsMatched,
  };
}

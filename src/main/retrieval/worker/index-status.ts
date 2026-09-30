/**
 * The index's half of the Knowledge Graph status poll (Settings, every 1.5 s
 * while it is open): read in the retrieval worker, composed on main with what
 * only main knows (the model download, the embed engine, the summary
 * scheduler, the git branch size). See `retrievalService.getStatus`.
 */

import { RetrievalStore } from '../retrieval-store';
import { SummaryStore } from '../summary/summary-store';
import type { SummaryChoiceCount } from '../../../shared/types';
import { indexedCodeBranch } from '../code/code-indexer';
import { hasVecSupport } from '../vec-support';
import { timeSyncWork } from '../../diagnostics/event-loop-lag';
import type Database from 'better-sqlite3';

export interface IndexStatusParams {
  projectId: string;
  /** The selected model, whose vectors count as embedded. */
  modelTag: string;
  /** Semantic search is on: read what is waiting for a vector. */
  semantic: boolean;
  /** Read the summaries row (indexing and semantic search on). */
  summaries: boolean;
  /** Read the source code row: null when not shown, else whether code is
   *  switched on (off reads only the indexed branch). */
  code: { on: boolean } | null;
  /** Read the per-source lines (indexing on). */
  sources: boolean;
}

export type CorpusTotalsRow = ReturnType<RetrievalStore['corpusTotals']>[number];

export interface IndexStatus {
  /** The worker's connection has sqlite-vec: semantic search can run. */
  hasVec: boolean;
  summaries: {
    written: number;
    finishedTasks: number;
    awaitingRewrite: number;
    writtenWith: SummaryChoiceCount[];
  } | null;
  code: {
    progress: { documents: number; chunks: number; embedded: number };
    indexedBranch: string | null;
  } | null;
  sources: {
    totals: CorpusTotalsRow[];
    waitingByCorpus: Map<string, number>;
  } | null;
}

/**
 * How long a project's corpus totals are kept before they are read again. The
 * totals are the Index panel's own read (`corpusTotals`, so the two show the
 * same counts), about 15 ms on a 94k-chunk index, and they move only as
 * documents are indexed. Keyed on the index's size instead, they were read
 * again after every embedding batch, on nearly every poll while embedding ran
 * (the size check alone is two full index counts). What moves by the second,
 * the passages still waiting, is read on every poll by a query that costs what
 * is waiting.
 */
export const SOURCE_TOTALS_TTL_MS = 30_000;

export function createIndexStatusReader(now: () => number = Date.now) {
  const totalsCache = new Map<string, { readAt: number; totals: CorpusTotalsRow[] }>();

  function totalsFor(projectId: string, store: RetrievalStore): CorpusTotalsRow[] {
    const at = now();
    let cached = totalsCache.get(projectId);
    if (!cached || at - cached.readAt > SOURCE_TOTALS_TTL_MS) {
      cached = { readAt: at, totals: timeSyncWork('status:source-totals', () => store.corpusTotals()) };
      totalsCache.set(projectId, cached);
    }
    return cached.totals;
  }

  return {
    read(db: Database.Database, params: IndexStatusParams): IndexStatus {
      const store = new RetrievalStore(db);
      let summaries: IndexStatus['summaries'] = null;
      if (params.summaries) {
        try {
          const summaryStore = new SummaryStore(db);
          summaries = { ...store.summaryCounts(), awaitingRewrite: summaryStore.awaitingRewrite(), writtenWith: summaryStore.writtenWith() };
        } catch {
          summaries = null;
        }
      }
      let code: IndexStatus['code'] = null;
      if (params.code) {
        try {
          code = {
            progress: params.code.on ? store.corpusProgress('code', params.modelTag) : { documents: 0, chunks: 0, embedded: 0 },
            indexedBranch: indexedCodeBranch(store),
          };
        } catch {
          code = null;
        }
      }
      let sources: IndexStatus['sources'] = null;
      if (params.sources) {
        try {
          sources = {
            totals: totalsFor(params.projectId, store),
            waitingByCorpus: params.semantic
              ? timeSyncWork('status:source-waiting', () => store.countChunksNeedingEmbedding(params.modelTag))
              : new Map(),
          };
        } catch {
          sources = null;
        }
      }
      return { hasVec: hasVecSupport(db), summaries, code, sources };
    },
    /** Forget a project's totals, after its index was cleared. */
    forget(projectId: string): void {
      totalsCache.delete(projectId);
    },
  };
}

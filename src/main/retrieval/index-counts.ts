/**
 * One project's index as the map's Index panel and the Settings card count it:
 * the map's snapshot (`graph/graph-service.ts`) and Settings' status poll
 * (`worker/index-status.ts`). Run in the retrieval worker. Each caller keeps its
 * own cache of the corpus totals (the snapshot keys them on the store's
 * fingerprint, the poll on a short age), and everything else is read here, the
 * same way for both, so the panel and the card cannot count a project differently.
 */

import type { RetrievalStore } from './retrieval-store';
import { INDEX_CORPORA, isEmbeddedCorpus } from './corpora';
import { NO_SUMMARIES, NO_SUMMARY_ACTIVITY } from '../../shared/index-summary';
import type {
  KnowledgeGraphIndexCorpusSummary, KnowledgeGraphIndexCounts, KnowledgeGraphSummaryCounts, SummaryChoiceCount,
} from '../../shared/types';

export type CorpusTotalsRow = ReturnType<RetrievalStore['corpusTotals']>[number];

/** The summary reads a count needs, which `SummaryStore` provides. */
export interface SummaryCountSource {
  awaitingRewrite(): number;
  writtenWith(): SummaryChoiceCount[];
}

export interface IndexCountsOptions {
  /** The selected model: only its vectors count as embedded. */
  modelTag: string;
  /** Semantic search is on, so passages waiting for a vector are read. */
  semantic: boolean;
  /** Read the task summaries' counts. */
  summaries: boolean;
}

/**
 * Every corpus's documents and passages, and how many passages have a vector
 * from the selected model. A passage embedded by another model is waiting: it
 * is embedded again, so it does not count as done. Read live (it costs what is
 * waiting), so a share moves as the drain works while the totals are cached.
 * Measured over 19 real projects, all of them on the Settings poll: 1.9 ms
 * caught up, 56.5 ms right after a model change with every passage waiting,
 * so it is not cached for projects that are not open.
 * The totals can trail a fresh index by their cache's age, so a corpus counts at
 * least the passages that wait.
 *
 * A project with no vector table yet (one not drained since semantic search was
 * switched on) is not read for what waits: the store counts nothing waiting
 * there, which would read every passage as embedded and keep it from ever
 * being drained.
 */
export function corporaOf(
  store: RetrievalStore,
  totals: ReadonlyArray<CorpusTotalsRow>,
  options: Pick<IndexCountsOptions, 'modelTag' | 'semantic'>,
): KnowledgeGraphIndexCorpusSummary[] {
  let waiting: Map<string, number> | null = null;
  if (options.semantic && store.hasVec) {
    try {
      waiting = store.countChunksNeedingEmbedding(options.modelTag);
    } catch {
      waiting = null;
    }
  }
  return INDEX_CORPORA.map((corpus) => {
    const row = totals.find((entry) => entry.corpus === corpus);
    const embeds = isEmbeddedCorpus(corpus);
    const waitingHere = embeds && waiting ? waiting.get(corpus) ?? 0 : 0;
    const chunks = Math.max(row?.chunks ?? 0, waitingHere);
    return {
      corpus,
      documents: row?.documents ?? 0,
      chunks,
      // Without a waiting read (semantic search off, or no vector table) the
      // totals' own count stands: nothing is being embedded either way.
      embeddedChunks: embeds && waiting ? chunks - waitingHere : row?.embeddedChunks ?? 0,
      embeds,
    };
  });
}

/** Each read on its own, so one that fails costs only its own figure. */
function readOr<Value>(read: () => Value, fallback: Value): Value {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** The task summaries' counts, with no scheduler activity: main adds that. */
export function summaryCountsOf(store: RetrievalStore, summaryStore: SummaryCountSource): KnowledgeGraphSummaryCounts {
  return {
    ...readOr(() => store.summaryCounts(), { written: 0, finishedTasks: 0 }),
    awaitingRewrite: readOr(() => summaryStore.awaitingRewrite(), 0),
    writtenWith: readOr(() => summaryStore.writtenWith(), []),
    ...NO_SUMMARY_ACTIVITY,
  };
}

/** One project's corpora and summaries, as the panel and the card count them. */
export function readIndexCounts(
  store: RetrievalStore,
  summaryStore: SummaryCountSource,
  totals: ReadonlyArray<CorpusTotalsRow>,
  options: IndexCountsOptions,
): KnowledgeGraphIndexCounts {
  return {
    corpora: corporaOf(store, totals, options),
    summaries: options.summaries ? summaryCountsOf(store, summaryStore) : { ...NO_SUMMARIES, writtenWith: [] },
  };
}

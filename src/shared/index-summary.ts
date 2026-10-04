/**
 * What the two Index views share: Settings > Knowledge Graph's Index card
 * (main sums every indexed project for it) and the Knowledge Graph's Index panel
 * (the renderer sums the projects on the map). Both sum one per-project record,
 * `KnowledgeGraphIndexCounts`, with `sumIndexCounts` (the panel through
 * `sumIndex`, which adds the size on disk), and read a line's figures from the
 * sum through the same functions, so the two cannot disagree. Only the time
 * left differs: main alone measures the rates, so the panel shows none.
 */

import type {
  KnowledgeGraphIndexCorpus,
  KnowledgeGraphIndexCorpusSummary,
  KnowledgeGraphIndexCounts,
  KnowledgeGraphIndexSummary,
  KnowledgeGraphSourceStatus,
  KnowledgeGraphSummaryCounts,
  KnowledgeGraphSummaryStatus,
  SummaryChoiceCount,
} from './types';

/**
 * A project the index holds conversations for. "All projects" means these, on
 * the map's picker and in the Settings card alike; a project with nothing
 * indexed has no map to draw.
 */
export function isIndexedProject(conversations: number): boolean {
  return conversations > 0;
}

/** What the summary scheduler is doing for a project, which main adds to the worker's counts. */
export type SummaryActivity = Pick<KnowledgeGraphSummaryCounts, 'skipped' | 'state' | 'retryInMs' | 'choice'>;

/** A project's summaries before main adds what its scheduler is doing. */
export const NO_SUMMARY_ACTIVITY: SummaryActivity = {
  skipped: 0,
  state: 'idle',
  retryInMs: null,
  choice: null,
};

/** No summaries at all: what a project counts while its summaries are not read. */
export const NO_SUMMARIES: KnowledgeGraphSummaryCounts = {
  written: 0,
  finishedTasks: 0,
  awaitingRewrite: 0,
  writtenWith: [],
  ...NO_SUMMARY_ACTIVITY,
};

const STATE_RANK: Record<KnowledgeGraphSummaryCounts['state'], number> = { idle: 0, retrying: 1, writing: 2 };

function choiceKey(entry: SummaryChoiceCount): string {
  return `${entry.agent}\u0000${entry.model ?? ''}\u0000${entry.effort ?? ''}`;
}

/** Summaries by what wrote them, the same choice added up, most first. */
function mergeWrittenWith(lists: ReadonlyArray<ReadonlyArray<SummaryChoiceCount>>): SummaryChoiceCount[] {
  const byChoice = new Map<string, SummaryChoiceCount>();
  for (const list of lists) {
    for (const entry of list) {
      const key = choiceKey(entry);
      const sum = byChoice.get(key);
      byChoice.set(key, sum ? { ...sum, count: sum.count + entry.count } : { ...entry });
    }
  }
  return [...byChoice.values()].sort((left, right) => right.count - left.count);
}

/**
 * Several projects' summaries as one. The counts add up. One project writing
 * makes the sum writing, else one retrying makes it retrying, at the soonest
 * retry: a running track or a failed call anywhere is what the line shows.
 */
export function sumSummaryCounts(list: ReadonlyArray<KnowledgeGraphSummaryCounts>): KnowledgeGraphSummaryCounts {
  let state: KnowledgeGraphSummaryCounts['state'] = 'idle';
  let retryInMs: number | null = null;
  for (const entry of list) {
    if (STATE_RANK[entry.state] > STATE_RANK[state]) state = entry.state;
    if (entry.state === 'retrying' && entry.retryInMs !== null) {
      retryInMs = retryInMs === null ? entry.retryInMs : Math.min(retryInMs, entry.retryInMs);
    }
  }
  return {
    written: list.reduce((total, entry) => total + entry.written, 0),
    finishedTasks: list.reduce((total, entry) => total + entry.finishedTasks, 0),
    awaitingRewrite: list.reduce((total, entry) => total + entry.awaitingRewrite, 0),
    writtenWith: mergeWrittenWith(list.map((entry) => entry.writtenWith)),
    skipped: list.reduce((total, entry) => total + entry.skipped, 0),
    state,
    retryInMs: state === 'retrying' ? retryInMs : null,
    choice: list.find((entry) => entry.choice !== null)?.choice ?? null,
  };
}

/** The index across projects: each corpus's counts summed, and the summaries. */
export function sumIndexCounts(list: ReadonlyArray<KnowledgeGraphIndexCounts>): KnowledgeGraphIndexCounts {
  const byCorpus = new Map<KnowledgeGraphIndexCorpusSummary['corpus'], KnowledgeGraphIndexCorpusSummary>();
  for (const counts of list) {
    for (const entry of counts.corpora) {
      const sum = byCorpus.get(entry.corpus);
      byCorpus.set(entry.corpus, sum
        ? {
          corpus: entry.corpus,
          documents: sum.documents + entry.documents,
          chunks: sum.chunks + entry.chunks,
          embeddedChunks: sum.embeddedChunks + entry.embeddedChunks,
          embeds: sum.embeds && entry.embeds,
        }
        : { ...entry });
    }
  }
  return {
    corpora: [...byCorpus.values()],
    summaries: sumSummaryCounts(list.map((counts) => counts.summaries)),
  };
}

/** The map's index across projects: the counts summed, and the sizes. */
export function sumIndex(summaries: ReadonlyArray<KnowledgeGraphIndexSummary>): KnowledgeGraphIndexSummary {
  return {
    ...sumIndexCounts(summaries),
    storageBytes: summaries.reduce((total, summary) => total + summary.storageBytes, 0),
  };
}

/** A corpus's passages still waiting for the selected model's vectors; none for a keyword-only corpus. */
function waitingChunksOf(entry: KnowledgeGraphIndexCorpusSummary): number {
  return entry.embeds ? Math.max(0, entry.chunks - entry.embeddedChunks) : 0;
}

/** The corpora whose passages still wait for the selected model's vectors. */
export function waitingCorporaOf(corpora: ReadonlyArray<KnowledgeGraphIndexCorpusSummary>): KnowledgeGraphIndexCorpus[] {
  return corpora.filter((entry) => waitingChunksOf(entry) > 0).map((entry) => entry.corpus);
}

/** Summaries still to write at the run's rate: unwritten tasks the agent has
 *  not passed over, and summaries marked for rewriting. */
export function summariesRemaining(summaries: KnowledgeGraphSummaryCounts): number {
  return Math.max(0, summaries.finishedTasks - summaries.written - summaries.skipped) + summaries.awaitingRewrite;
}

/** The Task summaries line's facts, with the time left at `writtenPerMinute`
 *  (main's measured rate), or none when there is no rate. */
export function summaryStatusOf(summaries: KnowledgeGraphSummaryCounts, writtenPerMinute: number | null): KnowledgeGraphSummaryStatus {
  const remaining = summariesRemaining(summaries);
  return {
    ...summaries,
    minutesLeft: writtenPerMinute && writtenPerMinute > 0 && remaining > 0 ? remaining / writtenPerMinute : null,
  };
}

/** A source with nothing indexed: what a line reads for a corpus the summary does not list. */
export const NO_SOURCE: KnowledgeGraphSourceStatus = { count: 0, percent: null, minutesLeft: null };

/**
 * An always-on source's facts: its count, and while some passages still wait
 * for a vector, the share that has one and the time left at `chunksPerMinute`
 * (main's measured rate), or none when there is no rate.
 */
export function sourceStatusOf(
  index: KnowledgeGraphIndexCounts,
  corpus: KnowledgeGraphIndexCorpus,
  semanticAvailable: boolean,
  chunksPerMinute: number | null,
): KnowledgeGraphSourceStatus | undefined {
  const entry = index.corpora.find((candidate) => candidate.corpus === corpus);
  if (!entry) return undefined;
  const waiting = semanticAvailable ? waitingChunksOf(entry) : 0;
  if (waiting === 0 || entry.chunks === 0) return { count: entry.documents, percent: null, minutesLeft: null };
  return {
    count: entry.documents,
    // Rounded down, so a line never reads 100% while a passage still waits.
    percent: Math.floor(((entry.chunks - waiting) / entry.chunks) * 100),
    minutesLeft: chunksPerMinute && chunksPerMinute > 0 ? waiting / chunksPerMinute : null,
  };
}

/**
 * The lines of the Knowledge Graph's Index panel, which reads as the Settings
 * Index card without its switches: the same sources, the same names, and the
 * same value pattern (`settings/tabs/index-sources.ts`). Pure, so each state is
 * pinned by a unit test.
 *
 * The numbers come from the graph's own index summary, summed over the projects
 * on the map with `sumIndex` (`shared/index-summary.ts`). The Settings card sums
 * the same per-project record over every indexed project through the same
 * functions, so on All projects the two read the same figures. The summary
 * carries no rate, so a running line shows its share without a time left.
 */

import type { CardSourceLineProps } from '../settings/settings-card';
import {
  alwaysOnLine,
  CODE_INFO,
  codeLine,
  NOT_YET_INDEXED,
  SUMMARIES_INFO,
  summariesLine,
  type SourceLineState,
} from '../settings/tabs/index-sources';
import type {
  KnowledgeGraphBuildProgress,
  KnowledgeGraphCodeStatus,
  KnowledgeGraphCoverageSummary,
  KnowledgeGraphIndexCorpus,
  KnowledgeGraphIndexSummary,
} from '../../../shared/types';
import { NO_SOURCE, sourceStatusOf, summaryStatusOf } from '../../../shared/index-summary';
import { settingProps } from '../settings/settings-registry';
import { formatBytes } from './PanelRow';

export interface IndexSourceLinesInput {
  index: KnowledgeGraphIndexSummary;
  semanticAvailable: boolean;
  summariesOn: boolean;
  codeOn: boolean;
  /** What the summaries and code still wait for (`sourceRequirements`). */
  requirements: { summaries: string | undefined; code: string | undefined };
}

function corpusOf(index: KnowledgeGraphIndexSummary, corpus: KnowledgeGraphIndexCorpus) {
  return index.corpora.find((entry) => entry.corpus === corpus);
}

/** A held source code corpus as the Settings line reads it: still embedding, or ready. */
function codeStatus(index: KnowledgeGraphIndexSummary): KnowledgeGraphCodeStatus | undefined {
  const entry = corpusOf(index, 'code');
  if (!entry) return undefined;
  return {
    state: entry.embeddedChunks < entry.chunks ? 'indexing' : 'ready',
    files: entry.documents,
    passages: entry.chunks,
    embedded: entry.embeddedChunks,
    minutesLeft: null,
  };
}

function isEmpty(index: KnowledgeGraphIndexSummary, corpus: KnowledgeGraphIndexCorpus): boolean {
  return (corpusOf(index, corpus)?.documents ?? 0) === 0;
}

/** Read as the Settings card reads it: a corpus the summary does not list counts 0, so it reads not yet indexed. */
function alwaysOnSource(index: KnowledgeGraphIndexSummary, corpus: KnowledgeGraphIndexCorpus, semanticAvailable: boolean, progressLabel: string): SourceLineState {
  return alwaysOnLine(sourceStatusOf(index, corpus, semanticAvailable, null) ?? NO_SOURCE, progressLabel);
}

/**
 * The Source code line. The summary cannot tell a branch still being read from
 * one with nothing committed, so an empty corpus says it is not indexed yet
 * rather than showing a track that may never move.
 */
function codeSource(index: KnowledgeGraphIndexSummary, codeOn: boolean, requirement: string | undefined): SourceLineState {
  if (requirement) return { requirement };
  if (isEmpty(index, 'code')) return codeOn ? NOT_YET_INDEXED : { value: 'Off', tone: 'muted' };
  return codeLine(codeStatus(index), undefined);
}

/** Conversations, Tasks, Commits, Task summaries, Source code: the Settings card's lines. */
export function indexSourceLines(input: IndexSourceLinesInput): CardSourceLineProps[] {
  const { index, semanticAvailable, summariesOn, codeOn, requirements } = input;
  return [
    { label: 'Conversations', ...alwaysOnSource(index, 'conversation', semanticAvailable, 'Conversations embedded'), testId: 'knowledge-graph-index-source-conversations' },
    { label: 'Tasks', ...alwaysOnSource(index, 'task', semanticAvailable, 'Tasks embedded'), testId: 'knowledge-graph-index-source-tasks' },
    { label: 'Commits', ...alwaysOnSource(index, 'commit', semanticAvailable, 'Commits indexed'), testId: 'knowledge-graph-index-source-commits' },
    {
      label: settingProps('knowledgeGraph.taskSummaries').label,
      info: SUMMARIES_INFO,
      ...summariesLine(summariesOn, summaryStatusOf(index.summaries, null), requirements.summaries),
      testId: 'knowledge-graph-index-source-summaries',
    },
    {
      label: settingProps('knowledgeGraph.sourceCode').label,
      info: CODE_INFO,
      ...codeSource(index, codeOn, requirements.code),
      testId: 'knowledge-graph-index-source-code',
    },
  ];
}

export interface IndexMapLinesInput {
  edgeCount: number;
  coverage: KnowledgeGraphCoverageSummary;
  storageBytes: number;
}

const LINKS_INFO = 'Links are computed in full embedding dimensionality and are exact. Position is an approximate reduction, so nearby is a hint, not a guarantee.';
const TRANSCRIPT_GONE_INFO = 'The agent\'s transcript file is gone, but the indexed text and its embeddings are still here and still searchable.';
const NOT_YET_INDEXED_INFO = 'The background sweep has not reached these conversations yet.';

/**
 * What only the map has: its links, and what the index holds beyond the
 * sources. The Index panel shows only on a map; while there is none, the
 * centre card says so.
 */
export function indexMapLines(input: IndexMapLinesInput): CardSourceLineProps[] {
  const { edgeCount, coverage, storageBytes } = input;
  const lines: CardSourceLineProps[] = [
    { label: 'Links', info: LINKS_INFO, value: edgeCount.toLocaleString(), testId: 'knowledge-graph-index-fact-map' },
  ];
  if (coverage.sourceMissingButSearchable.documents > 0) {
    lines.push({ label: 'Transcript gone', info: TRANSCRIPT_GONE_INFO, value: coverage.sourceMissingButSearchable.documents.toLocaleString(), testId: 'knowledge-graph-index-fact-transcript-gone' });
  }
  if (coverage.notYetIndexed.documents > 0) {
    lines.push({ label: 'Not yet indexed', info: NOT_YET_INDEXED_INFO, value: coverage.notYetIndexed.documents.toLocaleString(), testId: 'knowledge-graph-index-fact-not-yet-indexed' });
  }
  if (coverage.failed.documents > 0) {
    lines.push({ label: 'Failed to index', tone: 'caution', problem: coverage.failed.documents.toLocaleString(), testId: 'knowledge-graph-index-fact-failed' });
  }
  if (storageBytes > 0) {
    lines.push({ label: 'Size on disk', value: formatBytes(storageBytes), testId: 'knowledge-graph-index-fact-size' });
  }
  return lines;
}

const BUILD_STAGE_LABELS: Record<KnowledgeGraphBuildProgress['stage'], string> = {
  reading: 'Reading conversations',
  placing: 'Placing conversations',
  naming: 'Naming regions',
};

/**
 * The building card's status row: what the first build is doing and how far it
 * has got. Before its first figure arrives it reads as just begun.
 */
export function buildProgressRow(progress: KnowledgeGraphBuildProgress | null): { label: string; value: string; percent: number } {
  const stage = progress?.stage ?? 'reading';
  const percent = Math.max(0, Math.min(99, progress?.percent ?? 0));
  return { label: BUILD_STAGE_LABELS[stage], value: `${percent}%`, percent };
}

/**
 * Main's side of the retrieval worker's searches: embed the query here (only
 * the embed engine embeds, and it is on main), send the vectors with the call,
 * and answer with the worker's result.
 *
 * Each function degrades rather than throws. A worker that is restarting, or a
 * search that failed inside it, answers with no hits, the same thing an empty
 * index answers, so no caller grows a second error path.
 */

import { trackFeatureUsed } from '../analytics/usage';
import { retrievalClient, RetrievalUnavailableError } from './retrieval-client';
import { embedQueryTexts } from './query-vectors';
import type { TranscriptSearchHit } from './memory-search';
import type { CommitHit } from './commit/commit-search';
import type { ProjectRef, RankedRelatedWork } from './worker/methods';
import type { Embedder } from './types';
import type { KnowledgeGraphQueryHit } from '../../shared/types';

/** What a caller tells an agent or a reader when the worker cannot answer. */
export const INDEX_RESTARTING = 'The Knowledge Graph index is restarting. Try again in a moment.';

export interface ConversationSearchRequest {
  query: string;
  projects: ReadonlyArray<ProjectRef>;
  /** Semantic embedder, or null for keywords only. */
  embedder: Embedder | null;
  k?: number;
  taskId?: string;
  /** How long the query embed may take before the search runs on keywords. */
  embedWaitMs?: number;
}

/** Hybrid conversation search in the worker. */
export async function searchConversations(request: ConversationSearchRequest): Promise<TranscriptSearchHit[]> {
  const query = request.query.trim();
  if (!query || request.projects.length === 0) return [];
  const queryVectors = await embedQueryTexts(request.embedder, [query], request.embedWaitMs);
  // Adoption signal for the vector path only: a search that fell back to
  // keywords (no embedder, or an embed that failed or timed out) is not a use
  // of semantic memory. Deduped to once a day.
  if (queryVectors && queryVectors.vectors.length > 0) trackFeatureUsed('semantic_memory');
  try {
    return await retrievalClient.call('search.conversations', {
      query,
      projects: request.projects.map((project) => ({ id: project.id, name: project.name })),
      k: request.k,
      taskId: request.taskId,
      queryVectors,
    });
  } catch (error) {
    console.warn('[retrieval] conversation search unavailable:', error instanceof Error ? error.message : error);
    return [];
  }
}

/** Commits matching a query across projects. None while the worker is down. */
export async function searchCommitsIn(
  projects: ReadonlyArray<ProjectRef>,
  query: string,
  taskId?: string,
): Promise<Array<CommitHit & { projectName: string }>> {
  if (projects.length === 0) return [];
  try {
    return await retrievalClient.call('search.commits', {
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      query,
      taskId,
    });
  } catch (error) {
    console.warn('[retrieval] commit search unavailable:', error instanceof Error ? error.message : error);
    return [];
  }
}

/** A task's prior work (the task window's Related panel). None while the
 *  worker is down, as for a task with nothing near it. */
export async function findPriorWork(request: {
  project: ProjectRef;
  taskId: string;
  query: string;
  embedder: Embedder | null;
  overfetch: number;
  rows: number;
}): Promise<KnowledgeGraphQueryHit[]> {
  const queryVectors = await embedQueryTexts(request.embedder, [request.query.trim()]);
  if (queryVectors && queryVectors.vectors.length > 0) trackFeatureUsed('semantic_memory');
  try {
    return await retrievalClient.call('task.priorWork', {
      project: { id: request.project.id, name: request.project.name },
      taskId: request.taskId,
      query: request.query,
      queryVectors,
      overfetch: request.overfetch,
      rows: request.rows,
    });
  } catch (error) {
    console.warn('[retrieval] prior work unavailable:', error instanceof Error ? error.message : error);
    return [];
  }
}

export interface RankRelatedWorkRequest {
  projectId: string;
  question: string;
  keywordText?: string;
  excludeTaskId?: string;
  embedder: Embedder | null;
  /** The texts the query vectors are embedded from, in the order the search
   *  uses them (`relatedQueryTexts`, or one text for a task's whole body). */
  vectorTexts: ReadonlyArray<string>;
  embedWaitMs?: number;
  rows?: number;
  withExtras: boolean;
}

/**
 * One project's related work, ranked in the worker. Null when the worker
 * cannot answer, which a caller reports as `INDEX_RESTARTING`.
 */
export async function rankRelatedWork(request: RankRelatedWorkRequest): Promise<RankedRelatedWork | null> {
  const queryVectors = await embedQueryTexts(request.embedder, request.vectorTexts, request.embedWaitMs);
  if (queryVectors && queryVectors.vectors.length > 0) trackFeatureUsed('semantic_memory');
  try {
    return await retrievalClient.call('related.rank', {
      projectId: request.projectId,
      question: request.question,
      keywordText: request.keywordText,
      excludeTaskId: request.excludeTaskId,
      queryVectors,
      rows: request.rows,
      withExtras: request.withExtras,
    });
  } catch (error) {
    // The ranking degrades inside the worker rather than throwing, so anything
    // but an absent worker is a real failure and goes to the caller as one.
    if (!(error instanceof RetrievalUnavailableError)) throw error;
    console.warn('[retrieval] related work unavailable:', error.message);
    return null;
  }
}

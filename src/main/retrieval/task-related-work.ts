/**
 * The work related to one task: the other tasks most like it, ranked by the same
 * rollup as a Knowledge Graph question. One function, so the task window's prior
 * work and `kangentic_search relatedToTask` rank alike: they used to rank with two
 * different searches and named different tasks for the same task.
 */

import {
  boardRecordTasks,
  indexedConversationNodes,
  searchRelatedWork,
  type IndexedConversationNode,
  type RelatedWork,
} from './related-work';
import type { Embedder } from './types';
import type { KnowledgeGraphQueryHit } from '../../shared/types';

/**
 * Characters of the task's title and description the ranking reads: enough to
 * carry the task's meaning, and past it the embedding blurs.
 */
export const TASK_TEXT_CHARS = 1_200;
/** How long the ranking waits for its embedding before ranking by keyword alone. */
const EMBED_WAIT_MS = 5_000;

export interface RankWorkRelatedToTaskInput {
  projectId: string;
  task: { id: string; title: string; description?: string | null };
  /** An agent's query, which focuses the ranking. Empty ranks by the task alone. */
  focus?: string;
  embedder: Embedder | null;
}

export interface TaskRelatedWork {
  related: RelatedWork;
  /** The conversations the ranking read, the task's own left out. */
  nodes: IndexedConversationNode[];
}

/**
 * The task itself is left out entirely, its conversations and its record, so a
 * strength is measured against the best OTHER task.
 *
 * The node and record reads come BEFORE the embedding. The embed is a round trip
 * to the worker, so timers and IPC run between these reads and the vector scan;
 * read after it, they ran back to back with the scan and held main for one
 * merged 470 ms stall. The task is embedded once, as one query vector, because
 * each vector costs one scan of every conversation vector on main.
 */
export async function rankWorkRelatedToTask(input: RankWorkRelatedToTaskInput): Promise<TaskRelatedWork> {
  const focus = input.focus?.trim() ?? '';
  const { task } = input;
  const text = `${focus ? `${focus}. ` : ''}${task.title}\n${task.description ?? ''}`.slice(0, TASK_TEXT_CHARS);
  const nodes = indexedConversationNodes(input.projectId).filter((node) => node.taskId !== task.id);
  const recordOnlyTasks = boardRecordTasks(input.projectId).filter((record) => record.taskId !== task.id);
  let queryVectors: ReadonlyArray<Float32Array> = [];
  if (input.embedder) {
    try {
      queryVectors = (await input.embedder.embed([text], { timeoutMs: EMBED_WAIT_MS, isQuery: true })) ?? [];
    } catch {
      queryVectors = [];
    }
  }
  const related = await searchRelatedWork({
    question: text,
    // A long description ORs a hundred words into the keyword search and
    // matches everything, so keywords come from the focus and the title.
    keywordText: `${focus} ${task.title}`,
    projectId: input.projectId,
    nodes,
    recordOnlyTasks,
    embedder: input.embedder,
    queryVectors,
    embedWaitMs: EMBED_WAIT_MS,
  });
  return { related, nodes };
}

/**
 * The task window's rows: the strongest related tasks that have a conversation
 * to open, in the order `kangentic_search relatedToTask` lists them. A task
 * matched through its record alone has no conversation, and every row here
 * opens one, so it is left out.
 */
export function priorWorkHits(work: TaskRelatedWork, limit: number): KnowledgeGraphQueryHit[] {
  const docKeyBySession = new Map<string, string>();
  for (const node of work.nodes) {
    if (node.sessionId) docKeyBySession.set(node.sessionId, node.docKey);
  }
  const hits: KnowledgeGraphQueryHit[] = [];
  for (const task of work.related.handed) {
    if (hits.length === limit) break;
    const docKey = task.sessionId ? docKeyBySession.get(task.sessionId) : undefined;
    if (!task.sessionId || !docKey) continue;
    hits.push({
      docKey,
      sessionId: task.sessionId,
      taskId: task.taskId,
      taskTitle: task.title,
      agentName: null,
      snippet: task.bestChunkId !== null ? work.related.passages.get(task.bestChunkId) ?? '' : '',
      score: task.score,
      matchKind: work.related.semantic ? 'hybrid' : 'lexical',
      matchCount: task.matches,
      // The rollup keeps the matched turn's id, not its time.
      turnTs: null,
    });
  }
  return hits;
}
